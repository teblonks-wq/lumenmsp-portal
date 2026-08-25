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
});

export async function listServices(activeOnly = true): Promise<BookingService[]> {
  const r = await pool.query(
    `SELECT * FROM booking_services ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY sort_order, lower(name)`);
  return r.rows.map(MAP);
}

export async function getService(id: number): Promise<BookingService | null> {
  const r = await pool.query('SELECT * FROM booking_services WHERE id=$1', [id]);
  return r.rows.length ? MAP(r.rows[0]) : null;
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
  customerId: number;
  bookedByUserId: number;
  name: string; email: string; phone: string | null;
  notes: string | null;
}

export interface BookResult {
  ok: boolean; entryId?: number; staffName?: string; error?: string; taken?: boolean;
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

  const customer = (await pool.query('SELECT name FROM customers WHERE id=$1', [inp.customerId])).rows[0];
  const title = `${svc.name} — ${customer?.name || inp.name}`;

  const save: SaveInput = {
    kind: svc.kind, title,
    notes: [inp.notes, `Booked by ${inp.name} (${inp.email}${inp.phone ? ', ' + inp.phone : ''})`]
      .filter(Boolean).join('\n\n'),
    customerId: inp.customerId, ticketId: null, personIds: [staff.id],
    startEpoch: inp.startEpoch, endEpoch: end, dayKey: null, endDayKey: null,
    bufferMins: svc.bufferMins, colour: svc.colour,
    recurrence: 'none', recurrenceEnd: null, createdBy: null,
  };
  const saved = await saveEntry(null, save);
  // saveEntry lost the race against another write — that IS the safety net doing its job.
  if (!saved.ok) return { ok: false, taken: !!saved.clashes, error: saved.error || 'That time has just been taken. Please pick another.' };

  await pool.query(
    `UPDATE diary_entries SET booking_service_id=$2, booked_by_user_id=$3, booked_by_name=$4,
            booked_by_email=$5, booked_by_phone=$6, cancel_token=$7 WHERE id=$1`,
    [saved.id, svc.id, inp.bookedByUserId, inp.name.slice(0, 120), inp.email.slice(0, 190),
     inp.phone ? inp.phone.slice(0, 40) : null, token()]);

  return { ok: true, entryId: saved.id, staffName: staff.name };
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
