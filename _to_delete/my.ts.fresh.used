import { Router, Request, Response, NextFunction } from 'express';
import { requireCustomer } from '../middleware/auth';
import { pool, insightsPool } from '../db/pool';
import { nextTicketNumber } from './tickets';
import { getGroupsAndExtensions } from './insights';
import { buildJourneys, formatRoute, type CallEventRow } from '../lib/insights-journeys';
import { generateFromTemplate } from '../lib/insights/report-generator';
import { sendMail } from '../lib/mailer';
import { aiPolishText } from '../lib/ai-compose';

// ── Customer Portal (/my) ──────────────────────────────────────────────────────────
// A dedicated, reduced-access area for CUSTOMER-role users. Distinct from the staff /m app.
//
// ACCESS MODEL (Terry, 2026-06-25) — tiered by the customer's key-contact roles:
//   • Standard user   → their OWN tickets (raise + view own) + company profile (read-only)
//   • Finance contact → own tickets + INVOICES/finance
//   • Service contact → ALL company tickets + services/contracts + view company users
//   • Principal       → ALL company tickets + invoices + services + view company users
// A user's role is derived by matching their email to a customer_contacts row, then comparing
// that contact to customers.principal_contact_id / billing_contact_id / service_contact_id.
//
// SECURITY: every query is scoped to the session customerId; "all-tickets" perms are required
// to see beyond your own records; record ownership is re-checked server-side (anti-IDOR).

const router = Router();

// Idempotent: the per-customer "portal access enabled" master switch + the per-contact access
// level. Called at startup. (Both columns are also in schema.prisma so prisma db push keeps them.)
export async function ensureCustomerPortalColumn(): Promise<void> {
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_enabled boolean NOT NULL DEFAULT false')
    .catch((e) => console.error('ensureCustomerPortalColumn failed:', e.message));
  await pool.query('ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS portal_access_level text')
    .catch((e) => console.error('ensure portal_access_level failed:', e.message));
}

const q1 = async (sql: string, params: any[] = [], fallback = 0): Promise<number> =>
  Number((await pool.query(sql, params).catch(() => ({ rows: [{ n: fallback }] }))).rows[0]?.n ?? fallback);
const rows = async (sql: string, params: any[] = []): Promise<any[]> =>
  (await pool.query(sql, params).catch(() => ({ rows: [] }))).rows;

