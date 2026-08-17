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
  onsite:  { label: 'Onsite',            timed: true,  accent: 'var(--teal, #0ea5b7)' },
  remote:  { label: 'Remote support',    timed: true,  accent: 'var(--blue-bright, #2563eb)' },
  catchup: { label: 'Customer catch-up', timed: true,  accent: 'var(--violet, #7c3aed)' },
  timeoff: { label: 'Time off',          timed: false, accent: 'var(--muted, #64748b)' }, // timed OR all-day
  promise: { label: 'Promise',           timed: false, accent: 'var(--warn-fg, #b45309)' },
  task:    { label: 'Task',              timed: false, accent: 'var(--ok-fg, #15803d)' },
};

export function isDiaryKind(v: unknown): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIARY_KINDS, v);
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
            e.day_key
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
              -- all-day time off on the proposal's day(s)
           OR (e.kind = 'timeoff' AND e.start_at IS NULL AND e.day_key = ANY($6))
            )`,
    [personIds, excludeId, startEpoch, endEpoch, buf, dayKeys]);

  return r.rows.map((x: any) => ({
    id: Number(x.id), who: String(x.who), title: String(x.title), kind: String(x.kind),
    whenText: x.s ? `${diaryWhenText(Number(x.s))}–${new Date(Number(x.en) * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}` : `all day ${x.day_key}`,
    source: 'diary' as const,
  }));
}

/** All-day time off proposal vs the person's timed entries that day. */
export async function findAllDayClashes(personIds: number[], dayKey: string, excludeId: number | null): Promise<Clash[]> {
  if (!personIds.length) return [];
  const r = await pool.query(
    `SELECT DISTINCT e.id, e.title, e.kind, u.display_name AS who,
            EXTRACT(EPOCH FROM e.start_at)::bigint AS s, EXTRACT(EPOCH FROM e.end_at)::bigint AS en
       FROM diary_entries e
       JOIN diary_entry_people p ON p.entry_id = e.id
       JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ANY($1) AND e.status = 'booked'
        AND ($2::int IS NULL OR e.id <> $2)
        AND e.start_at IS NOT NULL
        AND to_char(e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') = $3`,
    [personIds, excludeId, dayKey]);
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
  feed?: string; // set on virtual feed items (not editable)
  link?: string;
}

/** Everything in the diary for [monday, monday+7d), people attached, feeds merged. */
export async function loadWeek(monday: string): Promise<WeekEntry[]> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const r = await pool.query(
    `SELECT e.id, e.kind, e.title, e.notes, e.customer_id, c.name AS customer_name,
            e.ticket_id, t.ticket_number, e.buffer_mins, e.status, e.day_key,
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
        AND COALESCE(to_char(e.start_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London','YYYY-MM-DD'), e.day_key) = ANY($1)
      GROUP BY e.id, c.name, t.ticket_number
      ORDER BY e.start_at NULLS FIRST, e.id`,
    [days]);

  const out: WeekEntry[] = r.rows.map((x: any) => ({
    id: Number(x.id), kind: String(x.kind), title: String(x.title), notes: x.notes || null,
    customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
    ticketId: x.ticket_id ? Number(x.ticket_id) : null, ticketNumber: x.ticket_number || null,
    s: x.s ? Number(x.s) : null, e: x.en ? Number(x.en) : null, dayKey: String(x.dk),
    bufferMins: Number(x.buffer_mins || 0), status: String(x.status),
    people: Array.isArray(x.people) ? x.people : JSON.parse(x.people || '[]'),
  }));

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
    out.push({
      id: -Number(x.id), kind: 'promise', title: `Case returns: ${x.subject || x.ticket_number}`,
      notes: null, customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
      ticketId: Number(x.id), ticketNumber: x.ticket_number || null,
      s: null, e: null, dayKey: String(x.dk), bufferMins: 0, status: 'booked',
      people: x.assigned_user_id ? [{ id: Number(x.assigned_user_id), name: String(x.who || '') }] : [],
      feed: 'postponed', link: `/tickets/${x.id}`,
    });
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
    out.push({
      id: -1000000 - Number(x.id), kind: 'remote', title: `${verb} — ${x.hostname || 'device'}`,
      notes: null, customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
      ticketId: null, ticketNumber: null,
      s: x.s ? Number(x.s) : null, e: x.s ? Number(x.s) + 900 : null, dayKey: String(x.dk),
      bufferMins: 0, status: 'booked', people: [],
      feed: 'maintenance', link: x.asset_id ? `/assets/${x.asset_id}` : undefined,
    });
  }

  return out;
}

