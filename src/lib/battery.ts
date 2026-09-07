import { pool } from '../db/pool';

// ── Battery health ──────────────────────────────────────────────────────────────
// Rides on shell.powershell like the BitLocker scan, so it ships without an agent rollout.
// Once a day, on every LAPTOP that checks in, a small read of Windows' own battery classes
// (root\wmi BatteryStaticData / BatteryFullChargedCapacity / BatteryCycleCount / BatteryStatus,
// plus Win32_Battery for the charge %) comes back as JSON carrying a marker; the result
// handler stores it as a reading. Readings are append-only — health is a slope, not a
// number: a battery at 78% that was 92% in June is the story worth telling.
//
// Health = full-charge capacity ÷ design capacity. Under 80% the battery is tired, under
// 60% it is due — those are the two lines the Hardware tab colours by.

export const BATTERY_MARKER = '"lumen_battery":1';
const REFRESH_HOURS = 24;
const ATTEMPT_GUARD_MINUTES = 30;   // a finished-but-unstorable probe must not be re-asked every heartbeat

export const BATTERY_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$r = [ordered]@{ lumen_battery = 1; present = $false; batteries = @() }',
  '$static = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData)',
  '$full   = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity)',
  '$cyc    = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryCycleCount)',
  '$stat   = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus)',
  '$w      = @(Get-CimInstance -ClassName Win32_Battery)',
  'for ($i = 0; $i -lt $static.Count; $i++) {',
  '  $s = $static[$i]; $key = $s.InstanceName',
  '  $f = $full | Where-Object { $_.InstanceName -eq $key } | Select-Object -First 1',
  '  $c = $cyc  | Where-Object { $_.InstanceName -eq $key } | Select-Object -First 1',
  '  $b = $stat | Where-Object { $_.InstanceName -eq $key } | Select-Object -First 1',
  '  $r.batteries += [ordered]@{ name = ($s.DeviceName, $s.InstanceName | Where-Object { $_ } | Select-Object -First 1); design_mwh = [int64]$s.DesignedCapacity; full_mwh = [int64]$f.FullChargedCapacity; cycles = [int]$c.CycleCount; charging = [bool]$b.Charging; discharging = [bool]$b.Discharging; ac = [bool]$b.PowerOnline; remaining_mwh = [int64]$b.RemainingCapacity }',
  '}',
  '$r.present = ($static.Count -gt 0) -or ($w.Count -gt 0)',
  'if ($w.Count) { $r.charge_pct = [int]$w[0].EstimatedChargeRemaining; $r.win32_status = [int]$w[0].BatteryStatus; $r.win32_name = [string]$w[0].Name }',
  '$r | ConvertTo-Json -Compress -Depth 4',
].join('\r\n');

export function looksLikeBatteryProbe(output: string | null | undefined): boolean {
  return !!output && output.indexOf(BATTERY_MARKER) >= 0;
}

export interface BatteryReading {
  collectedAt: Date; present: boolean; batteries: number;
  designMwh: number | null; fullMwh: number | null; healthPct: number | null; cycleCount: number | null;
  chargePct: number | null; status: string | null; name: string | null;
}

/** Turn the probe's JSON into one reading, summing packs where a machine has two. */
export function parseBatteryOutput(output: string): Omit<BatteryReading, 'collectedAt'> | null {
  const t = String(output || '');
  const from = t.indexOf('{'); const to = t.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  let j: any; try { j = JSON.parse(t.slice(from, to + 1)); } catch { return null; }
  if (!j || j.lumen_battery !== 1) return null;
  const packs: any[] = Array.isArray(j.batteries) ? j.batteries : (j.batteries ? [j.batteries] : []);
  const present = !!j.present && (packs.length > 0 || j.charge_pct != null);
  if (!present) return { present: false, batteries: 0, designMwh: null, fullMwh: null, healthPct: null, cycleCount: null, chargePct: null, status: null, name: null };
  let design = 0, full = 0, cycles = 0, anyCap = false, charging = false, discharging = false, ac = false;
  for (const p of packs) {
    const d = Number(p.design_mwh) || 0, f = Number(p.full_mwh) || 0;
    if (d > 0 && f > 0) { design += d; full += f; anyCap = true; }
    cycles = Math.max(cycles, Number(p.cycles) || 0);
    charging = charging || !!p.charging; discharging = discharging || !!p.discharging; ac = ac || !!p.ac;
  }
  // Some firmware reports a full-charge figure above design after a calibration; 100% is the ceiling.
  const health = anyCap ? Math.min(100, Math.round((full / design) * 1000) / 10) : null;
  const status = charging ? 'charging' : (ac ? 'on mains' : (discharging ? 'on battery' : null));
  return {
    present: true, batteries: packs.length, designMwh: anyCap ? design : null, fullMwh: anyCap ? full : null,
    healthPct: health, cycleCount: cycles || null,
    chargePct: j.charge_pct == null ? null : Math.max(0, Math.min(100, Number(j.charge_pct))),
    status, name: packs[0]?.name || j.win32_name || null,
  };
}

