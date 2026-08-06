import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { htmlToPdf } from '../lib/pdf';
import { logActivity } from '../lib/activity';
import { alertGroup } from '../lib/notifications';
import { sendMail } from '../lib/mailer';
import { quoteEmailHtml } from '../lib/emails';
import { config } from '../config';
import { getComms } from './comms';
import { nextInvoiceNumber } from '../lib/recurring-billing';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Embed the logo as a base64 data URI so the PDF renderer never needs a network fetch.
let _logoDataUri: string | null = null;
function logoDataUri(): string {
  if (_logoDataUri === null) {
    try {
      const buf = fs.readFileSync(path.join(process.cwd(), 'static', 'lumen-msp-logo.png'));
      _logoDataUri = 'data:image/png;base64,' + buf.toString('base64');
    } catch { _logoDataUri = ''; }
  }
  return _logoDataUri;
}

import {
  clientIp as evIp, getDocEvents, logDocEvent, newPixelToken, pixelImg, userAgent as evUa,
} from '../lib/doc-events';

const router = Router();
// 'invoiced' is set by the system, never chosen by hand - it means an invoice exists for
// this quote, and it is what stops the same job being billed twice.
const STATUSES = ['draft', 'sent', 'accepted', 'lost', 'invoiced'];

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const num = (v: any): number => { const x = parseFloat((v ?? '').toString()); return isNaN(x) ? 0 : x; };
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

