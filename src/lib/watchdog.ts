import cron from 'node-cron';
import { pool } from '../db/pool';
import { getSetting } from './settings';
import { raiseAlert, resolveAlert } from './alerts';

// ── Watchdog: the Portal watches its own plumbing ───────────────────────────────
// Born 2026-08-13: the mesh bridge timer was stopped by hand at 08:22 and nobody knew
// until Terry read the panel twelve hours later. Every external monitor already rides
// raiseAlert() (ticket + support-group email + Teams ping + staff toast); this gives our
// OWN infrastructure the same treatment. A check fires once on the way down (dedupe and
// flap-damping live in alerts.ts) and resolves itself on the way back up.
//
// Adding a check = one entry in CHECKS. Keep them cheap: this runs every 5 minutes on
// the same box it is checking, so a check is a couple of DB reads, never a network call.

interface WatchdogCheck {
  key: string;               // alerts.external_id — stable, one open alert per check
  severity: 'warning' | 'critical';
  /** Return null when healthy, or the alert body when not. Throwing = skipped, not failed. */
  probe: () => Promise<{ title: string; body: string } | null>;
}

const MESH_BRIDGE_STALE_MIN = 30;   // bridge runs every 5 min; 30 = six missed cycles
const AGENT_SILENCE_MIN = 15;       // whole estate silent = our /agent API is down, not the estate

const CHECKS: WatchdogCheck[] = [
  {
    key: 'mesh-bridge-offline',
    severity: 'warning',
    probe: async () => {
      const raw = await getSetting('mesh', 'last_contact');
      if (!raw) return null;  // bridge has never reported - nothing to compare against
      let at: number;
      try { at = new Date(JSON.parse(raw).at).getTime(); } catch { return null; }
      const mins = Math.floor((Date.now() - at) / 60000);
      if (!Number.isFinite(mins) || mins < MESH_BRIDGE_STALE_MIN) return null;
      return {
        title: `Remote control: the mesh bridge has not reported for ${mins} minutes`,
        body: 'The bridge on mesh01 links machines to their MeshCentral nodes; remote control only works on machines it has linked, so everything installed while it is down is stranded.\n\n'
            + 'It runs every 5 minutes from a systemd timer. On mesh01 (ssh lumen-admin@192.168.70.22):\n'
            + '  systemctl status lumen-mesh-bridge.timer lumen-mesh-bridge.service --no-pager\n'
            + '  journalctl -u lumen-mesh-bridge.service --since "-2h" --no-pager | tail -30\n'
            + '  sudo systemctl start lumen-mesh-bridge.timer   # if the timer is dead (13 Aug: someone stopped it by hand)\n'
            + '  sudo systemctl start lumen-mesh-bridge.service # force a run now\n\n'
            + 'This alert clears itself when the bridge reports again.',
      };
    },
  },
  {
    key: 'agent-estate-silent',
    severity: 'critical',
    probe: async () => {
      // If not one agent in the whole estate has checked in, the fault is OURS - the
      // /agent API, the DB, or the vhost - not a hundred customer machines at once.
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n, MAX(last_seen_at) AS latest FROM agent_devices WHERE revoked=false`);
      const { n, latest } = r.rows[0];
      if (!n || !latest) return null;  // no agents yet - nothing to judge
      const mins = Math.floor((Date.now() - new Date(latest).getTime()) / 60000);
      if (mins < AGENT_SILENCE_MIN) return null;
      return {
        title: `Every agent has gone quiet: no check-in from any of ${n} devices for ${mins} minutes`,
        body: 'Agents heartbeat every 2 minutes. One silent machine is that machine; ALL of them silent is the Portal\'s own /agent endpoint, the database, or the vhost. Check pm2 logs and nginx first.\n\nThis alert clears itself when a heartbeat lands.',
      };
    },
  },
];

async function runChecks(): Promise<void> {
  for (const c of CHECKS) {
    try {
      const fail = await c.probe();
      if (fail) {
        await raiseAlert({ source: 'watchdog', externalId: c.key, severity: c.severity,
          title: fail.title, body: fail.body });
      } else {
        await resolveAlert('watchdog', c.key);
      }
    } catch (e: any) {
      // A broken probe must never masquerade as either "healthy" or "down".
      console.error(`[watchdog] check ${c.key} errored (skipped):`, e.message);
    }
  }
}

export function startWatchdog(): void {
  cron.schedule('*/5 * * * *', () => { runChecks().catch((e) => console.error('[watchdog]', e.message)); });
  // One pass shortly after boot: a deploy restart must re-notice a still-broken bridge
  // rather than waiting out the first cron window on top of the outage.
  setTimeout(() => { runChecks().catch(() => { /* logged inside */ }); }, 90_000);
  console.log('[watchdog] internal health checks every 5 min (mesh bridge, agent estate)');
}
