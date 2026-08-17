import { pool } from '../db/pool';
import { logActivity } from './activity';
import { wakeAgent } from '../routes/agent-api';

// ── Power control ───────────────────────────────────────────────────────────────
// Sign out, restart, shut down — queued to a machine from the Portal.
//
// This deliberately reverses an earlier decision. The patching module was written so that
// nothing in it ever restarted a machine, on the grounds that choosing when to reboot a
// customer's server is a human call. It still is: the difference is that a person is now
// making that call by pressing a button, rather than the system deciding on its own.
//
// The person at the machine is TOLD, not asked (Terry, 2026-08-12: a branded warning
// "advising your LumenMSP have triggered a reboot / shutdown / logoff - they cannot stop
// it"). The agent raises that notice through the tray before it acts.
//
// A queued command runs when the machine NEXT CHECKS IN, which matters more than it looks:
// on a late-night patching run you can queue restarts across machines that are currently
// off, and each one acts as it comes back. It is a worklist, not a live console.

export type PowerAction = 'logoff' | 'restart' | 'shutdown' | 'cancel';

const KINDS: Record<PowerAction, string> = {
  logoff: 'power.logoff',
  restart: 'power.restart',
  shutdown: 'power.shutdown',
  cancel: 'power.cancel',
};

const VERB: Record<PowerAction, string> = {
  logoff: 'Sign out',
  restart: 'Restart',
  shutdown: 'Shut down',
  cancel: 'Cancel pending restart',
};

export function isPowerAction(v: unknown): v is PowerAction {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(KINDS, v);
}

export interface PowerResult {
  ok: boolean;
  error?: string;
  queued?: { commandId: number; action: PowerAction; hostname: string | null; delaySeconds: number; loggedInUser: string | null; online: boolean; runAtEpoch: number | null };
}

/** "Tue 18 Aug, 08:00" — one wording for every surface, always Europe/London. */
export function powerWhenText(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Queue a power action against ONE agent device.
 *
 * Refuses on a revoked device, and refuses a second one while an identical action is still
 * outstanding — double-clicking "Restart" should not schedule two.
 */
export async function queuePower(
  deviceId: number, action: PowerAction,
  opts: { delaySeconds?: number; userId: number | null; userName?: string | null; runAtEpoch?: number | null },
): Promise<PowerResult> {
  const delay = Math.max(0, Math.min(3600, Math.round(Number(opts.delaySeconds ?? 60)) || 0));

  // A one-time future restart/shutdown (the Atera-style "Schedule restart"). Held
  // portal-side in agent_commands.run_after — the poll does not hand the command over
  // until the time passes, so nothing agent-side had to change and an offline machine
  // simply acts the first time it checks in after the chosen moment.
  let runAt: number | null = null;
  if (opts.runAtEpoch != null && (action === 'restart' || action === 'shutdown')) {
    runAt = Math.round(Number(opts.runAtEpoch)) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (runAt <= now) return { ok: false, error: 'That time has already passed — pick a moment in the future.' };
    if (runAt > now + 30 * 86400) return { ok: false, error: 'That is more than 30 days away — schedule it nearer the time.' };
  }
  try {
    const d = (await pool.query(
      `SELECT id, hostname, customer_id, logged_in_user, revoked,
              EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS seen_secs
         FROM agent_devices WHERE id=$1`, [deviceId])).rows[0];
    if (!d) return { ok: false, error: 'That machine is not known to the Portal.' };
    if (d.revoked) return { ok: false, error: 'That machine has been revoked — its agent can no longer be reached.' };

    if (action !== 'cancel') {
      const pending = await pool.query(
        `SELECT 1 FROM agent_commands WHERE device_id=$1 AND kind=$2 AND status IN ('queued','running') LIMIT 1`,
        [deviceId, KINDS[action]]);
      if (pending.rows.length) {
        return { ok: false, error: `A ${VERB[action].toLowerCase()} is already queued on this machine and has not run yet.` };
      }
    }

    const payload = action === 'cancel'
      ? {}
      : { delay_seconds: String(delay), requested_by: opts.userName || 'Lumen IT' };

    const ins = await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, requested_by, run_after)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5::bigint) END)
       RETURNING id`,
      [deviceId, KINDS[action], JSON.stringify(payload), opts.userId, runAt]);
    // No point waking the agent for something it will not be given yet.
    if (!runAt) wakeAgent(deviceId);

    // Audited before anything happens, and the log records who was signed in at the time —
    // which is the question anyone asks afterwards if work was lost.
    await logActivity(opts.userId, 'agent_power', 'agent_devices', deviceId,
      `${VERB[action]} ${runAt ? `scheduled for ${powerWhenText(runAt)}` : 'queued'} on ${d.hostname || deviceId}` +
      (action === 'cancel' ? '' : ` (${delay}s warning)`) +
      (d.logged_in_user ? ` — ${d.logged_in_user} was signed in` : ' — nobody signed in'));

    return {
      ok: true,
      queued: {
        commandId: ins.rows[0].id, action, hostname: d.hostname || null, delaySeconds: delay,
        loggedInUser: d.logged_in_user || null,
        online: d.seen_secs !== null && Number(d.seen_secs) < 180,
        runAtEpoch: runAt,
      },
    };
  } catch (e: any) {
    console.error('[power] queue failed:', e.message);
    return { ok: false, error: 'Could not queue that.' };
  }
}

/** Wording for the confirmation, built server-side so every surface says the same thing. */
export function powerConfirmText(action: PowerAction, hostname: string | null, loggedInUser: string | null, online: boolean): string {
  const host = hostname || 'this machine';
  if (action === 'cancel') return `Cancel the pending restart or shutdown on ${host}?`;
  const who = loggedInUser ? `${loggedInUser} is signed in and will be warned but cannot stop it. ` : '';
  const off = online ? '' : `${host} is offline, so this runs the moment it next comes online. `;
  return `${VERB[action]} ${host}? ${who}${off}Unsaved work will be lost.`;
}
