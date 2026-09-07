import cron from 'node-cron';
import { pool } from '../db/pool';
import { raiseAlert, resolveAlert, createTicketForAlert } from './alerts';
import { notifyStaff } from './notifications';
import { getScript } from './scripts';
import { wakeAgent } from '../routes/agent-api';

// ── Watchdogs (customer machines) ───────────────────────────────────────────────
// Not to be confused with lib/watchdog.ts, which is the Portal watching its OWN plumbing.
// A watchdog asks one question of a set of machines on a cadence and already knows what to
// do on the day the answer is "no". Two families of signal:
//
//   HEARTBEAT kinds — offline · disk · uptime — read what the agent reports anyway
//   (last_seen_at, disk_info, last_boot_at). Free: no traffic to the machine, evaluated
//   every minute from the row that is already here.
//
//   PROBE kinds — service · process — queue a small PowerShell read on the machine every
//   `interval_minutes` and evaluate what comes back. Only machines that are actually
//   checking in get probed; a machine that is off is "unknown", never "failing", because a
//   service cannot be down on a machine that is not up. That distinction is the whole
//   difference between a board people trust and one they mute.
//
// Self-heal runs on the FIRST failure and then on a cool-down while the failure persists,
// capped per day; when the cap is hit the watchdog stops trying and escalates (a case, if
// asked for) — a service that will not stay up is a job for a person, not a loop.

export type WatchdogKind = 'service' | 'process' | 'disk' | 'offline' | 'uptime';
export const KINDS: Array<{ key: WatchdogKind; label: string; probe: boolean; help: string }> = [
  { key: 'service', label: 'Windows service is running', probe: true,
    help: 'Checks the named services on each machine. A service that is stopped fails the check; the default self-heal starts it again.' },
  { key: 'process', label: 'Process is running (or absent)', probe: true,
    help: 'Checks whether a process is running — for something that must always be up, or must never be.' },
  { key: 'disk', label: 'Disk free space', probe: false,
    help: 'Reads the free space the agent reports on every check-in. Fails when a drive drops under the line; clears once it is 5 points back above it, so a drive hovering on the line does not flap.' },
  { key: 'offline', label: 'Machine has gone quiet', probe: false,
    help: 'Fails when the agent has not checked in for longer than the limit. Nothing can be healed on a machine we cannot reach — this one is for knowing, and for raising a case.' },
  { key: 'uptime', label: 'Machine has not restarted in too long', probe: false,
    help: 'Fails when the last boot is older than the limit. The usual self-heal is a scheduled restart at a quiet hour rather than an immediate one.' },
];
export const HEAL_TYPES: Array<{ key: string; label: string; help: string }> = [
  { key: 'service_start', label: 'Start the service(s) again', help: 'Service watchdogs only. Start-Service on whatever was found stopped.' },
  { key: 'script', label: 'Run a script from the library', help: 'A reviewed script, run as SYSTEM.' },
  { key: 'command', label: 'Run a PowerShell command', help: 'One line, run as SYSTEM. No preview.' },
  { key: 'restart', label: 'Restart the machine', help: 'With a 60-second warning to anyone signed in.' },
  { key: 'case', label: 'Raise a case', help: 'A support case in the helpdesk, linked to the alert.' },
  { key: 'notify', label: 'Tell the team', help: 'An in-app notification to every member of staff.' },
];

