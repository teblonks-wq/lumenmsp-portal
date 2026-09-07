import { pool } from '../db/pool';

// ── Service inventory ─────────────────────────────────────────────────────────────
// Terry, 7 Sep 2026, on the Watchdog form: "Services — this needs to be a lookup across all
// services from all computers and devices." So the Portal now knows which Windows services exist
// on every machine: once a day each agent that checks in is asked for `Get-Service` (name,
// display name, state, start type) as a marked JSON probe on shell.powershell — the same shape as
// the BitLocker and battery probes, so no agent release. The result replaces the machine's rows.
//
// What it gives: the Watchdog "Services" box can offer real names with how many machines have
// them ("Spooler — Print Spooler, on 41 machines"), the picker can show which chosen machines
// actually run a service, and later a "service X is set to Automatic but stopped" check.

export const SERVICES_MARKER = '"lumen_services":1';
const REFRESH_HOURS = 24;
const ATTEMPT_GUARD_MINUTES = 30;

export const SERVICES_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$s = Get-CimInstance -ClassName Win32_Service | Select-Object Name, DisplayName, State, StartMode',
  '$r = [ordered]@{ lumen_services = 1; count = @($s).Count; services = @($s | ForEach-Object { @{ n = $_.Name; d = $_.DisplayName; s = $_.State; m = $_.StartMode } }) }',
  '$r | ConvertTo-Json -Compress -Depth 4',
].join('\r\n');

export function looksLikeServicesProbe(output: string | null | undefined): boolean {
  return !!output && output.indexOf(SERVICES_MARKER) >= 0;
}

export interface ServiceRow { name: string; displayName: string | null; status: string | null; startType: string | null }

export function parseServicesOutput(output: string): ServiceRow[] | null {
  const t = String(output || '');
  const from = t.indexOf('{'); const to = t.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  let j: any; try { j = JSON.parse(t.slice(from, to + 1)); } catch { return null; }
  if (!j || j.lumen_services !== 1) return null;
  const list: any[] = Array.isArray(j.services) ? j.services : (j.services ? [j.services] : []);
  const out: ServiceRow[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const name = String(s?.n || '').trim().slice(0, 200);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      displayName: s?.d ? String(s.d).slice(0, 300) : null,
      status: s?.s ? String(s.s).toLowerCase().slice(0, 30) : null,       // running | stopped | …
      startType: s?.m ? String(s.m).toLowerCase().slice(0, 30) : null,    // auto | manual | disabled
    });
  }
  return out;
}

