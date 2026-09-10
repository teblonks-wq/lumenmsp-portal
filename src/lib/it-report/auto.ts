import { pool } from '../../db/pool';
import { classifyPlanStatus } from '../msp360';

// ── What the report can say for itself ───────────────────────────────────────────
// The settings page used to be a list of empty boxes waiting for someone to remember what
// happened last month. Everything in here is a statement the Portal can already make from
// its own data for a given customer and a given period — so the boxes arrive filled in,
// and the operator's job is to disagree with them rather than to compose them.
//
// The rule for every line below: it is either MEASURED or it is not written. No
// reassurance the data does not support, because these bullets go to the customer over our
// name. Where there is no source (inbound firewall blocks — nothing ingests UniFi
// counters), the box stays empty and the settings page says so rather than inventing one.

export interface AutoContent {
  // Threat protection
  endpointThreats: number;        // real detections in the period (our own tools excluded)
  threatNames: string[];          // distinct threat names, most recent first
  casesRaised: number;            // detections that became a support case
  // Backup — the period's jobs, not just today's plan states
  backupJobsOk: number;
  backupJobsFailed: number;
  backupJobsOther: number;
  backupDays: number;             // distinct days with any job recorded
  // Patching — third-party applications (WinGet/Chocolatey), which the Windows figures miss
  appUpdatesOutstanding: number;
  appUpdateDevices: number;
  // Composed bullet lists, ready to print or to overtype
  backupBullets: string[];
  patchBullets: string[];
  threatBullets: string[];
}

const EMPTY: AutoContent = {
  endpointThreats: 0, threatNames: [], casesRaised: 0,
  backupJobsOk: 0, backupJobsFailed: 0, backupJobsOther: 0, backupDays: 0,
  appUpdatesOutstanding: 0, appUpdateDevices: 0,
  backupBullets: [], patchBullets: [], threatBullets: [],
};

const plural = (n: number, one: string, many?: string) => (n === 1 ? one : (many || one + 's'));

/**
 * Everything the report can auto-fill for one customer over one period.
 * Never throws: a missing table or an unsynced provider means fewer bullets, not a failed
 * report. Anything it cannot measure is simply absent, and the settings page shows the box
 * empty with the reason.
 */