export async function ingestBatteryProbe(deviceId: number, output: string): Promise<string> {
  const r = parseBatteryOutput(output);
  if (!r) throw new Error('battery probe output was not readable');
  await pool.query(
    `INSERT INTO device_battery_readings (device_id, present, batteries, design_mwh, full_mwh, health_pct, cycle_count, charge_pct, status, name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [deviceId, r.present, r.batteries, r.designMwh, r.fullMwh, r.healthPct, r.cycleCount, r.chargePct, r.status, r.name ? String(r.name).slice(0, 120) : null]);
  if (!r.present) return 'Battery probe stored — no battery in this machine.';
  return `Battery probe stored — health ${r.healthPct == null ? 'unknown' : r.healthPct + '%'}, ${r.cycleCount ?? '?'} cycles, ${r.chargePct ?? '?'}% charged.`;
}

const DUE_SQL = `
  SELECT (
    (SELECT MAX(collected_at) FROM device_battery_readings WHERE device_id = $1) IS NULL
    OR (SELECT MAX(collected_at) FROM device_battery_readings WHERE device_id = $1) < NOW() - ($2 || ' hours')::interval
  ) AND NOT EXISTS (
    SELECT 1 FROM agent_commands
     WHERE device_id = $1 AND kind = 'shell.powershell'
       AND (status IN ('queued','running') OR requested_at > NOW() - ($3 || ' minutes')::interval)
       AND (payload::text LIKE '%lumen_battery%' OR payload::text LIKE '%battery_probe%')
  ) AS due`;

/**
 * Called on every heartbeat. Laptops only — a desktop has no battery and asking it every
 * day would be 100 pointless commands. Two cheap reads in the common case, nothing queued.
 */
export async function maybeQueueBatteryProbe(deviceId: number, deviceType: string | null | undefined): Promise<boolean> {
  if (!/laptop|notebook|tablet|portable/i.test(String(deviceType || ''))) return false;
  const due = (await pool.query(DUE_SQL, [deviceId, REFRESH_HOURS, ATTEMPT_GUARD_MINUTES])).rows[0];
  if (!due || !due.due) return false;
  await queueBatteryProbe(deviceId);
  return true;
}

export async function queueBatteryProbe(deviceId: number, requestedBy: number | null = null): Promise<number> {
  const r = await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by) VALUES ($1,'shell.powershell',$2,'queued',$3) RETURNING id`,
    [deviceId, JSON.stringify({ script: BATTERY_SCRIPT, run_as: 'system', battery_probe: true }), requestedBy]);
  return r.rows[0].id;
}

/** The latest reading plus the one from ~30 days earlier, so the page can say which way it is going. */
export async function batteryForDevice(deviceId: number): Promise<{ latest: any | null; earlier: any | null; readings: number } | null> {
  const latest = (await pool.query(
    `SELECT * FROM device_battery_readings WHERE device_id=$1 ORDER BY collected_at DESC LIMIT 1`, [deviceId])).rows[0] || null;
  if (!latest) return null;
  const earlier = (await pool.query(
    `SELECT * FROM device_battery_readings WHERE device_id=$1 AND health_pct IS NOT NULL AND collected_at < NOW() - INTERVAL '25 days'
      ORDER BY collected_at DESC LIMIT 1`, [deviceId])).rows[0] || null;
  const n = (await pool.query('SELECT COUNT(*)::int n FROM device_battery_readings WHERE device_id=$1', [deviceId])).rows[0].n;
  return { latest, earlier, readings: n };
}

/** Same rule as pruneBitlockerCommands: only rows this feature made, only once they are worthless. */
export async function pruneBatteryCommands(): Promise<number> {
  const r = await pool.query(
    `DELETE FROM agent_commands
      WHERE kind='shell.powershell' AND output LIKE 'Battery probe stored%' AND finished_at < NOW() - INTERVAL '7 days'`);
  return r.rowCount || 0;
}
