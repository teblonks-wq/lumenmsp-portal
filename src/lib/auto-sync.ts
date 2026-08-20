/**
 * Schedulers for the imports and refreshes that used to happen only when somebody pressed
 * a button.
 *
 * The Portal had a good scheduled estate already - Giacom, UniFi, MSP360, Acronis, DMARC,
 * billing and the rest all start at boot. But three things a rollout depends on did not:
 *
 *  - `syncGravityZone` ran only from the Security page's Sync button. It is what fills
 *    security_endpoints, which is the GravityZone half of "protected" - so a machine could
 *    install Bitdefender cleanly and sit at "installed, waiting for GravityZone" forever
 *    because nothing ever went and looked.
 *  - `syncAssetsFromAtera` ran only from the Assets page's import button.
 *  - Nothing ever asked a machine for a fresh security reading unless a person opened its
 *    page and pressed Refresh. The agent's own inventory pass is every 24 hours, so the
 *    estate's security picture was, on average, half a day out of date.
 *
 * Three rules shape everything here, and they are why this is a file rather than three
 * setIntervals scattered around:
 *
 *  1. NEVER OVERLAP. A slow Atera pull must not have a second one started on top of it.
 *     Every job is wrapped in a guard that skips the tick if the last one is still going.
 *  2. NEVER STAMPEDE. A deploy restarts the process and every timer would otherwise start
 *     from the same instant. Each job gets a different first-run delay, and the security
 *     sweep is capped per pass so it walks the estate instead of asking 170 machines at
 *     once - which is exactly the kind of thundering herd that made the Portal feel frozen.
 *  3. NEVER BE THE SLOW PART. Intervals are chosen against what they watch, not against
 *     what feels thorough. An install takes minutes, so GravityZone is polled in minutes.
 *     Atera's inventory changes when someone buys a laptop, so it is polled hourly.
 */
import { pool } from '../db/pool';
import { syncGravityZone, gzConfigured } from './gravityzone';
import { syncAssetsFromAtera } from './asset-sync';
import { wakeAgent } from '../routes/agent-api';

/** How often GravityZone is asked what it can see. */
const GZ_EVERY_MS = 10 * 60 * 1000;
/** How often Atera's device list is pulled. */
const ATERA_EVERY_MS = 60 * 60 * 1000;
/** How often the estate is swept for stale security readings. */
const SEC_SWEEP_EVERY_MS = 15 * 60 * 1000;
/** A security reading older than this is worth re-asking for. */
const SEC_STALE_SECS = 3 * 60 * 60;
/** Most machines asked in one sweep. 40 every 15 minutes walks 170 devices in about an
 *  hour without ever putting a burst of work on the database or the endpoints. */
const SEC_SWEEP_MAX = 40;
/** A machine not seen in this long is off; asking it just queues a command it cannot answer. */
const ONLINE_SECS = 15 * 60;

/** Run `fn` on a timer, skipping any tick where the previous run has not finished. */
function every(label: string, ms: number, firstDelayMs: number, fn: () => Promise<void>): void {
  let running = false;
  const tick = async () => {
    if (running) { console.warn('[auto-sync] %s still running - skipping this tick', label); return; }
    running = true;
    try { await fn(); }
    catch (e: any) { console.error('[auto-sync] %s failed: %s', label, e.message); }
    finally { running = false; }
  };
  setTimeout(tick, firstDelayMs);
  setInterval(tick, ms);
}

export function startGravityZoneSync(): void {
  every('gravityzone', GZ_EVERY_MS, 45_000, async () => {
    if (!(await gzConfigured())) return;
    const r = await syncGravityZone(null);
    if (r.endpoints || r.detections) {
      console.log('[auto-sync] gravityzone: %d endpoints, %d matched, %d detections',
        r.endpoints, r.matchedDevices, r.detections);
    }
  });
}

export function startAteraImport(): void {
  every('atera', ATERA_EVERY_MS, 3 * 60_000, async () => {
    const r = await syncAssetsFromAtera(null);
    if (r.error) { console.warn('[auto-sync] atera: %s', r.error); return; }
    if (r.imported || r.linked) {
      console.log('[auto-sync] atera: %d imported, %d linked, %d unmatched', r.imported, r.linked, r.unmatched);
    }
  });
}

/**
 * Ask the machines with the oldest security readings for a fresh one.
 *
 * Deliberately a sweep rather than a shorter timer inside the agent: the cadence stays a
 * Portal setting we can change in one line, instead of a value baked into a build that
 * would need a whole estate rollout before anyone felt it. Only machines that have checked
 * in recently are asked - an offline PC would just accumulate identical commands - and one
 * already-pending request means it has been asked and has not answered yet.
 */
export function startSecurityFreshnessSweep(): void {
  every('security-sweep', SEC_SWEEP_EVERY_MS, 90_000, async () => {
    const rows = (await pool.query(
      `SELECT d.id
         FROM agent_devices d
        WHERE d.revoked = false
          AND d.last_seen_at > NOW() - ($1 || ' seconds')::interval
          AND (d.security_at IS NULL OR d.security_at < NOW() - ($2 || ' seconds')::interval)
          AND NOT EXISTS (
                SELECT 1 FROM agent_commands c
                 WHERE c.device_id = d.id AND c.kind = 'security.status'
                   AND c.status IN ('queued','running'))
        ORDER BY d.security_at ASC NULLS FIRST
        LIMIT $3`,
      [ONLINE_SECS, SEC_STALE_SECS, SEC_SWEEP_MAX])).rows;
    if (!rows.length) return;

    const ids = rows.map((r: any) => Number(r.id));
    await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, status)
       SELECT t.id, 'security.status', '{}', 'queued' FROM unnest($1::int[]) AS t(id)`,
      [ids]);
    for (const id of ids) wakeAgent(id);
    console.log('[auto-sync] security-sweep: asked %d device(s) for a fresh reading', ids.length);
  });
}
