import { pool } from '../db/pool';
import { getGraphToken, graphConfigured } from './graph';
import { getSetting } from './settings';

// ── Diary ↔ Microsoft 365 — push + busy-check, PORTAL IS MASTER ─────────────────
// Two jobs only (no two-way sync, ever — see the Diary brief):
//
//   1. freeBusy(): at booking time, ask Graph getSchedule whether any named person
//      is already busy in Outlook — the dentist appointment that never touched the
//      Portal still blocks. Returns busy blocks; the caller hard-blocks on them.
//   2. pushEntry()/removeEntry(): mirror timed bookings (and all-day time off)
//      into each person's M365 calendar so phones and Outlook show them. Event ids
//      live in diary_entries.graph_sync ({"<userId>": "<eventId>"}).
//
// Graph requirement: APPLICATION permissions **Calendars.ReadWrite** (push) — which
// also satisfies getSchedule — with admin consent on the Portal app registration.
// Until Terry grants it, every call 403s: freeBusy degrades to a WARNING (we never
// block a booking because a permission is missing) and pushes are skipped quietly.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CATEGORY = 'LumenMSP Diary';

// ── The shared remote-work calendar ─────────────────────────────────────────────
// SP@lumenmsp.co.uk is a mailbox Terry and Andrew both have open. It is where remote
// work is meant to be visible without opening the Portal. It is a MIRROR, not a second
// master: the entry is still pushed to the named person's own calendar (that is what
// makes their phone right and what free/busy reads), and the shared copy sits beside it.
//
// Anything a HUMAN puts in that mailbox directly — a block, a shared commitment — is
// read back as busy for EVERYONE, because a block in the shared diary means nobody is
// taking remote work then. Our own mirrors never double-block: freeBusy skips any item
// whose subject carries the CATEGORY tag, and every pushed event carries it.
//
// Address and kinds are settings, not constants, so neither needs a deploy to change:
//   Admin → Settings → Diary   group 'diary', keys 'shared_mailbox' / 'shared_kinds'.
const SHARED_KEY = 'shared';                 // reserved key in diary_entries.graph_sync
const SHARED_KINDS_DEFAULT = ['remote'];

/** The shared calendar's address, or null when Terry has not named one. */
export async function sharedMailbox(): Promise<string | null> {
  try {
    const v = ((await getSetting('diary', 'shared_mailbox')) || '').trim().toLowerCase();
    return v.includes('@') ? v : null;
  } catch { return null; }
}

/** Which DIARY_KINDS mirror into the shared calendar. */
export async function sharedKinds(): Promise<string[]> {
  try {
    const raw = ((await getSetting('diary', 'shared_kinds')) || '').trim();
    if (!raw) return SHARED_KINDS_DEFAULT;
    const list = raw.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    return list.length ? list : SHARED_KINDS_DEFAULT;
  } catch { return SHARED_KINDS_DEFAULT; }
}