function cid(req: Request): number { return Number(req.session.user!.customerId); }
function perms(req: Request): any { return (req as any).perms || {}; }
function stripHtml(h: string): string {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
// SQL fragment limiting a ticket to this customer, and (unless they can see all) to their own.
function ticketScope(p: any): { where: string; params: (n: number, c: number) => any[] } {
  return p.allTickets
    ? { where: 'id=$1 AND customer_id=$2', params: (id, c) => [id, c] }
    : { where: 'id=$1 AND customer_id=$2 AND contact_id =$3', params: (id, c) => [id, c, p.contactId] };
}

// Resolve the logged-in customer user's permissions from their key-contact role(s).
async function attachPerms(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = req.session.user!;
  const c = Number(u.customerId);
  const contact = (await rows(
    'SELECT id, portal_access_level FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND lower(email)=lower($2) LIMIT 1',
    [c, u.email]))[0];
  const cust = (await rows(
    'SELECT principal_contact_id, billing_contact_id, service_contact_id, portal_enabled FROM customers WHERE id=$1', [c]))[0] || {};
  // Master switch: a customer must be deliberately enabled for portal access (live check, so
  // disabling a company cuts off its users on their next request).
  if (!cust.portal_enabled) {
    res.status(403).render('error', { message: 'Portal access is not enabled for your company yet. Please contact Lumen IT.' });
    return;
  }
  const contactId: number | null = contact?.id ?? null;

  // Access level: an explicit per-contact level (none|tickets|finance|service|full) takes precedence.
  // Contacts with no level set fall back to their key-contact role, so pre-existing access keeps working.
  const level = String(contact?.portal_access_level || '').toLowerCase();
  if (level === 'none') {
    res.status(403).render('error', { message: 'Your portal access has not been switched on yet. Please contact Lumen IT.' });
    return;
  }
  let isPrincipal: boolean, isFinance: boolean, isService: boolean;
  // 'support_insights' = company-wide ticket overview + call insights, NOTHING financial
  // and no services/users/IT-report areas (added 2026-07-08 for insight-service contacts).
  const isSupportInsights = level === 'support_insights';
  // 'tickets_insights' = their OWN tickets only + call insights (added 2026-07-14) — the
  // own-support sibling of 'support_insights'; every role flag stays false so ticket scope
  // falls back to contact_id, and only the insights permission is switched on below.
  const isTicketsInsights = level === 'tickets_insights';
  if (level === 'full' || level === 'finance' || level === 'service' || level === 'tickets' || isSupportInsights || isTicketsInsights) {
    isPrincipal = level === 'full';
    isFinance   = level === 'finance';
    isService   = level === 'service';
    // 'tickets' = own-tickets only — every role flag stays false.
  } else {
    isPrincipal = !!contactId && contactId === cust.principal_contact_id;
    isFinance   = !!contactId && contactId === cust.billing_contact_id;
    isService   = !!contactId && contactId === cust.service_contact_id;
  }
  const p = {
    contactId, isPrincipal, isFinance, isService,
    allTickets: isPrincipal || isService || isSupportInsights, // see beyond your own tickets
    finance:    isPrincipal || isFinance,            // invoices
    services:   isPrincipal || isService,            // services & contracts
    viewUsers:  isPrincipal || isService,            // view (not manage) company users
    insights:   isPrincipal || isService || isSupportInsights || isTicketsInsights, // call insights / number lookup (their own data only)
    itReports:  isPrincipal || isService,            // monthly IT Operations & Security Snapshots
  };
  (req as any).perms = p;
  res.locals.perms = p;
  next();
}

router.use('/my', requireCustomer, attachPerms);

// Guard a route on a named permission.
const need = (key: string) => (req: Request, res: Response, next: NextFunction): void => {
  if (perms(req)[key]) { next(); return; }
  res.status(403).render('error', { message: 'This area is not available on your account. Please contact your principal or finance contact.' });
};

// ── Dashboard ────────────────────────────────────────────────────────────────────
router.get('/my', async (req: Request, res: Response) => {
  const u = req.session.user!;
  const c = cid(req);
  const p = perms(req);
  const company = (await rows('SELECT name FROM customers WHERE id=$1', [c]))[0]?.name || 'Your company';

  // Tickets: all-company for principal/service, otherwise just your own.
  const ticketWhere = p.allTickets
    ? 'customer_id=$1'
    : 'customer_id=$1 AND contact_id =$2';
  const ticketParams = p.allTickets ? [c] : [c, p.contactId];

  const openTickets = await q1(
    `SELECT COUNT(*)::int n FROM inbox_tickets WHERE ${ticketWhere} AND deleted_at IS NULL AND is_spam=false AND status NOT IN ('resolved','closed')`, ticketParams);
  const recentTickets = await rows(
    `SELECT id, ticket_number, subject, status, updated_at FROM inbox_tickets WHERE ${ticketWhere} AND deleted_at IS NULL AND is_spam=false ORDER BY updated_at DESC NULLS LAST LIMIT 5`, ticketParams);

  const unpaidInvoices = p.finance ? await q1(
    "SELECT COUNT(*)::int n FROM invoices WHERE customer_id=$1 AND deleted_at IS NULL AND status NOT IN ('paid','cancelled','void')", [c]) : 0;
  const services = p.services ? await q1(
    "SELECT COUNT(*)::int n FROM service_items WHERE customer_id=$1", [c]) : 0;

  const h = new Date().getHours();
  const greeting = 'Good ' + (h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening') + ', ' + String(u.displayName || '').split(' ')[0];

  res.render('my/dashboard', { active: 'home', user: u, company, greeting, openTickets, unpaidInvoices, services, recentTickets });
});

// ── Tickets — list (scoped by permission) ──────────────────────────────────────────
router.get('/my/tickets', async (req: Request, res: Response) => {
  const c = cid(req); const p = perms(req);
  const where = p.allTickets ? 'customer_id=$1' : 'customer_id=$1 AND contact_id =$2';
  const params = p.allTickets ? [c] : [c, p.contactId];
  const tickets = await rows(
    `SELECT id, ticket_number, subject, status, activity_status, updated_at, created_at FROM inbox_tickets WHERE ${where} AND deleted_at IS NULL AND is_spam=false ORDER BY updated_at DESC NULLS LAST LIMIT 5000`, params);
  res.render('my/tickets', { active: 'tickets', user: req.session.user, tickets, scope: p.allTickets ? 'company' : 'you' });
});

// ── Tickets — raise (everyone) ──────────────────────────────────────────────────────
router.get('/my/tickets/new', (req: Request, res: Response) => {
  res.render('my/ticket-new', { active: 'tickets', user: req.session.user, error: null });
});

router.post('/my/tickets', async (req: Request, res: Response) => {
  const u = req.session.user!; const c = cid(req); const p = perms(req);
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const body = String(req.body.description || '').trim().slice(0, 10000);
  if (!subject || !body) {
    res.render('my/ticket-new', { active: 'tickets', user: u, error: 'Please give a subject and a description.' });
    return;
  }
  // Record WHO raised it: use their matched contact, or find-or-create one. This also makes the
  // ticket appear in their own-tickets list (own scope is by contact_id).
  const contactId = p.contactId || await ensureContact(c, u.email, u.displayName);
  try {
    const tn = await nextTicketNumber();
    await pool.query(
      `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, status, department, category, subject, description, activity_status, stage, updated_at)
       VALUES ($1, 'portal', $2, $3, 'new', 'support', 'incident', $4, $5, 'unread', 'awaiting_triage', NOW())`,
      [tn, c, contactId, subject, body]
    );
  } catch (e: any) { console.error('customer ticket create failed:', e.message); }
  res.redirect('/my/tickets');
});

// Find the customer's contact by email, or create a lightweight one so portal tickets are
// always attributed to a contact (logs the requester + powers own-ticket scoping).
async function ensureContact(customerId: number, email: string, name: string): Promise<number | null> {
  if (!email) return null;
  const found = (await rows('SELECT id FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND lower(email)=lower($2) LIMIT 1', [customerId, email]))[0];
  if (found) return found.id;
  const ins = (await rows('INSERT INTO customer_contacts (customer_id, full_name, email) VALUES ($1,$2,$3) RETURNING id', [customerId, name || email, email]))[0];
  return ins?.id ?? null;
}

// ── Tickets — detail + customer-safe conversation thread (ownership/permission checked) ──
router.get('/my/tickets/:id', async (req: Request, res: Response) => {
  const c = cid(req); const p = perms(req);
  const id = parseInt(String(req.params.id), 10);
  const sc = ticketScope(p);
  // Must belong to this customer AND (you can see all OR it's your own) — else 404 (anti-IDOR).
  const ticket = (await rows(
    `SELECT id, ticket_number, subject, status, activity_status, description, category, department, assigned_user_id, created_at, updated_at FROM inbox_tickets WHERE ${sc.where} AND deleted_at IS NULL AND is_spam=false LIMIT 1`,
    sc.params(id, c)))[0];
  if (!ticket) { res.status(404).render('error', { message: 'Ticket not found.' }); return; }

  // Who's handling it (engineer display name), for the customer-facing details panel.
  let assignedTo: string | null = null;
  if (ticket.assigned_user_id) {
    assignedTo = (await rows('SELECT display_name FROM users WHERE id=$1', [ticket.assigned_user_id]))[0]?.display_name || null;
  }

  // Customer-safe timeline: real messages (inbound from them / outbound to them) PLUS only
  // 'public_reply' notes. Internal notes ('private_note','side_convo','system_log') are NEVER shown.
  const msgs = await rows(
    "SELECT message_direction AS dir, from_name, body_html, body_text, COALESCE(received_at, created_at) AS at FROM inbox_messages WHERE ticket_id=$1 ORDER BY COALESCE(received_at, created_at)", [id]);
  const replies = await rows(
    "SELECT body, created_at AS at FROM inbox_notes WHERE ticket_id=$1 AND note_type='public_reply' ORDER BY created_at", [id]);
  // Newest first (matches the main portal).
  const timeline = [
    ...msgs.map((m: any) => ({ mine: m.dir === 'inbound', who: m.dir === 'inbound' ? (m.from_name || 'You') : 'Lumen IT', body: m.body_text || stripHtml(m.body_html || ''), at: m.at })),
    ...replies.map((r: any) => ({ mine: false, who: 'Lumen IT', body: stripHtml(r.body || ''), at: r.at })),
  ].filter((t) => t.body).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.render('my/ticket', { active: 'tickets', user: req.session.user, ticket, timeline, assignedTo });
});

// ── Tickets — customer reply (adds an inbound message + reopens the case) ────────────
router.post('/my/tickets/:id/reply', async (req: Request, res: Response) => {
  const u = req.session.user!; const c = cid(req); const p = perms(req);
  const id = parseInt(String(req.params.id), 10);
  const sc = ticketScope(p);
  const ticket = (await rows(`SELECT id FROM inbox_tickets WHERE ${sc.where} AND deleted_at IS NULL AND is_spam=false LIMIT 1`, sc.params(id, c)))[0];
  if (!ticket) { res.status(404).render('error', { message: 'Ticket not found.' }); return; }
  const body = String(req.body.body || '').trim().slice(0, 10000);
  if (body) {
    await pool.query(
      "INSERT INTO inbox_messages (ticket_id, message_direction, channel, from_name, from_email, body_text, received_at) VALUES ($1,'inbound','portal',$2,$3,$4,NOW())",
      [id, u.displayName || 'Customer', u.email, body]
    ).catch((e) => console.error('customer reply failed:', e.message));
    // Reopen + bump so staff see it.
    await pool.query("UPDATE inbox_tickets SET status='open', updated_at=NOW() WHERE id=$1", [id]).catch(() => {});
  }
  res.redirect('/my/tickets/' + id);
});

// "Improve with Claude" for the customer's reply box — polish their draft into clear British English.
router.post('/my/ai/polish', async (req: Request, res: Response) => {
  try {
    const message = await aiPolishText({ text: String((req.body || {}).text || ''), mode: 'polish' });
    res.json({ ok: true, message });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Improve failed' });
  }
});

// ── Profile (read-only, everyone) ───────────────────────────────────────────────────
router.get('/my/profile', async (req: Request, res: Response) => {
  const u = req.session.user!; const c = cid(req);
  const company = (await rows('SELECT name, email, phone, website, address_line_1, address_line_2, city, county, postcode FROM customers WHERE id=$1', [c]))[0] || {};
  const me = (await rows('SELECT full_name, email, phone, job_title FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND lower(email)=lower($2) LIMIT 1', [c, u.email]))[0] || { full_name: u.displayName, email: u.email };
  res.render('my/profile', { active: 'profile', user: u, company, me });
});

// ── Company users (view-only; principal/service) ────────────────────────────────────
router.get('/my/users', need('viewUsers'), async (req: Request, res: Response) => {
  const c = cid(req);
  const people = await rows('SELECT id, full_name, email, phone, job_title FROM customer_contacts WHERE customer_id=$1 ORDER BY full_name ASC', [c]);
  res.render('my/users', { active: 'users', user: req.session.user, people });
});

// ── Permission-gated feature pages (data build-out is the next phase) ───────────────
router.get('/my/invoices', need('finance'), async (req: Request, res: Response) => {
  const c = cid(req);
  const invoices = await rows(
    `SELECT id, invoice_number, title, total, balance, status, payment_status, issue_date, due_date
       FROM invoices WHERE customer_id=$1 AND deleted_at IS NULL
       ORDER BY issue_date DESC NULLS LAST, id DESC LIMIT 500`, [c]);
  res.render('my/invoices', { active: 'invoices', user: req.session.user, title: 'Invoices', invoices });
});
router.get('/my/quotes', need('finance'), async (req: Request, res: Response) => {
  const c = cid(req);
  const quotes = await rows(
    `SELECT id, quote_number, title, status, total, issue_date, valid_until
       FROM quotes WHERE customer_id=$1 AND deleted_at IS NULL
       ORDER BY issue_date DESC NULLS LAST, id DESC LIMIT 500`, [c]);
  res.render('my/quotes', { active: 'quotes', user: req.session.user, title: 'Quotes', quotes });
});

// Open a single invoice (finance-gated + scoped to this customer).
router.get('/my/invoices/:id', need('finance'), async (req: Request, res: Response) => {
  const c = cid(req);
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const inv = (await rows(
    `SELECT id, invoice_number, title, status, payment_status, issue_date, due_date, total, balance, notes, terms
       FROM invoices WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL LIMIT 1`, [id, c]))[0];
  if (!inv) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const items = await rows(
    'SELECT description, quantity, unit_price, tax_rate, line_total FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order NULLS LAST, id', [id]);
  res.render('my/invoice', { active: 'invoices', user: req.session.user, inv, items });
});

// Open a single quote (finance-gated + scoped to this customer).
router.get('/my/quotes/:id', need('finance'), async (req: Request, res: Response) => {
  const c = cid(req);
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(404).render('error', { message: 'Quote not found.' }); return; }
  const qt = (await rows(
    `SELECT id, quote_number, title, status, issue_date, valid_until, subtotal, tax_total, total
       FROM quotes WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL LIMIT 1`, [id, c]))[0];
  if (!qt) { res.status(404).render('error', { message: 'Quote not found.' }); return; }
  const items = await rows(
    'SELECT description, quantity, unit_price, tax_rate, line_total FROM quote_items WHERE quote_id=$1 ORDER BY sort_order NULLS LAST, id', [id]);
  res.render('my/quote', { active: 'quotes', user: req.session.user, qt, items });
});
router.get('/my/services', need('services'), (req: Request, res: Response) =>
  res.render('my/soon', { active: 'services', user: req.session.user, title: 'Services', blurb: 'The services and contracts you have with us will be listed here soon.' }));
// Customer Insights — their own call-analytics reports, scoped via the Insights DB's lumenmsp_id
// bridge back to this portal customer. Lists the reports we produce for them; each opens the stored HTML.
router.get('/my/insights', need('insights'), async (req: Request, res: Response) => {
  const u = req.session.user!;
  const c = cid(req);
  const tab = req.query.tab === 'reports' ? 'reports' : req.query.tab === 'reverse' ? 'reverse' : 'home';
  const q = String(req.query.q || '').trim();
  const base: any = {
    active: 'insights', user: u, title: 'Insights', tab, q,
    journeys: [], stats: null, templates: [], sites: [], reports: [], emails: [], insName: '',
    ext: '', fromDate: '', toDate: '', fromTime: '00:00', toTime: '23:59', extensions: [], calls: [], rstats: null,
    msg: req.query.msg || null, err: req.query.err || null, state: 'ok',
  };
  try {
    if (!insightsPool) { res.render('my/insights', { ...base, state: 'down' }); return; }
    const ins = (await insightsPool.query(
      'SELECT id, name FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [c])).rows[0];
    if (!ins) { res.render('my/insights', { ...base, state: 'unlinked' }); return; }
    base.insName = ins.name;

    // Home tab — Call Tracker: look up a number across the customer's cached calls (last 28 days).
    if (tab === 'home' && q.length >= 3) {
      const norm = q.replace(/[\s\-()]/g, '').replace(/^\+44/, '0');
      const from = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const rows2 = (await insightsPool.query(
        `SELECT * FROM call_events
          WHERE customer_id = $1
            AND (number_normalised = $2 OR number_normalised ILIKE $3 OR number_raw ILIKE $3)
            AND event_datetime >= $4 AND event_datetime <= $5
          ORDER BY event_datetime ASC LIMIT 5000`,
        [ins.id, norm, '%' + norm + '%', from + ' 00:00:00', to + ' 23:59:59'])).rows as CallEventRow[];
      const journeys = buildJourneys(rows2, { business_hours_only: false }).reverse().map((j) => ({ ...j, route: formatRoute(j) }));
      const total = journeys.length;
      const answered = journeys.filter((j) => j.status === 'Answered').length;
      const missed = journeys.filter((j) => j.status === 'Missed' || j.status === 'Abandoned').length;
      const avgWait = total ? Math.round(journeys.reduce((s, j) => s + j.wait_secs, 0) / total) : 0;
      base.journeys = journeys;
      base.stats = { total, answered, missed, ansRate: total ? Math.round(answered / total * 100) : 0, avgWait };
    }

    // "Answered by" (reverse lookup) tab — every call a chosen extension/user ANSWERED in a
    // date + time window, the customer-portal pair of the staff /insights/reverse tool.
    // BOUNDARIES: the Insights customer id comes ONLY from the session's lumenmsp bridge
    // (ins.id) — no customer/site parameter is accepted from the client; the extension
    // autocomplete list is scoped to ins.id; staff /insights/* routes stay blocked to the
    // customer role by requireAuth. Same anti-IDOR posture as the rest of /my.
    if (tab === 'reverse') {
      base.extensions = (await getGroupsAndExtensions(ins.id)).extensions;
      const ext = String(req.query.ext || '').trim().slice(0, 80);
      base.ext = ext;
      const today2 = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      base.fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : weekAgo;
      base.toDate   = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to   || '')) ? String(req.query.to)   : today2;
      base.fromTime = /^\d{2}:\d{2}$/.test(String(req.query.from_time || '')) ? String(req.query.from_time) : '00:00';
      base.toTime   = /^\d{2}:\d{2}$/.test(String(req.query.to_time   || '')) ? String(req.query.to_time)   : '23:59';
      if (ext) {
        if (base.toDate < base.fromDate) { base.err = 'The end date is before the start date.'; res.render('my/insights', base); return; }
        const spanDays = Math.round((new Date(base.toDate).getTime() - new Date(base.fromDate).getTime()) / 86400000) + 1;
        if (spanDays > 92) { base.err = 'Date range is too wide — pick 92 days or fewer.'; res.render('my/insights', base); return; }
        // All the customer's events in the window (not just this extension's rows) so the journey
        // builder sees every leg of each call and attributes "answered by" correctly.
        const evRows = (await insightsPool.query(
          `SELECT * FROM call_events
            WHERE customer_id = $1 AND event_datetime >= $2 AND event_datetime <= $3
            ORDER BY event_datetime ASC LIMIT 50000`,
          [ins.id, base.fromDate + ' 00:00:00', base.toDate + ' 23:59:59'])).rows as CallEventRow[];
        const revJourneys = buildJourneys(evRows, { business_hours_only: false });
        const normExt = (s: string) => String(s || '').replace(/@.*$/, '').trim().toLowerCase();
        const target = normExt(ext);
        // Wall-clock in Europe/London — the same clock this page displays (fmtT in the view).
        const ldn = (iso: string) => {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          }).formatToParts(new Date(iso));
          const g = (t: string) => parts.find((p) => p.type === t)?.value || '00';
          return { day: `${g('year')}-${g('month')}-${g('day')}`, mins: parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10) };
        };
        const [fh, fm] = base.fromTime.split(':').map(Number);
        const [th, tm] = base.toTime.split(':').map(Number);
        const lo = fh * 60 + fm, hi = th * 60 + tm;
        const calls = revJourneys
          .filter((j) => j.status === 'Answered' && normExt(j.answered_by || '') === target)
          .filter((j) => { const m = ldn(j.datetime).mins; return m >= lo && m <= hi; })
          .reverse()
          .map((j) => ({ ...j, route: formatRoute(j) }));
        const byDay = new Map<string, number>();
        for (const cj of calls) { const k = ldn(cj.datetime).day; byDay.set(k, (byDay.get(k) || 0) + 1); }
        let busiestDay = ''; let busiestN = 0;
        for (const [dk, n] of byDay) if (n > busiestN) { busiestDay = dk; busiestN = n; }
        base.calls = calls;
        base.rstats = {
          total: calls.length,
          uniqueCallers: new Set(calls.map((x) => x.number)).size,
          avgWait: calls.length ? Math.round(calls.reduce((s, j) => s + j.wait_secs, 0) / calls.length) : 0,
          busiestDay, busiestN,
        };
      }
    }


    // Reports tab — their predetermined report configs (per site) + the reports already produced.
    if (tab === 'reports') {
      base.templates = (await insightsPool.query(
        'SELECT id, name FROM report_templates WHERE is_active = true ORDER BY is_system DESC, lower(name)')).rows;
      base.sites = (await insightsPool.query(
        'SELECT id, site_label FROM sites WHERE customer_id = $1 ORDER BY site_label', [ins.id])).rows;
      base.reports = (await insightsPool.query(
        `SELECT gr.id, gr.report_start, gr.report_end, gr.generated_at, gr.created_at,
                rc.config_label, rc.report_type, s.site_label
           FROM generated_reports gr
           JOIN report_configs rc ON rc.id = gr.config_id
           JOIN sites s ON s.id = rc.site_id
          WHERE s.customer_id = $1 AND gr.html IS NOT NULL AND gr.status::text IN ('generated','sent')
          ORDER BY gr.generated_at DESC NULLS LAST, gr.created_at DESC LIMIT 60`, [ins.id])).rows;
      // Email suggestions = every address on this customer's contacts (portal DB, by portal customer id).
      base.emails = (await rows(
        "SELECT DISTINCT email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email <> '' ORDER BY email", [c]
      )).map((r: any) => r.email);
    }
    res.render('my/insights', base);
  } catch (e: any) {
    console.error('/my/insights failed:', e?.message || e);
    if (!res.headersSent) res.render('my/insights', { ...base, state: 'down' });
  }
});

