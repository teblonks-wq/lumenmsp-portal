import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin, requireCustomer } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import {
  listServices, getService, servicesForCustomer, availableSlots, bookSlot, customerBookings,
  uniqueSlug, setAgenda, tagTicket, untagTicket, entryTickets, openCasesFor, bookingById,
} from '../lib/booking';
import { sendBookingMail } from '../lib/booking-email';
import { previewBookingsImport, importBookingServices, syncBookingsTemplates } from '../lib/bookings';
import { attachPerms } from './my';
import {
  DIARY_KINDS, DIARY_COLOURS, dayKeyOf, addDays, mondayOf, diaryPeople, diaryWhenText, londonHM,
} from '../lib/diary';
import { pushEntry, removeEntry } from '../lib/diary-graph';

const router = Router();

// ── Bookings ────────────────────────────────────────────────────────────────────
// Staff configure WHAT can be booked (/diary/services); customers book it from /my/book.
// Everything a customer books becomes an ordinary diary entry, so it clashes, pushes to
// Outlook and shows on the week exactly like a booking Terry made himself.

const ihm = (v: any, d: string): string => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d;
const iInt = (v: any, d: number, lo: number, hi: number): number => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// ── Staff: what can be booked ───────────────────────────────────────────────────

router.get('/diary/services', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [services, people] = await Promise.all([listServices(false), diaryPeople()]);
  res.render('booking/services', {
    user: req.session.user!, services, people,
    appUrl: String(process.env.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, ''),
    KINDS: DIARY_KINDS, COLOURS: DIARY_COLOURS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

function serviceFields(b: any): any[] {
  const weekdays = (Array.isArray(b.weekdays) ? b.weekdays : b.weekdays != null ? [b.weekdays] : [])
    .map((n: any) => parseInt(String(n), 10)).filter((n: number) => n >= 1 && n <= 7);
  const staff = (Array.isArray(b.staff) ? b.staff : b.staff != null ? [b.staff] : [])
    .map((n: any) => parseInt(String(n), 10)).filter(Number.isInteger);
  const kind = DIARY_KINDS[String(b.kind)] && DIARY_KINDS[String(b.kind)].timed ? String(b.kind) : 'remote';
  const maxPerDay = parseInt(String(b.max_per_day ?? ''), 10);
  return [
    String(b.name || '').trim().slice(0, 120),
    String(b.blurb || '').trim().slice(0, 300) || null,
    kind,
    iInt(b.duration_mins, 30, 10, 480),
    kind === 'onsite' ? iInt(b.buffer_mins, 30, 0, 240) : 0,
    iInt(b.slot_step_mins, 30, 5, 240),
    iInt(b.lead_time_hours, 4, 0, 720),
    iInt(b.horizon_days, 30, 1, 365),
    ihm(b.window_start, '09:00'),
    ihm(b.window_end, '17:00'),
    JSON.stringify(weekdays.length ? weekdays : [1, 2, 3, 4, 5]),
    JSON.stringify(staff),
    Number.isFinite(maxPerDay) && maxPerDay > 0 ? maxPerDay : null,
    b.teams_meeting ? true : false,
    b.itsm_only ? true : false,
    DIARY_COLOURS[String(b.colour)] ? String(b.colour) : null,
    iInt(b.sort_order, 0, 0, 999),
    b.is_public ? true : false,
    String(b.location_text || '').trim().slice(0, 120) || null,
  ];
}

function serviceInvalid(f: any[]): string | null {
  if (!f[0]) return 'A bookable service needs a name.';
  if (f[8] >= f[9]) return 'The bookable window has to end after it starts.';
  // A duration that does not fit in the window would offer nothing at all, silently.
  const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  if (f[3] > mins(f[9]) - mins(f[8])) return 'That is longer than the window you have opened — nothing would ever be offered.';
  return null;
}

router.post('/diary/services', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const f = serviceFields(req.body);
  const bad = serviceInvalid(f);
  if (bad) { res.redirect('/diary/services?err=' + encodeURIComponent(bad)); return; }
  // Every service gets a slug at birth, whether or not it is public today: a service
  // published a month from now must not suddenly acquire a different URL than the one
  // already sitting in someone's sent items.
  const slug = await uniqueSlug(String(f[0]));
  const ins = await pool.query(
    `INSERT INTO booking_services (name, blurb, kind, duration_mins, buffer_mins, slot_step_mins,
       lead_time_hours, horizon_days, window_start, window_end, weekdays, staff_ids, max_per_day,
       teams_meeting, itsm_only, colour, sort_order, is_public, location_text, slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [...f, slug]);
  await logActivity(req.session.user!.id, 'booking_service_create', 'booking_services', ins.rows[0].id, `Bookable: ${f[0]}`);
  res.redirect('/diary/services?msg=' + encodeURIComponent(`${f[0]} is now bookable.`));
});

router.post('/diary/services/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const f = serviceFields(req.body);
  const bad = serviceInvalid(f);
  if (!id || bad) { res.redirect('/diary/services?err=' + encodeURIComponent(bad || 'Unknown service.')); return; }
  // The slug is deliberately NOT rewritten from the name. Renaming "IT review" to
  // "Service review" must not break the link already sitting in a hundred sent emails.
  await pool.query(
    `UPDATE booking_services SET name=$1, blurb=$2, kind=$3, duration_mins=$4, buffer_mins=$5,
            slot_step_mins=$6, lead_time_hours=$7, horizon_days=$8, window_start=$9, window_end=$10,
            weekdays=$11::jsonb, staff_ids=$12::jsonb, max_per_day=$13, teams_meeting=$14,
            itsm_only=$15, colour=$16, sort_order=$17, is_public=$18, location_text=$19,
            slug = COALESCE(slug, $20), updated_at=NOW()
      WHERE id=$21`, [...f, await uniqueSlug(String(f[0]), id), id]);
  res.redirect('/diary/services?msg=' + encodeURIComponent('Saved.'));
});

// Retiring a service never touches bookings already made — those are commitments.
router.post('/diary/services/:id/active', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const on = String(req.body.active || '') === '1';
  if (id) await pool.query('UPDATE booking_services SET is_active=$2, updated_at=NOW() WHERE id=$1', [id, on]);
  res.redirect('/diary/services?msg=' + encodeURIComponent(on ? 'Open for bookings.' : 'Closed to new bookings — anything already booked stands.'));
});

// ── Customer: book it ───────────────────────────────────────────────────────────

const cid = (req: Request): number => Number(req.session.user!.customerId);

// The customer sidebar is built from res.locals.perms — mount the SAME middleware the rest
// of /my uses, or these pages quietly lose half the customer's navigation.
router.use('/my/book', requireCustomer, attachPerms);

router.get('/my/book', async (req: Request, res: Response) => {
  const services = await servicesForCustomer(cid(req));
  const bookings = await customerBookings(cid(req));
  res.render('my/book', {
    active: 'book', user: req.session.user!, services, bookings,
    service: null, days: [], monday: null, prevW: null, nextW: null, outlookWarning: null,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.get('/my/book/:id', async (req: Request, res: Response) => {
  const svc = await getService(parseInt(String(req.params.id), 10));
  const offered = await servicesForCustomer(cid(req));
  if (!svc || !offered.some(s => s.id === svc.id)) {
    res.redirect('/my/book?err=' + encodeURIComponent('That is not something you can book at the moment.')); return;
  }
  const today = dayKeyOf(Math.floor(Date.now() / 1000));
  const wRaw = String(req.query.w || '');
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(wRaw) ? mondayOf(wRaw) : mondayOf(today);
  // Never offer the past, and never beyond the service's own horizon.
  const from = monday < today ? today : monday;
  const horizonEnd = addDays(today, svc.horizonDays);
  const to = addDays(monday, 6) > horizonEnd ? horizonEnd : addDays(monday, 6);

  const { slots, outlookWarning } = to < from
    ? { slots: [], outlookWarning: null }
    : await availableSlots(svc, from, to);

  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map(dk => ({
    dayKey: dk, past: dk < today, beyond: dk > horizonEnd,
    slots: slots.filter(s => s.dayKey === dk),
  }));

  res.render('my/book', {
    active: 'book', user: req.session.user!, service: svc, days, monday,
    prevW: addDays(monday, -7), nextW: addDays(monday, 7), horizonEnd, today,
    services: offered, bookings: await customerBookings(cid(req)),
    outlookWarning,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/my/book/:id', async (req: Request, res: Response) => {
  const u = req.session.user!;
  const svc = await getService(parseInt(String(req.params.id), 10));
  const offered = await servicesForCustomer(cid(req));
  const back = '/my/book/' + String(req.params.id);
  if (!svc || !offered.some(s => s.id === svc.id)) {
    res.redirect('/my/book?err=' + encodeURIComponent('That is not something you can book at the moment.')); return;
  }
  const start = parseInt(String(req.body.start || ''), 10);
  if (!Number.isFinite(start)) { res.redirect(back + '?err=' + encodeURIComponent('Pick a time.')); return; }

  const r = await bookSlot({
    service: svc, startEpoch: start, customerId: cid(req), bookedByUserId: u.id,
    name: String(req.body.name || u.displayName || '').trim().slice(0, 120),
    email: String(req.body.email || u.email || '').trim().slice(0, 190),
    phone: String(req.body.phone || '').trim().slice(0, 40) || null,
    company: null,   // a signed-in customer already has one — customerId settles it
    notes: String(req.body.notes || '').trim().slice(0, 2000) || null,
  });
  if (!r.ok) {
    res.redirect(back + '?w=' + dayKeyOf(start) + '&err=' + encodeURIComponent(r.error || 'That could not be booked.'));
    return;
  }

  // Push to Outlook FIRST and wait: a Teams service has no join link until the event
  // exists, and a confirmation email that promises a link it does not carry is worse
  // than one that says the link will follow.
  await pushEntry(r.entryId!).catch(() => {});
  const row = (await pool.query('SELECT online_meeting_url FROM diary_entries WHERE id=$1', [r.entryId])).rows[0];
  const joinUrl: string | null = row?.online_meeting_url || null;

  await logActivity(u.id, 'booking_created', 'diary_entries', r.entryId!,
    `${svc.name} booked by ${u.displayName} for ${diaryWhenText(start)}`);

  // One confirmation path for every booking, however it was made: the same branded email
  // and the same real calendar request, so a customer who books in the Portal and one who
  // books from a link in an email get an identical thing in their inbox.
  await sendBookingMail(r.entryId!, 'confirmed');

  const teamsNote = svc.teamsMeeting
    ? (joinUrl ? ' A Teams link is in your confirmation email.' : ' We will send the Teams link before the meeting.')
    : '';
  res.redirect('/my/book?msg=' + encodeURIComponent(
    `Booked — ${diaryWhenText(start)} with ${r.staffName}.${teamsNote}`));
});

// A customer may cancel their company's own booking. Scoped to their customer id, and the
// diary entry is cancelled through the same path staff use, so Outlook is cleaned up too.
router.post('/my/book/:id/cancel', async (req: Request, res: Response) => {
  const u = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const e = (await pool.query(
    `SELECT id, title, EXTRACT(EPOCH FROM start_at)::bigint AS s FROM diary_entries
      WHERE id=$1 AND customer_id=$2 AND booking_service_id IS NOT NULL AND status='booked'`,
    [id, cid(req)])).rows[0];
  if (!e) { res.redirect('/my/book?err=' + encodeURIComponent('That booking is not yours to cancel, or it is already gone.')); return; }
  await pool.query(`UPDATE diary_entries SET status='cancelled', updated_at=NOW() WHERE id=$1`, [id]);
  removeEntry(id).catch(() => {});
  await logActivity(u.id, 'booking_cancelled', 'diary_entries', id, `${e.title} cancelled by ${u.displayName}`);
  res.redirect('/my/book?msg=' + encodeURIComponent('Cancelled — the time is free again.'));
});



// ── Bringing Microsoft Bookings across ──────────────────────────────────────────
//
// Shown as a preview first, then imported on a second click. An import that silently
// rewrites a live booking configuration is not something anyone should trigger blind,
// and the preview is also where the awkward truth shows up: a Bookings service whose
// staff are not Portal users cannot be offered to anyone until they are.

router.get('/diary/services/import', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  let preview: any = null;
  let error: string | null = null;
  try { preview = await previewBookingsImport(); }
  catch (e: any) { error = (e?.message || 'Bookings could not be read.').slice(0, 300); }
  res.render('booking/import', {
    user: req.session.user!, preview, error,
    notice: req.query.msg || null,
  });
});

router.post('/diary/services/import', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const raw = req.body.ms_id;
  const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(String).filter(Boolean);
  if (!ids.length) { res.redirect('/diary/services/import?msg=' + encodeURIComponent('Nothing was ticked, so nothing was imported.')); return; }
  try {
    const r = await importBookingServices(ids);
    await logActivity(req.session.user!.id, 'bookings_imported', 'booking_services', null,
      `Imported from Microsoft Bookings: ${r.created} new, ${r.updated} updated — ${r.names.join(', ')}`);
    res.redirect('/diary/services?msg=' + encodeURIComponent(
      `${r.created} service(s) created and ${r.updated} updated from Microsoft Bookings. `
      + 'Each one is CLOSED to the public until you tick "Offer it on the public booking page".'));
  } catch (e: any) {
    res.redirect('/diary/services/import?msg=' + encodeURIComponent((e?.message || 'Import failed.').slice(0, 250)));
  }
});

/** Rebuild the composer templates so each one links to OUR booking page. */
router.post('/diary/services/templates', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await syncBookingsTemplates();
    res.redirect('/diary/services?msg=' + encodeURIComponent(
      `Composer templates rebuilt from ${r.services} public service(s) — ${r.created} created, ${r.updated} updated. Find them under "Templates" in the reply composer.`));
  } catch (e: any) {
    res.redirect('/diary/services?err=' + encodeURIComponent((e?.message || 'Templates could not be rebuilt.').slice(0, 250)));
  }
});

/**
 * The four Lumen offers as standard, for an estate with no Bookings pages left to import
 * from. Idempotent by name: running it twice adds nothing, so it is safe to click again
 * after deleting one by mistake.
 */
const STANDARD: Array<Record<string, any>> = [
  { name: 'Remote Services', blurb: 'A screen-share with an engineer to get something fixed now.',
    kind: 'remote', duration_mins: 30, slot_step_mins: 30, lead_time_hours: 2, horizon_days: 21,
    teams_meeting: false, location_text: 'Remote support session', sort_order: 10 },
  { name: 'Remote Teams Meeting', blurb: 'A call with us about anything that needs talking through.',
    kind: 'remote', duration_mins: 30, slot_step_mins: 30, lead_time_hours: 4, horizon_days: 30,
    teams_meeting: true, location_text: 'Microsoft Teams', sort_order: 20 },
  { name: 'Service Review — Teams', blurb: 'Your regular review of how IT is running, over Teams.',
    kind: 'remote', duration_mins: 60, slot_step_mins: 30, lead_time_hours: 24, horizon_days: 90,
    teams_meeting: true, location_text: 'Microsoft Teams', sort_order: 30 },
  { name: 'Service Review — Onsite', blurb: 'The same review, with an engineer at your site.',
    kind: 'onsite', duration_mins: 90, buffer_mins: 45, slot_step_mins: 30, lead_time_hours: 48,
    horizon_days: 90, teams_meeting: false, location_text: 'At your site', sort_order: 40 },
];

router.post('/diary/services/standard', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const made: string[] = [];
  for (const d of STANDARD) {
    const have = await pool.query('SELECT id FROM booking_services WHERE lower(name)=lower($1)', [d.name]);
    if (have.rows.length) continue;
    const slug = await uniqueSlug(d.name);
    await pool.query(
      `INSERT INTO booking_services (name, blurb, kind, duration_mins, buffer_mins, slot_step_mins,
         lead_time_hours, horizon_days, window_start, window_end, weekdays, staff_ids,
         teams_meeting, location_text, sort_order, slug, is_public, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'09:00','17:00','[1,2,3,4,5]'::jsonb,'[]'::jsonb,$9,$10,$11,$12,false,true)`,
      [d.name, d.blurb, d.kind, d.duration_mins, d.buffer_mins || 0, d.slot_step_mins,
       d.lead_time_hours, d.horizon_days, d.teams_meeting, d.location_text, d.sort_order, slug]);
    made.push(d.name);
  }
  await logActivity(req.session.user!.id, 'booking_services_seeded', 'booking_services', null,
    made.length ? `Added: ${made.join(', ')}` : 'Nothing added — all four already existed');
  res.redirect('/diary/services?msg=' + encodeURIComponent(made.length
    ? `Added ${made.join(', ')}. Each is CLOSED to the public until you tick "Offer it on the public booking page".`
    : 'All four were already there — nothing changed.'));
});

// ── One booking: the agenda, and the cases it covers ────────────────────────────
//
// This is the page the "new booking" email links to. A booking arrives as a time and a
// sentence; what makes it worth the hour is what gets added here beforehand — and both
// the agenda and the tagged cases go out on the calendar invite, so the invitation in the
// customer's diary says what the meeting is actually for.

router.get('/diary/booking/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const booking = id ? await bookingById(id) : null;
  if (!booking) { res.redirect('/diary/week'); return; }
  const row = (await pool.query('SELECT customer_id, notes FROM diary_entries WHERE id=$1', [id])).rows[0];
  const customerId = row?.customer_id == null ? null : Number(row.customer_id);
  const [tagged, open] = await Promise.all([entryTickets(id), openCasesFor(customerId)]);
  res.render('booking/detail', {
    user: req.session.user!, booking, tagged, open, notes: row?.notes || null, customerId,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/diary/booking/:id/agenda', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/diary/week'); return; }
  await setAgenda(id, String(req.body.agenda || ''));
  await logActivity(req.session.user!.id, 'booking_agenda', 'diary_entries', id, 'Agenda updated');
  // Re-pushing puts the agenda on the staff calendar copy too, so it is there in Outlook
  // on the morning rather than only in the Portal.
  pushEntry(id).catch(() => {});
  const resend = String(req.body.resend || '') === '1';
  if (resend) await sendBookingMail(id, 'updated');
  res.redirect(`/diary/booking/${id}?msg=` + encodeURIComponent(resend
    ? 'Agenda saved and an updated invitation sent — it replaces the one in their calendar.'
    : 'Agenda saved. The customer has not been told; tick "send an updated invitation" when you want them to see it.'));
});

router.post('/diary/booking/:id/cases', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/diary/week'); return; }
  const raw = req.body.ticket_id;
  const want = new Set((Array.isArray(raw) ? raw : raw != null ? [raw] : [])
    .map((x: any) => parseInt(String(x), 10)).filter(Number.isInteger));
  const have = new Set((await entryTickets(id)).map(t => t.id));
  for (const t of want) if (!have.has(t)) await tagTicket(id, t, req.session.user!.id);
  for (const t of have) if (!want.has(t)) await untagTicket(id, t);
  await logActivity(req.session.user!.id, 'booking_cases', 'diary_entries', id, `${want.size} case(s) tagged`);
  res.redirect(`/diary/booking/${id}?msg=` + encodeURIComponent('Cases updated.'));
});

router.post('/diary/booking/:id/resend', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/diary/week'); return; }
  await sendBookingMail(id, 'updated');
  await logActivity(req.session.user!.id, 'booking_resend', 'diary_entries', id, 'Invitation re-sent');
  res.redirect(`/diary/booking/${id}?msg=` + encodeURIComponent('Invitation sent again — same meeting, updated.'));
});

export default router;
