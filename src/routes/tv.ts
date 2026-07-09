import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { websiteStats } from '../lib/chat';
import { getSetting } from '../lib/settings';

// Office TV wallboard - overview only (no engineer diary). Fast auto-refresh + bing-bong on a new
// alert. Surfaces: open UniFi/Giacom alerts, website stats, new+unassigned cases, and case-load
// stats (this month, new/hr, closed/hr, live open).
//
// Access: normal login OR a trusted-IP allow-list (so a wall-mounted TV needs no login). The list is
// the setting `tv/allow_list` (comma-separated IPs/CIDRs); default covers the office LAN + WAN IP.
// NOTE: the app is cloud-hosted, so office LAN devices arrive as the office WAN IP via NAT - that
// public IP is what actually matches; the private /24 is there for a future site-to-site VPN.

const router = Router();
const DEFAULT_TV_ALLOW = '192.168.69.0/24,212.19.69.178,127.0.0.1,::1';

function ipToLong(ip: string): number | null {
  const m = String(ip || '').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/); // also handles ::ffff:1.2.3.4
  if (!m) return null;
  return (((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4])) >>> 0;
}
function ipMatches(ip: string, rule: string): boolean {
  rule = rule.trim(); if (!rule) return false;
  if (rule === ip) return true;
  if (rule.includes('/')) {
    const [net, bitsS] = rule.split('/'); const bits = parseInt(bitsS, 10);
    const a = ipToLong(ip), n = ipToLong(net); if (a == null || n == null) return false;
    const mask = bits <= 0 ? 0 : (bits >= 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0);
    return (a & mask) === (n & mask);
  }
  const a = ipToLong(ip), r = ipToLong(rule);
  return a != null && r != null && a === r;
}
let _allowCache: { list: string[]; at: number } | null = null;
async function tvAllowList(): Promise<string[]> {
  if (_allowCache && Date.now() - _allowCache.at < 60000) return _allowCache.list;
  const raw = ((await getSetting('tv', 'allow_list')) || DEFAULT_TV_ALLOW);
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  _allowCache = { list, at: Date.now() };
  return list;
}
async function tvIpAllowed(req: Request): Promise<boolean> {
  const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const list = await tvAllowList();
  return list.some((rule) => ipMatches(ip, rule));
}
// Allow trusted IPs straight through; everyone else must be logged in.
async function tvAuth(req: Request, res: Response, next: NextFunction) {
  try { if (await tvIpAllowed(req)) return next(); } catch { /* fall through to login */ }
  return requireAuth(req, res, next);
}

async function tvData() {
  const [alerts, alertCount, caseStats, unassigned, web] = await Promise.all([
    pool.query(
      `SELECT id, source, severity, title, started_at
         FROM alerts WHERE status='open'
        ORDER BY (severity='critical') DESC, started_at DESC LIMIT 12`
    ),
    pool.query("SELECT COUNT(*)::int n FROM alerts WHERE status='open'"),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE assigned_user_id IS NULL AND status NOT IN ('resolved','closed'))::int AS unassigned,
         COUNT(*) FILTER (WHERE status IN ('new','open','in_progress','pending'))::int AS live_open,
         COUNT(*) FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE))::int AS this_month,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS new_today,
         COUNT(*) FILTER (WHERE closed_at::date = CURRENT_DATE)::int AS closed_today,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS new_last_hour,
         COUNT(*) FILTER (WHERE closed_at  > NOW() - INTERVAL '1 hour')::int AS closed_last_hour
       FROM inbox_tickets WHERE deleted_at IS NULL AND is_spam = false`
    ),
    pool.query(
      `SELECT t.ticket_number, t.subject, t.created_at, c.name AS customer_name
         FROM inbox_tickets t LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.assigned_user_id IS NULL AND t.status NOT IN ('resolved','closed')
          AND t.deleted_at IS NULL AND t.is_spam = false
        ORDER BY t.created_at ASC LIMIT 10`
    ),
    websiteStats().catch(() => ({ today: 0, uniques30: 0, liveNow: 0 })),
  ]);

  const cs = caseStats.rows[0];
  // Per-hour rates: today's totals averaged over the hours elapsed since midnight (min 1h).
  const now = new Date();
  const hoursElapsed = Math.max(1, (now.getHours() + now.getMinutes() / 60));
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    ts: now.toISOString(),
    alerts: {
      open: alertCount.rows[0].n,
      items: alerts.rows.map((a: any) => ({
        id: a.id, source: a.source, severity: a.severity || 'warning',
        title: a.title || '(alert)', since: a.started_at,
      })),
    },
    web: { today: (web as any).today || 0, uniques30: (web as any).uniques30 || 0, liveNow: (web as any).liveNow || 0 },
    cases: {
      unassignedCount: cs.unassigned,
      liveOpen: cs.live_open,
      thisMonth: cs.this_month,
      newToday: cs.new_today,
      closedToday: cs.closed_today,
      newPerHour: round1(cs.new_today / hoursElapsed),
      closedPerHour: round1(cs.closed_today / hoursElapsed),
      newLastHour: cs.new_last_hour,
      closedLastHour: cs.closed_last_hour,
      unassigned: unassigned.rows.map((t: any) => ({
        number: t.ticket_number, subject: t.subject || '(no subject)',
        customer: t.customer_name || 'Unknown', since: t.created_at,
      })),
    },
  };
}

// Full-screen board shell (renders with the first snapshot baked in).
router.get('/tv', tvAuth, async (req: Request, res: Response) => {
  const data = await tvData();
  res.render('tv', { user: req.session.user || null, data });
});

// Live data the board polls every ~20s.
router.get('/tv/data.json', tvAuth, async (_req: Request, res: Response) => {
  try { res.json(await tvData()); }
  catch (e: any) { res.status(500).json({ error: e.message || 'tv data failed' }); }
});

export default router;