export interface SaveInput {
  kind: string; title: string; notes: string | null;
  customerId: number | null; ticketId: number | null;
  personIds: number[];
  startEpoch: number | null; endEpoch: number | null; // timed
  dayKey: string | null;                              // day-lane / all-day timeoff
  bufferMins: number;
  createdBy: number | null;
}

export interface SaveResult { ok: boolean; id?: number; clashes?: Clash[]; error?: string }

/** Create or update (id != null) an entry, enforcing the hard block. */
export async function saveEntry(id: number | null, inp: SaveInput): Promise<SaveResult> {
  if (!isDiaryKind(inp.kind)) return { ok: false, error: 'Unknown entry kind.' };
  if (!inp.title.trim()) return { ok: false, error: 'Give it a title.' };
  if (!inp.personIds.length) return { ok: false, error: 'Pick at least one person.' };
  const timed = inp.startEpoch != null && inp.endEpoch != null;
  if (timed && inp.endEpoch! <= inp.startEpoch!) return { ok: false, error: 'End must be after start.' };
  if (!timed && !inp.dayKey) return { ok: false, error: 'Pick a day.' };

  // The hard block. Day-lane tasks/promises never clash; everything timed does,
  // and all-day time off clashes against that day's timed entries.
  if (timed) {
    const clashes = await findClashes(inp.personIds, inp.startEpoch!, inp.endEpoch!, inp.bufferMins, id);
    if (clashes.length) return { ok: false, clashes };
  } else if (inp.kind === 'timeoff') {
    const clashes = await findAllDayClashes(inp.personIds, inp.dayKey!, id);
    if (clashes.length) return { ok: false, clashes };
  }

  const params = [
    inp.kind, inp.title.trim(), inp.notes || null, inp.customerId, inp.ticketId,
    timed ? inp.startEpoch : null, timed ? inp.endEpoch : null,
    timed ? null : inp.dayKey, Math.max(0, Math.round(inp.bufferMins || 0)), inp.createdBy,
  ];
  let entryId = id;
  if (id == null) {
    const ins = await pool.query(
      `INSERT INTO diary_entries (kind, title, notes, customer_id, ticket_id, start_at, end_at, day_key, buffer_mins, created_by)
       VALUES ($1,$2,$3,$4,$5, to_timestamp($6::bigint), to_timestamp($7::bigint), $8, $9, $10) RETURNING id`, params);
    entryId = Number(ins.rows[0].id);
  } else {
    await pool.query(
      `UPDATE diary_entries SET kind=$1, title=$2, notes=$3, customer_id=$4, ticket_id=$5,
              start_at=to_timestamp($6::bigint), end_at=to_timestamp($7::bigint), day_key=$8, buffer_mins=$9,
              updated_at=NOW()
        WHERE id=$10`, [...params.slice(0, 9), id]);
    await pool.query(`DELETE FROM diary_entry_people WHERE entry_id=$1`, [id]);
  }
  for (const uid of Array.from(new Set(inp.personIds))) {
    await pool.query(`INSERT INTO diary_entry_people (entry_id, user_id) VALUES ($1,$2)`, [entryId, uid]);
  }
  return { ok: true, id: entryId! };
}
