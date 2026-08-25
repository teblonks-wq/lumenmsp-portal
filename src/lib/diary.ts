import { pool } from '../db/pool';

// ── The Diary — one pool of entries, hard-block clash engine ────────────────────
// Design agreed 2026-08-17 (brief: 02 Projects/[C] Diary — business scheduling
// design brief.md). The rules that matter:
//
//   * ONE pool: the diaries (Mine / Andy's / Support / Onsite / Company Week) are
//     views, never separate stores. An entry names one or both staff.
//   * HARD BLOCK: a timed entry that overlaps any named person's existing timed
//     entry cannot be saved. No override — move the other thing first, so the
//     diary never lies. Time off blocks exactly like a clash.
//   * Travel buffer: onsite entries carry buffer_mins EACH side; the clash check
//     expands BOTH the proposal's and the existing entry's interval by their own
//     buffers, so back-to-back Didcot and a remote session are caught.
//   * Day-lane items (task / promise) belong to a day, not an hour. They never
//     clash and are never given fake times.
//
// Time handling follows the estate rule (portal-timestamp-timezone-trap): the
// BROWSER converts picked local times to epochs; we write to_timestamp(epoch) and
// read EXTRACT(EPOCH ...). Day keys ('YYYY-MM-DD') are always Europe/London.

export const DIARY_KINDS: Record<string, { label: string; timed: boolean; accent: string }> = {
  onsite:  { label: 'Onsite',            timed: true,  accent: '#0ea5b7' },
  remote:  { label: 'Remote support',    timed: true,  accent: '#2563eb' },
  catchup: { label: 'Customer catch-up', timed: true,  accent: '#7c3aed' },
  meeting: { label: 'IT meeting',        timed: true,  accent: '#0891b2' },
  timeoff: { label: 'Time off',          timed: false, accent: '#64748b' }, // timed OR all-day
  promise: { label: 'Promise',           timed: false, accent: '#d97706' },
  task:    { label: 'Task',              timed: false, accent: '#16a34a' },
};

// ── Colour ──────────────────────────────────────────────────────────────────────
// A card's colour comes from its KIND by default; `colour` overrides it so a run of
// visits for one customer, or one person's standing commitments, can be told apart at
// a glance. Accents are plain hex ON PURPOSE: the view mixes them into the surface
// with color-mix(), which is what makes one palette work in all three themes without
// a second set of dark values. These are the house accents (see the colour-scheme
// note) — do NOT add another teal.
export const DIARY_COLOURS: Record<string, { label: string; accent: string }> = {
  teal:   { label: 'Teal',   accent: '#0ea5b7' },
  blue:   { label: 'Blue',   accent: '#2563eb' },
  violet: { label: 'Violet', accent: '#7c3aed' },
  green:  { label: 'Green',  accent: '#16a34a' },
  amber:  { label: 'Amber',  accent: '#d97706' },
  rose:   { label: 'Rose',   accent: '#e11d48' },
  slate:  { label: 'Slate',  accent: '#64748b' },
};

/** The accent a card should paint with: its override, else its kind's, else muted. */
export function entryAccent(kind: string, colour: string | null | undefined): string {
  if (colour && DIARY_COLOURS[colour]) return DIARY_COLOURS[colour].accent;
  return DIARY_KINDS[kind] ? DIARY_KINDS[kind].accent : '#64748b';
}

export function isDiaryColour(v: unknown): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIARY_COLOURS, v);
}

export function isDiaryKind(v: unknown): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIARY_KINDS, v);
}

// ── Recurrence ──────────────────────────────────────────────────────────────────
// Occurrences are REAL ROWS, generated at save time. The alternative — expanding a
// rule at read time — would put bookings in front of Terry that the clash engine has
// never seen, and the whole point of this diary is that a clash is impossible rather
// than merely flagged. Generation is capped so a typo in the end date cannot fill the
// table.
export const DIARY_RECURRENCE: Record<string, string> = {
  none:        'Does not repeat',
  daily:       'Every day',
  weekdays:    'Every weekday (Mon–Fri)',
  weekly:      'Every week',
  fortnightly: 'Every 2 weeks',
  monthly:     'Every month (same date)',
};
export const RECURRENCE_CAP = 200;

