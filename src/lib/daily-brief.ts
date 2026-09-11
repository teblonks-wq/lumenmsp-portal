import { pool } from '../db/pool';
import { getSetting } from './settings';
import { DIARY_KINDS, londonHM, dayKeyOf } from './diary';

/**
 * The 06:00 company brief — one Teams post, once a weekday morning, that says what the
 * day holds before anybody opens the Portal.
 *
 * Three rules shaped it:
 *
 *  1. ONE POST, NOT SEVEN. A per-person message means seven notifications for one day
 *     and nobody reading anyone else's. The point of this one is that Terry can see
 *     Andrew's day and Andrew can see Terry's, which is what stops two people being
 *     out at once.
 *  2. IT NEVER POSTS AN EMPTY DAY as if it were news. A weekend, a bank holiday or a
 *     genuinely blank Friday says so in one line and stops.
 *  3. EVERY SECTION IS INDEPENDENTLY SAFE. A section whose query fails is dropped, not
 *     escalated — a broken promise count must not cost the whole brief. The day starts
 *     either way.
 *
 * Sending goes through whatever webhook is configured. A Power Automate relay gets the
 * same JSON shape sendTeamsNotice uses, with `channel: true` and an `html` body added;
 * a classic/Workflows channel webhook (webhook.office.com) gets a MessageCard, because
 * that is the only thing it will render.
 */

export interface DailyBrief {
  dayKey: string;
  title: string;
  text: string;     // plain text — what a relay shows if it ignores html
  html: string;     // richer body for a channel card
  empty: boolean;   // nothing at all on: the caller may choose not to post
}

const LONDON = 'Europe/London';

function londonToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: LONDON });   // YYYY-MM-DD
}

function prettyDay(dayKey: string): string {
  return new Date(dayKey + 'T12:00:00Z').toLocaleDateString('en-GB', {
    timeZone: LONDON, weekday: 'long', day: 'numeric', month: 'long',
  });
}

function isWeekend(dayKey: string): boolean {
  const d = new Date(dayKey + 'T12:00:00Z').getUTCDay();
  return d === 0 || d === 6;
}

