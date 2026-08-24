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
import { NET_DISCO_MIN_AGENT, agentAtLeast } from './network-discovery';

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

// ── Network device polling ──────────────────────────────────────────────────────
// Every device someone ticked as Monitored, read on a timer. Until this existed the
// "Monitored" flag was decoration: it put a green dot on a row and nothing ever went and
// looked at the device, so a printer could sit at 4% toner for a fortnight with the Portal
// perfectly content.

/** How often the monitored estate is swept. Toner does not move fast, but a paper jam
 *  wants noticing the same morning rather than the same week. */
const NET_POLL_EVERY_MS = 30 * 60 * 1000;
/** Do not re-ask a device that was read this recently — a sweep landing slightly early
 *  should not double the traffic on a customer's LAN. */
const NET_POLL_FRESH_MINS = 25;
/** Most polls queued against ONE agent per sweep. Commands run one at a time in order and
 *  a poll is a couple of seconds, so ten is well under a minute of work — but it stops a
 *  server with forty printers behind it collecting a queue it will never finish before the
 *  next sweep adds more. */
const NET_POLL_PER_AGENT = 10;

export function startNetworkPolling(): void {
  every('network-poll', NET_POLL_EVERY_MS, 4 * 60_000, async () => {
    const due = (await pool.query(
      `SELECT n.id, n.ip, n.agent_device_id, d.agent_version
         FROM network_devices n
         JOIN agent_devices d ON d.id = n.agent_device_id
        WHERE n.monitored = true
          AND n.archived_at IS NULL
          AND d.revoked = false
          AND d.last_seen_at > NOW() - ($1 || ' seconds')::interval
          AND (n.last_poll_at IS NULL OR n.last_poll_at < NOW() - ($2 || ' minutes')::interval)
        ORDER BY n.last_poll_at NULLS FIRST`,
      [ONLINE_SECS, NET_POLL_FRESH_MINS])).rows;
    if (!due.length) return;

    // What each agent is already carrying, so a slow or offline one is not buried.
    const pending = new Map<number, number>();
    for (const r of (await pool.query(
      `SELECT device_id, COUNT(*)::int AS n FROM agent_commands
        WHERE kind='snmp.poll' AND status IN ('queued','running') GROUP BY device_id`)).rows) {
      pending.set(Number(r.device_id), Number(r.n));
    }

    let queued = 0, skippedOld = 0;
    for (const d of due) {
      // An agent that does not know the verb would collect the command and drop it, and
      // the device would then look like it had been polled and said nothing.
      if (!agentAtLeast(d.agent_version, NET_DISCO_MIN_AGENT)) { skippedOld++; continue; }

      const agentId = Number(d.agent_device_id);
      const already = pending.get(agentId) || 0;
      if (already >= NET_POLL_PER_AGENT) continue;
      pending.set(agentId, already + 1);

      await pool.query(
        `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by)
         VALUES ($1,'snmp.poll',$2,'queued',NULL)`,
        [agentId, JSON.stringify({ networkDeviceId: d.id, ip: d.ip })]);
      wakeAgent(agentId);
      queued++;
    }

    // Say what was left out as well as what was done. A count that quietly omits the
    // devices behind an old agent reads as "everything is being watched", and it is not.
    if (queued || skippedOld) {
      console.log('[auto-sync] network-poll: queued %d, skipped %d on agents older than %s',
        queued, skippedOld, NET_DISCO_MIN_AGENT);
    }
  });
}
