import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin, requireCustomer } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { sendMail } from '../lib/mailer';
import { config } from '../config';
import {
  listServices, getService, servicesForCustomer, availableSlots, bookSlot, customerBookings,
} from '../lib/booking';
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
  const ins = await pool.query(
    `INSERT INTO booking_services (name, blurb, kind, duration_mins, buffer_mins, slot_step_mins,
       lead_time_hours, horizon_days, window_start, window_end, weekdays, staff_ids, max_per_day,
       teams_meeting, itsm_only, colour, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17) RETURNING id`, f);
  await logActivity(req.session.user!.id, 'booking_service_create', 'booking_services', ins.rows[0].id, `Bookable: ${f[0]}`);
  res.redirect('/diary/services?msg=' + encodeURIComponent(`${f[0]} is now bookable.`));
});

router.post('/diary/services/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const f = serviceFields(req.body);
  const bad = serviceInvalid(f);
  if (!id || bad) { res.redirect('/diary/services?err=' + encodeURIComponent(bad || 'Unknown service.')); return; }
  await pool.query(
    `UPDATE booking_services SET name=$1, blurb=$2, kind=$3, duration_mins=$4, buffer_mins=$5,
            slot_step_mins=$6, lead_time_hours=$7, horizon_days=$8, window_start=$9, window_end=$10,
            weekdays=$11::jsonb, staff_ids=$12::jsonb, max_per_day=$13, teams_meeting=$14,
            itsm_only=$15, colour=$16, sort_order=$17, updated_at=NOW()
      WHERE id=$18`, [...f, id]);
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

  await sendBookingEmail(r.entryId!, svc.name, start, start + svc.durationMins * 60,
    String(req.body.email || u.email || ''), r.staffName || 'Lumen', joinUrl, svc.teamsMeeting).catch(e =>
    console.error('[booking] confirmation email failed:', e.message));

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

// ── Confirmation ────────────────────────────────────────────────────────────────

/** A real calendar invite, so the customer's own diary carries it too. */
function icsFor(uid: string, summary: string, start: number, end: number, joinUrl: string | null): string {
  const z = (e: number) => new Date(e * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LumenMSP//Portal//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${z(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
    `SUMMARY:${summary.replace(/[,;\\]/g, ' ')}`,
    joinUrl ? `DESCRIPTION:Join: ${joinUrl}` : 'DESCRIPTION:Booked with Lumen IT Solutions.',
    joinUrl ? `URL:${joinUrl}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

async function sendBookingEmail(
  entryId: number, serviceName: string, start: number, end: number,
  to: string, staffName: string, joinUrl: string | null, wantsTeams: boolean,
): Promise<void> {
  if (!/\S+@\S+/.test(to)) return;
  const when = `${diaryWhenText(start)}–${londonHM(end)}`;
  const teamsLine = joinUrl
    ? `<p style="margin:14px 0;"><a href="${joinUrl}" style="background:#0ea5b7;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;">Join the Teams meeting</a></p>`
    : wantsTeams
      ? '<p style="margin:14px 0;color:#b45309;">We will send the Teams joining link before the meeting.</p>'
      : '';
  const html = `
    <p>Your booking is confirmed.</p>
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:3px 12px 3px 0;color:#64748b;">What</td><td><strong>${serviceName}</strong></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#64748b;">When</td><td><strong>${when}</strong></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#64748b;">With</td><td>${staffName}</td></tr>
    </table>
    ${teamsLine}
    <p style="font-size:13px;color:#64748b;">Need to change it? Sign in to the Portal and open <strong>Book</strong> — you can cancel there and pick another time.</p>`;
  await sendMail({
    to, subject: `Confirmed: ${serviceName} — ${when}`, html, autoSubmitted: true,
    attachments: [{
      filename: 'booking.ics', contentType: 'text/calendar',
      base64: Buffer.from(icsFor(`lumen-booking-${entryId}@${(config.FROM_EMAIL || 'lumenmsp.co.uk').split('@').pop()}`,
        serviceName, start, end, joinUrl), 'utf8').toString('base64'),
    }],
  });
}

export default router;
