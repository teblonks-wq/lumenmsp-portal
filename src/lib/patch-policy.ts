import { pool } from '../db/pool';

// ── Resolving a machine's patch policy ──────────────────────────────────────────
// The chain is the same one the Patching screen shows:
//   1. the device's own override      (agent_devices.patch_policy_id)
//   2. the customer's policy for its class (customers.patch_policy_{workstation,server}_id)
//   3. the built-in default for that class (patch_policies.is_default)
//
// It lives here as well as on the Patching screen because software updates now need the
// same answer — "when is it acceptable to touch this machine" is one question, and the
// answer should not depend on which page you asked it from.

export interface ResolvedPolicy {
  id: number | null;
  name: string;
  source: 'device' | 'customer' | 'default' | 'none';
  enabled: boolean;
  windowDays: string;      // comma-separated day numbers, 0 = Sunday
  windowStart: string;     // HH:MM
  windowMinutes: number;
  rebootMode: string;
  excluded: boolean;       // the machine is skipped entirely
  deviceClass: 'workstation' | 'server';
}

const classOf = (d: any): 'workstation' | 'server' =>
  d.patch_class === 'server' || d.patch_class === 'workstation'
    ? d.patch_class
    : (String(d.os || '').toLowerCase().includes('server') ? 'server' : 'workstation');

export async function resolvePolicy(deviceId: number): Promise<ResolvedPolicy | null> {
  const d = (await pool.query(
    `SELECT ad.id, ad.os, ad.patch_class, ad.patch_excluded, ad.patch_policy_id, ad.customer_id,
            c.patch_policy_workstation_id, c.patch_policy_server_id
       FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ad.id = $1`, [deviceId])).rows[0];
  if (!d) return null;

  const cls = classOf(d);
  const wanted = d.patch_policy_id
    || (cls === 'server' ? d.patch_policy_server_id : d.patch_policy_workstation_id)
    || null;
  const src: ResolvedPolicy['source'] = d.patch_policy_id ? 'device'
    : (cls === 'server' ? d.patch_policy_server_id : d.patch_policy_workstation_id) ? 'customer'
    : 'default';

  const p = wanted
    ? (await pool.query('SELECT * FROM patch_policies WHERE id=$1', [wanted])).rows[0]
    : (await pool.query('SELECT * FROM patch_policies WHERE is_default=true AND device_class=$1 LIMIT 1', [cls])).rows[0];

  if (!p) {
    return { id: null, name: 'No policy', source: 'none', enabled: false, windowDays: '',
      windowStart: '', windowMinutes: 0, rebootMode: 'never', excluded: !!d.patch_excluded, deviceClass: cls };
  }

  return {
    id: p.id, name: p.name, source: wanted ? src : 'default', enabled: !!p.enabled,
    windowDays: String(p.window_days || ''), windowStart: String(p.window_start || ''),
    windowMinutes: Number(p.window_minutes || 0), rebootMode: String(p.reboot_mode || 'never'),
    excluded: !!d.patch_excluded, deviceClass: cls,
  };
}

/**
 * When may we next touch this machine?
 *
 * null means "now" — either there is no policy with a maintenance window, or we are inside
 * one. A Date means hold the command until then. Computed in local time on purpose: the app
 * server runs Europe/London and a maintenance window of "02:00" means two in the morning to
 * the person who typed it, not 02:00 UTC.
 */
export function nextWindowStart(p: ResolvedPolicy | null, now = new Date()): Date | null {
  if (!p || !p.windowStart || !p.windowDays) return null;
  const days = p.windowDays.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 0 && n <= 6);
  if (!days.length) return null;

  const [hh, mm] = p.windowStart.split(':').map((x) => parseInt(x, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  // Already inside today's window? Then now is fine.
  if (days.includes(now.getDay())) {
    const start = new Date(now); start.setHours(hh, mm, 0, 0);
    const end = new Date(start.getTime() + Math.max(30, p.windowMinutes) * 60000);
    if (now >= start && now < end) return null;
  }

  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d > now && days.includes(d.getDay())) return d;
  }
  return null;
}

/** One line for the UI: what will happen and when. */
export function windowLabel(p: ResolvedPolicy | null, at: Date | null): string {
  if (!p || p.source === 'none') return 'no policy — will run at the next check-in';
  if (!at) return `${p.name} — no window set, so it runs at the next check-in`;
  return `${p.name} — held until ${at.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