export interface WatchdogRow {
  id: number; name: string; kind: WatchdogKind; params: any; scope: string; customerId: number | null;
  severity: string; intervalMinutes: number; enabled: boolean; heal: any[]; healMaxPerDay: number;
  healCooldownMinutes: number; escalateCase: boolean; notes: string | null; createdBy: number | null;
  createdAt: Date; updatedAt: Date;
}
const MAP = (r: any): WatchdogRow => ({
  id: r.id, name: r.name, kind: r.kind, params: r.params || {}, scope: r.scope, customerId: r.customer_id,
  severity: r.severity, intervalMinutes: Number(r.interval_minutes), enabled: !!r.enabled,
  heal: Array.isArray(r.heal) ? r.heal : [], healMaxPerDay: Number(r.heal_max_per_day),
  healCooldownMinutes: Number(r.heal_cooldown_minutes), escalateCase: !!r.escalate_case, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const SEL = `SELECT * FROM watchdogs WHERE deleted_at IS NULL`;

export async function listWatchdogs(): Promise<Array<WatchdogRow & { targets: number; failing: number; unknown: number; ok: number }>> {
  const r = await pool.query(
    `SELECT w.*,
            (SELECT COUNT(*)::int FROM watchdog_states s WHERE s.watchdog_id=w.id) AS targets,
            (SELECT COUNT(*)::int FROM watchdog_states s WHERE s.watchdog_id=w.id AND s.status='failing') AS failing,
            (SELECT COUNT(*)::int FROM watchdog_states s WHERE s.watchdog_id=w.id AND s.status='unknown') AS unknown,
            (SELECT COUNT(*)::int FROM watchdog_states s WHERE s.watchdog_id=w.id AND s.status='ok') AS ok
       FROM watchdogs w WHERE w.deleted_at IS NULL ORDER BY w.enabled DESC, lower(w.name)`);
  return r.rows.map((x: any) => Object.assign(MAP(x), { targets: x.targets, failing: x.failing, unknown: x.unknown, ok: x.ok }));
}
export async function getWatchdog(id: number): Promise<WatchdogRow | null> {
  const r = await pool.query(`${SEL} AND id=$1`, [id]);
  return r.rows.length ? MAP(r.rows[0]) : null;
}

// ── Create / edit ───────────────────────────────────────────────────────────────

export interface WatchdogInput {
  name: string; kind: string; params: any; scope: string; customerId?: number | null; deviceIds?: number[];
  severity?: string; intervalMinutes?: number; heal?: any[]; healMaxPerDay?: number; healCooldownMinutes?: number;
  escalateCase?: boolean; notes?: string | null;
}
const SVC_OK = /^[A-Za-z0-9 ._$()-]{1,120}$/;

/** Turns the form's loose input into something the sweep can act on, or says exactly why not. */
export function normalise(inp: WatchdogInput): { ok: true; value: WatchdogInput } | { ok: false; error: string } {
  const kind = String(inp.kind || '') as WatchdogKind;
  if (!KINDS.some((k) => k.key === kind)) return { ok: false, error: 'Pick what to watch.' };
  const name = String(inp.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'Give the watchdog a name — it is what the alert will be called.' };
  const p: any = {};
  const src = inp.params || {};
  if (kind === 'service') {
    const list = String(Array.isArray(src.services) ? src.services.join('\n') : (src.services || ''))
      .split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return { ok: false, error: 'Name at least one service (the short name, e.g. Spooler).' };
    const bad = list.find((s) => !SVC_OK.test(s));
    if (bad) return { ok: false, error: `"${bad}" is not a service name.` };
    p.services = Array.from(new Set(list)).slice(0, 20);
  } else if (kind === 'process') {
    const proc = String(src.process || '').trim().replace(/\.exe$/i, '');
    if (!proc || !SVC_OK.test(proc)) return { ok: false, error: 'Give the process name, e.g. outlook.' };
    p.process = proc;
    p.expect = String(src.expect) === 'absent' ? 'absent' : 'running';
  } else if (kind === 'disk') {
    const drive = String(src.drive || 'C:').trim().toUpperCase();
    if (!/^([A-Z]:|ANY)$/.test(drive)) return { ok: false, error: 'Drive must be a letter like C: or "any".' };
    p.drive = drive === 'ANY' ? 'any' : drive;
    const pct = Number(src.minFreePct); const gb = Number(src.minFreeGb);
    if (!(pct > 0 && pct < 100) && !(gb > 0)) return { ok: false, error: 'Set a free-space line — a percentage, gigabytes, or both.' };
    if (pct > 0 && pct < 100) p.minFreePct = Math.round(pct);
    if (gb > 0) p.minFreeGb = Math.round(gb * 10) / 10;
  } else if (kind === 'offline') {
    const m = Math.round(Number(src.minutes));
    if (!(m >= 5 && m <= 60 * 24 * 14)) return { ok: false, error: 'Quiet for how long? Between 5 minutes and 14 days.' };
    p.minutes = m;
  } else if (kind === 'uptime') {
    const d = Math.round(Number(src.days));
    if (!(d >= 1 && d <= 365)) return { ok: false, error: 'How many days without a restart? 1 to 365.' };
    p.days = d;
  }
  const scope = ['devices', 'customer', 'estate'].includes(String(inp.scope)) ? String(inp.scope) : 'devices';
  const deviceIds = Array.from(new Set((inp.deviceIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)));
  const customerId = Number(inp.customerId) > 0 ? Number(inp.customerId) : null;
  if (scope === 'devices' && !deviceIds.length) return { ok: false, error: 'Pick at least one machine, or watch a whole customer or the estate.' };
  if (scope === 'customer' && !customerId) return { ok: false, error: 'Pick the customer.' };

  // Heal actions. Kept to what the sweep knows how to do; anything else is dropped rather than
  // stored as a promise nobody will keep.
  const heal: any[] = [];
  for (const h of Array.isArray(inp.heal) ? inp.heal : []) {
    const t = String(h?.type || '');
    if (!HEAL_TYPES.some((x) => x.key === t)) continue;
    if (t === 'service_start' && kind !== 'service') continue;
    if (t === 'script') { const sid = Number(h.scriptId); if (!(sid > 0)) return { ok: false, error: 'Pick the script to run.' }; heal.push({ type: t, scriptId: sid }); continue; }
    if (t === 'command') { const cmd = String(h.script || '').trim(); if (!cmd) return { ok: false, error: 'Type the command to run.' }; if (cmd.length > 4000) return { ok: false, error: 'That command is too long (4,000 max).' }; heal.push({ type: t, script: cmd }); continue; }
    if (t === 'restart') { heal.push({ type: t, delaySeconds: Math.max(0, Math.min(3600, Math.round(Number(h.delaySeconds ?? 60)) || 60)) }); continue; }
    heal.push({ type: t });
  }
  if (kind === 'offline' && heal.some((h) => ['service_start', 'script', 'command', 'restart'].includes(h.type))) {
    return { ok: false, error: 'A machine that has gone quiet cannot run anything — keep "gone quiet" to a case or a notification.' };
  }
  const severity = String(inp.severity) === 'critical' ? 'critical' : 'warning';
  const interval = Math.max(5, Math.min(1440, Math.round(Number(inp.intervalMinutes ?? 15)) || 15));
  const maxPerDay = Math.max(0, Math.min(24, Math.round(Number(inp.healMaxPerDay ?? 3))));
  const cooldown = Math.max(5, Math.min(1440, Math.round(Number(inp.healCooldownMinutes ?? 30)) || 30));
  return { ok: true, value: { name, kind, params: p, scope, customerId, deviceIds, severity, intervalMinutes: interval, heal,
    healMaxPerDay: maxPerDay, healCooldownMinutes: cooldown, escalateCase: inp.escalateCase !== false, notes: inp.notes ? String(inp.notes).slice(0, 2000) : null } };
}

export async function createWatchdog(inp: WatchdogInput, userId: number | null): Promise<{ ok: boolean; id?: number; error?: string }> {
  const n = normalise(inp);
  if (!n.ok) return { ok: false, error: n.error };
  const v = n.value;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO watchdogs (name, kind, params, scope, customer_id, severity, interval_minutes, heal, heal_max_per_day, heal_cooldown_minutes, escalate_case, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [v.name, v.kind, JSON.stringify(v.params), v.scope, v.customerId, v.severity, v.intervalMinutes, JSON.stringify(v.heal),
        v.healMaxPerDay, v.healCooldownMinutes, v.escalateCase, v.notes, userId]);
    const id = r.rows[0].id as number;
    for (const d of v.deviceIds || []) {
      await client.query('INSERT INTO watchdog_targets (watchdog_id, device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, d]);
    }
    await client.query('COMMIT');
    await event(id, null, 'note', 'Watchdog created.');
    return { ok: true, id };
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: e.message };
  } finally { client.release(); }
}

export async function updateWatchdog(id: number, inp: WatchdogInput): Promise<{ ok: boolean; error?: string }> {
  const n = normalise(inp);
  if (!n.ok) return { ok: false, error: n.error };
  const v = n.value;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE watchdogs SET name=$2, kind=$3, params=$4, scope=$5, customer_id=$6, severity=$7, interval_minutes=$8, heal=$9,
              heal_max_per_day=$10, heal_cooldown_minutes=$11, escalate_case=$12, notes=$13, updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL`,
      [id, v.name, v.kind, JSON.stringify(v.params), v.scope, v.customerId, v.severity, v.intervalMinutes, JSON.stringify(v.heal),
        v.healMaxPerDay, v.healCooldownMinutes, v.escalateCase, v.notes]);
    await client.query('DELETE FROM watchdog_targets WHERE watchdog_id=$1', [id]);
    for (const d of v.deviceIds || []) {
      await client.query('INSERT INTO watchdog_targets (watchdog_id, device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, d]);
    }
    // A changed question deserves a fresh answer: outstanding probes are forgotten, states re-read.
    await client.query(`UPDATE watchdog_states SET probe_command_id=NULL, probe_queued_at=NULL, last_checked_at=NULL WHERE watchdog_id=$1`, [id]);
    await client.query('COMMIT');
    await event(id, null, 'note', 'Watchdog changed.');
    return { ok: true };
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: e.message };
  } finally { client.release(); }
}

export async function setEnabled(id: number, on: boolean): Promise<void> {
  await pool.query('UPDATE watchdogs SET enabled=$2, updated_at=NOW() WHERE id=$1', [id, on]);
  if (!on) {
    // Switching off closes what it raised — a paused watchdog must not leave red on the board.
    const states = (await pool.query(`SELECT device_id FROM watchdog_states WHERE watchdog_id=$1 AND status='failing'`, [id])).rows;
    for (const s of states) await resolveAlert('watchdog', `wd:${id}:${s.device_id}`).catch(() => {});
    await pool.query(`UPDATE watchdog_states SET status='unknown', probe_command_id=NULL, probe_queued_at=NULL, updated_at=NOW() WHERE watchdog_id=$1`, [id]);
  }
  await event(id, null, 'note', on ? 'Switched on.' : 'Switched off — its open alerts were closed.');
}

export async function deleteWatchdog(id: number): Promise<void> {
  await setEnabled(id, false);
  await pool.query('UPDATE watchdogs SET deleted_at=NOW(), enabled=false WHERE id=$1', [id]);
}

async function event(watchdogId: number, deviceId: number | null, kind: string, detail: string, commandId: number | null = null): Promise<void> {
  await pool.query('INSERT INTO watchdog_events (watchdog_id, device_id, kind, detail, command_id) VALUES ($1,$2,$3,$4,$5)',
    [watchdogId, deviceId, kind, detail.slice(0, 2000), commandId]).catch(() => {});
}

// ── Targets ─────────────────────────────────────────────────────────────────────

interface Dev { id: number; hostname: string; customerId: number | null; customerName: string | null; lastSeenSecs: number | null; diskInfo: any; lastBootAt: Date | null; os: string | null }

async function targetsOf(w: WatchdogRow): Promise<Dev[]> {
  const where = w.scope === 'estate' ? '' : w.scope === 'customer' ? 'AND ad.customer_id = $1'
    : 'AND ad.id IN (SELECT device_id FROM watchdog_targets WHERE watchdog_id = $1)';
  const params = w.scope === 'estate' ? [] : [w.scope === 'customer' ? w.customerId : w.id];
  const r = await pool.query(
    `SELECT ad.id, ad.hostname, ad.customer_id, c.name AS customer_name, ad.disk_info, ad.last_boot_at, ad.os,
            EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at)) AS seen_secs
       FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ad.revoked IS NOT TRUE ${where}`, params);
  return r.rows.map((x: any) => ({
    id: x.id, hostname: x.hostname || `#${x.id}`, customerId: x.customer_id, customerName: x.customer_name,
    lastSeenSecs: x.seen_secs == null ? null : Number(x.seen_secs), diskInfo: parseJson(x.disk_info), lastBootAt: x.last_boot_at, os: x.os,
  }));
}
function parseJson(v: any): any { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(String(v)); } catch { return null; } }

