import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { readBookToken } from '../lib/book-token';
import {
  publicServices, getServiceBySlug, availableSlots, bookSlot,
  bookerFromContact, bookerFromEmail, bookingByToken, KnownBooker,
} from '../lib/booking';
import { dayKeyOf, addDays, mondayOf } from '../lib/diary';
import { pushEntry, removeEntry } from '../lib/diary-graph';
import { sendBookingMail, notifyStaffOfBooking } from '../lib/booking-email';

// ─────────────────────────────────────────────────────────────────────────────────
// The public booking page. No session, no login, reachable by anyone with the link —
// which is the point: the link goes at the bottom of every email we send, so that a
// customer who needs half an hour of an engineer can take it instead of asking for it
// and waiting.
//
// Because it is open, every route here assumes the caller may be hostile:
//
//   1. NOTHING PRIVATE IS SHOWN. The page lists services and free times. It never
//      confirms whether an address is one of our customers, never names a customer, and
//      the token in the link only pre-fills a form — it grants nothing.
//   2. THE DIARY IS THE LIMIT. A booking still goes through saveEntry's hard block, so
//      the worst a flood can do is fill genuinely free slots, and the per-day cap on each
//      service is what bounds that.
//   3. THROTTLED AND HONEYPOTTED. A handful of bookings per hour per address; a hidden
//      field no human ever fills in.
//
// CSRF: the global guard exempts requests with no session (index.ts), which is the same
// treatment the quote-accept and self-signup flows get. The protections above are what
// stands in for it here.
// ─────────────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Throttle ────────────────────────────────────────────────────────────────────
// In-memory and per-process on purpose: this is a speed bump against a script, not a
// security control, and a Postgres round-trip per page view to enforce it would cost
// more than the abuse it prevents. Cleared on restart, which is fine.

const HITS = new Map<string, number[]>();
const MAX_PER_HOUR = 6;

