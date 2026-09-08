import cron from 'node-cron';
import { pool } from '../db/pool';
import { wakeAgent } from '../routes/agent-api';

// ── Nightly Group Policy collection ─────────────────────────────────────────────
// Until this existed, a domain's policies were only as current as the last time somebody
// pressed Refresh — so the estate view was quietly a museum, and "collected: never" was the
// normal state for any customer nobody had looked at recently (Terry, 2026-09-08).
//
// Runs from midnight, STAGGERED across the following hour. Twenty domain controllers all
// enumerating every GPO at 00:00:00 is a self-inflicted load spike on twenty customers'
// most important server, and none of it is urgent — it is a nightly refresh, not an alarm.
//
// A queued command is a WORKLIST ENTRY, not a live call: the agent picks it up on its next
// check-in. So a DC that is off at midnight collects when it comes back rather than being
// skipped, and there is no need to test whether it is awake first. wakeAgent is only a
// nudge for the ones that are already there.

/** How long the run is spread over. One hour, from midnight. */
const SPREAD_MS = 60 * 60 * 1000;
/** Don't nudge a machine that plainly is not listening; the command still waits for it. */
const AWAKE_SECS = 15 * 60;

interface AdTarget { customer_id: number; customer_name: string; device_id: number; hostname: string; seen_secs: number | null }

/** Every customer with a nominated AD agent, one row each — the newest-seen agent wins,
 *  the same rule the manual Refresh button uses, so both paths collect from the same box. */
async function adTargets(): Promise<AdTarget[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (ad.customer_id)
            ad.customer_id, c.name AS customer_name, ad.id AS device_id, ad.hostname,
            EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS seen_secs
       FROM agent_devices ad
       JOIN customers c ON c.id = ad.customer_id
      WHERE ad.is_ad_agent = true AND ad.revoked = false AND c.deleted_at IS NULL
      ORDER BY ad.customer_id, ad.last_seen_at DESC NULLS LAST`);
  return rows as AdTarget[];
}

/** Already on its way? One collection per customer at a time — this is what stops a DC that
 *  has been off for a fortnight accumulating fourteen identical commands to run at once. */
async function alreadyQueued(customerId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM agent_commands ac
       JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ad.customer_id = $1 AND ac.kind = 'gpo.inventory'
        AND ac.status IN ('queued','running') LIMIT 1`, [customerId]);
  return r.rows.length > 0;
}

async function queueOne(t: AdTarget): Promise<'queued' | 'already-queued' | 'failed'> {
  try {
    if (await alreadyQueued(t.customer_id)) return 'already-queued';
    // requested_by NULL = the system asked, not a person. The activity log is for things a
    // human did; a nightly refresh in there would bury the collections someone chose to run.
    await pool.query(
      `INSERT INTO agent_commands (device_id, kind, status, requested_by)
       VALUES ($1, 'gpo.inventory', 'queued', NULL)`, [t.device_id]);
    if (t.seen_secs != null && Number(t.seen_secs) < AWAKE_SECS) wakeAgent(t.device_id);
    return 'queued';
  } catch (e: any) {
    console.error('[gpo-nightly] %s (%s): %s', t.customer_name, t.hostname, e.message);
    return 'failed';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exported so it can be run by hand from a REPL or a future admin button without
 *  waiting for midnight — and so the schedule and the work are separable when testing. */
export async function runGpoNightly(): Promise<{ queued: number; skipped: number; failed: number; total: number }> {
  const targets = await adTargets();
  if (!targets.length) {
    console.log('[gpo-nightly] no customers have an AD agent — nothing to collect');
    return { queued: 0, skipped: 0, failed: 0, total: 0 };
  }
  // Spread evenly across the hour. One customer goes immediately; the gap only exists to
  // keep them off each other's toes, so with a handful of customers it stays small.
  const gap = Math.floor(SPREAD_MS / targets.length);
  const tally = { queued: 0, skipped: 0, failed: 0, total: targets.length };
  console.log('[gpo-nightly] %d customer(s) with an AD agent, spread over %d minutes',
    targets.length, Math.round(SPREAD_MS / 60000));

  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(gap);
    const r = await queueOne(targets[i]);
    if (r === 'queued') tally.queued++;
    else if (r === 'already-queued') tally.skipped++;
    else tally.failed++;
  }
  console.log('[gpo-nightly] done — %d queued, %d already had one, %d failed',
    tally.queued, tally.skipped, tally.failed);
  return tally;
}

export function startGpoNightly(): void {
  // Midnight, server local time (Europe/London), every night.
  cron.schedule('0 0 * * *', () => {
    runGpoNightly().catch((e) => console.error('[gpo-nightly] run failed:', e.message));
  });
  console.log('✓ Group Policy nightly collection started (00:00, spread over the following hour)');
}
