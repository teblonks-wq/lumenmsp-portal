import { pool } from '../db/pool';

// ── Stale remote-command reaper ─────────────────────────────────────────────────
// A command is claimed by flipping it to 'running' the moment the agent polls for it.
// If that agent then restarts before it reports back - a self-update, a reboot, a service
// crash, an engineer restarting it - nothing ever moves the row again. It sits in
// 'running' forever, and because queueMeshInstall() treats 'queued' OR 'running' as
// "already in flight", the machine never gets another remote-access install queued
// either. That is exactly how a device ends up saying "Installing remote access..." for
// five hours on a PC that has been switched on the whole time.
//
// So: give every kind a budget (its own agent-side timeout plus headroom) and fail
// anything that overruns it, with an explanation. Failing it is what lets the next
// heartbeat queue a fresh attempt.

const BUDGET_MINUTES: Record<string, number> = {
  'mesh.install': 20,     // 10 min installer + up to 1 min waiting for the service
  'mesh.remove': 20,
  'agent.update': 20,     // download + verify + restart
  'software.install': 30,
  'software.uninstall': 30,
  'inventory.software': 20,
  'patch.scan': 45,       // the Windows Update search is genuinely slow
  'patch.scan.apps': 30,
  'patch.install': 120,
  'ce.assess': 30,
  'server.facts': 20,
};
const DEFAULT_MINUTES = 10;

// A queued command nobody ever collected is not worth carrying forever either - a machine
// that has been off for a fortnight wants a fresh instruction, not a stale one.
const QUEUED_EXPIRY_DAYS = 14;

const STUCK_NOTE =
  'The agent never reported back. It was almost certainly restarted while this was running ' +
  '(an agent update, a reboot, or the service being restarted). Marked failed so it can be retried.';

const EXPIRED_NOTE =
  'This was never collected - the machine did not come online within ' + QUEUED_EXPIRY_DAYS + ' days. Queue it again if it is still wanted.';

function budgetCase(): string {
  const whens = Object.entries(BUDGET_MINUTES)
    .map(([kind, mins]) => `WHEN '${kind.replace(/'/g, "''")}' THEN ${Number(mins)}`)
    .join(' ');
  return `CASE kind ${whens} ELSE ${DEFAULT_MINUTES} END`;
}

export interface ReapResult { stuck: number; expired: number; kinds: string[] }

let lastRunMs = 0;

/**
 * Fail commands that overran their budget. Cheap (two set-based statements) and
 * throttled to once a minute, so it is safe to call from a hot path like the heartbeat
 * or the command poll.
 */
export async function reapStaleCommands(force = false): Promise<ReapResult> {
  const now = Date.now();
  if (!force && now - lastRunMs < 60_000) return { stuck: 0, expired: 0, kinds: [] };
  lastRunMs = now;

  const out: ReapResult = { stuck: 0, expired: 0, kinds: [] };
  try {
    const stuck = await pool.query(
      `UPDATE agent_commands
          SET status='failed', exit_code=-1, finished_at=NOW(), payload=NULL,
              output = CASE WHEN COALESCE(output,'') = '' THEN $1 ELSE output || E'\\n\\n' || $1 END
        WHERE status='running'
          AND started_at IS NOT NULL
          -- Measured from the last sign of life, not from the start: a genuinely long
          -- install that is streaming progress must not be shot for taking its time.
          AND GREATEST(started_at, COALESCE(progress_at, started_at)) < NOW() - make_interval(mins => ${budgetCase()})
        RETURNING id, device_id, kind`, [STUCK_NOTE]);
    out.stuck = stuck.rows.length;
    out.kinds = Array.from(new Set(stuck.rows.map((r: any) => String(r.kind))));

    const expired = await pool.query(
      `UPDATE agent_commands
          SET status='failed', exit_code=-1, finished_at=NOW(), payload=NULL,
              output = CASE WHEN COALESCE(output,'') = '' THEN $1 ELSE output || E'\\n\\n' || $1 END
        WHERE status='queued'
          AND requested_at < NOW() - interval '${QUEUED_EXPIRY_DAYS} days'
        RETURNING id`, [EXPIRED_NOTE]);
    out.expired = expired.rows.length;

    if (out.stuck || out.expired) {
      console.log(`[agent] reaped ${out.stuck} stalled command(s)${out.kinds.length ? ' (' + out.kinds.join(', ') + ')' : ''}` +
        `${out.expired ? ` and expired ${out.expired} uncollected` : ''}`);
    }
  } catch (e: any) {
    // Never let housekeeping break the request that triggered it.
    console.error('[agent] command reaper failed:', e.message);
  }
  return out;
}