/** Replace the machine's inventory with what it just reported. One transaction, so a reader never sees half. */
export async function ingestServicesProbe(deviceId: number, output: string): Promise<string> {
  const rows = parseServicesOutput(output);
  if (!rows) throw new Error('services probe output was not readable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM device_services WHERE device_id=$1', [deviceId]);
    // Multi-row insert in chunks: a server can have 300+ services.
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const vals: any[] = []; const ph: string[] = [];
      chunk.forEach((r, k) => { const b = k * 5; ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`); vals.push(deviceId, r.name, r.displayName, r.status, r.startType); });
      await client.query(`INSERT INTO device_services (device_id, name, display_name, status, start_type) VALUES ${ph.join(',')}`, vals);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  return `Service inventory stored — ${rows.length} services, ${rows.filter((r) => r.status === 'running').length} running.`;
}

const DUE_SQL = `
  SELECT (
    (SELECT MAX(collected_at) FROM device_services WHERE device_id = $1) IS NULL
    OR (SELECT MAX(collected_at) FROM device_services WHERE device_id = $1) < NOW() - ($2 || ' hours')::interval
  ) AND NOT EXISTS (
    SELECT 1 FROM agent_commands
     WHERE device_id = $1 AND kind = 'shell.powershell'
       AND (status IN ('queued','running') OR requested_at > NOW() - ($3 || ' minutes')::interval)
       AND (payload::text LIKE '%lumen_services%' OR payload::text LIKE '%services_probe%')
  ) AS due`;

/** Called on every heartbeat, every machine. Two cheap reads in the common case, nothing queued. */
export async function maybeQueueServicesProbe(deviceId: number): Promise<boolean> {
  const due = (await pool.query(DUE_SQL, [deviceId, REFRESH_HOURS, ATTEMPT_GUARD_MINUTES])).rows[0];
  if (!due || !due.due) return false;
  await queueServicesProbe(deviceId);
  return true;
}

export async function queueServicesProbe(deviceId: number, requestedBy: number | null = null): Promise<number> {
  const r = await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by) VALUES ($1,'shell.powershell',$2,'queued',$3) RETURNING id`,
    [deviceId, JSON.stringify({ script: SERVICES_SCRIPT, run_as: 'system', services_probe: true }), requestedBy]);
  return r.rows[0].id;
}

/**
 * The lookup behind the Watchdog form: service names known anywhere on the estate (or on chosen
 * machines / one customer), with how many machines have each and the commonest display name.
 */
export async function lookupServices(a: { q?: string; deviceIds?: number[]; customerId?: number | null; limit?: number }): Promise<Array<{ name: string; displayName: string | null; machines: number; running: number }>> {
  const params: any[] = []; const where: string[] = [];
  if (a.q) { params.push('%' + a.q + '%'); where.push(`(s.name ILIKE $${params.length} OR s.display_name ILIKE $${params.length})`); }
  if (a.deviceIds && a.deviceIds.length) { params.push(a.deviceIds); where.push(`s.device_id = ANY($${params.length}::int[])`); }
  if (a.customerId) { params.push(a.customerId); where.push(`s.device_id IN (SELECT id FROM agent_devices WHERE customer_id=$${params.length})`); }
  params.push(Math.max(1, Math.min(200, a.limit || 40)));
  const r = await pool.query(
    `SELECT s.name, MODE() WITHIN GROUP (ORDER BY s.display_name) AS display_name,
            COUNT(DISTINCT s.device_id)::int AS machines,
            COUNT(DISTINCT s.device_id) FILTER (WHERE s.status='running')::int AS running
       FROM device_services s
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY s.name
      ORDER BY machines DESC, s.name
      LIMIT $${params.length}`, params);
  return r.rows.map((x: any) => ({ name: x.name, displayName: x.display_name, machines: x.machines, running: x.running }));
}

/** Which of the given machines have each of the given services — the "will this watchdog fail on day one" check. */
export async function servicesOnMachines(deviceIds: number[], names: string[]): Promise<Record<string, number[]>> {
  if (!deviceIds.length || !names.length) return {};
  const r = await pool.query(
    `SELECT LOWER(name) AS name, device_id FROM device_services WHERE device_id = ANY($1::int[]) AND LOWER(name) = ANY($2::text[])`,
    [deviceIds, names.map((n) => n.toLowerCase())]);
  const out: Record<string, number[]> = {};
  for (const n of names) out[n] = [];
  for (const row of r.rows) { const key = names.find((n) => n.toLowerCase() === row.name); if (key) out[key].push(Number(row.device_id)); }
  return out;
}

export async function inventoryStats(): Promise<{ machines: number; services: number; newest: Date | null }> {
  const r = await pool.query(`SELECT COUNT(DISTINCT device_id)::int AS machines, COUNT(DISTINCT name)::int AS services, MAX(collected_at) AS newest FROM device_services`);
  return { machines: r.rows[0].machines, services: r.rows[0].services, newest: r.rows[0].newest };
}

/** Same rule as the other probes: only rows this feature made, only once they are worthless. */
export async function pruneServicesCommands(): Promise<number> {
  const r = await pool.query(
    `DELETE FROM agent_commands WHERE kind='shell.powershell' AND output LIKE 'Service inventory stored%' AND finished_at < NOW() - INTERVAL '7 days'`);
  return r.rowCount || 0;
}