// Run a POOL template against the customer's own site over a date range, and render it. Scoped:
// the site must belong to this customer (site→customer→lumenmsp_id), so no other company's data.
router.post('/my/insights/run', need('insights'), async (req: Request, res: Response) => {
  const c = cid(req);
  const b = (req.body || {}) as any;
  const siteId = parseInt(String(b.site_id || ''), 10);
  const templateId = parseInt(String(b.template_id || ''), 10);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(b.date_from || today);
  const to = new Date(b.date_to || b.date_from || today);
  if (!insightsPool || !siteId || !templateId) { res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Pick a report and a site.')); return; }
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) { res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Pick a valid date range.')); return; }
  try {
    const ok = (await insightsPool.query(
      `SELECT 1 FROM sites s JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1 AND c.lumenmsp_id = $2 AND c.is_active = true LIMIT 1`, [siteId, c])).rows[0];
    if (!ok) { res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Site not found.')); return; }
    const { html } = await generateFromTemplate(templateId, siteId, from, to);
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob: https:; img-src * data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:");
    res.send(html);
  } catch (e: any) {
    console.error('/my/insights/run failed:', e?.message || e);
    res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Could not run that report just now.'));
  }
});

// Email one of the customer's reports to an address (suggested from their own contacts, but any
// valid address is allowed). Scoped: the report must belong to this customer.
router.post('/my/insights/report/:id/email', need('insights'), async (req: Request, res: Response) => {
  const c = cid(req);
  const id = parseInt(String(req.params.id), 10);
  const to = String((req.body || {}).to || '').trim();
  if (!insightsPool || !Number.isInteger(id)) { res.redirect('/my/insights?tab=reports'); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Enter a valid email address.')); return;
  }
  try {
    const r = (await insightsPool.query(
      `SELECT gr.html, gr.report_start, gr.report_end, rc.config_label
         FROM generated_reports gr
         JOIN report_configs rc ON rc.id = gr.config_id
         JOIN sites s ON s.id = rc.site_id
         JOIN customers c ON c.id = s.customer_id
        WHERE gr.id = $1 AND c.lumenmsp_id = $2 AND c.is_active = true LIMIT 1`, [id, c])).rows[0];
    if (!r || !r.html) { res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Report not found.')); return; }
    const fmt = (x: any) => x ? new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const period = r.report_start ? ` — ${fmt(r.report_start)}${r.report_end ? ' to ' + fmt(r.report_end) : ''}` : '';
    await sendMail({ to, subject: `${r.config_label}${period}`, html: r.html });
    res.redirect('/my/insights?tab=reports&msg=' + encodeURIComponent('Report emailed to ' + to));
  } catch (e: any) {
    console.error('/my/insights/report/email failed:', e?.message || e);
    res.redirect('/my/insights?tab=reports&err=' + encodeURIComponent('Could not email the report just now.'));
  }
});

// View one of THIS customer's reports. Scoped: the join to customers.lumenmsp_id = my customer id
// means a guessed/forged report id from another company returns 404 (anti-IDOR).
router.get('/my/insights/report/:id', need('insights'), async (req: Request, res: Response) => {
  const c = cid(req);
  if (!insightsPool) { res.status(503).send('Insights is temporarily unavailable.'); return; }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(404).render('error', { message: 'Report not found.' }); return; }
  try {
    const row = (await insightsPool.query(
      `SELECT gr.html
         FROM generated_reports gr
         JOIN report_configs rc ON rc.id = gr.config_id
         JOIN sites s ON s.id = rc.site_id
         JOIN customers c ON c.id = s.customer_id
        WHERE gr.id = $1 AND c.lumenmsp_id = $2 AND c.is_active = true LIMIT 1`, [id, c])).rows[0];
    if (!row || !row.html) { res.status(404).render('error', { message: 'Report not found.' }); return; }
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob: https:; img-src * data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:");
    res.send(row.html);
  } catch (e: any) {
    console.error('/my/insights/report failed:', e?.message || e);
    if (!res.headersSent) res.status(503).send('Insights is temporarily unavailable.');
  }
});

// ── IT Operations & Security Snapshots (customer view) ───────────────────────────
router.get('/my/it-reports', need('itReports'), async (req: Request, res: Response) => {
  const c = cid(req);
  const reports = await rows(
    `SELECT id, period_label, created_at, sent_at FROM it_report_runs
      WHERE customer_id=$1 AND status='sent' ORDER BY period_start DESC, created_at DESC LIMIT 60`, [c]);
  res.render('my/it-reports', { active: 'it-reports', user: req.session.user, reports });
});

router.get('/my/it-report/:id', need('itReports'), async (req: Request, res: Response) => {
  const c = cid(req);
  const row = (await rows(
    "SELECT html FROM it_report_runs WHERE id=$1 AND customer_id=$2 AND status='sent' LIMIT 1",
    [parseInt(String(req.params.id), 10), c]))[0];
  if (!row || !row.html) { res.status(404).render('error', { message: 'Report not found.' }); return; }
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob: https:; img-src * data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:");
  res.send(row.html);
});

export default router;