function localIso(epochSecs: number): string {
  // 'YYYY-MM-DDTHH:mm:ss' in Europe/London — what Graph wants next to a timeZone.
  return new Date(epochSecs * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T');
}

async function greq(method: string, path: string, body?: any): Promise<any> {
  const token = await getGraphToken();
  const res = await fetch(GRAPH + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(data?.error?.message || `Graph HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export interface BusyBlock { email: string; s: number; e: number; status: string; shared?: boolean }
export interface FreeBusyResult { busy: BusyBlock[]; warning: string | null; sharedEmail: string | null }

/**
 * Outlook busy blocks for the given mailboxes over [startEpoch, endEpoch).
 *
 * The shared remote-work calendar is ALWAYS added to the list when one is configured,
 * even if the caller did not ask for it, and its blocks come back flagged `shared:true`.
 * A caller that maps blocks onto a specific person must handle those separately — they
 * belong to the company, not to one mailbox. Anything the Portal itself pushed is
 * skipped, so a mirrored booking never blocks the person it was booked for.
 */
export async function freeBusy(emails: string[], startEpoch: number, endEpoch: number): Promise<FreeBusyResult> {
  const shareTo = await sharedMailbox();
  if (!graphConfigured() || (!emails.length && !shareTo)) return { busy: [], warning: null, sharedEmail: shareTo };
  const busy: BusyBlock[] = [];
  const seen = new Set<string>();
  const mailboxes: string[] = [];
  for (const e of [...emails, ...(shareTo ? [shareTo] : [])]) {
    const k = String(e || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k); mailboxes.push(e);
  }
  try {
    for (const email of mailboxes) {
      // Ask in UTC on purpose: getSchedule echoes times in the REQUESTED zone with
      // no offset, so requesting UTC is the only way `Date.parse(x + 'Z')` is exact
      // across the BST boundary (portal-timestamp-timezone-trap, Graph edition).
      const r = await greq('POST', `/users/${encodeURIComponent(email)}/calendar/getSchedule`, {
        schedules: [email],
        startTime: { dateTime: new Date(startEpoch * 1000).toISOString().slice(0, 19), timeZone: 'UTC' },
        endTime: { dateTime: new Date(endEpoch * 1000).toISOString().slice(0, 19), timeZone: 'UTC' },
        availabilityViewInterval: 15,
      });
      const items = r?.value?.[0]?.scheduleItems || [];
      for (const it of items) {
        const st = String(it.status || '').toLowerCase();
        if (st !== 'busy' && st !== 'oof') continue;          // tentative/free never block
        if (String(it.subject || '').includes(CATEGORY)) continue; // our own pushed events are not "Outlook"
        const s = Math.floor(Date.parse(it.start?.dateTime + 'Z') / 1000);
        const e = Math.floor(Date.parse(it.end?.dateTime + 'Z') / 1000);
        const isShared = !!shareTo && email.trim().toLowerCase() === shareTo;
        if (Number.isFinite(s) && Number.isFinite(e)) busy.push({ email, s, e, status: st, shared: isShared });
      }
    }
    return { busy, warning: null, sharedEmail: shareTo };
  } catch (e: any) {
    const why = e?.status === 403
      ? 'Outlook could not be checked — the app registration still needs Calendars.ReadWrite with admin consent.'
      : `Outlook could not be checked (${e.message}).`;
    return { busy: [], warning: why, sharedEmail: shareTo };
  }
}

/** Push (create or update) one entry into every named person's M365 calendar. Never throws. */
export async function pushEntry(entryId: number): Promise<void> {
  if (!graphConfigured()) return;
  try {
    const er = await pool.query(
      `SELECT e.*,
              -- The SERVICE asks for Teams on a customer booking; the ENTRY asks for it on
              -- one Terry created himself. Aliased explicitly because e.* already carries a
              -- teams_meeting of its own, and two columns of the same name is a coin toss.
              COALESCE(bs.teams_meeting, e.teams_meeting) AS wants_teams,
              EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en,
              c.name AS customer_name
         FROM diary_entries e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN booking_services bs ON bs.id = e.booking_service_id
        WHERE e.id=$1`, [entryId]);
    const e = er.rows[0];
    if (!e || e.status === 'cancelled') return;
    const timed = e.s != null && e.en != null;
    const allDayOff = e.kind === 'timeoff' && !timed && e.day_key;
    if (!timed && !allDayOff) return; // promises/tasks are day-lane noise Outlook does not need

    const people = (await pool.query(
      `SELECT u.id, u.email FROM diary_entry_people p JOIN users u ON u.id = p.user_id WHERE p.entry_id=$1`,
      [entryId])).rows;
    const sync: Record<string, string> = (e.graph_sync && typeof e.graph_sync === 'object') ? { ...e.graph_sync } : {};

    const subject = `${e.title}${e.customer_name ? ' — ' + e.customer_name : ''} [${CATEGORY}]`;
    const body = { contentType: 'text', content: (e.notes || '') + '\n\nBooked in the LumenMSP Portal Diary.' };
    const payload: any = allDayOff
      ? { subject, body, isAllDay: true, showAs: 'oof', categories: [CATEGORY],
          start: { dateTime: e.day_key + 'T00:00:00', timeZone: 'Europe/London' },
          end: { dateTime: `${new Date(Date.parse(e.day_key + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)}T00:00:00`, timeZone: 'Europe/London' } }
      : { subject, body, showAs: 'busy', categories: [CATEGORY],
          start: { dateTime: localIso(Number(e.s)), timeZone: 'Europe/London' },
          end: { dateTime: localIso(Number(e.en)), timeZone: 'Europe/London' } };

    // A service that says it needs Teams gets a real online meeting on the FIRST person's
    // copy, and that join link is written back so the confirmation email and the customer's
    // own bookings page can show it. Only the first copy asks for one: two people's calendars
    // would otherwise produce two different meetings for one appointment.
    const wantsTeams = !!e.wants_teams && timed;
    let joinUrl: string | null = e.online_meeting_url || null;

    for (const p of people) {
      try {
        const existing = sync[String(p.id)];
        const first = people[0] && people[0].id === p.id;
        // Ask for the online meeting only when creating the organiser's copy and we do not
        // already hold a link — a PATCH that re-requests one can rebuild the meeting.
        const thisPayload = (wantsTeams && first && !existing && !joinUrl)
          ? { ...payload, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }
          : (wantsTeams && joinUrl && !existing
              ? { ...payload, body: { contentType: 'text', content: (payload.body.content || '') + '\n\nJoin: ' + joinUrl } }
              : payload);
        if (existing) {
          await greq('PATCH', `/users/${encodeURIComponent(p.email)}/events/${encodeURIComponent(existing)}`, thisPayload);
        } else {
          const created = await greq('POST', `/users/${encodeURIComponent(p.email)}/events`, thisPayload);
          if (created?.id) sync[String(p.id)] = String(created.id);
          if (!joinUrl && created?.onlineMeeting?.joinUrl) joinUrl = String(created.onlineMeeting.joinUrl);
        }
      } catch (err: any) {
        if (err?.status === 404 && sync[String(p.id)]) {
          delete sync[String(p.id)];                       // event deleted in Outlook — recreate next push
        } else {
          console.error(`[diary] Graph push failed for ${p.email}:`, err.message);
        }
      }
    }
    // ── Mirror into the shared remote-work calendar ─────────────────────────────
    // One copy for the company, beside the personal copies, so Terry and Andrew both
    // see remote work without opening the Portal. It never asks for its own Teams
    // meeting: it carries the join link the organiser's copy produced, because two
    // requests would make two different meetings for one appointment.
    const shareTo = await sharedMailbox();
    const shareThis = !!shareTo && (await sharedKinds()).includes(String(e.kind)) && e.status !== 'cancelled';
    if (shareThis) {
      try {
        const existing = sync[SHARED_KEY];
        const sharedPayload = joinUrl
          ? { ...payload, body: { contentType: 'text', content: (payload.body.content || '') + '\n\nJoin: ' + joinUrl } }
          : payload;
        if (existing) {
          await greq('PATCH', `/users/${encodeURIComponent(shareTo!)}/events/${encodeURIComponent(existing)}`, sharedPayload);
        } else {
          const created = await greq('POST', `/users/${encodeURIComponent(shareTo!)}/events`, sharedPayload);
          if (created?.id) sync[SHARED_KEY] = String(created.id);
        }
      } catch (err: any) {
        if (err?.status === 404 && sync[SHARED_KEY]) delete sync[SHARED_KEY];   // deleted there — recreate next push
        else console.error(`[diary] Graph push to the shared calendar (${shareTo}) failed:`, err.message);
      }
    } else if (sync[SHARED_KEY] && shareTo) {
      // The kind changed, or sharing was turned off: take the mirror back out.
      await greq('DELETE', `/users/${encodeURIComponent(shareTo)}/events/${encodeURIComponent(sync[SHARED_KEY])}`).catch(() => {});
      delete sync[SHARED_KEY];
    }

    // People removed from the entry lose their calendar copy.
    const keep = new Set(people.map((p: any) => String(p.id)));
    for (const uid of Object.keys(sync)) {
      if (uid === SHARED_KEY) continue;   // not a person — handled above
      if (keep.has(uid)) continue;
      const em = (await pool.query(`SELECT email FROM users WHERE id=$1`, [Number(uid)])).rows[0];
      if (em) await greq('DELETE', `/users/${encodeURIComponent(em.email)}/events/${encodeURIComponent(sync[uid])}`).catch(() => {});
      delete sync[uid];
    }
    await pool.query(`UPDATE diary_entries SET graph_sync=$1, online_meeting_url=COALESCE($3, online_meeting_url) WHERE id=$2`,
      [JSON.stringify(sync), entryId, joinUrl]);
  } catch (err: any) {
    console.error('[diary] Graph push failed:', err.message);
  }
}

/** Delete an entry's pushed events (entry cancelled). Never throws. */
export async function removeEntry(entryId: number): Promise<void> {
  if (!graphConfigured()) return;
  try {
    const e = (await pool.query(`SELECT graph_sync FROM diary_entries WHERE id=$1`, [entryId])).rows[0];
    const sync: Record<string, string> = (e?.graph_sync && typeof e.graph_sync === 'object') ? e.graph_sync : {};
    const shareTo = await sharedMailbox();
    for (const [uid, evId] of Object.entries(sync)) {
      // SHARED_KEY is the company mirror, not a user id — look it up in settings, not users.
      const addr = uid === SHARED_KEY
        ? shareTo
        : ((await pool.query(`SELECT email FROM users WHERE id=$1`, [Number(uid)])).rows[0] || {}).email || null;
      if (addr) await greq('DELETE', `/users/${encodeURIComponent(addr)}/events/${encodeURIComponent(evId)}`).catch(() => {});
    }
    await pool.query(`UPDATE diary_entries SET graph_sync='{}'::jsonb WHERE id=$1`, [entryId]);
  } catch (err: any) {
    console.error('[diary] Graph remove failed:', err.message);
  }
}