export function isRecurrence(v: unknown): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIARY_RECURRENCE, v);
}

/** Europe/London day key for an epoch (seconds). */
export function dayKeyOf(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/** 'Mon 18 Aug, 08:00' — matches the power lightbox wording. */
export function diaryWhenText(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** The Monday ('YYYY-MM-DD') of the week containing the given day key. */
export function mondayOf(dayKey: string): string {
  const d = new Date(dayKey + 'T12:00:00Z'); // noon UTC — immune to DST edge maths
  const dow = (d.getUTCDay() + 6) % 7;       // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDays(dayKey: string, n: number): string {
  const d = new Date(dayKey + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Add n calendar months, keeping the day of month. Returns null if that date does not
 *  exist in the target month (31 Jan + 1 month) — skipped rather than silently moved. */
export function addMonthsExact(dayKey: string, n: number): string | null {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d, 12));
  if (t.getUTCDate() !== d) return null; // rolled into the next month — not the same date
  return t.toISOString().slice(0, 10);
}

/** Inclusive list of day keys from start to end. Capped — a range is a span of days, not a policy. */
export function dayRange(startKey: string, endKey: string | null, cap = 400): string[] {
  const out = [startKey];
  if (!endKey || endKey <= startKey) return out;
  let cur = startKey;
  while (cur < endKey && out.length < cap) { cur = addDays(cur, 1); out.push(cur); }
  return out;
}

/** Europe/London wall-clock (dayKey + 'HH:MM') → epoch seconds. Two-pass so the hour
 *  either side of a DST switch resolves exactly; see the estate timestamp rule. */
export function londonEpoch(dayKey: string, hhmm: string): number {
  const naive = Date.parse(dayKey + 'T' + hhmm + ':00Z'); // read the wall clock as if UTC
  const offsetAt = (utcMs: number) => {
    const asLocal = new Date(utcMs).toLocaleString('sv-SE', { timeZone: 'Europe/London' });
    return Date.parse(asLocal.replace(' ', 'T') + 'Z') - utcMs;
  };
  let guess = naive - offsetAt(naive);
  guess = naive - offsetAt(guess);
  return Math.floor(guess / 1000);
}

/** 'HH:MM' in Europe/London for an epoch. */
export function londonHM(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * The day keys a series lands on, first occurrence included. Wall-clock is preserved
 * (a 09:00 visit stays 09:00 across the BST switch) because callers rebuild each
 * occurrence's epochs from the day key, never by adding 86400 to the last one.
 */
export function occurrenceDays(firstDay: string, recurrence: string, endDay: string): string[] {
  if (recurrence === 'none' || !endDay || endDay < firstDay) return [firstDay];
  const out: string[] = [];
  if (recurrence === 'monthly') {
    for (let i = 0; out.length < RECURRENCE_CAP; i++) {
      const d = addMonthsExact(firstDay, i);
      if (d === null) { if (i > 400) break; continue; } // month too short — skip it honestly
      if (d > endDay) break;
      out.push(d);
      if (i > 400) break;
    }
    return out.length ? out : [firstDay];
  }
  const step = recurrence === 'fortnightly' ? 14 : recurrence === 'weekly' ? 7 : 1;
  let cur = firstDay;
  while (cur <= endDay && out.length < RECURRENCE_CAP) {
    const dow = new Date(cur + 'T12:00:00Z').getUTCDay(); // 0 Sun … 6 Sat
    if (recurrence !== 'weekdays' || (dow >= 1 && dow <= 5)) out.push(cur);
    cur = addDays(cur, step);
  }
  return out.length ? out : [firstDay];
}

/** Staff who can appear in the diary (Terry + Andy today; anyone staffy tomorrow). */
export async function diaryPeople(): Promise<Array<{ id: number; name: string; email: string }>> {
  const r = await pool.query(
    `SELECT id, display_name AS name, email FROM users
      WHERE customer_id IS NULL AND is_active AND NOT hidden_from_lookups
        AND role IN ('staff','admin')
      ORDER BY id`);
  return r.rows.map((x: any) => ({ id: Number(x.id), name: String(x.name), email: String(x.email) }));
}

export interface Clash {
  id: number | null;
  who: string;
  title: string;
  kind: string;
  whenText: string;
  source: 'diary' | 'outlook';
}

export interface ClashCheck {
  clashes: Clash[];          // hard-blocking conflicts (diary + confirmed Outlook busy)
  warning: string | null;    // e.g. Outlook unreachable — surfaced, never blocking
}

/**
 * The hard-block check for a TIMED proposal [startEpoch, endEpoch) with its own
 * buffer, against every named person's existing diary. Pass excludeId when moving
 * an existing entry so it does not clash with itself.
 */
export async function findClashes(
  personIds: number[], startEpoch: number, endEpoch: number, bufferMins: number, excludeId: number | null,
): Promise<Clash[]> {
  if (!personIds.length) return [];
  const buf = Math.max(0, bufferMins) * 60;
  const dayKeys = Array.from(new Set([dayKeyOf(startEpoch), dayKeyOf(Math.max(startEpoch, endEpoch - 1))]));

  const r = await pool.query(
    `SELECT DISTINCT e.id, e.title, e.kind, u.display_name AS who,
            EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en,
            e.day_key, e.end_day_key
       FROM diary_entries e
       JOIN diary_entry_people p ON p.entry_id = e.id
       JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ANY($1)
        AND e.status = 'booked'
        AND ($2::int IS NULL OR e.id <> $2)
        AND (
              -- timed vs timed: both intervals expanded by their own buffers
              (e.start_at IS NOT NULL AND e.end_at IS NOT NULL
               AND EXTRACT(EPOCH FROM e.start_at) - e.buffer_mins*60 < $4::bigint + $5::bigint
               AND EXTRACT(EPOCH FROM e.end_at)   + e.buffer_mins*60 > $3::bigint - $5::bigint)
              -- all-day time off covering any of the proposal's day(s). A RANGE counts for
              -- every day it spans, so a booking mid-week off is blocked like day one.
           OR (e.kind = 'timeoff' AND e.start_at IS NULL
               AND EXISTS (SELECT 1 FROM unnest($6::text[]) AS d(k)
                            WHERE d.k >= e.day_key AND d.k <= COALESCE(e.end_day_key, e.day_key)))
            )`,
    [personIds, excludeId, startEpoch, endEpoch, buf, dayKeys]);

  return r.rows.map((x: any) => ({
    id: Number(x.id), who: String(x.who), title: String(x.title), kind: String(x.kind),
    whenText: x.s
      ? `${diaryWhenText(Number(x.s))}–${new Date(Number(x.en) * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}`
      : (x.end_day_key && x.end_day_key !== x.day_key ? `all day ${x.day_key} → ${x.end_day_key}` : `all day ${x.day_key}`),
    source: 'diary' as const,
  }));
}

/**
 * An all-day proposal (one day, or a whole range) vs every timed entry those people
 * already hold on those days. Takes the FULL span so booking a week off is checked
 * against all five days before any of it is written.
 */
export async function findAllDayClashes(personIds: number[], dayKeys: string[], excludeId: number | null): Promise<Clash[]> {
  if (!personIds.length || !dayKeys.length) return [];
  const r = await pool.query(
    `SELECT DISTINCT e.id, e.title, e.kind, u.display_name AS who,
            EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en
       FROM diary_entries e
       JOIN diary_entry_people p ON p.entry_id = e.id
       JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ANY($1) AND e.status = 'booked'
        AND ($2::int IS NULL OR e.id <> $2)
        AND e.start_at IS NOT NULL
        AND to_char(e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') = ANY($3::text[])`,
    [personIds, excludeId, dayKeys]);
  return r.rows.map((x: any) => ({
    id: Number(x.id), who: String(x.who), title: String(x.title), kind: String(x.kind),
    whenText: diaryWhenText(Number(x.s)), source: 'diary' as const,
  }));
}

export interface WeekEntry {
  id: number; kind: string; title: string; notes: string | null;
  customerId: number | null; customerName: string | null; ticketId: number | null; ticketNumber: string | null;
  s: number | null; e: number | null; dayKey: string; bufferMins: number; status: string;
  people: Array<{ id: number; name: string }>;
  // Date range (day-lane entries only). endDayKey is the entry's true last day even when
  // the week only shows part of it; spanTotal/spanIndex describe THIS card's place in it,
  // so the view can round only the real ends and label "day 2 of 5".
  endDayKey: string | null; spanTotal: number; spanIndex: number;
  colour: string | null; accent: string;
  seriesId: number | null; recurrence: string; recurrenceEnd: string | null;
  feed?: string; // set on virtual feed items (not editable)
  link?: string;
}

function feedEntry(base: Partial<WeekEntry> & { id: number; kind: string; title: string; dayKey: string }): WeekEntry {
  return {
    notes: null, customerId: null, customerName: null, ticketId: null, ticketNumber: null,
    s: null, e: null, bufferMins: 0, status: 'booked', people: [],
    endDayKey: null, spanTotal: 1, spanIndex: 0,
    colour: null, accent: entryAccent(base.kind, null),
    seriesId: null, recurrence: 'none', recurrenceEnd: null,
    ...base,
  } as WeekEntry;
}

/** Everything in the diary for [monday, monday+7d), people attached, feeds merged.
 *  A day-lane entry that SPANS days is returned once per visible day it covers. */
export async function loadWeek(monday: string): Promise<WeekEntry[]> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const firstDay = days[0], lastDay = days[days.length - 1];
  const r = await pool.query(
    `SELECT e.id, e.kind, e.title, e.notes, e.customer_id, c.name AS customer_name,
            e.ticket_id, t.ticket_number, e.buffer_mins, e.status, e.day_key, e.end_day_key,
            e.colour, e.series_id, e.recurrence, e.recurrence_end,
            EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en,
            COALESCE(to_char(e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD'), e.day_key) AS dk,
            COALESCE(json_agg(json_build_object('id', u.id, 'name', u.display_name)
                              ORDER BY u.id) FILTER (WHERE u.id IS NOT NULL), '[]') AS people
       FROM diary_entries e
       LEFT JOIN diary_entry_people p ON p.entry_id = e.id
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN inbox_tickets t ON t.id = e.ticket_id
      WHERE e.status <> 'cancelled'
        AND (
              (e.start_at IS NOT NULL
               AND to_char(e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') = ANY($1::text[]))
           OR (e.start_at IS NULL AND e.day_key IS NOT NULL
               AND e.day_key <= $3 AND COALESCE(e.end_day_key, e.day_key) >= $2)
            )
      GROUP BY e.id, c.name, t.ticket_number
      ORDER BY e.start_at NULLS FIRST, e.id`,
    [days, firstDay, lastDay]);

  const out: WeekEntry[] = [];
  for (const x of r.rows) {
    const startKey = String(x.dk);
    // Ranges belong to the day lane only — a timed entry's span is its own start/end.
    const endKey: string | null = x.s ? null : (x.end_day_key ? String(x.end_day_key) : null);
    const base: WeekEntry = {
      id: Number(x.id), kind: String(x.kind), title: String(x.title), notes: x.notes || null,
      customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
      ticketId: x.ticket_id ? Number(x.ticket_id) : null, ticketNumber: x.ticket_number || null,
      s: x.s ? Number(x.s) : null, e: x.en ? Number(x.en) : null, dayKey: startKey,
      bufferMins: Number(x.buffer_mins || 0), status: String(x.status),
      people: Array.isArray(x.people) ? x.people : JSON.parse(x.people || '[]'),
      endDayKey: endKey && endKey > startKey ? endKey : null,
      spanTotal: 1, spanIndex: 0,
      colour: x.colour || null, accent: entryAccent(String(x.kind), x.colour || null),
      seriesId: x.series_id ? Number(x.series_id) : null,
      recurrence: String(x.recurrence || 'none'), recurrenceEnd: x.recurrence_end || null,
    };
    if (base.s != null || !base.endDayKey) { out.push(base); continue; }
    // A span: one card per day it covers, but only the days this week actually shows.
    const all = dayRange(startKey, base.endDayKey);
    all.forEach((dk, i) => {
      if (dk < firstDay || dk > lastDay) return;
      out.push({ ...base, dayKey: dk, spanTotal: all.length, spanIndex: i });
    });
  }

  // ── Feed: postponed cases return to their owner's day lane ─────────────────────
  const post = await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, t.customer_id, c.name AS customer_name,
            t.assigned_user_id, u.display_name AS who,
            to_char(t.postponed_until AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') AS dk
       FROM inbox_tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN users u ON u.id = t.assigned_user_id
      WHERE t.status = 'postponed' AND t.postponed_until IS NOT NULL
        AND to_char(t.postponed_until AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') = ANY($1)`,
    [days]);
  for (const x of post.rows) {
    out.push(feedEntry({
      id: -Number(x.id), kind: 'promise', title: `Case returns: ${x.subject || x.ticket_number}`,
      customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
      ticketId: Number(x.id), ticketNumber: x.ticket_number || null, dayKey: String(x.dk),
      people: x.assigned_user_id ? [{ id: Number(x.assigned_user_id), name: String(x.who || '') }] : [],
      feed: 'postponed', link: `/tickets/${x.id}`,
    }));
  }

  // ── Feed: scheduled restarts/shutdowns + windowed installs (Support view) ──────
  const cmds = await pool.query(
    `SELECT ac.id, ac.kind, EXTRACT(EPOCH FROM ac.run_after)::bigint AS s,
            to_char(ac.run_after AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') AS dk,
            d.hostname, c.name AS customer_name, d.customer_id, a.id AS asset_id
       FROM agent_commands ac
       JOIN agent_devices d ON d.id = ac.device_id
       LEFT JOIN customers c ON c.id = d.customer_id
       LEFT JOIN customer_assets a ON a.agent_device_id = d.id AND a.merged_into_id IS NULL
      WHERE ac.status = 'queued' AND ac.run_after IS NOT NULL
        AND (ac.kind LIKE 'power.%' OR ac.kind LIKE 'patch.%')
        AND to_char(ac.run_after AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD') = ANY($1)`,
    [days]);
  for (const x of cmds.rows) {
    const verb = x.kind === 'power.shutdown' ? 'Shutdown' : x.kind.startsWith('patch.') ? 'Patch install' : 'Restart';
    out.push(feedEntry({
      id: -1000000 - Number(x.id), kind: 'remote', title: `${verb} — ${x.hostname || 'device'}`,
      customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
      s: x.s ? Number(x.s) : null, e: x.s ? Number(x.s) + 900 : null, dayKey: String(x.dk),
      feed: 'maintenance', link: x.asset_id ? `/assets/${x.asset_id}` : undefined,
    }));
  }

  return out;
}

export interface SaveInput {
  kind: string; title: string; notes: string | null;
  customerId: number | null; ticketId: number | null;
  personIds: number[];
  startEpoch: number | null; endEpoch: number | null; // timed
  dayKey: string | null;                              // day-lane / all-day timeoff
  endDayKey: string | null;                           // inclusive last day of a day-lane RANGE
  bufferMins: number;
  colour: string | null;
  recurrence: string;                                 // none | daily | weekdays | weekly | fortnightly | monthly
  recurrenceEnd: string | null;                       // 'YYYY-MM-DD', required when recurrence <> none
  createdBy: number | null;
}

export interface SkippedOccurrence { dayKey: string; clashes: Clash[] }

export interface SaveResult {
  ok: boolean; id?: number; clashes?: Clash[]; error?: string;
  // Series only: every row that was written, and every date that could not be because
  // someone was already committed. A part-booked series is reported, never hidden.
  ids?: number[]; seriesId?: number; skipped?: SkippedOccurrence[];
}

/** The days a proposal occupies: its span for a day-lane entry, its start/end days for a timed one. */
function proposalDays(inp: SaveInput, timed: boolean): string[] {
  if (timed) {
    return Array.from(new Set([dayKeyOf(inp.startEpoch!), dayKeyOf(Math.max(inp.startEpoch!, inp.endEpoch! - 1))]));
  }
  return dayRange(inp.dayKey!, inp.endDayKey);
}

function validate(inp: SaveInput): string | null {
  if (!isDiaryKind(inp.kind)) return 'Unknown entry kind.';
  if (!inp.title.trim()) return 'Give it a title.';
  if (!inp.personIds.length) return 'Pick at least one person.';
  if (inp.colour && !isDiaryColour(inp.colour)) return 'Unknown colour.';
  if (!isRecurrence(inp.recurrence)) return 'Unknown repeat pattern.';
  const timed = inp.startEpoch != null && inp.endEpoch != null;
  if (timed && inp.endEpoch! <= inp.startEpoch!) return 'End must be after start.';
  if (!timed && !inp.dayKey) return 'Pick a day.';
  if (!timed && inp.endDayKey && inp.endDayKey < inp.dayKey!) return 'The last day cannot be before the first.';
  if (!timed && inp.endDayKey && dayRange(inp.dayKey!, inp.endDayKey).length > 366) return 'That range is longer than a year.';
  if (inp.recurrence !== 'none' && !inp.recurrenceEnd) return 'A repeating entry needs a date to repeat until.';
  return null;
}

/** Create or update (id != null) ONE entry, enforcing the hard block. */
export async function saveEntry(id: number | null, inp: SaveInput): Promise<SaveResult> {
  const bad = validate(inp);
  if (bad) return { ok: false, error: bad };
  const timed = inp.startEpoch != null && inp.endEpoch != null;

  // The hard block. Day-lane tasks/promises never clash; everything timed does, and
  // all-day time off clashes against every timed entry inside its span.
  if (timed) {
    const clashes = await findClashes(inp.personIds, inp.startEpoch!, inp.endEpoch!, inp.bufferMins, id);
    if (clashes.length) return { ok: false, clashes };
  } else if (inp.kind === 'timeoff') {
    const clashes = await findAllDayClashes(inp.personIds, proposalDays(inp, false), id);
    if (clashes.length) return { ok: false, clashes };
  }

  const params = [
    inp.kind, inp.title.trim(), inp.notes || null, inp.customerId, inp.ticketId,
    timed ? inp.startEpoch : null, timed ? inp.endEpoch : null,
    timed ? null : inp.dayKey, Math.max(0, Math.round(inp.bufferMins || 0)), inp.createdBy,
    timed ? null : (inp.endDayKey && inp.endDayKey > inp.dayKey! ? inp.endDayKey : null),
    inp.colour || null, inp.recurrence, inp.recurrence === 'none' ? null : inp.recurrenceEnd,
  ];
  let entryId = id;
  if (id == null) {
    const ins = await pool.query(
      `INSERT INTO diary_entries (kind, title, notes, customer_id, ticket_id, start_at, end_at, day_key,
                                  buffer_mins, created_by, end_day_key, colour, recurrence, recurrence_end)
       VALUES ($1,$2,$3,$4,$5, to_timestamp($6::bigint), to_timestamp($7::bigint), $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`, params);
    entryId = Number(ins.rows[0].id);
  } else {
    // Editing ONE occurrence must not rewrite the series it belongs to, so recurrence /
    // recurrence_end / series_id are deliberately left alone here.
    await pool.query(
      `UPDATE diary_entries SET kind=$1, title=$2, notes=$3, customer_id=$4, ticket_id=$5,
              start_at=to_timestamp($6::bigint), end_at=to_timestamp($7::bigint), day_key=$8, buffer_mins=$9,
              end_day_key=$10, colour=$11, updated_at=NOW()
        WHERE id=$12`,
      [params[0], params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8],
       params[10], params[11], id]);
    await pool.query(`DELETE FROM diary_entry_people WHERE entry_id=$1`, [id]);
  }
  for (const uid of Array.from(new Set(inp.personIds))) {
    await pool.query(`INSERT INTO diary_entry_people (entry_id, user_id) VALUES ($1,$2)`, [entryId, uid]);
  }
  return { ok: true, id: entryId! };
}

/**
 * Create a repeating entry. The FIRST occurrence is the booking you actually asked for,
 * so a clash there blocks the whole thing. Later occurrences are booked one at a time
 * and any that clash are SKIPPED and reported — a fortnightly catch-up should not be
 * abandoned because one date in November is already an onsite.
 */
export async function saveSeries(
  inp: SaveInput,
  outlookBusy: Array<{ s: number; e: number; who: string; title: string }> = [],
): Promise<SaveResult> {
  const bad = validate(inp);
  if (bad) return { ok: false, error: bad };
  if (inp.recurrence === 'none') return saveEntry(null, inp);

  const timed = inp.startEpoch != null && inp.endEpoch != null;
  const firstDay = timed ? dayKeyOf(inp.startEpoch!) : inp.dayKey!;
  const days = occurrenceDays(firstDay, inp.recurrence, inp.recurrenceEnd!);

  // Wall clock and span length are what repeat — never a fixed number of seconds, which
  // would drift an hour at the BST switch.
  const startHM = timed ? londonHM(inp.startEpoch!) : null;
  const endHM = timed ? londonHM(inp.endEpoch!) : null;
  const endsNextDay = timed ? dayKeyOf(inp.endEpoch! - 1) !== firstDay : false;
  const spanDays = timed ? 0 : dayRange(firstDay, inp.endDayKey).length - 1;

  const occurrenceFor = (dk: string): SaveInput => timed
    ? { ...inp, startEpoch: londonEpoch(dk, startHM!), endEpoch: londonEpoch(endsNextDay ? addDays(dk, 1) : dk, endHM!), dayKey: null, endDayKey: null }
    : { ...inp, dayKey: dk, endDayKey: spanDays > 0 ? addDays(dk, spanDays) : null };

  const first = await saveEntry(null, occurrenceFor(days[0]));
  if (!first.ok) return first;

  const ids = [first.id!];
  const skipped: SkippedOccurrence[] = [];
  const buf = Math.max(0, inp.bufferMins || 0) * 60;
  for (const dk of days.slice(1)) {
    const occ = occurrenceFor(dk);
    // Outlook busy for the WHOLE series window is fetched once by the caller — checking
    // it per occurrence here means a standing catch-up cannot quietly land on top of a
    // dentist appointment six weeks out.
    if (occ.startEpoch != null) {
      const hit = outlookBusy.filter(b => b.s < occ.endEpoch! + buf && b.e > occ.startEpoch! - buf);
      if (hit.length) {
        skipped.push({ dayKey: dk, clashes: hit.map(h => ({
          id: null, who: h.who, title: h.title, kind: 'outlook',
          whenText: diaryWhenText(h.s), source: 'outlook' as const })) });
        continue;
      }
    }
    const r = await saveEntry(null, occ);
    if (r.ok) ids.push(r.id!);
    else skipped.push({ dayKey: dk, clashes: r.clashes || [] });
  }

  // series_id points at the first entry and is stamped on it too, so "the whole series"
  // is one predicate and cancelling from any occurrence finds its siblings.
  await pool.query(`UPDATE diary_entries SET series_id=$1 WHERE id = ANY($2::int[])`, [first.id, ids]);
  return { ok: true, id: first.id, ids, seriesId: first.id, skipped };
}

/**
 * Cancel a whole series from a given day forward (default: everything still to come).
 * History is left alone — a diary that rewrites the past is not a record.
 * Returns the cancelled ids so their calendar copies can be pulled too.
 */
export async function cancelSeries(seriesId: number, fromDayKey: string | null): Promise<number[]> {
  const from = fromDayKey || dayKeyOf(Math.floor(Date.now() / 1000));
  const r = await pool.query(
    `UPDATE diary_entries SET status='cancelled', updated_at=NOW()
      WHERE series_id=$1 AND status='booked'
        AND COALESCE(to_char(start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD'), day_key) >= $2
      RETURNING id`, [seriesId, from]);
  return r.rows.map((x: any) => Number(x.id));
}

/** How many bookings a series still holds from today onward — for "cancel the series?" wording. */
export async function seriesRemaining(seriesId: number): Promise<number> {
  const today = dayKeyOf(Math.floor(Date.now() / 1000));
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM diary_entries
      WHERE series_id=$1 AND status='booked'
        AND COALESCE(to_char(start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD'), day_key) >= $2`,
    [seriesId, today]);
  return Number(r.rows[0].n || 0);
}