async function nextQuoteNumber(): Promise<string> {
  const { rows } = await pool.query(`SELECT quote_number FROM quotes`);
  let max = 0;
  for (const r of rows) {
    const m = String(r.quote_number).match(/(\d+)/);
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  return 'Q-' + String(max + 1).padStart(4, '0');
}

// Persist line items + recompute and store totals on the quote (within a transaction client)
async function saveItemsAndTotals(client: any, quoteId: number, body: any): Promise<void> {
  const desc = asArray(body['desc']);
  const qty = asArray(body['qty']);
  const price = asArray(body['price']);
  const tax = asArray(body['tax']);
  const buy = asArray(body['buy']);
  const supplier = asArray(body['supplier']);
  const prodId = asArray(body['product_id']);

  await client.query('DELETE FROM quote_items WHERE quote_id = $1', [quoteId]);

  let subtotal = 0, taxTotal = 0, sort = 1;
  for (let i = 0; i < desc.length; i++) {
    const d = (desc[i] || '').toString().trim();
    if (!d) continue;
    const q = num(qty[i]) || 1;
    const p = num(price[i]);
    const t = num(tax[i]);
    const pid = prodId[i] ? (parseInt(prodId[i], 10) || null) : null;
    const lineTotal = q * p;
    subtotal += lineTotal;
    taxTotal += lineTotal * (t / 100);
    await client.query(
      `INSERT INTO quote_items (quote_id, product_id, sort_order, description, quantity, unit_price, tax_rate, line_total, buy_price, supplier_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [quoteId, pid, sort++, d, q, p, t, lineTotal, num(buy[i]), nz(supplier[i])]
    );
  }
  const total = subtotal + taxTotal;
  await client.query(
    `UPDATE quotes SET subtotal=$1, tax_total=$2, total=$3, updated_at=NOW() WHERE id=$4`,
    [subtotal.toFixed(2), taxTotal.toFixed(2), total.toFixed(2), quoteId]
  );
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/quotes', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const status = ((req.query.status as string) || '').trim();
  const search = ((req.query.search as string) || '').trim();

  const where: string[] = ['q.deleted_at IS NULL'];
  const params: any[] = [];
  if (status && STATUSES.includes(status)) { params.push(status); where.push('q.status = $' + params.length); }
  if (search) {
    params.push('%' + search + '%');
    where.push(`(q.quote_number ILIKE $${params.length} OR q.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  // LATERAL rather than a plain join: a quote could in principle carry more than one
  // invoice, and we want one row per quote with the first invoice attached, not a
  // duplicated quote row per invoice.
  const { rows } = await pool.query(
    `SELECT q.id, q.quote_number, q.title, q.status, q.total, q.currency_code, q.issue_date, q.valid_until,
            q.invoiced_at, c.name AS customer_name, c.id AS customer_id,
            inv.id AS invoice_id, inv.invoice_number, inv.status AS invoice_status
     FROM quotes q
     LEFT JOIN customers c ON c.id = q.customer_id
     LEFT JOIN LATERAL (
       SELECT i.id, i.invoice_number, i.status FROM invoices i
        WHERE i.quote_id = q.id AND i.deleted_at IS NULL
        ORDER BY i.id LIMIT 1
     ) inv ON true
     WHERE ${where.join(' AND ')}
     ORDER BY q.id DESC`,
    params
  );
  const stat = await pool.query(`SELECT status, COUNT(*)::int n FROM quotes WHERE deleted_at IS NULL GROUP BY status`);
  const statusCounts: Record<string, number> = {};
  stat.rows.forEach((r: any) => { statusCounts[r.status] = r.n; });

  res.render('quotes/list', { user, quotes: rows, status, search, statusCounts, msg: req.query.msg || null });
});

// ── New ──────────────────────────────────────────────────────────────────────────
router.get('/quotes/new', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const customers = await pool.query(
    `SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder = false ORDER BY name ASC`
  );
  res.render('quotes/form', {
    user, quote: null, items: [], customers: customers.rows,
    preselectCustomer: req.query.customer ? parseInt(String(req.query.customer), 10) : null, error: null,
  });
});

// ── Create ──────────────────────────────────────────────────────────────────────
router.post('/quotes', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  const title = (b.title || '').trim();
  if (!title) {
    const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
    res.render('quotes/form', { user, quote: b, items: [], customers: customers.rows, preselectCustomer: null, error: 'Title is required.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quoteNumber = await nextQuoteNumber();
    const { rows } = await client.query(
      `INSERT INTO quotes (customer_id, quote_number, title, status, issue_date, valid_until, currency_code, notes, terms, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, quoteNumber, title,
        STATUSES.includes(b.status) ? b.status : 'draft',
        nz(b.issue_date), nz(b.valid_until), nz(b.currency_code) || 'GBP', nz(b.notes), nz(b.terms), user.id,
      ]
    );
    await saveItemsAndTotals(client, rows[0].id, b);
    await client.query('COMMIT');
    await logActivity(user.id, 'created', 'quotes', rows[0].id, `Created quote ${quoteNumber} - ${title}`);
    res.redirect('/quotes/' + rows[0].id);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ── Detail ────────────────────────────────────────────────────────────────────
// ── Quote → invoice ─────────────────────────────────────────────────────────────
// The invoice comes out READY BUT NOT SENT: today's date on both issue and due, status
// draft, nothing emailed, nothing pushed to QuickBooks, no Direct Debit submitted.
// Someone still has to press Complete in Invoices — that is the action with consequences
// outside the Portal, and it should stay a deliberate one.
async function convertQuoteToInvoice(quoteId: number, userId: number): Promise<{
  ok: boolean; reason?: string; invoiceId?: number; invoiceNumber?: string; quoteNumber?: string;
}> {
  const q = (await pool.query('SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL', [quoteId])).rows[0];
  if (!q) return { ok: false, reason: 'no longer there' };

  const existing = (await pool.query(
    'SELECT id, invoice_number FROM invoices WHERE quote_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
    [quoteId])).rows[0];
  if (existing) {
    // Already billed. Correct the quote if it never got marked, then leave well alone —
    // a second invoice against one quote is how a customer gets charged twice.
    await pool.query(
      `UPDATE quotes SET status='invoiced', invoiced_at=COALESCE(invoiced_at, NOW()) WHERE id=$1`, [quoteId]);
    return { ok: false, reason: 'already invoiced as ' + existing.invoice_number, quoteNumber: q.quote_number };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = await nextInvoiceNumber('IT');
    const ins = await client.query(
      `INSERT INTO invoices (customer_id, quote_id, invoice_number, invoice_scheme, title, status,
              payment_status, payment_method, issue_date, due_date, currency_code, notes, terms,
              subtotal, tax_total, total, balance, created_by)
       VALUES ($1,$2,$3,'IT',$4,'draft','unpaid','upfront',CURRENT_DATE,CURRENT_DATE,$5,$6,$7,$8,$9,$10,$10,$11)
       RETURNING id`,
      [q.customer_id, q.id, invoiceNumber, q.title, q.currency_code || 'GBP', q.notes, q.terms,
       q.subtotal, q.tax_total, q.total, userId]);
    const invoiceId = ins.rows[0].id;

    // Totals are copied from the quote rather than recomputed: the quote is what the
    // customer agreed to, down to the penny, and rounding it a second time is how the
    // invoice ends up a penny out from the thing they signed.
    await client.query(
      `INSERT INTO invoice_items (invoice_id, product_id, source, sort_order, description,
              quantity, unit_price, tax_rate, line_total)
       SELECT $1, qi.product_id, 'manual', qi.sort_order, qi.description,
              qi.quantity, qi.unit_price, qi.tax_rate, qi.line_total
         FROM quote_items qi WHERE qi.quote_id=$2 ORDER BY qi.sort_order, qi.id`, [invoiceId, q.id]);

    await client.query(`UPDATE quotes SET status='invoiced', invoiced_at=NOW() WHERE id=$1`, [q.id]);
    await client.query('COMMIT');

    await logActivity(userId, 'created', 'invoices', invoiceId,
      `Created invoice ${invoiceNumber} from quote ${q.quote_number}`);
    await logActivity(userId, 'status_changed', 'quotes', q.id,
      `Quote ${q.quote_number} invoiced as ${invoiceNumber}`);
    return { ok: true, invoiceId, invoiceNumber, quoteNumber: q.quote_number };
  } catch (e: any) {
    await client.query('ROLLBACK');
    return { ok: false, reason: e.message, quoteNumber: q.quote_number };
  } finally {
    client.release();
  }
}

// ── Bulk actions ────────────────────────────────────────────────────────────────
// Registered BEFORE '/quotes/:id' — Express matches in order, and POST '/quotes/:id'
// would otherwise swallow this as a quote with the id "bulk".
router.post('/quotes/bulk', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const action = String(req.body.bulk_action || '');
  const ids = asArray(req.body.ids).map((v: any) => parseInt(String(v), 10)).filter((n: number) => !!n);
  const go = (m: string) => res.redirect('/quotes?msg=' + encodeURIComponent(m));

  if (!ids.length) { go('Nothing was ticked.'); return; }

  try {
    if (action === 'invoice') {
      // One transaction per quote, in sequence. nextInvoiceNumber() reads committed rows,
      // so converting them inside one transaction would hand every invoice the same number.
      const made: string[] = [];
      const skipped: string[] = [];
      for (const id of ids) {
        const r = await convertQuoteToInvoice(id, user.id);
        if (r.ok) made.push(r.invoiceNumber!);
        else skipped.push(`${r.quoteNumber || '#' + id} — ${r.reason}`);
      }
      let m = made.length
        ? `Created ${made.length} invoice${made.length === 1 ? '' : 's'} (${made.join(', ')}). They are drafts dated today — complete them in Invoices when you are ready.`
        : 'No invoices were created.';
      if (skipped.length) m += ` Skipped ${skipped.length}: ${skipped.join('; ')}.`;
      go(m);
      return;
    }

    if (action === 'lost') {
      const r = await pool.query(
        `UPDATE quotes SET status='lost' WHERE id = ANY($1::int[]) AND deleted_at IS NULL
           AND status <> 'invoiced' RETURNING id`, [ids]);
      const held = ids.length - r.rows.length;
      await logActivity(user.id, 'status_changed', 'quotes', null,
        `Marked ${r.rows.length} quote(s) as lost`);
      go(`Marked ${r.rows.length} as lost.` + (held ? ` ${held} left alone — a quote that has been invoiced cannot be lost.` : ''));
      return;
    }

    if (action === 'delete') {
      const r = await pool.query(
        `UPDATE quotes SET deleted_at=NOW(), deleted_by_user_id=$2
          WHERE id = ANY($1::int[]) AND deleted_at IS NULL RETURNING id`, [ids, user.id]);
      await logActivity(user.id, 'deleted', 'quotes', null,
        `Deleted ${r.rows.length} quote(s) in bulk`);
      go(`Moved ${r.rows.length} to the recycle bin.`);
      return;
    }

    go('That is not an action I know.');
  } catch (e: any) {
    console.error('[quotes] bulk action failed:', e.message);
    go('Could not finish: ' + e.message);
  }
});

router.get('/quotes/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Quote not found.' }); return; }
  const qRes = await pool.query(
    `SELECT q.*, c.name AS customer_name, cb.display_name AS created_by_name, it.ticket_number AS ticket_number
     FROM quotes q
     LEFT JOIN customers c ON c.id = q.customer_id
     LEFT JOIN users cb ON cb.id = q.created_by
     LEFT JOIN inbox_tickets it ON it.id = q.inbox_ticket_id
     WHERE q.id = $1 AND q.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (qRes.rows.length === 0) { res.status(404).render('error', { message: 'Quote not found.' }); return; }
  const quote = qRes.rows[0];
  const items = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY sort_order ASC, id ASC', [id]);
  const contacts = quote.customer_id
    ? (await pool.query('SELECT full_name, email, is_primary FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email <> \'\' ORDER BY is_primary DESC, full_name', [quote.customer_id])).rows
    : [];
  // What this quote became. Shown on the quote so nobody has to search Invoices to find
  // out whether it was ever billed.
  const invoices = (await pool.query(
    `SELECT id, invoice_number, status, payment_status, total, issue_date
       FROM invoices WHERE quote_id=$1 AND deleted_at IS NULL ORDER BY id`, [id])).rows;
  const comms = await getComms('quote', id);
  const commsTo = quote.sent_to || (contacts[0]?.email) || '';
  // For the Duplicate control — the common reason to copy a quote is to send the same
  // specification to a different customer, so the picker lives right next to the button.
  const customers = (await pool.query(
    `SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`)).rows;
  // Optional same-site return path (e.g. the customer screen's Quotes tab).
  const backQ = String(req.query.back || '');
  res.render('quotes/detail', { user, quote, items: items.rows, contacts, comms, commsTo, customers, invoices,
    back: /^\/(?!\/)/.test(backQ) ? backQ : null, events: await getDocEvents('quote', quote.id) });
});

// ── Duplicate ─────────────────────────────────────────────────────────────────
// Same specification, new number, today's date — and optionally a different customer,
// which is the usual reason for copying one.
//
// Deliberately NOT carried across: status, the accept token, view count, acceptance
// details and who it was sent to. A copy is a fresh draft nobody has seen; bringing any
// of that with it would make the audit trail claim things that never happened.
router.post('/quotes/:id/duplicate', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Quote not found.' }); return; }

  const src = (await pool.query('SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id])).rows[0];
  if (!src) { res.status(404).render('error', { message: 'Quote not found.' }); return; }

  const picked = parseInt(String((req.body || {}).customer_id || ''), 10);
  const customerId = Number.isFinite(picked) && picked > 0 ? picked : src.customer_id;

  // Keep the same validity WINDOW rather than the same expiry date — a quote copied in
  // August that inherited a July expiry would be born already out of date.
  let validDays: number | null = null;
  if (src.issue_date && src.valid_until) {
    const ms = new Date(src.valid_until).getTime() - new Date(src.issue_date).getTime();
    if (ms > 0) validDays = Math.round(ms / 86400000);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quoteNumber = await nextQuoteNumber();

    // Dates come from the database, not from Node — the server runs Europe/London while
    // Postgres stores UTC, and computing "today" in the wrong one is off by a day for an
    // hour every night through BST.
    const ins = await client.query(
      `INSERT INTO quotes (customer_id, quote_number, title, status, issue_date, valid_until,
                           currency_code, notes, terms, subtotal, tax_total, total, created_by)
       VALUES ($1,$2,$3,'draft', CURRENT_DATE, CURRENT_DATE + $4::int,
               $5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [customerId, quoteNumber, src.title, validDays,
       src.currency_code || 'GBP', src.notes, src.terms,
       src.subtotal, src.tax_total, src.total, user.id]);
    const newId = ins.rows[0].id;

    // Copy the lines in SQL so nothing is lost in translation — buy prices, supplier
    // links and sort order all come across exactly as they were.
    await client.query(
      `INSERT INTO quote_items (quote_id, product_id, supplier_id, sort_order, description, quantity,
                                unit_price, tax_rate, line_total, buy_price, supplier_name, supplier_url)
       SELECT $1, product_id, supplier_id, sort_order, description, quantity,
              unit_price, tax_rate, line_total, buy_price, supplier_name, supplier_url
         FROM quote_items WHERE quote_id = $2`, [newId, id]);

    await client.query('COMMIT');
    await logActivity(user.id, 'created', 'quotes', newId, `Duplicated ${src.quote_number} as ${quoteNumber}`);
    res.redirect('/quotes/' + newId);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ── Edit ──────────────────────────────────────────────────────────────────────
router.get('/quotes/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const qRes = await pool.query('SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (qRes.rows.length === 0) { res.status(404).render('error', { message: 'Quote not found.' }); return; }
  const [items, customers] = await Promise.all([
    pool.query('SELECT qi.*, ap.name AS product_name FROM quote_items qi LEFT JOIN asset_products ap ON ap.id=qi.product_id WHERE qi.quote_id=$1 ORDER BY qi.sort_order, qi.id', [id]),
    pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`),
  ]);
  res.render('quotes/form', { user, quote: qRes.rows[0], items: items.rows, customers: customers.rows, preselectCustomer: null, error: null });
});

// ── Update ──────────────────────────────────────────────────────────────────────
router.post('/quotes/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE quotes SET customer_id=$1, title=$2, status=$3, issue_date=$4, valid_until=$5, currency_code=$6, notes=$7, terms=$8
       WHERE id=$9 AND deleted_at IS NULL`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, (b.title || '').trim(),
        STATUSES.includes(b.status) ? b.status : 'draft',
        nz(b.issue_date), nz(b.valid_until), nz(b.currency_code) || 'GBP', nz(b.notes), nz(b.terms), id,
      ]
    );
    await saveItemsAndTotals(client, id, b);
    await client.query('COMMIT');
    await logActivity(user.id, 'updated', 'quotes', id, `Edited quote #${id}`);
    res.redirect('/quotes/' + id);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ── Status change ────────────────────────────────────────────────────────────────
router.post('/quotes/:id/status', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const status = String(req.body.status || '');
  if (STATUSES.includes(status)) {
    await logActivity(user.id, 'status_changed', 'quotes', id, `Quote #${id} status -> ${status}`);
    if (status === 'accepted') {
      await pool.query('UPDATE quotes SET status=$1, accepted_at=COALESCE(accepted_at, NOW()) WHERE id=$2', [status, id]);
    } else if (status === 'sent') {
      await pool.query(
        `UPDATE quotes SET status=$1, issue_date=COALESCE(issue_date, CURRENT_DATE),
           accept_token=COALESCE(accept_token, $2) WHERE id=$3`,
        [status, crypto.randomBytes(24).toString('hex'), id]
      );
    } else {
      await pool.query('UPDATE quotes SET status=$1 WHERE id=$2', [status, id]);
    }
  }
  res.redirect('/quotes/' + id);
});

// ── Soft delete ───────────────────────────────────────────────────────────────
router.post('/quotes/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE quotes SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id=$2', [user.id, id]);
  await logActivity(user.id, 'deleted', 'quotes', id, 'Deleted quote #' + id);
  res.redirect('/quotes');
});

// ── PDF (inline preview, or ?dl=1 to download) ──────────────────────────────────
router.get('/quotes/:id/pdf', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const qRes = await pool.query(
    `SELECT q.*, c.name AS customer_name, c.address_line_1, c.address_line_2, c.city, c.county, c.postcode
     FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
     WHERE q.id=$1 AND q.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!qRes.rows.length) { res.status(404).render('error', { message: 'Quote not found.' }); return; }
  const items = await pool.query(
    `SELECT qi.*, ap.name AS product_name FROM quote_items qi
     LEFT JOIN asset_products ap ON ap.id = qi.product_id WHERE qi.quote_id=$1 ORDER BY qi.sort_order, qi.id`, [id]
  );
  const acceptUrl = qRes.rows[0].accept_token ? config.APP_URL + '/q/' + qRes.rows[0].accept_token : null;
  const logoUrl = logoDataUri();
  res.app.render('quotes/pdf', { quote: qRes.rows[0], items: items.rows, acceptUrl, logoUrl }, async (err: any, html?: string) => {
    if (err || !html) { res.status(500).render('error', { message: 'PDF render failed.' }); return; }
    try {
      const pdf = await htmlToPdf(html, { margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + `; filename="${qRes.rows[0].quote_number}.pdf"`);
      res.send(pdf);
    } catch (e) {
      console.error('PDF error:', e);
      res.status(500).render('error', { message: 'PDF generation failed (Chromium may be missing on the server).' });
    }
  });
});

// ── Send to customer (sets token + status; emails if mail is configured) ────────
router.post('/quotes/:id/send', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const sendTo = nz(req.body.send_to);
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `UPDATE quotes SET status='sent', issue_date=COALESCE(issue_date, CURRENT_DATE),
       accept_token=COALESCE(accept_token, $1), sent_to=COALESCE($2, sent_to) WHERE id=$3`,
    [token, sendTo, id]
  );
  const q = await pool.query('SELECT quote_number, title, accept_token, total, valid_until, customer_id FROM quotes WHERE id=$1', [id]);
  const quote = q.rows[0];
  const link = config.APP_URL + '/q/' + quote.accept_token;
  const message = (req.body.message || '').toString().trim();
  if (sendTo) {
    // Personalise with the recipient's name if they're a known contact.
    let contactName = '';
    if (quote.customer_id) {
      const ct = await pool.query(
        'SELECT full_name FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1',
        [quote.customer_id, sendTo]
      );
      contactName = ct.rows[0]?.full_name || '';
    }
    const total = '£' + (Number(quote.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const validUntil = quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
    const pixelToken = newPixelToken();
    const sentEventId = await logDocEvent('quote', id, 'sent', {
      customerId: quote.customer_id, actor: sendTo, pixelToken,
      meta: { recipient: sendTo, by: user.displayName },
    });
    try {
      await sendMail({
        to: sendTo,
        subject: `Quotation ${quote.quote_number} from Lumen IT Solutions`,
        html: (sentEventId ? pixelImg(config.APP_URL, pixelToken) : '') +
          quoteEmailHtml({ contactName, quoteNumber: quote.quote_number, title: quote.title, total, validUntil, message, link }),
        signatureName: user.displayName,
      });
    } catch (e) { console.error('Quote email failed (mail not configured?):', e); }
  }
  res.redirect('/quotes/' + id);
});

// ── PUBLIC accept/reject page (no auth — customer-facing via token) ──────────────
router.get('/q/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const qRes = await pool.query(
    `SELECT q.*, c.name AS customer_name FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
     WHERE q.accept_token=$1 AND q.deleted_at IS NULL LIMIT 1`, [token]
  );
  if (!qRes.rows.length) { res.status(404).render('error', { message: 'This quote link is not valid.' }); return; }
  await pool.query('UPDATE quotes SET view_count = view_count + 1 WHERE accept_token=$1', [token]);
  await logDocEvent('quote', qRes.rows[0].id, 'opened', {
    customerId: qRes.rows[0].customer_id, actor: qRes.rows[0].sent_to,
    ip: evIp(req), userAgent: evUa(req),
  });
  const items = await pool.query('SELECT * FROM quote_items WHERE quote_id=$1 ORDER BY sort_order, id', [qRes.rows[0].id]);
  res.render('quotes/public', { quote: qRes.rows[0], items: items.rows, done: null });
});

router.post('/q/:token/accept', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const name = (req.body.name || '').trim();
  if (!name) { res.redirect('/q/' + token); return; }
  await pool.query(
    `UPDATE quotes SET status='accepted', accepted_by_name=$1, accepted_by_email=$2, approve_note=$3, accepted_at=NOW()
     WHERE accept_token=$4 AND status <> 'accepted'`,
    [name, nz(req.body.email), nz(req.body.note), token]
  );
  const q = await pool.query('SELECT id, customer_id, quote_number FROM quotes WHERE accept_token=$1', [token]);
  if (q.rows[0]) {
    const quote = q.rows[0];
    if (quote.customer_id) {
      await pool.query(`UPDATE customers SET status='active', lead_status='won' WHERE id=$1 AND status='lead'`, [quote.customer_id]);
      // Mark any open lead for this customer as won (converted) — keeps the pipeline honest.
      await pool.query(
        `UPDATE leads SET status='won', won_at=NOW(), updated_at=NOW()
          WHERE customer_id=$1 AND deleted_at IS NULL AND status NOT IN ('won','lost')`, [quote.customer_id]
      );
    }
    await logDocEvent('quote', quote.id, 'accepted', {
      customerId: quote.customer_id, actor: name + (nz(req.body.email) ? ' <' + nz(req.body.email) + '>' : ''),
      ip: evIp(req), userAgent: evUa(req),
    });
    await alertGroup('sales', 'Quote accepted — ' + quote.quote_number, name + ' accepted the quote', '/quotes/' + quote.id);
  }
  res.render('quotes/public', { quote: null, items: [], done: 'accepted' });
});

router.post('/q/:token/reject', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const rq = (await pool.query('SELECT id, customer_id FROM quotes WHERE accept_token=$1', [token])).rows[0];
  await pool.query(`UPDATE quotes SET status='lost', reject_reason=$1 WHERE accept_token=$2`, [nz(req.body.reason), token]);
  if (rq) {
    await logDocEvent('quote', rq.id, 'declined', {
      customerId: rq.customer_id, ip: evIp(req), userAgent: evUa(req),
      meta: { reason: nz(req.body.reason) },
    });
  }
  res.render('quotes/public', { quote: null, items: [], done: 'rejected' });
});

export default router;