function clientIp(req: Request): string {
  // Express's resolved ip (trust proxy = 1), never the raw header — a client can rotate
  // x-forwarded-for and walk straight through a throttle keyed on it.
  return String(req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function tooMany(ip: string): boolean {
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter(t => now - t < 3600_000);
  HITS.set(ip, recent);
  if (HITS.size > 5000) HITS.clear();          // never let the map become the leak
  return recent.length >= MAX_PER_HOUR;
}

// ── Availability cache ──────────────────────────────────────────────────────────
// Working out a week of slots asks Microsoft Graph for each engineer's free/busy. On a
// page anyone can load, that is an unauthenticated visitor spending our Graph quota, one
// call per person per refresh. A short cache makes a burst of page loads cost one lookup
// while staying far fresher than the ten minutes it would take someone to choose a time —
// and the write path re-checks availability from scratch anyway, so a cached slot that
// has since gone is refused at the moment of booking, not double-booked.

const SLOT_TTL_MS = 45_000;
const SLOTS = new Map<string, { at: number; v: { slots: any[]; outlookWarning: string | null } }>();

async function slotsCached(svc: any, from: string, to: string) {
  const key = `${svc.id}|${from}|${to}`;
  const hit = SLOTS.get(key);
  if (hit && Date.now() - hit.at < SLOT_TTL_MS) return hit.v;
  const v = await availableSlots(svc, from, to);
  if (SLOTS.size > 500) SLOTS.clear();
  SLOTS.set(key, { at: Date.now(), v });
  return v;
}

/** Drop a service's cached weeks the moment something is booked into one of them. */
function forgetSlots(serviceId: number): void {
  for (const k of Array.from(SLOTS.keys())) if (k.startsWith(`${serviceId}|`)) SLOTS.delete(k);
}

function record(ip: string): void {
  const now = Date.now();
  HITS.set(ip, [...(HITS.get(ip) || []).filter(t => now - t < 3600_000), now]);
}

// ── Who are we talking to? ──────────────────────────────────────────────────────

async function whoIsThis(req: Request): Promise<{ booker: KnownBooker; token: string }> {
  const raw = String(req.query.t || (req.body && req.body.t) || '');
  const contactId = readBookToken(raw);
  const booker = await bookerFromContact(contactId);
  // A token that no longer resolves (contact archived, secret rotated) simply falls back
  // to the anonymous page. Never an error — they came to book, not to debug our links.
  return { booker, token: booker.contactId ? raw : '' };
}

const qs = (token: string, extra = ''): string => {
  const parts = [token ? 't=' + encodeURIComponent(token) : '', extra].filter(Boolean);
  return parts.length ? '?' + parts.join('&') : '';
};

function base(req: Request, over: Record<string, any> = {}): Record<string, any> {
  return {
    mode: 'list', services: [], service: null, days: [], monday: null,
    prevW: null, nextW: null, today: null, horizonEnd: null, outlookWarning: null,
    booker: null, token: '', booking: null, values: {},
    notice: req.query.msg ? String(req.query.msg).slice(0, 300) : null,
    error: req.query.err ? String(req.query.err).slice(0, 300) : null,
    ...over,
  };
}

// ── The list ────────────────────────────────────────────────────────────────────

router.get('/book', async (req: Request, res: Response) => {
  const { booker, token } = await whoIsThis(req);
  const services = await publicServices(booker.customerId);
  res.render('book/public', base(req, { mode: 'list', services, booker, token }));
});

// ── One service: pick a time ────────────────────────────────────────────────────

router.get('/book/:slug', async (req: Request, res: Response, next) => {
  const slug = String(req.params.slug || '');
  if (slug === 'manage') return next();                     // reserved: the manage-a-booking path

  const { booker, token } = await whoIsThis(req);
  const services = await publicServices(booker.customerId);
  const svc = services.find(s => s.slug === slug) || null;
  if (!svc) {
    // Same answer whether the slug is wrong, retired, or Managed-IT-only and they are not:
    // a different message for each turns the page into a way to probe our configuration.
    res.redirect('/book' + qs(token, 'err=' + encodeURIComponent('That is not something we are taking bookings for at the moment.')));
    return;
  }

  const today = dayKeyOf(Math.floor(Date.now() / 1000));
  const wRaw = String(req.query.w || '');
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(wRaw) ? mondayOf(wRaw) : mondayOf(today);
  const from = monday < today ? today : monday;
  const horizonEnd = addDays(today, svc.horizonDays);
  const to = addDays(monday, 6) > horizonEnd ? horizonEnd : addDays(monday, 6);

  const { slots, outlookWarning } = to < from
    ? { slots: [] as any[], outlookWarning: null }
    : await slotsCached(svc, from, to);

  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map(dk => ({
    dayKey: dk, past: dk < today, beyond: dk > horizonEnd,
    slots: slots.filter((sl: any) => sl.dayKey === dk),
  }));

  res.render('book/public', base(req, {
    mode: 'pick', services, service: svc, days, monday, today, horizonEnd,
    prevW: addDays(monday, -7), nextW: addDays(monday, 7),
    outlookWarning, booker, token,
  }));
});

// ── Take the slot ───────────────────────────────────────────────────────────────

router.post('/book/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '');
  const b = (req.body || {}) as Record<string, string>;
  const { booker: fromToken, token } = await whoIsThis(req);
  const backToPick = (msg: string) => res.redirect(`/book/${encodeURIComponent(slug)}` + qs(token, 'err=' + encodeURIComponent(msg)));

  // The honeypot. A field positioned off-screen and labelled for autofill to ignore;
  // anything in it came from something reading the HTML, not from a person.
  if (String(b.website || '').trim()) { res.redirect('/book' + qs(token, 'msg=' + encodeURIComponent('Thank you.'))); return; }

  const ip = clientIp(req);
  if (tooMany(ip)) {
    return backToPick('That is several bookings from your connection in a short time. Please give it an hour, or email us and we will sort it out directly.');
  }

  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().slice(0, 190);
  const phone = String(b.phone || '').trim().slice(0, 40) || null;
  const company = String(b.company || '').trim().slice(0, 160) || null;
  const notes = String(b.notes || '').trim().slice(0, 2000) || null;
  const start = parseInt(String(b.start || ''), 10);

  if (!name) return backToPick('Please tell us your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return backToPick('Please give us an email address we can send the invitation to.');
  if (!Number.isFinite(start)) return backToPick('Please pick a time.');

  // Recognise them: the token first, then the address they typed. Neither is a claim of
  // entitlement — it decides which customer the meeting is FILED against, and nothing else.
  const booker = fromToken.customerId != null ? fromToken : await bookerFromEmail(email);

  const services = await publicServices(booker.customerId);
  const svc = services.find(s => s.slug === slug);
  if (!svc) return backToPick('That is not something we are taking bookings for at the moment.');

  const r = await bookSlot({
    service: svc, startEpoch: start,
    customerId: booker.customerId, bookedByUserId: null,
    name, email, phone, company: company || booker.customerName, notes,
  });
  if (!r.ok) {
    res.redirect(`/book/${encodeURIComponent(slug)}` + qs(token, `w=${dayKeyOf(start)}&err=` + encodeURIComponent(r.error || 'That time could not be booked. Please pick another.')));
    return;
  }
  record(ip);
  forgetSlots(svc.id);          // the slot they just took must not still be offered

  // Push to Outlook and WAIT: a Teams service has no join link until the event exists, and
  // an invitation that promises a link it does not carry is worse than one that says the
  // link will follow.
  await pushEntry(r.entryId!).catch(() => {});

  await logActivity(null, 'booking_created_public', 'diary_entries', r.entryId!,
    `${svc.name} booked by ${name} <${email}>${booker.customerName ? ' (' + booker.customerName + ')' : ' — UNMATCHED customer'}`);

  // Both emails are fire-and-forget: a booking that is genuinely in the diary must not be
  // reported as failed because a mailbox was slow.
  sendBookingMail(r.entryId!, 'confirmed').catch(() => {});
  notifyStaffOfBooking(r.entryId!).catch(() => {});

  res.redirect(`/book/manage/${r.cancelToken}?new=1`);
});

// ── Manage a booking (the link in the confirmation) ─────────────────────────────

router.get('/book/manage/:token', async (req: Request, res: Response) => {
  const booking = await bookingByToken(String(req.params.token || ''));
  if (!booking) {
    res.status(404).render('book/public', base(req, { mode: 'gone' }));
    return;
  }
  res.render('book/public', base(req, {
    mode: booking.status === 'cancelled' ? 'cancelled' : 'manage',
    booking, justBooked: String(req.query.new || '') === '1',
  }));
});

router.post('/book/manage/:token/cancel', async (req: Request, res: Response) => {
  const t = String(req.params.token || '');
  const booking = await bookingByToken(t);
  if (!booking || booking.status === 'cancelled') { res.redirect(`/book/manage/${encodeURIComponent(t)}`); return; }

  await pool.query(`UPDATE diary_entries SET status='cancelled', updated_at=NOW() WHERE id=$1`, [booking.id]);
  removeEntry(booking.id).catch(() => {});
  await logActivity(null, 'booking_cancelled_public', 'diary_entries', booking.id,
    `${booking.serviceName} cancelled by ${booking.bookedByName || 'the booker'}`);
  sendBookingMail(booking.id, 'cancelled').catch(() => {});
  res.redirect(`/book/manage/${encodeURIComponent(t)}`);
});

export default router;
