import { pool } from '../db/pool';
import {
  DIARY_KINDS, dayKeyOf, addDays, dayRange, londonEpoch, londonHM, diaryWhenText,
  diaryPeople, saveEntry, SaveInput,
} from './diary';
import { freeBusy } from './diary-graph';

// ── Customer bookings — the MS-Bookings-shaped front door ───────────────────────
//
// Two rules decide everything in here:
//
//   1. A slot that is OFFERED must be genuinely free. Availability is computed from the
//      live diary and Outlook, not from an idea of office hours, so nothing is shown that
//      would land on top of an onsite visit, a day off or a dentist appointment.
//   2. The OFFER is not the booking. Two customers can be looking at the same slot, so the
//      write still goes through the diary's own hard block (saveEntry) and through a
//      fresh Outlook check. If it has gone in the meantime the second person is told so.
//
// The booking IS a diary entry — same pool, same clash engine, same push to Outlook. A
// booking the clash engine cannot see is a double-booking waiting to happen, which is
// how bolt-on booking systems fail.

export interface BookingService {
  id: number; name: string; blurb: string | null; kind: string;
  durationMins: number; bufferMins: number; slotStepMins: number;
  leadTimeHours: number; horizonDays: number;
  windowStart: string; windowEnd: string;
  weekdays: number[];            // ISO: Mon=1 … Sun=7
  staffIds: number[];            // empty = anyone in the diary
  maxPerDay: number | null;
  teamsMeeting: boolean; itsmOnly: boolean;
  colour: string | null; isActive: boolean; sortOrder: number;
  slug: string | null; isPublic: boolean; locationText: string | null;
  msServiceId: string | null;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const intList = (v: any): number[] =>
  (Array.isArray(v) ? v : []).map((n: any) => parseInt(String(n), 10)).filter(Number.isInteger);

const MAP = (x: any): BookingService => ({
  id: Number(x.id), name: String(x.name), blurb: x.blurb || null, kind: String(x.kind || 'remote'),
  durationMins: Number(x.duration_mins || 30), bufferMins: Number(x.buffer_mins || 0),
  slotStepMins: Math.max(5, Number(x.slot_step_mins || 30)),
  leadTimeHours: Math.max(0, Number(x.lead_time_hours ?? 4)),
  horizonDays: Math.max(1, Number(x.horizon_days || 30)),
  windowStart: HM.test(String(x.window_start)) ? String(x.window_start) : '09:00',
  windowEnd: HM.test(String(x.window_end)) ? String(x.window_end) : '17:00',
  weekdays: intList(x.weekdays).filter(d => d >= 1 && d <= 7).length ? intList(x.weekdays) : [1, 2, 3, 4, 5],
  staffIds: intList(x.staff_ids),
  maxPerDay: x.max_per_day == null ? null : Number(x.max_per_day),
  teamsMeeting: !!x.teams_meeting, itsmOnly: !!x.itsm_only,
  colour: x.colour || null, isActive: !!x.is_active, sortOrder: Number(x.sort_order || 0),
  slug: x.slug || null, isPublic: !!x.is_public, locationText: x.location_text || null,
  msServiceId: x.ms_service_id || null,
});

/** A URL-safe slug for a service name, unique against everything already stored. */
export async function uniqueSlug(name: string, exceptId: number | null = null): Promise<string> {
  const base = String(name || 'booking').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'booking';
  for (let n = 0; n < 50; n++) {
    const cand = n === 0 ? base : `${base}-${n + 1}`;
    const r = await pool.query('SELECT id FROM booking_services WHERE slug=$1', [cand]);
    if (!r.rows.length || (exceptId != null && r.rows.every((x: any) => Number(x.id) === exceptId))) return cand;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function listServices(activeOnly = true): Promise<BookingService[]> {
  const r = await pool.query(
    `SELECT * FROM booking_services ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY sort_order, lower(name)`);
  return r.rows.map(MAP);
}

export async function getService(id: number): Promise<BookingService | null> {
  const r = await pool.query('SELECT * FROM booking_services WHERE id=$1', [id]);
  return r.rows.length ? MAP(r.rows[0]) : null;
}

export async function getServiceBySlug(slug: string): Promise<BookingService | null> {
  const r = await pool.query('SELECT * FROM booking_services WHERE slug=$1', [String(slug || '')]);
  return r.rows.length ? MAP(r.rows[0]) : null;
}

/**
 * What the PUBLIC page offers. Public and active are two separate switches on purpose:
 * closing a service to new bookings must not silently republish it later when someone
 * reopens it, and a service can be live for signed-in customers while still being kept
 * off the open web.
 *
 * `customerId` is whoever we recognised from the link's token — null for a stranger. A
 * Managed-IT-only service is never shown to a stranger: we cannot check the entitlement,
 * and offering something we would then have to withdraw is worse than not offering it.
 */
export async function publicServices(customerId: number | null): Promise<BookingService[]> {
  const r = await pool.query(
    `SELECT * FROM booking_services WHERE is_active = true AND is_public = true AND slug IS NOT NULL
      ORDER BY sort_order, lower(name)`);
  const all = r.rows.map(MAP);
  if (!all.some(x => x.itsmOnly)) return all;
  if (customerId == null) return all.filter(x => !x.itsmOnly);
  const itsm = !!(await pool.query('SELECT is_itsm FROM customers WHERE id=$1', [customerId])
    .catch(() => ({ rows: [] as any[] }))).rows[0]?.is_itsm;
  return itsm ? all : all.filter(x => !x.itsmOnly);
}

/** What a given customer may book: active services, minus Managed-IT-only ones if they are not. */
export async function servicesForCustomer(customerId: number): Promise<BookingService[]> {
  const all = await listServices(true);
  if (!all.some(s => s.itsmOnly)) return all;
  const itsm = !!(await pool.query('SELECT is_itsm FROM customers WHERE id=$1', [customerId])
    .catch(() => ({ rows: [] as any[] }))).rows[0]?.is_itsm;
  return itsm ? all : all.filter(s => !s.itsmOnly);
}

// ── Availability ────────────────────────────────────────────────────────────────

export interface Busy { start: number; end: number }

/**
 * Every person's committed time over a window, as epoch intervals already widened by the
 * buffer that entry carries. All-day time off becomes a whole-day interval — booking
 * someone who is on leave is exactly the mistake this prevents.
 *
 * This is a READ used to decide what to OFFER. It is not the safety net: the safety net
 * is saveEntry's SQL clash check, which runs again at the moment of writing.
 */
export async function busyByPerson(personIds: number[], fromDay: string, toDay: string): Promise<Map<number, Busy[]>> {
  const out = new Map<number, Busy[]>();
  for (const id of personIds) out.set(id, []);
  if (!personIds.length) return out;

  const days = dayRange(fromDay, toDay);
  const r = await pool.query(
    `SELECT p.user_id, e.buffer_mins, e.kind, e.day_key, e.end_day_key,
            EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en
       FROM diary_entries e
       JOIN diary_entry_people p ON p.entry_id = e.id
      WHERE p.user_id = ANY($1) AND e.status = 'booked'
        AND (
              (e.start_at IS NOT NULL
               AND to_char(e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') = ANY($2::text[]))
           OR (e.start_at IS NULL AND e.kind = 'timeoff' AND e.day_key IS NOT NULL
               AND e.day_key <= $4 AND COALESCE(e.end_day_key, e.day_key) >= $3)
            )`,
    [personIds, days, days[0], days[days.length - 1]]);

  for (const x of r.rows) {
    const uid = Number(x.user_id);
    const list = out.get(uid);
    if (!list) continue;
    if (x.s) {
      const buf = Number(x.buffer_mins || 0) * 60;
      list.push({ start: Number(x.s) - buf, end: Number(x.en) + buf });
    } else {
      // All-day time off: block each day it covers, midnight to midnight local.
      for (const dk of dayRange(String(x.day_key), x.end_day_key ? String(x.end_day_key) : null)) {
        if (dk < days[0] || dk > days[days.length - 1]) continue;
        list.push({ start: londonEpoch(dk, '00:00'), end: londonEpoch(addDays(dk, 1), '00:00') });
      }
    }
  }
  return out;
}

const clashesAny = (list: Busy[], start: number, end: number): boolean =>
  list.some(b => b.start < end && b.end > start);

export interface Slot { start: number; end: number; staffId: number; dayKey: string; label: string }

/**
 * The slots to OFFER for a service. A slot survives only if at least one eligible person
 * is free for it in the diary AND in Outlook; the person named is the one carrying the
 * fewest bookings that day, so customer bookings spread rather than piling on whoever
 * sorts first.
 *
 * `outlookWarning` is non-null when Graph could not be reached. Availability is still
 * returned — refusing to show anything because a permission is missing helps nobody —
 * but the caller must say so rather than present it as certain.
 */
export async function availableSlots(
  svc: BookingService, fromDay: string, toDay: string,
): Promise<{ slots: Slot[]; outlookWarning: string | null }> {
  const people = await diaryPeople();
  const eligible = svc.staffIds.length ? people.filter(p => svc.staffIds.includes(p.id)) : people;
  if (!eligible.length) return { slots: [], outlookWarning: null };

  const ids = eligible.map(p => p.id);
  const busy = await busyByPerson(ids, fromDay, toDay);

  // Outlook: one call per person across the WHOLE window, not per slot.
  let outlookWarning: string | null = null;
  const winStart = londonEpoch(fromDay, '00:00');
  const winEnd = londonEpoch(addDays(toDay, 1), '00:00');
  const fb = await freeBusy(eligible.map(p => p.email), winStart, winEnd);
  outlookWarning = fb.warning;
  for (const b of fb.busy) {
    if (b.status === 'tentative') continue;          // tentative does not block, same as the staff rule
    if (b.shared) {
      // A block somebody put in the shared remote-work diary by hand. It belongs to the
      // company, not to one mailbox, so while it stands nobody is offered that slot.
      // Mirrors the Portal wrote are not in this list - freeBusy drops anything tagged
      // [LumenMSP Diary] - so a booking never blocks the person it was booked for.
      for (const p of eligible) busy.get(p.id)!.push({ start: b.s, end: b.e });
      continue;
    }
    const person = eligible.find(p => p.email.toLowerCase() === String(b.email).toLowerCase());
    if (person) busy.get(person.id)!.push({ start: b.s, end: b.e });
  }

  // How many customer bookings each day already holds, for the per-day cap.
  const perDay = new Map<string, number>();
  if (svc.maxPerDay) {
    const c = await pool.query(
      `SELECT to_char(start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') dk, COUNT(*)::int n
         FROM diary_entries
        WHERE booking_service_id=$1 AND status='booked' AND start_at IS NOT NULL
        GROUP BY 1`, [svc.id]);
    for (const x of c.rows) perDay.set(String(x.dk), Number(x.n));
  }

  const now = Math.floor(Date.now() / 1000);
  const earliest = now + svc.leadTimeHours * 3600;
  const buf = svc.bufferMins * 60;
  const slots: Slot[] = [];

  for (const dk of dayRange(fromDay, toDay)) {
    const jsDow = new Date(dk + 'T12:00:00Z').getUTCDay();       // 0 Sun … 6 Sat
    const iso = jsDow === 0 ? 7 : jsDow;                          // ISO: Mon=1 … Sun=7
    if (!svc.weekdays.includes(iso)) continue;
    if (svc.maxPerDay && (perDay.get(dk) || 0) >= svc.maxPerDay) continue;

    const dayOpen = londonEpoch(dk, svc.windowStart);
    const dayShut = londonEpoch(dk, svc.windowEnd);
    // Load is measured across the WHOLE day, not just the bookable window: someone whose
    // afternoon is full is still the busier person, and should not also take the morning
    // slot while a colleague is free. Counted once per day, not per slot.
    const midnight = londonEpoch(dk, '00:00');
    const nextMidnight = londonEpoch(addDays(dk, 1), '00:00');
    const dayLoad = new Map<number, number>();
    for (const p of eligible) {
      dayLoad.set(p.id, busy.get(p.id)!.filter(b => b.start < nextMidnight && b.end > midnight).length);
    }
    for (let t = dayOpen; t + svc.durationMins * 60 <= dayShut; t += svc.slotStepMins * 60) {
      const end = t + svc.durationMins * 60;
      if (t < earliest) continue;
      // Whoever is free AND least busy that day takes it — spread, not first-come-first-loaded.
      const free = eligible.filter(p => !clashesAny(busy.get(p.id)!, t - buf, end + buf));
      if (!free.length) continue;
      const pick = free.slice().sort((a, b) => (dayLoad.get(a.id)! - dayLoad.get(b.id)!) || a.id - b.id)[0];
      slots.push({ start: t, end, staffId: pick.id, dayKey: dk, label: `${londonHM(t)}–${londonHM(end)}` });
    }
  }
  return { slots, outlookWarning };
}

// ── Booking ─────────────────────────────────────────────────────────────────────

export interface BookInput {
  service: BookingService;
  startEpoch: number;
  // Null when a stranger books from the public page and we could not match them to a
  // customer. The booking is still real and still blocks the diary — it just arrives
  // needing a human to say who it belongs to.
  customerId: number | null;
  bookedByUserId: number | null;   // null for a public booking (no Portal login behind it)
  name: string; email: string; phone: string | null;
  company: string | null;          // what a public booker typed, kept verbatim
  notes: string | null;
}

export interface BookResult {
  ok: boolean; entryId?: number; staffName?: string; staffEmail?: string;
  cancelToken?: string; error?: string; taken?: boolean;
}

function token(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(36);
  return s.slice(0, 24);
}

/**
 * Take a slot. Re-checks availability from scratch — the page the customer is looking at
 * may be minutes old — then writes through the diary's own hard block. A slot that has
 * gone comes back as `taken`, which the page turns into "that time has just been taken"
 * rather than a stack trace or, worse, a silent double-booking.
 */
export async function bookSlot(inp: BookInput): Promise<BookResult> {
  const svc = inp.service;
  if (!DIARY_KINDS[svc.kind]) return { ok: false, error: 'That service is misconfigured — tell us and we will fix it.' };
  const dk = dayKeyOf(inp.startEpoch);
  const end = inp.startEpoch + svc.durationMins * 60;

  // Fresh availability for that day only: cheap, and it is the offer being re-tested.
  const { slots } = await availableSlots(svc, dk, dk);
  const slot = slots.find(s => s.start === inp.startEpoch);
  if (!slot) return { ok: false, taken: true, error: 'That time has just been taken. Please pick another.' };

  const people = await diaryPeople();
  const staff = people.find(p => p.id === slot.staffId);
  if (!staff) return { ok: false, error: 'No-one is available for that time.' };

  const customer = inp.customerId == null
    ? null
    : (await pool.query('SELECT name FROM customers WHERE id=$1', [inp.customerId])).rows[0] || null;
  // Who this is FOR, in the words most useful on a diary card: the customer we matched,
  // else the company they typed, else their own name. Never an empty dash.
  const who = customer?.name || (inp.company || '').trim() || inp.name || 'a customer';
  const title = `${svc.name} — ${who}`;

  const save: SaveInput = {
    kind: svc.kind, title,
    notes: [inp.notes, `Booked by ${inp.name}${inp.company ? ' of ' + inp.company : ''} `
      + `(${inp.email}${inp.phone ? ', ' + inp.phone : ''})`].filter(Boolean).join('\n\n'),
    customerId: inp.customerId, ticketId: null, personIds: [staff.id],
    startEpoch: inp.startEpoch, endEpoch: end, dayKey: null, endDayKey: null,
    bufferMins: svc.bufferMins, colour: svc.colour,
    recurrence: 'none', recurrenceEnd: null, createdBy: null,
  };
  const saved = await saveEntry(null, save);
  // saveEntry lost the race against another write — that IS the safety net doing its job.
  if (!saved.ok) return { ok: false, taken: !!saved.clashes, error: saved.error || 'That time has just been taken. Please pick another.' };

  const cancelToken = token();
  await pool.query(
    `UPDATE diary_entries SET booking_service_id=$2, booked_by_user_id=$3, booked_by_name=$4,
            booked_by_email=$5, booked_by_phone=$6, cancel_token=$7, booked_by_company=$8 WHERE id=$1`,
    [saved.id, svc.id, inp.bookedByUserId, inp.name.slice(0, 120), inp.email.slice(0, 190),
     inp.phone ? inp.phone.slice(0, 40) : null, cancelToken,
     inp.company ? inp.company.slice(0, 160) : null]);

  return { ok: true, entryId: saved.id, staffName: staff.name, staffEmail: staff.email, cancelToken };
}

/** A booking a customer may see or cancel — always re-scoped to their own company. */
export async function customerBookings(customerId: number, includePast = false): Promise<any[]> {
  const r = await pool.query(
    `SELECT e.id, e.title, e.status, e.online_meeting_url, e.booked_by_name, e.notes,
            EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en,
            bs.name AS service_name, bs.teams_meeting,
            COALESCE(string_agg(u.display_name, ', ' ORDER BY u.id), '') AS staff
       FROM diary_entries e
       JOIN booking_services bs ON bs.id = e.booking_service_id
       LEFT JOIN diary_entry_people p ON p.entry_id = e.id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE e.customer_id = $1 AND e.booking_service_id IS NOT NULL AND e.status <> 'cancelled'
        ${includePast ? '' : "AND e.end_at > NOW() - interval '2 hours'"}
      GROUP BY e.id, bs.name, bs.teams_meeting
      ORDER BY e.start_at`, [customerId]);
  return r.rows.map((x: any) => ({
    id: Number(x.id), title: String(x.title), status: String(x.status),
    start: Number(x.s), end: Number(x.en), whenText: diaryWhenText(Number(x.s)),
    timeText: `${londonHM(Number(x.s))}–${londonHM(Number(x.en))}`,
    serviceName: String(x.service_name), staff: String(x.staff || ''),
    joinUrl: x.online_meeting_url || null, wantsTeams: !!x.teams_meeting,
    notes: x.notes || null,
  }));
}

// ── Who is this? ────────────────────────────────────────────────────────────────
//
// The public page is open to anyone, but most people arriving at it are already ours —
// they clicked the link at the bottom of an email we sent them. Recognising them is
// worth real effort: it is the difference between "Hello Sarah, the usual details?" and
// a blank form that asks a customer of eight years to type their own email address.
//
// Two ways we recognise someone, in order of confidence:
//   1. The signed token on the link — we know exactly which contact we sent it to.
//   2. The email address they type — matched to a contact, and failing that to a
//      customer by email DOMAIN.
//
// Neither is treated as proof of anything. Recognition changes what we PRE-FILL and
// which customer the booking is filed against; it never unlocks a service, and a
// booking we cannot place is filed with no customer for a human to sort out, never
// guessed at.

export interface KnownBooker {
  contactId: number | null;
  customerId: number | null;
  customerName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
}

const EMPTY_BOOKER: KnownBooker = {
  contactId: null, customerId: null, customerName: null, name: null, email: null, phone: null,
};

/** The contact a booking-link token points at, with their company. Null token → nobody. */
export async function bookerFromContact(contactId: number | null): Promise<KnownBooker> {
  if (contactId == null) return { ...EMPTY_BOOKER };
  const r = await pool.query(
    `SELECT c.id, c.full_name, c.email, COALESCE(c.mobile_phone, c.phone) AS phone,
            c.customer_id, cu.name AS customer_name
       FROM customer_contacts c
       LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE c.id = $1 AND c.archived = false`, [contactId]);
  const x = r.rows[0];
  if (!x) return { ...EMPTY_BOOKER };
  return {
    contactId: Number(x.id), customerId: x.customer_id == null ? null : Number(x.customer_id),
    customerName: x.customer_name || null, name: x.full_name || null,
    email: x.email || null, phone: x.phone || null,
  };
}

// Domains that say nothing about who someone works for. Matching on these would file a
// booking against whichever customer happens to have a gmail address on record.
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'msn.com',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'protonmail.com', 'proton.me', 'gmx.com',
]);

/**
 * Place a typed email address. Exact contact match first; then the domain, but ONLY when
 * it lands on exactly one customer — two customers sharing a domain (a group and its
 * subsidiary, say) is precisely the case where a guess would file the meeting against the
 * wrong company, so we decline to guess and leave it for a human.
 */
export async function bookerFromEmail(email: string): Promise<KnownBooker> {
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { ...EMPTY_BOOKER };

  const c = await pool.query(
    `SELECT c.id, c.full_name, c.email, COALESCE(c.mobile_phone, c.phone) AS phone,
            c.customer_id, cu.name AS customer_name
       FROM customer_contacts c
       LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE lower(c.email) = $1 AND c.archived = false
      ORDER BY c.is_primary DESC, c.id LIMIT 1`, [addr]);
  if (c.rows.length) {
    const x = c.rows[0];
    return {
      contactId: Number(x.id), customerId: x.customer_id == null ? null : Number(x.customer_id),
      customerName: x.customer_name || null, name: x.full_name || null,
      email: x.email || null, phone: x.phone || null,
    };
  }

  const domain = addr.split('@')[1];
  if (!domain || PUBLIC_DOMAINS.has(domain)) return { ...EMPTY_BOOKER };
  const d = await pool.query(
    `SELECT DISTINCT c.customer_id, cu.name AS customer_name
       FROM customer_contacts c JOIN customers cu ON cu.id = c.customer_id
      WHERE c.archived = false AND lower(split_part(c.email, '@', 2)) = $1
      LIMIT 2`, [domain]);
  if (d.rows.length !== 1) return { ...EMPTY_BOOKER };   // 0 = unknown, 2 = ambiguous. Both mean "ask a human".
  return {
    ...EMPTY_BOOKER,
    customerId: Number(d.rows[0].customer_id),
    customerName: d.rows[0].customer_name || null,
  };
}

// ── One booking, by its cancel token ────────────────────────────────────────────
//
// The token in the confirmation email is the ONLY key to a public booking — the person
// who made it has no Portal login. It is 24 random characters, it is scoped to one row,
// and the worst it can do is cancel a meeting the holder already knows about.

export interface BookingDetail {
  id: number; title: string; status: string; serviceName: string; slug: string | null;
  start: number; end: number; whenText: string; timeText: string;
  staff: string; joinUrl: string | null; wantsTeams: boolean; kind: string;
  agenda: string | null; locationText: string | null;
  bookedByName: string | null; bookedByEmail: string | null; customerName: string | null;
  cancelToken: string | null;
}

const DETAIL_SQL = `
  SELECT e.id, e.title, e.status, e.kind, e.agenda, e.online_meeting_url, e.cancel_token,
         e.booked_by_name, e.booked_by_email,
         EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en,
         bs.name AS service_name, bs.slug, bs.teams_meeting, bs.location_text,
         cu.name AS customer_name,
         COALESCE(string_agg(DISTINCT u.display_name, ', '), '') AS staff
    FROM diary_entries e
    JOIN booking_services bs ON bs.id = e.booking_service_id
    LEFT JOIN customers cu ON cu.id = e.customer_id
    LEFT JOIN diary_entry_people p ON p.entry_id = e.id
    LEFT JOIN users u ON u.id = p.user_id`;

function mapDetail(x: any): BookingDetail {
  return {
    id: Number(x.id), title: String(x.title), status: String(x.status), kind: String(x.kind || 'remote'),
    serviceName: String(x.service_name), slug: x.slug || null,
    start: Number(x.s), end: Number(x.en),
    whenText: diaryWhenText(Number(x.s)),
    timeText: `${londonHM(Number(x.s))}–${londonHM(Number(x.en))}`,
    staff: String(x.staff || ''), joinUrl: x.online_meeting_url || null,
    wantsTeams: !!x.teams_meeting, agenda: x.agenda || null, locationText: x.location_text || null,
    bookedByName: x.booked_by_name || null, bookedByEmail: x.booked_by_email || null,
    customerName: x.customer_name || null, cancelToken: x.cancel_token || null,
  };
}

export async function bookingByToken(cancelToken: string): Promise<BookingDetail | null> {
  const t = String(cancelToken || '');
  if (t.length < 8) return null;                                   // never let a stub token scan the table
  const r = await pool.query(`${DETAIL_SQL} WHERE e.cancel_token = $1 GROUP BY e.id, bs.name, bs.slug, bs.teams_meeting, bs.location_text, cu.name`, [t]);
  return r.rows.length ? mapDetail(r.rows[0]) : null;
}

export async function bookingById(id: number): Promise<BookingDetail | null> {
  const r = await pool.query(`${DETAIL_SQL} WHERE e.id = $1 GROUP BY e.id, bs.name, bs.slug, bs.teams_meeting, bs.location_text, cu.name`, [id]);
  return r.rows.length ? mapDetail(r.rows[0]) : null;
}

// ── Agenda and the cases a meeting covers ───────────────────────────────────────
//
// A booking arrives as a time and a sentence. What makes it useful is what gets added to
// it afterwards: the agenda the engineer builds, and the open cases the meeting is
// actually going to work through. Both live on the entry, so they survive on the calendar
// invite, on the reminder and in the recap.

export async function setAgenda(entryId: number, agenda: string | null): Promise<void> {
  const a = agenda && agenda.trim() ? agenda.trim().slice(0, 4000) : null;
  await pool.query('UPDATE diary_entries SET agenda=$2, updated_at=NOW() WHERE id=$1', [entryId, a]);
}

export async function tagTicket(entryId: number, ticketId: number, byUserId: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO diary_entry_tickets (entry_id, ticket_id, added_by) VALUES ($1,$2,$3)
     ON CONFLICT (entry_id, ticket_id) DO NOTHING`, [entryId, ticketId, byUserId]);
}

export async function untagTicket(entryId: number, ticketId: number): Promise<void> {
  await pool.query('DELETE FROM diary_entry_tickets WHERE entry_id=$1 AND ticket_id=$2', [entryId, ticketId]);
}

export interface TaggedCase { id: number; ticketNumber: string; subject: string; status: string }

export async function entryTickets(entryId: number): Promise<TaggedCase[]> {
  const r = await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, t.status
       FROM diary_entry_tickets d JOIN inbox_tickets t ON t.id = d.ticket_id
      WHERE d.entry_id = $1 ORDER BY t.id`, [entryId]).catch(() => ({ rows: [] as any[] }));
  return r.rows.map((x: any) => ({
    id: Number(x.id), ticketNumber: String(x.ticket_number || ''),
    subject: String(x.subject || ''), status: String(x.status || ''),
  }));
}

/** The customer's open cases, to offer as things this meeting could cover. */
export async function openCasesFor(customerId: number | null, limit = 40): Promise<TaggedCase[]> {
  if (customerId == null) return [];
  const r = await pool.query(
    `SELECT id, ticket_number, subject, status FROM inbox_tickets
      WHERE customer_id=$1 AND deleted_at IS NULL AND is_spam = false
        AND status NOT IN ('resolved','closed')
      ORDER BY updated_at DESC LIMIT $2`, [customerId, limit]).catch(() => ({ rows: [] as any[] }));
  return r.rows.map((x: any) => ({
    id: Number(x.id), ticketNumber: String(x.ticket_number || ''),
    subject: String(x.subject || ''), status: String(x.status || ''),
  }));
}
