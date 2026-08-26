import { pool } from '../db/pool';
import { rpc } from './gravityzone';
import { logActivity } from './activity';

// ── On-demand Bitdefender scans ───────────────────────────────────────────────────
// "Scan now" on a device, and the history of what that produced.
//
// GravityZone's Network API does not hand back a task id from createScanTask — it
// answers true — so the only durable handle on a task is its NAME. Every scan is given
// a unique one, stored before the call, and the poller matches tasks back by it. Get
// that wrong and a scan history quietly attaches results to the wrong machine.
//
// Findings are not read from the task: detections already arrive through the normal
// GravityZone sync into security_detections. The task tells you the scan RAN; the
// detections tell you what it FOUND, and joining them by time window is honest about
// which is which.

export type ScanType = 'quick' | 'full';

/** GravityZone's numeric scan types. */
const GZ_SCAN_TYPE: Record<ScanType, number> = { quick: 1, full: 2 };

/** 1 pending · 2 in progress · 3 finished — GravityZone's own vocabulary. */
export function scanStatusLabel(code: number | null | undefined): string {
  if (code === 1) return 'Pending';
  if (code === 2) return 'Running';
  if (code === 3) return 'Finished';
  return 'Unknown';
}

export interface ScanRow {
  id: number;
  scan_type: string;
  task_name: string;
  status_code: number | null;
  status_label: string;
  requested_at: string;
  finished_at: string | null;
  detail: string | null;
  requested_by_name: string | null;
  found: number;
}

// Detections are counted in the window the scan covered, and only real ones: our own
// MeshAgent trips Hyper Detect, and a history that called that a find would cry wolf on
// every machine we manage.
const SCANS_SQL = `
  SELECT t.id, t.scan_type, t.task_name, t.status_code, t.detail,
         to_char(t.requested_at, 'YYYY-MM-DD HH24:MI') AS requested_at,
         to_char(t.finished_at,  'YYYY-MM-DD HH24:MI') AS finished_at,
         u.name AS requested_by_name,
         (SELECT COUNT(*) FROM security_detections d
           WHERE d.endpoint_gz_id = t.endpoint_gz_id
             AND d.own_tool = false
             AND d.detected_at >= t.requested_at
             AND d.detected_at <= COALESCE(t.finished_at, NOW())) AS found
    FROM security_scan_tasks t
    LEFT JOIN users u ON u.id = t.requested_by
   WHERE t.asset_id = $1
   ORDER BY t.requested_at DESC
   LIMIT $2`;

/** The GravityZone endpoint behind one of our assets, or null when BD has never seen it. */
async function endpointFor(assetId: number): Promise<{ gzId: string; name: string } | null> {
  const r = (await pool.query(
    'SELECT gz_id, name FROM security_endpoints WHERE asset_id=$1 ORDER BY synced_at DESC LIMIT 1',
    [assetId])).rows[0];
  return r ? { gzId: String(r.gz_id), name: String(r.name || '') } : null;
}

/** Unique, and readable in GravityZone's own task list — whoever finds it there should be
 *  able to tell at a glance that the Portal asked for it and for which machine. */
function taskNameFor(host: string, assetId: number): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `Lumen ${host || 'device'} ${assetId} ${stamp}`.slice(0, 100);
}

/**
 * Ask GravityZone to scan one machine now.
 *
 * The row is written BEFORE the API call and marked failed if the call throws, so a scan
 * that GravityZone accepted can never be missing from the history — the failure mode that
 * matters is a scan running with nothing on screen to say so.
 */