const ONLINE_SECS = 10 * 60;   // "checking in" for probe purposes — the heartbeat is a few minutes

// ── Evaluation ──────────────────────────────────────────────────────────────────

interface Verdict { status: 'ok' | 'failing' | 'unknown'; detail: string; failed?: string[] }

function evalHeartbeat(w: WatchdogRow, d: Dev, prev: any): Verdict {
  const p = w.params || {};
  if (w.kind === 'offline') {
    if (d.lastSeenSecs == null) return { status: 'failing', detail: `${d.hostname} has never checked in.` };
    const mins = Math.floor(d.lastSeenSecs / 60);
    if (mins > p.minutes) return { status: 'failing', detail: `${d.hostname} last checked in ${describeMinutes(mins)} ago (limit ${describeMinutes(p.minutes)}).` };
    return { status: 'ok', detail: `Checked in ${describeMinutes(mins)} ago.` };
  }
  if (w.kind === 'uptime') {
    if (!d.lastBootAt) return { status: 'unknown', detail: 'The agent has not reported a boot time yet.' };
    const days = Math.floor((Date.now() - new Date(d.lastBootAt).getTime()) / 86400000);
    if (days > p.days) return { status: 'failing', detail: `${d.hostname} last restarted ${days} days ago (limit ${p.days}).` };
    return { status: 'ok', detail: `Last restart ${days} day${days === 1 ? '' : 's'} ago.` };
  }
  if (w.kind === 'disk') {
    const disks: any[] = Array.isArray(d.diskInfo) ? d.diskInfo : [];
    if (!disks.length) return { status: 'unknown', detail: 'No disk figures from the agent yet.' };
    const want = disks.filter((x) => p.drive === 'any' || String(x.drive || '').toUpperCase().startsWith(p.drive));
    if (!want.length) return { status: 'unknown', detail: `No drive ${p.drive} reported.` };
    const wasFailing = prev?.status === 'failing';
    const bad: string[] = []; const fine: string[] = [];
    for (const x of want) {
      const total = Number(x.total_gb) || 0, free = Number(x.free_gb) || 0;
      const pct = total > 0 ? (free / total) * 100 : 100;
      // Hysteresis: raise under the line, clear only 5 points (or 2 GB) back above it.
      const pctLine = p.minFreePct ? (wasFailing ? p.minFreePct + 5 : p.minFreePct) : null;
      const gbLine = p.minFreeGb ? (wasFailing ? p.minFreeGb + 2 : p.minFreeGb) : null;
      const under = (pctLine != null && pct < pctLine) || (gbLine != null && free < gbLine);
      const words = `${x.drive} ${free.toFixed(1)} GB free of ${total.toFixed(0)} (${pct.toFixed(0)}%)`;
      (under ? bad : fine).push(words);
    }
    if (bad.length) return { status: 'failing', detail: `${d.hostname}: ${bad.join('; ')}.` };
    return { status: 'ok', detail: fine.join('; ') + '.' };
  }
  return { status: 'unknown', detail: 'Not a heartbeat check.' };
}

function describeMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  if (m < 60 * 48) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

/** The PowerShell a probe runs. Output is JSON the sweep can read without guessing. */
function probeScript(w: WatchdogRow): string {
  const p = w.params || {};
  const q = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";
  if (w.kind === 'service') {
    const names = (p.services as string[]).map(q).join(',');
    return [
      `$names = @(${names})`,
      `$out = foreach ($n in $names) { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; if ($s) { [pscustomobject]@{ name=$s.Name; display=$s.DisplayName; status=[string]$s.Status; start=[string]$s.StartType } } else { [pscustomobject]@{ name=$n; display=$null; status='NotInstalled'; start=$null } } }`,
      `@($out) | ConvertTo-Json -Compress`,
    ].join('\r\n');
  }
  if (w.kind === 'process') {
    return [
      `$p = @(Get-Process -Name ${q(p.process)} -ErrorAction SilentlyContinue)`,
      `[pscustomobject]@{ process=${q(p.process)}; count=$p.Count; users=@($p | ForEach-Object { try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").GetOwner().User } catch { $null } } | Where-Object { $_ } | Select-Object -Unique) } | ConvertTo-Json -Compress`,
    ].join('\r\n');
  }
  return '"unsupported"';
}

function evalProbe(w: WatchdogRow, d: Dev, output: string): Verdict {
  const t = String(output || '').trim();
  const from = Math.min(...[t.indexOf('['), t.indexOf('{')].filter((n) => n >= 0));
  if (!Number.isFinite(from)) return { status: 'unknown', detail: `The probe returned nothing readable: ${t.slice(0, 160) || '(empty)'}` };
  let j: any; try { j = JSON.parse(t.slice(from, Math.max(t.lastIndexOf(']'), t.lastIndexOf('}')) + 1)); } catch { return { status: 'unknown', detail: `The probe answer was not JSON: ${t.slice(0, 160)}` }; }
  if (w.kind === 'service') {
    const rows: any[] = Array.isArray(j) ? j : [j];
    const down = rows.filter((r) => String(r.status) !== 'Running');
    if (!down.length) return { status: 'ok', detail: rows.map((r) => `${r.display || r.name} running`).join('; ') + '.' };
    const words = down.map((r) => `${r.display || r.name} ${r.status === 'NotInstalled' ? 'is not installed' : String(r.status).toLowerCase()}`);
    return { status: 'failing', detail: `${d.hostname}: ${words.join('; ')}.`, failed: down.filter((r) => r.status !== 'NotInstalled').map((r) => String(r.name)) };
  }
  if (w.kind === 'process') {
    const n = Number(j.count) || 0;
    const expectRunning = (w.params?.expect || 'running') === 'running';
    if (expectRunning) return n > 0 ? { status: 'ok', detail: `${w.params.process} is running (${n}).` } : { status: 'failing', detail: `${d.hostname}: ${w.params.process} is not running.` };
    return n === 0 ? { status: 'ok', detail: `${w.params.process} is not running.` } : { status: 'failing', detail: `${d.hostname}: ${w.params.process} is running (${n}${Array.isArray(j.users) && j.users.length ? ', ' + j.users.join(', ') : ''}).` };
  }
  return { status: 'unknown', detail: 'Unsupported probe.' };
}