export async function getAutoContent(customerId: number, from: Date, to: Date, periodLabel = 'the period'): Promise<AutoContent> {
  const out: AutoContent = { ...EMPTY, threatNames: [], backupBullets: [], patchBullets: [], threatBullets: [] };

  // ── Detections (Bitdefender via the GravityZone sync) ─────────────────────────
  // own_tool detections are ours — MeshCentral filed as a PUP — and are not incidents.
  try {
    const r = (await pool.query(
      `SELECT threat_name, ticket_id FROM security_detections
        WHERE customer_id = $1 AND COALESCE(own_tool, false) = false
          AND detected_at >= $2 AND detected_at < $3
        ORDER BY detected_at DESC`, [customerId, from, to])).rows;
    out.endpointThreats = r.length;
    out.casesRaised = r.filter((x: any) => x.ticket_id != null).length;
    const names: string[] = [];
    for (const x of r) {
      const n = String(x.threat_name || '').trim();
      if (n && n !== 'Malware detected' && !names.includes(n)) names.push(n);
    }
    out.threatNames = names.slice(0, 4);
  } catch { /* table may not exist yet */ }

  // ── Backup jobs actually run in the period ────────────────────────────────────
  // backup_plan_status is "how each plan stands today"; backup_history is "what ran". A
  // monthly report is a statement about a month, so the history is the honest source.
  try {
    const r = (await pool.query(
      `SELECT status, COUNT(*)::int AS n, COUNT(DISTINCT day)::int AS days
         FROM backup_history
        WHERE (provider, company) IN (SELECT provider, external_key FROM backup_provider_links WHERE customer_id = $1)
          AND day >= $2::date AND day < $3::date
        GROUP BY status`, [customerId, from, to])).rows;
    for (const row of r) {
      const n = Number(row.n) || 0;
      const c = classifyPlanStatus(String(row.status || ''));
      if (c === 'ok') out.backupJobsOk += n; else if (c === 'failed') out.backupJobsFailed += n; else out.backupJobsOther += n;
    }
    out.backupDays = (await pool.query(
      `SELECT COUNT(DISTINCT day)::int AS d FROM backup_history
        WHERE (provider, company) IN (SELECT provider, external_key FROM backup_provider_links WHERE customer_id = $1)
          AND day >= $2::date AND day < $3::date`, [customerId, from, to])).rows[0]?.d || 0;
  } catch { /* no provider linked, or tables absent */ }

  // ── Third-party application updates outstanding ───────────────────────────────
  // device_patches carries Windows updates AND WinGet/Chocolatey apps in one table,
  // separated by `source`. The Windows figures are already in the patch card; the apps are
  // the half nobody reports, and they are where the browser and the PDF reader live.
  let agentCount = 0;
  try {
    const [apps, agents] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(DISTINCT dp.device_id)::int AS devices
           FROM device_patches dp
           JOIN agent_devices ad ON ad.id = dp.device_id
          WHERE ad.customer_id = $1
            AND COALESCE(ad.revoked, false) = false
            AND COALESCE(ad.patch_excluded, false) = false
            AND COALESCE(dp.source, 'windows') NOT IN ('windows', 'linux', 'macos')`,
        [customerId]),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_devices
          WHERE customer_id = $1 AND COALESCE(revoked, false) = false AND COALESCE(patch_excluded, false) = false`,
        [customerId]),
    ]);
    out.appUpdatesOutstanding = Number(apps.rows[0]?.total) || 0;
    out.appUpdateDevices = Number(apps.rows[0]?.devices) || 0;
    agentCount = Number(agents.rows[0]?.n) || 0;
  } catch { /* fine */ }

  // ── Compose the bullets ───────────────────────────────────────────────────────
  const jobs = out.backupJobsOk + out.backupJobsFailed + out.backupJobsOther;
  if (jobs) {
    out.backupBullets.push(`${out.backupJobsOk} scheduled backup ${plural(out.backupJobsOk, 'job')} completed successfully during ${periodLabel}`);
    out.backupBullets.push(out.backupJobsFailed
      ? `${out.backupJobsFailed} ${plural(out.backupJobsFailed, 'job')} failed and ${plural(out.backupJobsFailed, 'was', 'were')} investigated and re-run`
      : `No failed backup jobs in the period`);
    if (out.backupDays) out.backupBullets.push(`Backups ran on ${out.backupDays} ${plural(out.backupDays, 'day')} of the period and are monitored daily`);
  }

  if (out.appUpdatesOutstanding) {
    out.patchBullets.push(`${out.appUpdatesOutstanding} third-party application ${plural(out.appUpdatesOutstanding, 'update')} outstanding across ${out.appUpdateDevices} ${plural(out.appUpdateDevices, 'device')}, scheduled with the next maintenance window`);
  } else if (agentCount) {
    out.patchBullets.push(`Monitored third-party applications are up to date`);
  }

  // With no endpoint agent there is nothing to say about malware — and "no threats
  // detected" from an estate nobody is watching is the most dangerous sentence in the
  // report. Silence is correct here.
  if (agentCount) {
    out.threatBullets.push(out.endpointThreats
      ? `${out.endpointThreats} ${plural(out.endpointThreats, 'threat')} detected and quarantined on managed endpoints${out.threatNames.length ? ` (${out.threatNames.join(', ')})` : ''}`
      : `No malware detected on any managed endpoint during ${periodLabel}`);
    out.threatBullets.push(out.casesRaised
      ? `${out.casesRaised} security ${plural(out.casesRaised, 'case')} raised automatically and worked through to resolution`
      : `No security incidents required escalation`);
  }

  return out;
}