const esc = (s: any) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Build the brief for one day. Never throws. */
export async function buildDailyBrief(dayKey?: string): Promise<DailyBrief> {
  const dk = dayKey || londonToday();
  const appUrl = String(process.env.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, '');

  // ── Timed work today ─────────────────────────────────────────────────────────
  // Read through the day boundary in Europe/London, not UTC: in BST a 00:00 UTC cut
  // loses the last hour of the previous evening and gains an hour of tomorrow.
  let timed: any[] = [];
  try {
    timed = (await pool.query(
      `SELECT e.id, e.kind, e.title, e.colour, e.online_meeting_url,
              EXTRACT(EPOCH FROM e.start_at)::bigint AS s,
              EXTRACT(EPOCH FROM e.end_at)::bigint   AS en,
              c.name AS customer_name,
              COALESCE(string_agg(u.display_name, ', ' ORDER BY u.display_name), '') AS who
         FROM diary_entries e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN diary_entry_people p ON p.entry_id = e.id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE e.status <> 'cancelled'
          AND e.start_at IS NOT NULL
          AND (e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date = $1::date
        GROUP BY e.id, c.name
        ORDER BY e.start_at`, [dk])).rows;
  } catch (err: any) { console.error('[brief] timed work failed:', err.message); }

  // ── Who is out ───────────────────────────────────────────────────────────────
  // A week off is ONE row spanning day_key..end_day_key, so the test is a range test.
  let off: any[] = [];
  try {
    off = (await pool.query(
      `SELECT e.id, e.title,
              COALESCE(string_agg(u.display_name, ', ' ORDER BY u.display_name), '') AS who
         FROM diary_entries e
         LEFT JOIN diary_entry_people p ON p.entry_id = e.id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE e.status <> 'cancelled' AND e.kind = 'timeoff'
          AND e.start_at IS NULL AND e.day_key IS NOT NULL
          AND $1 BETWEEN e.day_key AND COALESCE(e.end_day_key, e.day_key)
        GROUP BY e.id
        ORDER BY e.id`, [dk])).rows;
  } catch (err: any) { console.error('[brief] time off failed:', err.message); }

  // ── Promises and tasks landing today ─────────────────────────────────────────
  let due: any[] = [];
  try {
    due = (await pool.query(
      `SELECT e.id, e.kind, e.title, e.ticket_id, c.name AS customer_name,
              COALESCE(string_agg(u.display_name, ', ' ORDER BY u.display_name), '') AS who
         FROM diary_entries e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN diary_entry_people p ON p.entry_id = e.id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE e.status = 'booked' AND e.kind IN ('promise','task')
          AND e.start_at IS NULL AND e.day_key = $1
        GROUP BY e.id, c.name
        ORDER BY e.kind DESC, e.id`, [dk])).rows;
  } catch (err: any) { console.error('[brief] promises failed:', err.message); }

  // ── Promises that were due BEFORE today and are still open ───────────────────
  // A promise made to a customer and quietly missed is the one thing in this brief
  // worth waking up to, so it is called out separately rather than buried in a count.
  let overdue: any[] = [];
  try {
    overdue = (await pool.query(
      `SELECT e.id, e.title, e.day_key, c.name AS customer_name,
              COALESCE(string_agg(u.display_name, ', ' ORDER BY u.display_name), '') AS who
         FROM diary_entries e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN diary_entry_people p ON p.entry_id = e.id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE e.status = 'booked' AND e.kind = 'promise'
          AND e.start_at IS NULL AND e.day_key IS NOT NULL AND e.day_key < $1
        GROUP BY e.id, c.name
        ORDER BY e.day_key
        LIMIT 10`, [dk])).rows;
  } catch (err: any) { console.error('[brief] overdue promises failed:', err.message); }

  // ── The case board in one line ───────────────────────────────────────────────
  let cases: any = null;
  try {
    cases = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int              AS open,
              COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')
                                 AND assigned_user_id IS NULL)::int                          AS unassigned,
              COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')
                                 AND activity_status = 'unread')::int                        AS unread
         FROM inbox_tickets
        WHERE deleted_at IS NULL`)).rows[0];
  } catch (err: any) { console.error('[brief] case counts failed:', err.message); }

  // ── Assemble ─────────────────────────────────────────────────────────────────
  const day = prettyDay(dk);
  const title = `Today — ${day}`;
  const T: string[] = [];
  const H: string[] = [];

  const line = (t: string, h?: string) => { T.push(t); H.push(h == null ? esc(t) : h); };

  if (timed.length) {
    line('');
    line(timed.length === 1 ? 'In the diary' : `In the diary (${timed.length})`,
         `<strong>${timed.length === 1 ? 'In the diary' : 'In the diary (' + timed.length + ')'}</strong>`);
    for (const e of timed) {
      const k = DIARY_KINDS[String(e.kind)];
      const when = `${londonHM(Number(e.s))}–${londonHM(Number(e.en))}`;
      const bits = [e.title, e.customer_name, e.who].filter(Boolean).join(' · ');
      const kindLabel = k ? k.label : String(e.kind);
      line(`  ${when}  ${kindLabel}: ${bits}`,
           `• <strong>${esc(when)}</strong> ${esc(kindLabel)}: ${esc(bits)}` +
           (e.online_meeting_url ? ' <a href="' + esc(e.online_meeting_url) + '">Join</a>' : ''));
    }
  }

  if (off.length) {
    line('');
    line('Out today', '<strong>Out today</strong>');
    for (const e of off) line(`  ${e.who || 'Someone'} — ${e.title}`, `• ${esc(e.who || 'Someone')} — ${esc(e.title)}`);
  }

  if (due.length) {
    line('');
    line('Promised for today', '<strong>Promised for today</strong>');
    for (const e of due) {
      const bits = [e.title, e.customer_name, e.who].filter(Boolean).join(' · ');
      line(`  ${bits}`, `• ${esc(bits)}`);
    }
  }

  if (overdue.length) {
    line('');
    line(`Still open from before (${overdue.length})`, `<strong>Still open from before (${overdue.length})</strong>`);
    for (const e of overdue) {
      const bits = [e.title, e.customer_name, e.who].filter(Boolean).join(' · ');
      line(`  ${e.day_key} — ${bits}`, `• <strong>${esc(e.day_key)}</strong> — ${esc(bits)}`);
    }
  }

  if (cases && Number(cases.open) > 0) {
    line('');
    const bits = `${cases.open} open` +
      (Number(cases.unassigned) ? `, ${cases.unassigned} unassigned` : '') +
      (Number(cases.unread) ? `, ${cases.unread} unread` : '');
    line(`Cases: ${bits}`, `<strong>Cases:</strong> ${esc(bits)}`);
  }

  const empty = !timed.length && !off.length && !due.length && !overdue.length;
  if (empty) {
    line('');
    line('Nothing booked. No promises due. Quiet one.');
  }

  T.push('');
  T.push(`${appUrl}/diary/week`);
  H.push(`<p><a href="${appUrl}/diary/week">Open the diary</a></p>`);

  return { dayKey: dk, title, text: [title, ...T].join('\n').trim(), html: `<p><strong>${esc(title)}</strong></p>` + H.join('<br>'), empty };
}

/** True when the classic/Workflows channel webhook shape is the only one that will render. */
function isOfficeConnector(url: string): boolean {
  return /webhook\.office\.com|office\.com\/webhook/i.test(url);
}

/**
 * Post the brief to the Teams channel. Returns what happened rather than throwing, so a
 * scheduler can log it without a try/catch of its own.
 */
export async function postDailyBrief(brief: DailyBrief): Promise<{ ok: boolean; error?: string; skipped?: string }> {
  const url = ((await getSetting('integrations', 'teams_channel_webhook').catch(() => null)) || '').trim()
           || ((await getSetting('integrations', 'teams_webhook').catch(() => null)) || '').trim();
  if (!url) return { ok: false, skipped: 'No Teams channel webhook is configured.' };

  const body = isOfficeConnector(url)
    ? {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: brief.title,
        themeColor: '0EA5B7',
        title: brief.title,
        text: brief.html,
      }
    : { channel: true, title: brief.title, text: brief.text, html: brief.html };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : '') };
    }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

// ── The 06:00 scheduler ─────────────────────────────────────────────────────────
// Deliberately NOT a setInterval on 24 hours: a deploy at 09:00 would move the post to
// 09:00 for good, and BST would drift it by an hour twice a year. This wakes every
// minute, asks the clock in London what time it is, and posts on the first tick of the
// configured minute — then remembers the day so a restart inside that minute cannot
// post twice.
let lastPostedDay: string | null = null;

export function startDailyBriefCron(): void {
  const check = async () => {
    try {
      const when = ((await getSetting('diary', 'brief_time').catch(() => null)) || '06:00').trim();
      const m = /^(\d{1,2}):(\d{2})$/.exec(when);
      if (!m) return;
      const now = new Date().toLocaleString('en-GB', {
        timeZone: LONDON, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const hh = String(parseInt(m[1], 10)).padStart(2, '0');
      if (now !== `${hh}:${m[2]}`) return;

      const dk = londonToday();
      if (lastPostedDay === dk) return;
      lastPostedDay = dk;

      const weekendsOff = ((await getSetting('diary', 'brief_weekends').catch(() => null)) || '').toLowerCase() !== 'on';
      if (weekendsOff && isWeekend(dk)) { console.log('[brief] %s is a weekend - not posting', dk); return; }

      const brief = await buildDailyBrief(dk);
      const quietOff = ((await getSetting('diary', 'brief_quiet').catch(() => null)) || '').toLowerCase() === 'off';
      if (brief.empty && quietOff) { console.log('[brief] %s is empty - not posting', dk); return; }

      const r = await postDailyBrief(brief);
      if (r.ok) console.log('[brief] posted the %s brief', dk);
      else console.warn('[brief] %s brief NOT posted: %s', dk, r.error || r.skipped);
    } catch (e: any) { console.error('[brief] cron failed:', e.message); }
  };
  setInterval(() => { check().catch(() => {}); }, 60 * 1000);
  console.log('[brief] daily Teams brief scheduler started');
}

export { londonToday, dayKeyOf };
