import { pool } from '../../db/pool';

// ── Business-hours clock (09:00–17:00, Mon–Fri, UK time) ──────────────────────────
// Response timers must PAUSE outside working hours: a ticket logged at 16:50 Friday and
// first answered 09:10 Monday counts as ~20 working minutes, not the whole weekend.
const BH_START = 9;   // 09:00
const BH_END = 17;    // 17:00
// Convert a UTC instant to "naive UK wall-clock" ms (London tz applied, then read as if UTC),
// so day/hour arithmetic below is in local terms. DST drift within a single response gap is
// at most an hour once and is immaterial for a response timer.
function naiveUk(d: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {} as Record<string, string>);
  const hh = p.hour === '24' ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hh, Number(p.minute), Number(p.second));
}
function businessMinutesBetween(start: Date, end: Date): number {
  let s = naiveUk(start), e = naiveUk(end);
  if (e <= s) return 0;
  let total = 0;
  let day = new Date(s); day.setUTCHours(0, 0, 0, 0);
  let guard = 0;
  while (day.getTime() <= e && guard++ < 400) {
    const dow = day.getUTCDay(); // 0=Sun..6=Sat
    if (dow >= 1 && dow <= 5) {
      const winA = day.getTime() + BH_START * 3600000;
      const winB = day.getTime() + BH_END * 3600000;
      const a = Math.max(s, winA), b = Math.min(e, winB);
      if (b > a) total += b - a;
    }
    day = new Date(day.getTime() + 86400000);
  }
  return Math.round(total / 60000);
}

// ── Helpdesk / Support & Service Activity ────────────────────────────────────────
// Draws from the portal's own tickets (inbox_tickets + inbox_messages) for one
// customer over the report period. Mirrors the numbers on the existing Staybrook
// snapshot: tickets handled, average response time, resolved, still open.

export interface HelpdeskStats {
  totalCases: number;              // tickets created in the period (total logged)
  resolved: number;                // of those, currently status = resolved
  closed: number;                  // of those, currently status = closed
  open: number;                    // of those, neither resolved nor closed
  openAllTime: number;             // total open for the customer right now (context)
  avgResponseMins: number | null;  // created → first staff reply, working-hours, averaged
  avgResolutionMins: number | null;// created → closed/resolved, working-hours, averaged
  byCategory: { category: string; count: number }[];
  topRequesters: { name: string; count: number }[];
}

export async function getHelpdeskStats(customerId: number, from: Date, to: Date): Promise<HelpdeskStats> {
  // Tickets created in the window (the "handled" set), with resolution + first-response timing.
  const { rows } = await pool.query(
    `SELECT t.id, t.category, t.status, t.created_at, t.closed_at,
            co.full_name AS requester,
            (SELECT MIN(COALESCE(m.received_at, m.created_at))
               FROM inbox_messages m
              WHERE m.ticket_id = t.id AND m.message_direction = 'outbound') AS first_reply_at
       FROM inbox_tickets t
       LEFT JOIN customer_contacts co ON co.id = t.contact_id
      WHERE t.customer_id = $1 AND t.deleted_at IS NULL AND COALESCE(t.is_spam,false) = false
        AND t.created_at >= $2 AND t.created_at < $3`,
    [customerId, from, to]
  );

  let resolved = 0, closed = 0, open = 0;
  const responseMins: number[] = [];
  const resolutionMins: number[] = [];
  const byCat = new Map<string, number>();
  const byReq = new Map<string, number>();
  for (const t of rows) {
    const st = String(t.status || '').toLowerCase();
    if (st === 'resolved') resolved++;
    else if (st === 'closed') closed++;
    else open++;
    if (t.first_reply_at) {
      // Working-hours elapsed only (09:00–17:00 Mon–Fri), so out-of-hours doesn't inflate the timer.
      const mins = businessMinutesBetween(new Date(t.created_at), new Date(t.first_reply_at));
      if (mins >= 0 && mins < 60 * 8 * 40) responseMins.push(mins);
    }
    if (t.closed_at) {
      const rmins = businessMinutesBetween(new Date(t.created_at), new Date(t.closed_at));
      if (rmins >= 0 && rmins < 60 * 8 * 200) resolutionMins.push(rmins);
    }
    const cat = String(t.category || 'general');
    byCat.set(cat, (byCat.get(cat) || 0) + 1);
    const req = String(t.requester || '').trim();
    if (req) byReq.set(req, (byReq.get(req) || 0) + 1);
  }

  const openAllTime = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM inbox_tickets
      WHERE customer_id = $1 AND deleted_at IS NULL AND COALESCE(is_spam,false) = false
        AND status NOT IN ('resolved','closed')`, [customerId]
  )).rows[0].n;

  const avgResponseMins = responseMins.length
    ? Math.round(responseMins.reduce((a, b) => a + b, 0) / responseMins.length)
    : null;
  const avgResolutionMins = resolutionMins.length
    ? Math.round(resolutionMins.reduce((a, b) => a + b, 0) / resolutionMins.length)
    : null;

  return {
    totalCases: rows.length,
    resolved,
    closed,
    open,
    openAllTime,
    avgResponseMins,
    avgResolutionMins,
    byCategory: [...byCat.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    topRequesters: [...byReq.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

// Human "17 minutes" / "2.3 hours" style formatting for the report.
export function fmtResponse(mins: number | null): string {
  if (mins == null) return 'n/a';
  if (mins < 90) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = mins / 60;
  if (hrs < 48) return `${hrs.toFixed(1)} hours`;
  return `${(hrs / 24).toFixed(1)} days`;
}