// ── The sweep ───────────────────────────────────────────────────────────────────

let sweeping = false;
export async function sweepWatchdogs(): Promise<void> {
  if (sweeping) return;   // a slow cycle must not stack on itself
  sweeping = true;
  try {
    const dogs = (await pool.query(`${SEL} AND enabled=true`)).rows.map(MAP);
    for (const w of dogs) {
      try { await sweepOne(w); } catch (e: any) { console.error(`[watchdog] ${w.id} ${w.name}:`, e.message); }
    }
  } finally { sweeping = false; }
}

async function sweepOne(w: WatchdogRow): Promise<void> {
  const devs = await targetsOf(w);
  const states = new Map<number, any>();
  (await pool.query('SELECT * FROM watchdog_states WHERE watchdog_id=$1', [w.id])).rows.forEach((s: any) => states.set(s.device_id, s));
  const probe = KINDS.find((k) => k.key === w.kind)?.probe;

  for (const d of devs) {
    const prev = states.get(d.id) || null;
    if (!probe) {
      const v = evalHeartbeat(w, d, prev);
      await settle(w, d, prev, v, null);
      continue;
    }
    // Probe kinds. A machine that is not checking in is UNKNOWN, and stays that way.
    const online = d.lastSeenSecs != null && d.lastSeenSecs < ONLINE_SECS;
    if (prev?.probe_command_id) {
      const cmd = (await pool.query('SELECT id, status, output, exit_code, created_at FROM agent_commands WHERE id=$1', [prev.probe_command_id])).rows[0];
      if (!cmd) { await clearProbe(w.id, d.id); continue; }
      if (cmd.status === 'done' || cmd.status === 'failed' || cmd.status === 'expired') {
        const v = cmd.status === 'done' ? evalProbe(w, d, cmd.output) : { status: 'unknown' as const, detail: `The probe ${cmd.status}: ${String(cmd.output || '').slice(0, 160)}` };
        await settle(w, d, prev, v, cmd.id);
        continue;
      }
      // Still out there. Give up on it after twice the interval so a dead command cannot
      // block the next one for ever.
      const age = (Date.now() - new Date(prev.probe_queued_at || cmd.created_at).getTime()) / 60000;
      if (age > w.intervalMinutes * 2) {
        await event(w.id, d.id, 'probe_error', `Probe #${cmd.id} never answered in ${Math.round(age)} min — forgotten.`, cmd.id);
        await clearProbe(w.id, d.id);
      }
      continue;
    }
    if (!online) {
      if (!prev || prev.status !== 'unknown') await settle(w, d, prev, { status: 'unknown', detail: `${d.hostname} is not checking in — nothing to probe.` }, null);
      continue;
    }
    const due = !prev?.last_checked_at || (Date.now() - new Date(prev.last_checked_at).getTime()) / 60000 >= w.intervalMinutes;
    if (!due) continue;
    const ins = await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, requested_by) VALUES ($1,'shell.powershell',$2,NULL) RETURNING id`,
      [d.id, JSON.stringify({ script: probeScript(w), run_as: 'system', watchdog_id: w.id, watchdog_probe: true })]);
    await pool.query(
      `INSERT INTO watchdog_states (watchdog_id, device_id, probe_command_id, probe_queued_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (watchdog_id, device_id) DO UPDATE SET probe_command_id=EXCLUDED.probe_command_id, probe_queued_at=NOW(), updated_at=NOW()`,
      [w.id, d.id, ins.rows[0].id]);
    wakeAgent(d.id);
  }

  // Machines that left the target set: close what they had open and forget them.
  const keep = new Set(devs.map((d) => d.id));
  for (const [devId, s] of states) {
    if (keep.has(devId)) continue;
    if (s.status === 'failing') await resolveAlert('watchdog', `wd:${w.id}:${devId}`).catch(() => {});
    await pool.query('DELETE FROM watchdog_states WHERE watchdog_id=$1 AND device_id=$2', [w.id, devId]);
  }
}

async function clearProbe(watchdogId: number, deviceId: number): Promise<void> {
  await pool.query(`UPDATE watchdog_states SET probe_command_id=NULL, probe_queued_at=NULL, last_checked_at=NOW(), updated_at=NOW() WHERE watchdog_id=$1 AND device_id=$2`, [watchdogId, deviceId]);
}

/** Record a verdict and act on any change of state. */
async function settle(w: WatchdogRow, d: Dev, prev: any, v: Verdict, commandId: number | null): Promise<void> {
  const was = prev?.status || 'unknown';
  await pool.query(
    `INSERT INTO watchdog_states (watchdog_id, device_id, status, detail, last_checked_at, probe_command_id, probe_queued_at, failing_since)
     VALUES ($1,$2,$3,$4,NOW(),NULL,NULL, CASE WHEN $3='failing' THEN NOW() ELSE NULL END)
     ON CONFLICT (watchdog_id, device_id) DO UPDATE SET
       status=EXCLUDED.status, detail=EXCLUDED.detail, last_checked_at=NOW(), probe_command_id=NULL, probe_queued_at=NULL,
       failing_since = CASE WHEN EXCLUDED.status='failing' THEN COALESCE(watchdog_states.failing_since, NOW()) ELSE NULL END,
       updated_at=NOW()`,
    [w.id, d.id, v.status, v.detail.slice(0, 1000)]);

  if (v.status === 'failing' && was !== 'failing') {
    // New failure: on the board, in the story, and heal straight away.
    const a = await raiseAlert({
      source: 'watchdog', externalId: `wd:${w.id}:${d.id}`, severity: w.severity,
      title: `${w.name} — ${d.hostname}${d.customerName ? ' (' + d.customerName + ')' : ''}`,
      body: v.detail, url: `/automation/watchdogs/${w.id}`, autoTicket: false,
      raw: { watchdogId: w.id, deviceId: d.id, kind: w.kind },
    });
    await pool.query('UPDATE watchdog_states SET alert_id=$3, escalated_at=NULL WHERE watchdog_id=$1 AND device_id=$2', [w.id, d.id, a.id]);
    await event(w.id, d.id, 'failed', v.detail, commandId);
    await heal(w, d, v, 'first failure');
    return;
  }
  if (v.status === 'failing' && was === 'failing') {
    await heal(w, d, v, 'still failing');
    return;
  }
  if (v.status === 'ok' && was === 'failing') {
    await resolveAlert('watchdog', `wd:${w.id}:${d.id}`).catch(() => {});
    await pool.query('UPDATE watchdog_states SET alert_id=NULL, escalated_at=NULL, updated_at=NOW() WHERE watchdog_id=$1 AND device_id=$2', [w.id, d.id]);
    await event(w.id, d.id, 'recovered', v.detail, commandId);
    return;
  }
  if (v.status === 'unknown' && was === 'failing') {
    // Lost sight of a failing machine. The alert stays up — silence is not recovery.
    await event(w.id, d.id, 'probe_error', v.detail, commandId);
    await pool.query(`UPDATE watchdog_states SET status='failing', detail=$3 WHERE watchdog_id=$1 AND device_id=$2`, [w.id, d.id, (prev?.detail || v.detail).slice(0, 1000)]);
  }
}

// ── Self-heal ───────────────────────────────────────────────────────────────────

function todayKey(): string { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }

async function heal(w: WatchdogRow, d: Dev, v: Verdict, why: string): Promise<void> {
  if (!w.heal.length) return;
  const s = (await pool.query('SELECT * FROM watchdog_states WHERE watchdog_id=$1 AND device_id=$2', [w.id, d.id])).rows[0];
  if (!s) return;
  const day = todayKey();
  const count = s.heal_day === day ? Number(s.heal_count) : 0;
  const sinceLast = s.last_heal_at ? (Date.now() - new Date(s.last_heal_at).getTime()) / 60000 : Infinity;
  if (why !== 'first failure' && sinceLast < w.healCooldownMinutes) return;
  if (count >= w.healMaxPerDay) {
    if (!s.escalated_at) await escalate(w, d, v, count);
    return;
  }
  await pool.query(`UPDATE watchdog_states SET heal_count=$3, heal_day=$4, last_heal_at=NOW(), updated_at=NOW() WHERE watchdog_id=$1 AND device_id=$2`,
    [w.id, d.id, count + 1, day]);
  const done: string[] = [];
  for (const h of w.heal) {
    try { done.push(await runHeal(w, d, v, h)); } catch (e: any) { done.push(`${h.type}: could not — ${e.message}`); }
  }
  await event(w.id, d.id, 'heal', `Self-heal ${count + 1} of ${w.healMaxPerDay} (${why}): ${done.join(' · ')}`);
}

async function runHeal(w: WatchdogRow, d: Dev, v: Verdict, h: any): Promise<string> {
  const queue = async (kind: string, payload: any, label: string): Promise<string> => {
    const ins = await pool.query(`INSERT INTO agent_commands (device_id, kind, payload, requested_by) VALUES ($1,$2,$3,NULL) RETURNING id`,
      [d.id, kind, JSON.stringify(Object.assign({ watchdog_id: w.id, watchdog_heal: true }, payload))]);
    wakeAgent(d.id);
    return `${label} (command #${ins.rows[0].id})`;
  };
  switch (String(h.type)) {
    case 'service_start': {
      // Start only what the probe found down — the rest is running and must be left alone.
      // (A person pressing "Heal now" has no fresh probe, so everything named gets a start.)
      const names = v.failed && v.failed.length ? v.failed : (w.params.services as string[]);
      const out: string[] = [];
      for (const n of names) out.push(await queue('services.start', { name: n }, `start ${n}`));
      return out.join(', ');
    }
    case 'script': {
      const s = await getScript(Number(h.scriptId));
      if (!s) return 'script: no longer exists';
      if (String(s.body).length > 8000) return `script "${s.name}": over the agent's 8,000-character limit`;
      const kind = s.fileType === 'bat' || s.fileType === 'cmd' ? 'shell.cmd' : 'shell.powershell';
      return await queue(kind, { script: s.body, run_as: s.runAs === 'current_user' ? 'user' : 'system', script_id: s.id, script_name: s.name }, `ran "${s.name}"`);
    }
    case 'command':
      return await queue('shell.powershell', { script: String(h.script), run_as: 'system' }, 'ran the command');
    case 'restart':
      return await queue('power.restart', { delay_seconds: String(h.delaySeconds ?? 60), requested_by: 'Watchdog' }, 'restart queued');
    case 'case': {
      const s = (await pool.query('SELECT alert_id FROM watchdog_states WHERE watchdog_id=$1 AND device_id=$2', [w.id, d.id])).rows[0];
      const tid = s?.alert_id ? await createTicketForAlert(Number(s.alert_id)) : null;
      return tid ? `case raised (#${tid})` : 'case: could not be raised';
    }
    case 'notify':
      await notifyStaff(`Watchdog: ${w.name} — ${d.hostname}`, { body: v.detail, link: `/automation/watchdogs/${w.id}`, type: w.severity === 'critical' ? 'warning' : 'info' });
      return 'team told';
    default:
      return `${h.type}: not a heal the sweep knows`;
  }
}

async function escalate(w: WatchdogRow, d: Dev, v: Verdict, count: number): Promise<void> {
  await pool.query('UPDATE watchdog_states SET escalated_at=NOW(), updated_at=NOW() WHERE watchdog_id=$1 AND device_id=$2', [w.id, d.id]);
  const parts: string[] = [`Self-heal cap reached (${count} today) — stopped trying.`];
  if (w.escalateCase) {
    const s = (await pool.query('SELECT alert_id FROM watchdog_states WHERE watchdog_id=$1 AND device_id=$2', [w.id, d.id])).rows[0];
    const tid = s?.alert_id ? await createTicketForAlert(Number(s.alert_id)) : null;
    parts.push(tid ? `Case #${tid} raised.` : 'A case could not be raised.');
  }
  await notifyStaff(`Watchdog needs a person: ${w.name} — ${d.hostname}`, { body: `${v.detail} ${parts.join(' ')}`, link: `/automation/watchdogs/${w.id}`, type: 'warning' });
  await event(w.id, d.id, 'escalated', parts.join(' '));
}

/** "Check now" — forget the last check so the next sweep probes / re-reads straight away. */
export async function checkNow(id: number): Promise<void> {
  await pool.query(`UPDATE watchdog_states SET last_checked_at=NULL, probe_command_id=NULL, probe_queued_at=NULL, updated_at=NOW() WHERE watchdog_id=$1`, [id]);
  await event(id, null, 'note', 'Check now requested.');
  setTimeout(() => { sweepWatchdogs().catch(() => {}); }, 100);
}

/** "Heal now" — run the actions on one machine regardless of cap or cool-down. A person asked. */
export async function healNow(id: number, deviceId: number, userName: string): Promise<string> {
  const w = await getWatchdog(id);
  if (!w) return 'That watchdog is gone.';
  const d = (await targetsOf(w)).find((x) => x.id === deviceId);
  if (!d) return 'That machine is not in this watchdog.';
  const s = (await pool.query('SELECT * FROM watchdog_states WHERE watchdog_id=$1 AND device_id=$2', [id, deviceId])).rows[0];
  const v: Verdict = { status: (s?.status || 'unknown'), detail: s?.detail || '' };
  const done: string[] = [];
  for (const h of w.heal) { try { done.push(await runHeal(w, d, v, h)); } catch (e: any) { done.push(`${h.type}: ${e.message}`); } }
  await event(id, deviceId, 'heal', `Heal run by ${userName}: ${done.join(' · ') || 'nothing configured'}`);
  return done.join(' · ') || 'This watchdog has no self-heal actions.';
}

export async function watchdogDetail(id: number): Promise<{ states: any[]; events: any[] } | null> {
  const w = await getWatchdog(id);
  if (!w) return null;
  const states = (await pool.query(
    `SELECT s.*, ad.hostname, c.name AS customer_name, ast.id AS asset_id,
            EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at)) AS seen_secs
       FROM watchdog_states s
       JOIN agent_devices ad ON ad.id = s.device_id
       LEFT JOIN customers c ON c.id = ad.customer_id
       LEFT JOIN LATERAL (SELECT ca.id FROM customer_assets ca WHERE ca.agent_device_id = s.device_id AND ca.merged_into_id IS NULL AND ca.archived_at IS NULL ORDER BY ca.id LIMIT 1) ast ON true
      WHERE s.watchdog_id=$1
      ORDER BY (s.status='failing') DESC, (s.status='unknown') DESC, c.name NULLS LAST, ad.hostname`, [id])).rows;
  const events = (await pool.query(
    `SELECT e.*, ad.hostname FROM watchdog_events e LEFT JOIN agent_devices ad ON ad.id = e.device_id
      WHERE e.watchdog_id=$1 ORDER BY e.created_at DESC LIMIT 200`, [id])).rows;
  return { states, events };
}

export async function watchdogSummary(): Promise<{ watchdogs: number; failing: number; unknown: number }> {
  const r = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM watchdogs WHERE deleted_at IS NULL AND enabled) AS watchdogs,
            (SELECT COUNT(*)::int FROM watchdog_states s JOIN watchdogs w ON w.id=s.watchdog_id AND w.enabled AND w.deleted_at IS NULL WHERE s.status='failing') AS failing,
            (SELECT COUNT(*)::int FROM watchdog_states s JOIN watchdogs w ON w.id=s.watchdog_id AND w.enabled AND w.deleted_at IS NULL WHERE s.status='unknown') AS unknown`)).rows[0];
  return r;
}

export function startWatchdogSweep(): void {
  cron.schedule('* * * * *', () => { sweepWatchdogs().catch((e) => console.error('[watchdog] sweep failed:', e.message)); });
}