export async function startScan(assetId: number, type: ScanType, userId: number | null): Promise<{ ok: boolean; error?: string }> {
  const ep = await endpointFor(assetId);
  if (!ep) return { ok: false, error: 'GravityZone has never seen this machine, so there is nothing to scan. Deploy Bitdefender first.' };
  const host = (await pool.query('SELECT hostname FROM customer_assets WHERE id=$1', [assetId])).rows[0]?.hostname || ep.name;
  const name = taskNameFor(host, assetId);

  const ins = await pool.query(
    `INSERT INTO security_scan_tasks (asset_id, endpoint_gz_id, task_name, scan_type, status_code, requested_by)
     VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
    [assetId, ep.gzId, name, type, userId]);
  const rowId = Number(ins.rows[0].id);

  try {
    await rpc('network', 'createScanTask', { targetIds: [ep.gzId], type: GZ_SCAN_TYPE[type], name });
  } catch (e: any) {
    await pool.query(
      'UPDATE security_scan_tasks SET status_code=NULL, detail=$1, finished_at=NOW() WHERE id=$2',
      [String(e.message || 'GravityZone refused the scan').slice(0, 500), rowId]);
    return { ok: false, error: e.message || 'GravityZone refused the scan.' };
  }
  await logActivity(userId, 'bd_scan', 'customer_assets', assetId, `Started a ${type} Bitdefender scan on ${host}`);
  return { ok: true };
}

/**
 * Bring open scans up to date. GravityZone is polled once for its task list and the rows
 * are matched back by name — one call however many scans are open, rather than one call
 * per scan, because the API is rate-limited and a busy morning would otherwise hammer it.
 *
 * Only tasks we are still waiting on are touched. A finished scan is history and must not
 * be rewritten by a later page of results.
 */
export async function refreshScanTasks(): Promise<number> {
  const open = (await pool.query(
    `SELECT id, task_name FROM security_scan_tasks
      WHERE finished_at IS NULL AND status_code IS NOT NULL
        AND requested_at > NOW() - INTERVAL '2 days'`)).rows;
  if (!open.length) return 0;

  let tasks: any[] = [];
  try {
    const r: any = await rpc('network', 'getScanTasksList', { page: 1, perPage: 100 });
    tasks = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
  } catch {
    return 0;   // GravityZone unreachable is not a reason to mark anybody's scan failed
  }
  const byName = new Map<string, any>();
  for (const t of tasks) if (t && t.name) byName.set(String(t.name), t);

  let updated = 0;
  for (const row of open) {
    const t = byName.get(String(row.task_name));
    // A task that has fallen off GravityZone's list after two days is finished as far as
    // anyone here is concerned; the two-day filter above lets it age out on its own
    // rather than being guessed at now.
    if (!t) continue;
    const code = Number(t.status) || null;
    await pool.query(
      `UPDATE security_scan_tasks
          SET status_code=$1, last_checked_at=NOW(),
              started_at = COALESCE(started_at, CASE WHEN $1 >= 2 THEN NOW() END),
              finished_at = CASE WHEN $1 = 3 THEN NOW() ELSE finished_at END
        WHERE id=$2`, [code, row.id]);
    updated++;
  }
  return updated;
}

/**
 * Scan history for one device, newest first, with how many detections GravityZone
 * recorded on that endpoint between the scan starting and finishing.
 *
 * `found` counts real detections only — our own MeshAgent trips Hyper Detect as
 * Gen:Illusion.PUP.MeshCentral, and a scan history that reported that as a find would
 * cry wolf on every machine we manage.
 */
export async function scansFor(assetId: number, limit = 10): Promise<ScanRow[]> {
  const r = await pool.query(SCANS_SQL, [assetId, limit]);
  return r.rows.map((row: any) => ({
    ...row,
    status_label: row.status_code == null ? 'Failed' : scanStatusLabel(row.status_code),
    found: Number(row.found || 0),
  })) as ScanRow[];
}

/** Is a scan already in flight for this device? Two scans at once achieve nothing but a
 *  slower machine and a confusing history. */
export async function scanInFlight(assetId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM security_scan_tasks
      WHERE asset_id=$1 AND finished_at IS NULL AND status_code IS NOT NULL
        AND requested_at > NOW() - INTERVAL '6 hours' LIMIT 1`, [assetId]);
  return r.rows.length > 0;
}

/** Poll GravityZone for the scans we are waiting on. Five minutes, not two: a scan takes
 *  minutes to hours, and the task-list endpoint is rate-limited — polling it harder would
 *  buy nothing and risk the rest of the integration. Nothing runs at boot, so a deploy
 *  restart does not race the first sync. */
export function startScanPoller(): void {
  const EVERY_MS = 5 * 60 * 1000;
  const tick = async () => {
    try {
      const n = await refreshScanTasks();
      if (n) console.log('[gz] scan poller: %d task(s) updated', n);
    } catch (e: any) { console.error('[gz] scan poller failed:', e.message); }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, EVERY_MS);
}
