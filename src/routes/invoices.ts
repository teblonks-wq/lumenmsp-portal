import { Router, Request, Response } from 'express';
import { requireAuth, requireFinance } from '../middleware/auth';
import { pool } from '../db/pool';
import { getComms } from './comms';
import { logActivity } from '../lib/activity';
import { notify } from '../lib/notifications';
import { renderInvoicePdf, loadInvoiceForRender, renderInvoiceHtml } from '../lib/invoice-pdf';
import { htmlToPdf } from '../lib/pdf';
import { emailInvoiceAction, pushInvoiceToQBAction, submitInvoiceToGCAction, remindInvoiceAction } from './integrations';
import { sendMail } from '../lib/mailer';
import { invoiceEmailHtml } from '../lib/emails';
import { invoiceViewUrl } from '../lib/invoice-link';
import { QuickBooks } from '../lib/quickbooks';
import { generateFromTemplate, refreshGiacomLines, refreshCallCharges, regenerateInvoice, nextInvoiceNumber, recomputeInvoiceTotals } from '../lib/recurring-billing';
import { syncItCloudInvoice, resyncItCloudLine, promoteItCloudToTemplate } from '../lib/it-cloud-sync';
import { resolvePeriod, PERIOD_OPTIONS } from '../lib/date-periods';
import { getSetting } from '../lib/settings';
import { config } from '../config';
import { aiAskText, aiAskCached, cacheNote } from '../lib/ai-compose';
import { GoCardless } from '../lib/gocardless';
import { askFinance, listFinanceConversations, getFinanceConversation, listFinanceMemories, archiveFinanceMemory } from '../lib/finance-agent';

import {
  clientIp as evIp, getDocEvents, logDocEvent, newPixelToken, pixelImg, userAgent as evUa,
} from '../lib/doc-events';

const router = Router();
// Finance-only (admins included). Scoped to this module's paths so it never gates unrelated
// requests that pass through this '/'-mounted router (it previously redirected everything to login).
router.use(['/invoices', '/credits'], requireFinance);
const STATUSES = ['draft', 'issued', 'paid', 'void'];
const PAY_STATUSES = ['unpaid', 'pending', 'paid', 'failed'];
const SCHEMES = ['IT', 'CS', 'IC']; // IC added Phase 0 (register rebuild) - create/edit posts were coercing IC to IT

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const num = (v: any): number => { const x = parseFloat((v ?? '').toString()); return isNaN(x) ? 0 : x; };
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

// nextInvoiceNumber now comes from lib/recurring-billing (the collision-safe version that
// scans past globally-taken numbers incl. soft-deleted rows) - the weaker local copy is gone (Phase 0).

async function saveItemsAndTotals(client: any, invoiceId: number, body: any): Promise<void> {
  const desc = asArray(body['desc']);
  const qty = asArray(body['qty']);
  const price = asArray(body['price']);
  const tax = asArray(body['tax']);
  const prodId = asArray(body['product_id']);
  const src = asArray(body['source']);
  // Hybrid IT&Cloud sync metadata carried through the form (optional — absent on plain invoices).
  const syncRef = asArray(body['sync_ref']);
  const syncLocked = asArray(body['sync_locked']);   // current lock state (hidden)
  const oneOff = asArray(body['one_off']);
  const prevQty = asArray(body['prev_qty']);
  const prevPrice = asArray(body['prev_price']);
  const prevDesc = asArray(body['prev_desc']);
  const itemIds = asArray(body['item_id']);
  const truthy = (v: any) => v === 'on' || v === '1' || v === 'true' || v === true;
  // PRESERVE what the form doesn't carry (Phase 0): the delete-and-reinsert below used to
  // silently strip invoice_category and contract_line_id on EVERY hand edit - breaking the
  // comms per-category compare tick and contract-push idempotency for the edited invoice.
  // Rows round-trip their DB id via hidden item_id[]; new rows have none.
  const prevRows = (await client.query('SELECT id, invoice_category, contract_line_id FROM invoice_items WHERE invoice_id=$1', [invoiceId])).rows;
  const prevById: Record<string, any> = {};
  for (const r of prevRows) prevById[String(r.id)] = r;
  await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [invoiceId]);
  let subtotal = 0, taxTotal = 0, sort = 1;
  for (let i = 0; i < desc.length; i++) {
    const d = (desc[i] || '').toString().trim();
    if (!d) continue;
    const q = num(qty[i]) || 1, p = num(price[i]), t = num(tax[i]);
    const pid = prodId[i] ? (parseInt(prodId[i], 10) || null) : null;
    // Preserve the auto-managed tag (giacom/calls/contract) so editing a recurring template
    // doesn't strip it and cause the refresh engine to duplicate the line next cycle.
    const source = (src[i] || 'manual').toString().trim() || 'manual';
    // Edit-locks-the-override: a synced (giacom) line that the user changed becomes a manual
    // override so the next sync leaves it alone (drift is recorded instead of overwriting).
    const changed = source === 'giacom' && (q !== (num(prevQty[i]) || 1) || p !== num(prevPrice[i]) || d !== (prevDesc[i] || '').toString().trim());
    const locked = source === 'giacom' && (truthy(syncLocked[i]) || changed);
    const ref = (syncRef[i] || '').toString().trim() || null;
    const oneoff = truthy(oneOff[i]);
    const lineTotal = q * p;
    subtotal += lineTotal; taxTotal += lineTotal * (t / 100);
    const keep = prevById[String((itemIds[i] || '').toString().trim())] || null;
    await client.query(
      `INSERT INTO invoice_items (invoice_id, product_id, source, sort_order, description, quantity, unit_price, tax_rate, line_total, sync_ref, sync_locked, is_one_off, invoice_category, contract_line_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [invoiceId, pid, source, sort++, d, q, p, t, lineTotal, ref, locked, oneoff, keep ? keep.invoice_category : null, keep ? keep.contract_line_id : null]
    );
  }
  await client.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3, updated_at=NOW() WHERE id=$4',
    [subtotal.toFixed(2), taxTotal.toFixed(2), (subtotal + taxTotal).toFixed(2), invoiceId]);
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const status = ((req.query.status as string) || '').trim();
  const search = ((req.query.search as string) || '').trim();
  const source = ((req.query.source as string) || '').trim(); // '' | portal | legacy
  const paid = ((req.query.paid as string) || '').trim();      // '' | unpaid | paid
  const dd = ((req.query.dd as string) || '').trim();          // '' | yes | no  (direct debit)
  const gc = ((req.query.gc as string) || '').trim();          // '' | yes | no  (payment sent to GoCardless)
  const qb = ((req.query.qb as string) || '').trim();          // '' | yes | no  (pushed to QuickBooks)
  const emailed = ((req.query.emailed as string) || '').trim();// '' | yes | no  (emailed to the customer)
  const period = resolvePeriod(((req.query.period as string) || '').trim(), req.query.from as string, req.query.to as string);

  const recurring = ((req.query.recurring as string) || '').trim(); // '' hide templates | 'yes' templates only
  const where: string[] = ['i.deleted_at IS NULL'];
  // Staged drafts (comms + IT&Cloud) live in Bureau (no number until Completed) — keep them out
  // of the main Invoices list. They appear here once the run is Completed (numbered + issued).
  where.push("COALESCE(i.staged,false)=false");
  // Recurring TEMPLATES are configuration (the customer's base services), not bills — hidden by
  // default; ?recurring=yes shows just the templates.
  if (recurring === 'yes') where.push('COALESCE(i.is_recurring,false)=true');
  else where.push('COALESCE(i.is_recurring,false)=false');
  const params: any[] = [];
  if (status && STATUSES.includes(status)) { params.push(status); where.push('i.status = $' + params.length); }
  // Payment filter: "unpaid" = anything not fully paid (unpaid + partial); "paid" = settled.
  if (paid === 'unpaid') where.push("COALESCE(i.payment_status,'unpaid') <> 'paid'");
  else if (paid === 'paid') where.push("i.payment_status = 'paid'");
  // Direct debit: a customer with a GoCardless mandate is on Direct Debit.
  if (dd === 'yes') where.push('c.gocardless_mandate_id IS NOT NULL');
  else if (dd === 'no') where.push('(c.gocardless_mandate_id IS NULL)');
  // Sent to GoCardless = a payment has been submitted (gocardless_payment_id set).
  if (gc === 'yes') where.push('i.gocardless_payment_id IS NOT NULL');
  else if (gc === 'no') where.push('i.gocardless_payment_id IS NULL');
  // Sent to QuickBooks = pushed to QB (quickbooks_invoice_id set).
  if (qb === 'yes') where.push('i.quickbooks_invoice_id IS NOT NULL');
  else if (qb === 'no') where.push('i.quickbooks_invoice_id IS NULL');
  // Emailed = at least one outbound communication logged against the invoice.
  if (emailed === 'yes') where.push("EXISTS (SELECT 1 FROM communications cm WHERE cm.entity_type='invoice' AND cm.direction='outbound' AND cm.entity_id=i.id)");
  else if (emailed === 'no') where.push("NOT EXISTS (SELECT 1 FROM communications cm WHERE cm.entity_type='invoice' AND cm.direction='outbound' AND cm.entity_id=i.id)");
  // "Legacy" = imported FROM QuickBooks (has a QB id but no portal creator). Portal-native
  // invoices that were merely pushed to QB keep their created_by, so they aren't "legacy".
  if (source === 'legacy') where.push('(i.quickbooks_invoice_id IS NOT NULL AND i.created_by IS NULL)');
  else if (source === 'portal') where.push('(i.quickbooks_invoice_id IS NULL OR i.created_by IS NOT NULL)');
  else if (source === 'nocustomer') where.push('i.customer_id IS NULL');
  if (period.from) { params.push(period.from); where.push('i.issue_date >= $' + params.length); }
  if (period.to) { params.push(period.to); where.push('i.issue_date <= $' + params.length); }
  // Search covers the invoice header AND its line items, so "printer" finds every invoice with
  // a printer on it — not just ones with "printer" in the title. Line match looks at the typed
  // description and, where the line came from the catalogue, the product name too.
  let matchSelect = ', NULL AS match_lines';
  if (search) {
    params.push('%' + search + '%');
    const n = params.length;
    where.push(`(i.invoice_number ILIKE $${n} OR i.title ILIKE $${n} OR c.name ILIKE $${n}
       OR EXISTS (SELECT 1 FROM invoice_items ii LEFT JOIN asset_products ap ON ap.id = ii.product_id
                   WHERE ii.invoice_id = i.id AND (ii.description ILIKE $${n} OR ap.name ILIKE $${n})))`);
    // Show WHICH lines matched, so a search result explains itself.
    matchSelect = `, (SELECT string_agg(DISTINCT COALESCE(NULLIF(ii.description, ''), ap.name), ' | ')
                        FROM invoice_items ii LEFT JOIN asset_products ap ON ap.id = ii.product_id
                       WHERE ii.invoice_id = i.id AND (ii.description ILIKE $${n} OR ap.name ILIKE $${n})
                     ) AS match_lines`;
  }
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.title, i.total, i.balance, i.status, i.payment_status,
            i.issue_date, i.due_date, i.payment_synced_at, i.is_recurring,
            i.quickbooks_invoice_id, i.gocardless_payment_id,
            (i.quickbooks_invoice_id IS NOT NULL AND i.created_by IS NULL) AS is_legacy,
            c.name AS customer_name, c.id AS customer_id, c.gocardless_mandate_id,
            (em.entity_id IS NOT NULL) AS emailed${matchSelect}
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     LEFT JOIN (SELECT entity_id FROM communications WHERE entity_type='invoice' AND direction='outbound' GROUP BY entity_id) em ON em.entity_id = i.id
     WHERE ${where.join(' AND ')} ORDER BY i.issue_date DESC NULLS LAST, i.id DESC`, params
  );
  const stat = await pool.query(`SELECT status, COUNT(*)::int n FROM invoices WHERE deleted_at IS NULL GROUP BY status`);
  const statusCounts: Record<string, number> = {};
  stat.rows.forEach((r: any) => { statusCounts[r.status] = r.n; });
  const legacyCount = (await pool.query(`SELECT COUNT(*)::int n FROM invoices WHERE deleted_at IS NULL AND quickbooks_invoice_id IS NOT NULL AND created_by IS NULL`)).rows[0].n;
  const unmatchedCount = (await pool.query(`SELECT COUNT(*)::int n FROM invoices WHERE deleted_at IS NULL AND customer_id IS NULL`)).rows[0].n;
  const total = rows.reduce((s: number, r: any) => s + Number(r.total || 0), 0);
  const outstanding = rows.reduce((s: number, r: any) => s + Number(r.balance || 0), 0);
  const faCustomersList = (await pool.query('SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY name')).rows;
  res.render('invoices/list', {
    user, invoices: rows, status, search, statusCounts, legacyCount, unmatchedCount, total, outstanding,
    source, paid, dd, gc, qb, emailed, recurring, period, periodOptions: PERIOD_OPTIONS, from: req.query.from || '', to: req.query.to || '',
    faCustomersList,
  });
});

// ── New (optionally prefilled from a quote or customer) ──────────────────────────
router.get('/invoices/new', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
  let invoice: any = null;
  let items: any[] = [];
  if (req.query.quote) {
    const qid = parseInt(String(req.query.quote), 10);
    const q = await pool.query('SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL', [qid]);
    if (q.rows.length) {
      const quote = q.rows[0];
      invoice = { title: quote.title, customer_id: quote.customer_id, quote_id: quote.id, currency_code: quote.currency_code, notes: quote.notes, terms: quote.terms };
      // Join the catalogue so the product/service link is visibly carried over (product_id + product_name).
      const qi = await pool.query(
        `SELECT qi.*, ap.name AS product_name FROM quote_items qi
         LEFT JOIN asset_products ap ON ap.id = qi.product_id
         WHERE qi.quote_id=$1 ORDER BY qi.sort_order, qi.id`, [qid]
      );
      items = qi.rows;
    }
  }
  const preselectCustomer = req.query.customer ? parseInt(String(req.query.customer), 10) : null;
  res.render('invoices/form', { user, invoice, items, customers: customers.rows, preselectCustomer, error: null });
});

// ── Create ──────────────────────────────────────────────────────────────────────
router.post('/invoices', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  const title = (b.title || '').trim();
  if (!title) {
    const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
    res.render('invoices/form', { user, invoice: b, items: [], customers: customers.rows, preselectCustomer: null, error: 'Title is required.' });
    return;
  }
  const scheme = SCHEMES.includes(b.invoice_scheme) ? b.invoice_scheme : 'IT';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = await nextInvoiceNumber(scheme);
    const { rows } = await client.query(
      `INSERT INTO invoices (customer_id, quote_id, invoice_number, invoice_scheme, title, status, payment_status,
        payment_method, issue_date, due_date, currency_code, notes, terms, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, b.quote_id ? parseInt(b.quote_id, 10) : null,
        invoiceNumber, scheme, title, STATUSES.includes(b.status) ? b.status : 'draft',
        PAY_STATUSES.includes(b.payment_status) ? b.payment_status : 'unpaid',
        nz(b.payment_method) || 'upfront', nz(b.issue_date), nz(b.due_date), nz(b.currency_code) || 'GBP',
        nz(b.notes), nz(b.terms), user.id,
      ]
    );
    await saveItemsAndTotals(client, rows[0].id, b);
    await client.query('COMMIT');
    await logActivity(user.id, 'created', 'invoices', rows[0].id, `Created invoice ${invoiceNumber} - ${title}`);
    res.redirect('/invoices/' + rows[0].id);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ── Batch-complete progress (polled by the list page) ───────────────────────────
// Declared BEFORE '/invoices/:id' so the literal path isn't captured as an :id.
router.get('/invoices/batch-status', requireAuth, async (_req: Request, res: Response) => {
  const raw = await getSetting('invoices', 'batch_status');
  res.json(raw ? JSON.parse(raw) : { running: false, total: 0, done: 0, ok: 0, errs: [], startedAt: null, finishedAt: null });
});

// A same-site path to return to after an action (e.g. the customer screen's invoices tab).
// Only relative paths are honoured — anything else falls back, so it can't open-redirect.
function safeBack(raw: unknown, fallback: string): string {
  const s = String(raw || '');
  return /^\/(?!\/)/.test(s) ? s : fallback;
}
// Append a query param to a path that may carry a #hash (the param must go before the hash).
function withParam(url: string, qs: string): string {
  const i = url.indexOf('#');
  const base = i >= 0 ? url.slice(0, i) : url;
  const hash = i >= 0 ? url.slice(i) : '';
  return base + (base.includes('?') ? '&' : '?') + qs + hash;
}

// ── Bulk actions on selected invoices (email / QB / GC / reminders) ──────────────
router.post('/invoices/bulk', requireAuth, async (req: Request, res: Response) => {
  const action = String(req.body.action || '').trim();
  const ids = ([] as any[]).concat(req.body.ids || []).map((x) => parseInt(String(x), 10)).filter(Boolean);
  const backTo = safeBack(req.body.back, '/invoices'); // e.g. the customer invoices tab
  const labels: Record<string, string> = { email: 'Emailed', qb: 'Sent to QuickBooks', gc: 'Sent to GoCardless', reminder: 'Reminders sent', delete: 'Deleted' };
  if (!ids.length || !labels[action]) { res.redirect(withParam(backTo, 'err=' + encodeURIComponent('Select invoices and a bulk action.'))); return; }
  const uid = req.session.user!.id;
  // Soft-delete → recycle bin (recoverable). Returns a success verb so it counts as done.
  const deleteInvoiceAction = async (id: number): Promise<string> => {
    const r = await pool.query('UPDATE invoices SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id=$2 AND deleted_at IS NULL', [uid, id]);
    if (!r.rowCount) return 'already deleted';
    await logActivity(uid, 'deleted', 'invoices', id, 'Deleted invoice #' + id + ' (bulk)');
    return 'deleted';
  };
  const run = action === 'email' ? (id: number) => emailInvoiceAction(id, uid)
    : action === 'qb' ? (id: number) => pushInvoiceToQBAction(id)
    : action === 'gc' ? (id: number) => submitInvoiceToGCAction(id)
    : action === 'delete' ? (id: number) => deleteInvoiceAction(id)
    : (id: number) => remindInvoiceAction(id, uid);
  let ok = 0; const skipped: string[] = []; const failed: string[] = [];
  for (const id of ids) {
    try {
      const r = await run(id);
      if (/^(emailed|pushed|amended|submitted|reminder|deleted)/i.test(r)) { ok++; }
      else { skipped.push('#' + id + ': ' + r); console.warn(`[bulk ${action}] invoice #${id} skipped: ${r}`); }
    } catch (e: any) {
      const m = e?.message || 'error';
      failed.push('#' + id + ': ' + m);
      console.error(`[bulk ${action}] invoice #${id} FAILED: ${m}`);
    }
  }
  // Surface a full, categorised breakdown so nothing is silent. Every skip/failure is also logged
  // server-side (above) for the complete list, regardless of how many there are.
  const parts: string[] = [`${labels[action]}: ${ok}/${ids.length} done`];
  if (skipped.length) parts.push(`${skipped.length} skipped — ${skipped.slice(0, 12).join('; ')}${skipped.length > 12 ? ' …' : ''}`);
  if (failed.length) parts.push(`${failed.length} failed — ${failed.slice(0, 12).join('; ')}${failed.length > 12 ? ' …' : ''}`);
  const hadProblem = skipped.length > 0 || failed.length > 0;
  res.redirect(withParam(backTo, (hadProblem ? 'err' : 'msg') + '=' + encodeURIComponent(parts.join(' · '))));
});

// Combined PDF of selected invoices (Download = attachment, Print = inline new tab).
router.get('/invoices/bulk-pdf', requireAuth, async (req: Request, res: Response) => {
  const ids = String(req.query.ids || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 60);
  if (!ids.length) { res.redirect('/invoices'); return; }
  const parts: string[] = [];
  for (const id of ids) {
    try { const data = await loadInvoiceForRender(id); if (data) parts.push(await renderInvoiceHtml(data)); } catch { /* skip a bad one */ }
  }
  if (!parts.length) { res.redirect('/invoices?err=' + encodeURIComponent('Nothing to render.')); return; }
  // Wrap each invoice (full HTML doc) in a page-breaking container; shared styles apply globally.
  const combined = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + parts.map((h, i) => `<div style="${i ? 'page-break-before:always;' : ''}">${h}</div>`).join('')
    + '</body></html>';
  const pdf = await htmlToPdf(combined, { margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  const disp = String(req.query.print || '') === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disp}; filename="invoices-${ids.length}.pdf"`);
  res.send(pdf);
});

// ── Detail ────────────────────────────────────────────────────────────────────
router.get('/invoices/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const r = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.billing_contact_id, c.gocardless_mandate_id, q.quote_number FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN quotes q ON q.id = i.quote_id
     WHERE i.id=$1 AND i.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (r.rows.length === 0) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const items = await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id', [id]);
  const inv = r.rows[0];
  const comms = await getComms('invoice', id);
  let commsTo = '';
  let commsContacts: any[] = [];
  if (inv.customer_id) {
    commsContacts = (await pool.query("SELECT id, full_name, email, job_title, is_primary FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, full_name", [inv.customer_id])).rows;
    // Default the invoice recipient to the finance (billing) contact, else primary
    const finance = inv.billing_contact_id ? commsContacts.find((c: any) => c.id === inv.billing_contact_id) : null;
    commsTo = (finance?.email) || commsContacts[0]?.email || '';
  }
  // Open credits available on this customer (overpayments etc.) to apply to this invoice.
  let openCredits: any[] = [];
  if (inv.customer_id) {
    openCredits = (await pool.query(
      "SELECT id, amount, reason, source_invoice_id, quickbooks_credit_id, created_at FROM customer_credits WHERE customer_id=$1 AND status='open' ORDER BY created_at", [inv.customer_id]
    )).rows;
  }
  res.render('invoices/detail', { user, invoice: inv, items: items.rows, openCredits,
    notice: req.query.msg || null, error: req.query.err || null, comms, commsTo, commsContacts,
    back: safeBack(req.query.back, '') || null, events: await getDocEvents('invoice', inv.id) });
});

// ── Log an overpayment / credit against the customer (from this invoice) ──────────
router.post('/invoices/:id/log-credit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const amount = parseFloat(String(req.body.amount || '').replace(/[^0-9.\-]/g, ''));
  const inv = (await pool.query('SELECT customer_id, invoice_number FROM invoices WHERE id=$1', [id])).rows[0];
  if (!inv || !inv.customer_id || isNaN(amount) || amount <= 0) {
    res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Enter a credit amount (and the invoice must have a customer).')); return;
  }
  const r = await pool.query(
    "INSERT INTO customer_credits (customer_id, amount, reason, source_invoice_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [inv.customer_id, amount.toFixed(2), nz(req.body.reason), id, user.id]
  );
  await logActivity(user.id, 'created', 'customers', inv.customer_id, `Logged £${amount.toFixed(2)} credit from invoice ${inv.invoice_number}`);
  let extra = '';
  if (req.body.to_qb) {
    try { await pushCreditToQb(r.rows[0].id); extra = ' · raised in QuickBooks'; }
    catch (e: any) { extra = ' · QB credit failed: ' + (e.message || 'error'); }
  }
  res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Credit of £' + amount.toFixed(2) + ' logged' + extra));
});

// Submit an existing open credit to QuickBooks as a Credit Memo.
router.post('/credits/:id/submit-to-qb', requireAuth, async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.id), 10);
  const back = String(req.body.return || '/invoices');
  try { await pushCreditToQb(cid); res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('Credit raised in QuickBooks')); }
  catch (e: any) { res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent('QB credit failed: ' + (e.message || 'error'))); }
});

// Push a portal credit to QB as a Credit Memo (idempotent: skips if already there).
async function pushCreditToQb(creditId: number): Promise<string> {
  const cr = (await pool.query(
    `SELECT cc.amount, cc.reason, cc.customer_id, cc.quickbooks_credit_id,
            c.quickbooks_customer_id, c.name, c.email, c.phone, c.website
     FROM customer_credits cc JOIN customers c ON c.id=cc.customer_id WHERE cc.id=$1`, [creditId]
  )).rows[0];
  if (!cr) throw new Error('Credit not found');
  if (cr.quickbooks_credit_id) return cr.quickbooks_credit_id;
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) throw new Error('QuickBooks not connected');
  let qbCust = cr.quickbooks_customer_id;
  if (!qbCust) { qbCust = await qb.findOrCreateCustomer({ name: cr.name, email: cr.email, phone: cr.phone, website: cr.website }); await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbCust, cr.customer_id]); }
  const qbId = await qb.pushCreditMemo(qbCust, Number(cr.amount), cr.reason || 'Customer credit');
  await pool.query('UPDATE customer_credits SET quickbooks_credit_id=$1 WHERE id=$2', [qbId, creditId]);
  return qbId;
}

// ── Apply an open credit to this invoice (adds a negative line, marks it used) ─────
router.post('/invoices/:id/apply-credit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const creditId = parseInt(String(req.body.credit_id || ''), 10);
  const inv = (await pool.query('SELECT customer_id, invoice_number FROM invoices WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!inv) { res.redirect('/invoices?err=Invoice+not+found'); return; }
  const cr = (await pool.query("SELECT id, amount, source_invoice_id FROM customer_credits WHERE id=$1 AND customer_id=$2 AND status='open'", [creditId, inv.customer_id])).rows[0];
  if (!cr) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Credit not found or already used.')); return; }
  const amount = Number(cr.amount);
  const srcNum = cr.source_invoice_id ? (await pool.query('SELECT invoice_number FROM invoices WHERE id=$1', [cr.source_invoice_id])).rows[0]?.invoice_number : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sort = (await client.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM invoice_items WHERE invoice_id=$1', [id])).rows[0].n;
    // VAT-aware credit line (2026-07-30): a credit is CASH (VAT-inclusive). When it divides
    // cleanly into net + 20% VAT, post it net @20% so the document's subtotal/VAT split stays
    // honest — a gross line at 0% produces negative subtotals and overstates VAT (seen on
    // IT-10001321). Falls back to the old gross@0 form when the pennies don't split.
    const creditNet = Math.round((amount / 1.2) * 100) / 100;
    const cleanSplit = Math.abs(creditNet * 1.2 - amount) < 0.005;
    const creditUnit = cleanSplit ? -creditNet : -amount;
    const creditRate = cleanSplit ? 20 : 0;
    await client.query(
      `INSERT INTO invoice_items (invoice_id, sort_order, description, quantity, unit_price, tax_rate, line_total)
       VALUES ($1,$2,$3,1,$4,$5,$4)`,
      [id, sort, 'Credit applied' + (srcNum ? ' (overpayment from ' + srcNum + ')' : '') + (cleanSplit ? ' - ' + amount.toFixed(2) + ' inc VAT' : ''), creditUnit.toFixed(2), creditRate]
    );
    await recomputeInvoiceTotals(client, id);
    await client.query("UPDATE customer_credits SET status='applied', applied_invoice_id=$1, applied_at=NOW() WHERE id=$2", [id, creditId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity(user.id, 'updated', 'invoices', id, `Applied £${amount.toFixed(2)} credit to invoice ${inv.invoice_number}`);
  res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Applied £' + amount.toFixed(2) + ' credit'));
});

// ── Edit ──────────────────────────────────────────────────────────────────────
// An invoice is LOCKED once it leaves draft (issued/paid/void). At that point it's a document the
// customer and QuickBooks already hold, so its lines/header must NOT be silently rewritten — that's
// what wiped IC-0123's one-off + part-month lines. Drafts (bill-run review stage) stay editable.
function invoiceLocked(inv: any): boolean {
  // Locked once it's no longer a draft, OR has been emailed to the customer, OR submitted to
  // QuickBooks — any of those means it's a real document we must not silently rewrite.
  return !!inv && (
    (!!inv.status && inv.status !== 'draft') ||
    !!inv.emailed_at ||
    !!inv.quickbooks_invoice_id
  );
}
const LOCK_MSG = 'This invoice has been issued and is locked from editing. To change it, void it and re-issue, or raise a credit note.';

router.get('/invoices/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM invoices WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (r.rows.length === 0) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  if (invoiceLocked(r.rows[0])) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent(LOCK_MSG)); return; }
  const [items, customers] = await Promise.all([
    pool.query('SELECT ii.*, ap.name AS product_name FROM invoice_items ii LEFT JOIN asset_products ap ON ap.id=ii.product_id WHERE ii.invoice_id=$1 ORDER BY ii.sort_order, ii.id', [id]),
    pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`),
  ]);
  res.render('invoices/form', { user, invoice: r.rows[0], items: items.rows, customers: customers.rows, preselectCustomer: null, error: null });
});

// ── Update ──────────────────────────────────────────────────────────────────────
router.post('/invoices/:id', requireAuth, async (req: Request, res: Response, next) => {
  const id = parseInt(String(req.params.id), 10);
  // Non-numeric segment (e.g. /invoices/batch-complete) belongs to another route — fall through.
  if (Number.isNaN(id)) { next(); return; }
  // Issued / emailed / QB-submitted invoices are locked — never silently rewrite a real invoice.
  const lk = await pool.query('SELECT status, emailed_at, quickbooks_invoice_id, invoice_scheme FROM invoices WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (lk.rows.length && invoiceLocked(lk.rows[0])) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent(LOCK_MSG)); return; }
  const user = req.session.user!;
  const b = req.body;
  const on = (v: any) => v === 'on' || v === '1' || v === true;
  const custId = b.customer_id ? parseInt(b.customer_id, 10) : null;
  // Service type (contract): '', 'IT' or 'Comms'. Enforce one contract of each type per customer.
  let contractType: string | null = (['IT', 'Comms'].includes(String(b.contract_type)) ? String(b.contract_type) : null);
  if (contractType && custId) {
    const other = await pool.query('SELECT invoice_number FROM invoices WHERE customer_id=$1 AND contract_type=$3 AND id<>$2 AND deleted_at IS NULL LIMIT 1', [custId, id, contractType]);
    if (other.rows.length) { res.redirect('/invoices/' + id + '/edit?err=' + encodeURIComponent('This customer already has a ' + contractType + ' contract invoice (' + other.rows[0].invoice_number + ').')); return; }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE invoices SET customer_id=$1, title=$2, invoice_scheme=$3,
        payment_method=$4, issue_date=$5, due_date=$6, currency_code=$7, notes=$8, terms=$9, contract_type=$11,
        is_recurring=$12, recurring_active=$13, send_day=$14, due_day=$15, recurring_name=$16,
        auto_send=$17, auto_qb=$18, auto_gc=$19, updated_at=NOW()
       WHERE id=$10 AND deleted_at IS NULL`,
      [
        custId, (b.title || '').trim(),
        // Preserve the CURRENT scheme when the form doesn't post one — the hardcoded 'IT'
        // fallback silently rebranded staged IC drafts on every edit (July 2026: TLC + Choose
        // Leads vanished from the IT&Cloud cockpit after hand-edits).
        SCHEMES.includes(b.invoice_scheme) ? b.invoice_scheme : (lk.rows[0]?.invoice_scheme || 'IT'),
        nz(b.payment_method) || 'upfront', nz(b.issue_date), nz(b.due_date), nz(b.currency_code) || 'GBP',
        nz(b.notes), nz(b.terms), id, contractType,
        on(b.is_recurring), on(b.recurring_active), parseInt(b.send_day, 10) || 23, parseInt(b.due_day, 10) || 1,
        nz(b.recurring_name), on(b.auto_send), on(b.auto_qb), on(b.auto_gc),
      ]
    );
    await saveItemsAndTotals(client, id, b);
    await client.query('COMMIT');
    await logActivity(user.id, 'updated', 'invoices', id, `Edited invoice #${id}`);
    res.redirect('/invoices/' + id);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ── Status / payment ───────────────────────────────────────────────────────────
router.post('/invoices/:id/status', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const status = String(req.body.status || '');
  const pay = String(req.body.payment_status || '');
  if (STATUSES.includes(status)) {
    await pool.query('UPDATE invoices SET status=$1 WHERE id=$2', [status, id]);
    await logActivity(user.id, 'status_changed', 'invoices', id, `Invoice #${id} status -> ${status}`);
  }
  if (PAY_STATUSES.includes(pay)) {
    await pool.query('UPDATE invoices SET payment_status=$1 WHERE id=$2', [pay, id]);
    await logActivity(user.id, 'status_changed', 'invoices', id, `Invoice #${id} payment -> ${pay}`);
    if (pay === 'paid') {
      const inv = (await pool.query('SELECT invoice_number, total, created_by FROM invoices WHERE id=$1', [id])).rows[0];
      if (inv?.created_by) await notify(inv.created_by, `Invoice ${inv.invoice_number} paid`, { type: 'invoice', body: `£${Number(inv.total||0).toFixed(2)} marked paid`, link: '/invoices/' + id });
    }
  }
  res.redirect('/invoices/' + id);
});

// ── PDF (inline, or ?dl=1 to download) ──────────────────────────────────────────
router.get('/invoices/:id/pdf', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const numRow = await pool.query('SELECT invoice_number FROM invoices WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!numRow.rows.length) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  try {
    const pdf = await renderInvoicePdf(id); // shared renderer — address from primary site
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + `; filename="${numRow.rows[0].invoice_number}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error('Invoice PDF error:', e); res.status(500).render('error', { message: 'PDF generation failed (Chromium missing?).' }); }
});

// ── Resend the invoice (with PDF attached) to the finance / billing contact ──────
router.post('/invoices/:id/resend-finance', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.billing_contact_id,
            c.address_line_1, c.address_line_2, c.city, c.county, c.postcode, c.gocardless_mandate_id
     FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const inv = r.rows[0];

  // Resolve the finance recipient: designated billing contact → primary contact → customer email.
  let to = '', toName = '';
  if (inv.billing_contact_id) {
    const bc = await pool.query('SELECT full_name, email FROM customer_contacts WHERE id=$1', [inv.billing_contact_id]);
    if (bc.rows[0]?.email) { to = bc.rows[0].email; toName = bc.rows[0].full_name || ''; }
  }
  if (!to && inv.customer_id) {
    const pc = await pool.query("SELECT full_name, email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, id LIMIT 1", [inv.customer_id]);
    if (pc.rows[0]) { to = pc.rows[0].email; toName = pc.rows[0].full_name || ''; }
  }
  if (!to) to = inv.customer_email || '';
  if (!to) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('No finance/billing contact email on file for this customer.')); return; }

  // Render the invoice PDF to attach (shared renderer — address from primary site).
  // An invoice email with no attachment is useless — if the PDF can't be rendered we
  // ABORT the send and surface the error rather than emailing a bare invoice.
  let attachments: { filename: string; contentType: string; base64: string }[] = [];
  try {
    const pdf = await renderInvoicePdf(id);
    attachments = [{ filename: inv.invoice_number + '.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') }];
  } catch (e) {
    console.error('Invoice PDF for resend failed:', e);
    res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Could not generate the invoice PDF, so nothing was sent. Check the invoice opens at /invoices/' + id + '/pdf and try again.'));
    return;
  }

  const total = '£' + (Number(inv.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dueDate = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  const body = invoiceEmailHtml({ contactName: toName, invoiceNumber: inv.invoice_number, title: inv.title, total, dueDate,
    directDebit: !!inv.gocardless_mandate_id, viewLink: await invoiceViewUrl(id) });
  try {
    // The pixel stays — it is the only signal for someone who never clicks — but it is the
    // weaker one. An open of the hosted copy is served by us, so that is the evidence.
    const pixelToken = newPixelToken();
    const sentEventId = await logDocEvent('invoice', inv.id, 'sent', {
      customerId: inv.customer_id, actor: to, pixelToken,
      meta: { recipient: to, by: user.displayName, attached: true },
    });
    await sendMail({ to, subject: `Invoice ${inv.invoice_number} from Lumen IT Solutions`,
      html: (sentEventId ? pixelImg(config.APP_URL, pixelToken) : '') + body,
      signatureName: user.displayName, attachments });
    await pool.query(
      `INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, sent_by_user_id)
       VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6,$7)`,
      [id, config.FROM_NAME, config.FROM_EMAIL, to, 'Invoice ' + inv.invoice_number, 'Invoice ' + inv.invoice_number + ' sent to finance contact.', user.id]
    );
    await pool.query('UPDATE invoices SET emailed_at=NOW() WHERE id=$1', [id]);
    await logActivity(user.id, 'emailed', 'invoices', id, `Sent invoice ${inv.invoice_number} to ${to}`);
    res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Invoice emailed to ' + to));
  } catch (e: any) {
    res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Send failed: ' + (e.message || 'mail not configured')));
  }
});

// ── Recurring: save the template settings on an invoice ──────────────────────────
router.post('/invoices/:id/recurring', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const on = (v: any) => v === 'on' || v === '1' || v === true;
  // Contract type selector: '', 'IT' or 'Comms'. Back-compat: legacy it_contract checkbox → 'IT'.
  let contractType: string | null = (['IT', 'Comms'].includes(String(b.contract_type)) ? String(b.contract_type) : null);
  if (!contractType && on(b.it_contract)) contractType = 'IT';
  // Only one contract invoice of each type per customer (for now).
  if (contractType) {
    const cust = (await pool.query('SELECT customer_id FROM invoices WHERE id=$1', [id])).rows[0]?.customer_id;
    if (cust) {
      const other = await pool.query('SELECT invoice_number FROM invoices WHERE customer_id=$1 AND contract_type=$3 AND id<>$2 AND deleted_at IS NULL LIMIT 1', [cust, id, contractType]);
      if (other.rows.length) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('This customer already has a ' + contractType + ' contract invoice (' + other.rows[0].invoice_number + '). Only one is allowed.')); return; }
    }
  }
  await pool.query(
    `UPDATE invoices SET is_recurring=$2, recurring_active=$3, send_day=$4, due_day=$5,
       auto_send=$6, auto_qb=$7, auto_gc=$8, recurring_name=$9, contract_type=$10, updated_at=NOW() WHERE id=$1`,
    [id, on(b.is_recurring), on(b.recurring_active), parseInt(b.send_day, 10) || 23, parseInt(b.due_day, 10) || 1,
     on(b.auto_send), on(b.auto_qb), on(b.auto_gc), nz(b.recurring_name), contractType]
  );
  await logActivity(user.id, 'updated', 'invoices', id, on(b.is_recurring) ? 'Set invoice as recurring' : 'Recurring settings updated');
  res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Recurring settings saved'));
});

// ── Pull / refresh the customer's Giacom (cloud) services as invoice lines ────────
router.post('/invoices/:id/pull-giacom', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const inv = (await pool.query('SELECT customer_id, invoice_number FROM invoices WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  const back = String(req.body.return || '').trim() || ('/invoices/' + id);
  if (!inv || !inv.customer_id) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('This invoice needs a customer first.')); return; }
  try {
    const n = await refreshGiacomLines(id, inv.customer_id);
    await logActivity(user.id, 'updated', 'invoices', id, `Pulled ${n} Giacom line(s) into ${inv.invoice_number}`);
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(`Synced ${n} Giacom licence line(s) — totals updated`));
  } catch (e: any) { res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent('Giacom sync failed: ' + (e.message || 'error'))); }
});

// ── Pull / refresh the customer's call charges (Comms) as an invoice line ─────────
router.post('/invoices/:id/pull-calls', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const inv = (await pool.query('SELECT customer_id, invoice_number FROM invoices WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  const back = String(req.body.return || '').trim() || ('/invoices/' + id);
  if (!inv || !inv.customer_id) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('This invoice needs a customer first.')); return; }
  const period = String(req.body.period || '').trim() || undefined;
  try {
    const r = await refreshCallCharges(id, inv.customer_id, period);
    await logActivity(user.id, 'updated', 'invoices', id, `Pulled call charges (${r.period || 'no data'}) into ${inv.invoice_number}`);
    const note = r.period ? `Pulled ${r.calls} call(s) for ${r.period} → £${r.sell.toFixed(2)} (cost £${r.cost.toFixed(2)} + markup)` : 'No call records found for this customer';
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(note));
  } catch (e: any) { res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent('Call-charge sync failed: ' + (e.message || 'error'))); }
});

// ── Licence reconciliation: Giacom held vs billed on this invoice ─────────────────
router.get('/invoices/:id/licenses', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const inv = (await pool.query('SELECT id, invoice_number, customer_id, contract_type FROM invoices WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!inv || !inv.customer_id) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('This invoice needs a customer first.')); return; }
  const cust = (await pool.query('SELECT name FROM customers WHERE id=$1', [inv.customer_id])).rows[0];
  const invoiced = new Map<string, number>();
  (await pool.query("SELECT lower(description) AS d, SUM(quantity)::numeric AS q FROM invoice_items WHERE invoice_id=$1 AND source='giacom' GROUP BY lower(description)", [id]))
    .rows.forEach((r: any) => invoiced.set(r.d, Number(r.q)));
  const giacom = (await pool.query(
    "SELECT description, SUM(quantity)::numeric AS qty, SUM(total_cost)::numeric AS sell FROM service_items WHERE customer_id=$1 AND source='giacom' GROUP BY description ORDER BY description", [inv.customer_id]
  )).rows;
  const seen = new Set<string>();
  const rows = giacom.map((g: any) => {
    const key = (g.description || '').toLowerCase(); seen.add(key);
    const billed = invoiced.get(key) || 0; const qty = Number(g.qty);
    const status = billed === 0 ? 'not_billed' : (billed !== qty ? 'qty_diff' : 'billed');
    return { description: g.description || '(unnamed)', giacomQty: qty, billedQty: billed, sell: Number(g.sell), status };
  });
  // Lines billed but no longer held in Giacom.
  (await pool.query("SELECT description, SUM(quantity)::numeric AS q FROM invoice_items WHERE invoice_id=$1 AND source='giacom' GROUP BY description", [id]))
    .rows.forEach((r: any) => { if (!seen.has((r.description || '').toLowerCase())) rows.push({ description: r.description || '(unnamed)', giacomQty: 0, billedQty: Number(r.q), sell: 0, status: 'removed' }); });
  const notBilled = rows.filter((r) => r.status === 'not_billed').length;
  const issues = rows.filter((r) => r.status !== 'billed').length;
  res.render('invoices/licenses', { user: req.session.user!, inv, customerName: cust?.name || '', rows, notBilled, issues, notice: req.query.msg || null, error: req.query.err || null });
});

// ── Recurring: generate the next invoice from this template now (manual) ──────────
router.post('/invoices/:id/generate-now', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = await generateFromTemplate(id, user.id);
    res.redirect('/invoices/' + r.invoiceId + '?msg=' + encodeURIComponent('Generated ' + r.number + ' — ' + r.actions.join(' · ')));
  } catch (e: any) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Generate failed: ' + (e.message || 'error'))); }
});

// ── Regenerate an invoice's lines from current source data (in place) ─────────────
router.post('/invoices/:id/regenerate', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const back = String(req.body.return || '').trim() || ('/invoices/' + id);
  const sep = back.includes('?') ? '&' : '?';
  try {
    const r = await regenerateInvoice(id, user.id);
    res.redirect(back + sep + (r.ok ? 'msg=' + encodeURIComponent('Regenerated — ' + r.message) : 'err=' + encodeURIComponent(r.message)));
  } catch (e: any) { res.redirect(back + sep + 'err=' + encodeURIComponent('Regenerate failed: ' + (e.message || 'error'))); }
});

// ── IT&Cloud: sync the Giacom lines on this invoice (base/manual lines untouched) ──
router.post('/invoices/:id/sync-itcloud', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const back = String(req.body.return || '').trim() || ('/invoices/' + id);
  const sep = back.includes('?') ? '&' : '?';
  try {
    const r = await syncItCloudInvoice(id);
    await logActivity(user.id, 'updated', 'invoices', id, `IT&Cloud sync: ${r.synced} synced, ${r.locked} locked, ${r.drift} drift`);
    const msg = `Synced — ${r.synced} Giacom line(s)${r.locked ? `, ${r.locked} locked override(s)` : ''}${r.drift ? `, ⚠ ${r.drift} with drift` : ''}`;
    res.redirect(back + sep + 'msg=' + encodeURIComponent(msg));
  } catch (e: any) { res.redirect(back + sep + 'err=' + encodeURIComponent('Sync failed: ' + (e.message || 'error'))); }
});

// ── IT&Cloud: take-Giacom on a single locked line (unlock + re-pull) ──────────────
router.post('/invoices/:id/resync-line', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const itemId = parseInt(String(req.body.item_id), 10);
  const back = '/invoices/' + id;
  try { await resyncItCloudLine(itemId); res.redirect(back + '?msg=' + encodeURIComponent('Line re-synced from Giacom')); }
  catch (e: any) { res.redirect(back + '?err=' + encodeURIComponent('Re-sync failed: ' + (e.message || 'error'))); }
});

// ── IT&Cloud: promote this issued invoice to next month's template (strip one-offs) ──
router.post('/invoices/:id/promote-template', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  try { await promoteItCloudToTemplate(id, user.id); res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Promoted to next month\'s template — one-offs stripped')); }
  catch (e: any) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Promote failed: ' + (e.message || 'error'))); }
});

// ── Cancel (void) an invoice and email the customer a message ────────────────────
router.post('/invoices/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const message = String(req.body.message || '').trim();
  const r = await pool.query(
    `SELECT i.*, c.email AS customer_email, c.billing_contact_id FROM invoices i
     LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const inv = r.rows[0];

  // Void it (status void, payment cleared). Keeps the record for the audit trail.
  await pool.query("UPDATE invoices SET status='void', payment_status='void', updated_at=NOW() WHERE id=$1", [id]);
  await logActivity(user.id, 'status_changed', 'invoices', id, `Cancelled invoice ${inv.invoice_number}`);

  // Notify the customer if requested (message present and a recipient exists).
  let notice = 'Invoice cancelled';
  if (message) {
    let to = '', toName = '';
    if (inv.billing_contact_id) {
      const bc = await pool.query('SELECT full_name, email FROM customer_contacts WHERE id=$1', [inv.billing_contact_id]);
      if (bc.rows[0]?.email) { to = bc.rows[0].email; toName = bc.rows[0].full_name || ''; }
    }
    if (!to && inv.customer_id) {
      const pc = await pool.query("SELECT full_name, email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, id LIMIT 1", [inv.customer_id]);
      if (pc.rows[0]) { to = pc.rows[0].email; toName = pc.rows[0].full_name || ''; }
    }
    if (!to) to = inv.customer_email || '';
    if (to) {
      const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const html = `<p>Dear ${toName || 'customer'},</p><p>We're writing to let you know that invoice <strong>${inv.invoice_number}</strong>${inv.title ? ' (' + inv.title + ')' : ''} has been cancelled.</p><p>${safe}</p>`;
      try {
        await sendMail({ to, subject: `Invoice ${inv.invoice_number} cancelled — Lumen IT Solutions`, html, signatureName: user.displayName });
        await pool.query(
          `INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, sent_by_user_id)
           VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6,$7)`,
          [id, config.FROM_NAME, config.FROM_EMAIL, to, 'Invoice ' + inv.invoice_number + ' cancelled', message, user.id]
        );
        await logActivity(user.id, 'emailed', 'invoices', id, `Emailed cancellation of ${inv.invoice_number} to ${to}`);
        notice = 'Invoice cancelled and customer notified at ' + to;
      } catch (e: any) { notice = 'Invoice cancelled, but email failed: ' + (e.message || 'mail not configured'); }
    } else { notice = 'Invoice cancelled (no customer email on file to notify).'; }
  }
  res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent(notice));
});

// ── Soft delete ───────────────────────────────────────────────────────────────
router.post('/invoices/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE invoices SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id=$2', [user.id, id]);
  await logActivity(user.id, 'deleted', 'invoices', id, 'Deleted invoice #' + id);
  res.redirect('/invoices');
});

// ── PUBLIC invoice view (no login — the link IS the credential) ────────────────
// Mounted outside the /invoices prefix, so the finance gate above does not apply. Everything
// here is read-only and keyed on a 48-character random token.
async function invoiceByToken(token: string) {
  const r = await pool.query(
    `SELECT i.id, i.invoice_number, i.title, i.total, i.status, i.payment_status,
            i.due_date, i.invoice_date, i.customer_id, c.name AS customer_name, c.gocardless_mandate_id
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.view_token = $1 AND i.deleted_at IS NULL LIMIT 1`, [token]);
  return r.rows[0] || null;
}

const gbDate = (d: any): string => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

router.get('/i/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const invoice = await invoiceByToken(token);
  if (!invoice) { res.status(404).render('error', { message: 'This invoice link is not valid. Please contact us and we will send a fresh one.' }); return; }
  // Served by us, so this is evidence rather than a pixel's inference.
  await logDocEvent('invoice', invoice.id, 'opened', {
    customerId: invoice.customer_id, ip: evIp(req), userAgent: evUa(req),
    meta: { via: 'view link' },
  });
  const unpaid = invoice.payment_status !== 'paid' && invoice.status !== 'paid';
  res.render('invoices/public', {
    invoice, token, appUrl: config.APP_URL,
    dueDate: gbDate(invoice.due_date), issueDate: gbDate(invoice.invoice_date),
    overdue: !!(unpaid && invoice.due_date && new Date(invoice.due_date) < new Date()),
    money: (v: any) => '£' + (Number(v) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });
});

router.get('/i/:token/invoice.pdf', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const invoice = await invoiceByToken(token);
  if (!invoice) { res.status(404).render('error', { message: 'This invoice link is not valid.' }); return; }
  if (req.query.dl) {
    await logDocEvent('invoice', invoice.id, 'downloaded', {
      customerId: invoice.customer_id, ip: evIp(req), userAgent: evUa(req),
    });
  }
  try {
    const pdf = await renderInvoicePdf(invoice.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + `; filename="${invoice.invoice_number}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[invoice-public] pdf failed:', e);
    res.status(500).render('error', { message: 'The invoice could not be produced. Please contact us and we will email it across.' });
  }
});

// Print happens entirely in the browser, so the page reports it back.
router.post('/i/:token/event', async (req: Request, res: Response) => {
  const invoice = await invoiceByToken(String(req.params.token));
  const ev = String(req.body?.event || '');
  if (invoice && (ev === 'printed' || ev === 'downloaded')) {
    await logDocEvent('invoice', invoice.id, ev as any, {
      customerId: invoice.customer_id, ip: evIp(req), userAgent: evUa(req),
    });
  }
  res.status(204).end();
});

// ── Finance Agent — natural-language questions over ONE invoice ─────────────────
// Built for customer billing queries ("you took £91.80 but the invoice says £22.20"):
// grounds Claude in the invoice, its lines, the LIVE GoCardless payment (what actually
// happened to the money), the customer's credits + other invoices, and the email thread,
// then answers with citations. Every Q&A is stored per invoice, team-wide.
// (Terry, 2026-07-30 — born directly out of the June IT-2026-0006/0007 forensic.)

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_ai_queries (
      id         SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      user_id    INTEGER,
      question   TEXT NOT NULL,
      answer     JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error('ensure invoice_ai_queries failed:', e.message));
  await pool.query('CREATE INDEX IF NOT EXISTS invoice_ai_queries_invoice_idx ON invoice_ai_queries (invoice_id)')
    .catch(() => { /* index best-effort */ });
})();

function finPlain(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
const finMoney = (v: any) => '£' + (Number(v) || 0).toFixed(2);
const finDate = (v: any) => v ? new Date(v).toISOString().slice(0, 10) : '-';

router.get('/invoices/:id/ask', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const rows = (await pool.query(
    `SELECT q.id, q.question, q.answer, q.created_at, u.display_name AS asked_by
       FROM invoice_ai_queries q LEFT JOIN users u ON u.id = q.user_id
      WHERE q.invoice_id = $1 ORDER BY q.created_at DESC LIMIT 50`, [id])).rows;
  res.json({ ok: true, queries: rows });
});

router.post('/invoices/:id/ask', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const question = String((req.body || {}).question || '').trim().slice(0, 600);
  if (!Number.isInteger(id) || !question) { res.status(400).json({ ok: false, error: 'Ask a question first.' }); return; }
  try {
    const inv = (await pool.query(
      `SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.id = $1 AND i.deleted_at IS NULL LIMIT 1`, [id])).rows[0];
    if (!inv) { res.status(404).json({ ok: false, error: 'Invoice not found.' }); return; }
    const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id', [id])).rows;

    const blocks: string[] = [];
    blocks.push(`[INV] Invoice ${inv.invoice_number || '(unnumbered draft)'} — "${inv.title || ''}" | Customer: ${inv.customer_name || 'none'} | Status: ${inv.status} / payment ${inv.payment_status} | Scheme: ${inv.invoice_scheme || '-'} | Issued ${finDate(inv.issue_date)}, due ${finDate(inv.due_date)} | Subtotal ${finMoney(inv.subtotal)} + VAT ${finMoney(inv.tax_total)} = TOTAL ${finMoney(inv.total)} | Balance on record: ${finMoney(inv.balance)} | QuickBooks id: ${inv.quickbooks_invoice_id || 'not pushed'} | GoCardless payment: ${inv.gocardless_payment_id || 'not submitted'} | GC payout ref: ${inv.gocardless_payout_ref || '-'}` + (inv.notes ? `\nNotes: ${String(inv.notes).slice(0, 1500)}` : ''));
    items.forEach((it: any, i: number) => blocks.push(`[L${i + 1}] ${it.description} | qty ${it.quantity} × ${finMoney(it.unit_price)} @ ${it.tax_rate}% VAT = ${finMoney(it.line_total)}`));

    // What ACTUALLY happened to the money — live GoCardless lookup, never trusted from the doc.
    if (inv.gocardless_payment_id) {
      try {
        const gc = await GoCardless.load();
        if (gc.isConfigured()) {
          const pmt = await gc.getPayment(inv.gocardless_payment_id);
          const collected = Number(pmt?.amount || 0) / 100;
          const mismatch = Math.abs(collected - Number(inv.total || 0)) > 0.005;
          blocks.push(`[GC] LIVE GoCardless payment ${inv.gocardless_payment_id}: collected ${finMoney(collected)} | status ${pmt?.status || '?'} | charge date ${pmt?.charge_date || '?'} | description "${pmt?.description || ''}"` +
            (mismatch
              ? `\n!!! MISMATCH: the money actually collected (${finMoney(collected)}) does NOT equal the invoice's current total (${finMoney(inv.total)}). The collected amount is the truth about the money; the invoice document has probably been edited since collection.`
              : `\nCollected amount matches the invoice total.`));
        }
      } catch (e: any) { blocks.push(`[GC] GoCardless lookup failed: ${String(e.message || '').slice(0, 140)}`); }
    }

    // What QuickBooks has on record — portal edits do NOT auto-update QB, so its copy can
    // legitimately differ from the portal document (IT-2026-0008 taught us that on day one).
    if (inv.quickbooks_invoice_id) {
      try {
        const qbc = await QuickBooks.load();
        if (qbc.isConnected()) {
          const qi = await qbc.getInvoice(String(inv.quickbooks_invoice_id));
          if (qi) {
            const qbTotal = Number(qi.TotalAmt || 0);
            const drift = Math.abs(qbTotal - Number(inv.total || 0)) > 0.005;
            blocks.push(`[QB] QuickBooks invoice #${inv.quickbooks_invoice_id} (DocNumber ${qi.DocNumber || '-'}): total ${finMoney(qbTotal)} | balance ${finMoney(qi.Balance ?? qbTotal)} | date ${qi.TxnDate || '-'} | customer "${qi.CustomerRef?.name || ''}"` +
              (drift
                ? `\n!!! QB DRIFT: QuickBooks holds ${finMoney(qbTotal)} but the portal document now totals ${finMoney(inv.total)} — the invoice was edited after it was pushed. VAT/credit decisions must account for which figure was declared.`
                : `\nQuickBooks matches the portal document.`));
          }
        }
      } catch (e: any) { blocks.push(`[QB] QuickBooks lookup failed: ${String(e.message || '').slice(0, 140)}`); }
    }

    if (inv.customer_id) {
      const sibs = (await pool.query(
        `SELECT id, invoice_number, title, total, status, payment_status, issue_date, gocardless_payment_id, gocardless_payout_ref
           FROM invoices WHERE customer_id=$1 AND deleted_at IS NULL AND id<>$2
          ORDER BY issue_date DESC NULLS LAST, id DESC LIMIT 30`, [inv.customer_id, id])).rows;
      if (sibs.length) blocks.push('[SIB] Other invoices for this customer (newest first):\n' +
        sibs.map((sb: any) => `[I${sb.id}] ${sb.invoice_number || '(draft)'} "${String(sb.title || '').slice(0, 60)}" ${finMoney(sb.total)} ${sb.status}/${sb.payment_status} issued ${finDate(sb.issue_date)}${sb.gocardless_payment_id ? ' DD-collected' : ''}${sb.gocardless_payout_ref ? ' payout ' + sb.gocardless_payout_ref : ''}`).join('\n'));
      const crs = (await pool.query(
        `SELECT id, amount, reason, status, source_invoice_id, applied_invoice_id, created_at
           FROM customer_credits WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 15`, [inv.customer_id])).rows;
      if (crs.length) blocks.push('[CRED] Customer credits:\n' +
        crs.map((cr: any) => `[C${cr.id}] ${finMoney(cr.amount)} ${cr.status} — ${String(cr.reason || '').slice(0, 120)} (source invoice id ${cr.source_invoice_id || '-'}, applied to invoice id ${cr.applied_invoice_id || '-'}, ${finDate(cr.created_at)})`).join('\n'));
    }

    const thread = await getComms('invoice', id);
    for (const m of thread.slice(-15)) {
      const who = m.direction === 'outbound' ? `Lumen (${m.sent_by_name || 'sent'}) → ${m.to_email || ''}` : `from ${m.from_name || m.from_email || 'customer'}`;
      blocks.push(`[T${m.id}] ${who} · ${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')} | ${m.subject || ''}\n${finPlain(m.body || '').slice(0, 8000)}`);
    }

    let corpus = blocks.join('\n\n---\n\n');
    if (corpus.length > 160000) corpus = corpus.slice(0, 80000) + '\n\n[... omitted ...]\n\n' + corpus.slice(-80000);

    const system = [
      "You are the finance agent for Lumen IT Solutions' portal. Answer questions about ONE invoice — usually a customer's billing query — using ONLY the data provided.",
      'Blocks: [INV] invoice header, [L1..] its line items, [GC] the LIVE GoCardless payment (what actually happened to the money), [SIB] the customer\'s other invoices, [CRED] credits, [T123] email-thread messages.',
      'Rules:',
      '- The [GC] block is authoritative about money. If it flags a mismatch with the invoice total, lead with that and explain the document no longer matches the collection.',
      '- When asked "what made up £X taken on <date>", reconcile against [GC], [SIB] amounts and payout refs — multiple invoices can share a charge date. Show your arithmetic.',
      '- Answer concisely and factually. If the data cannot answer, say exactly that — NEVER guess or invent figures.',
      '- Reply with STRICT JSON only — no markdown fences:',
      '  {"answer":"...","findings":[{"ref":"GC","quote":"exact verbatim snippet (max 140 chars)"}],"actions":[{"type":"...","label":"short button label","why":"one sentence","params":{}}]}',
      '- 1 to 4 findings, most relevant first, quotes copied verbatim from the blocks. Valid refs: INV, L1.., GC, QB, I<id>, C<id>, T<id>, SIB, CRED.',
      '- ACTIONS: when the answer clearly calls for it, propose up to 3 one-click actions (in run order) the staff member can approve. NOTHING runs or sends without their click. Allowed types + params:',
      '  draft_reply {to, subject, body} — write the customer-facing reply (plain text paragraphs, friendly-professional UK tone, no sign-off — the signature is appended automatically). It is inserted into the composer for staff review, never sent automatically.',
      '  void_invoice {} — void THIS invoice (no customer email is sent).',
      '  create_restatement {title, line_description, net_amount, offset_description, notes} — raise a corrected replacement invoice on this customer; net_amount is the ex-VAT figure (20% VAT applies); include offset_description whenever the money was already collected so the replacement totals £0.',
      '  log_credit {amount, reason} — log a customer credit (amount in pounds).',
      '  zero_balance {} — clear a stale balance figure on a paid/void invoice (reporting fix only).',
      '- Only propose actions justified by the data; if unsure, propose none.',
    ].join('\n');

    // Invoice data cached, question last - see the ticket version for why the order matters.
    const { text: raw, usage: askUsage } = await aiAskCached(system, corpus, `QUESTION: ${question}`, { maxTokens: 800 });
    const askCache = cacheNote(askUsage);
    // Parse robustly: models sometimes wrap JSON in fences or lead with prose — take the
    // outermost {...} span rather than trusting the reply shape.
    let parsed: any;
    try {
      const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
      parsed = JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw);
    } catch { parsed = { answer: raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim(), findings: [] }; }
    const ALLOWED_AGENT_ACTIONS: Record<string, string[]> = {
      draft_reply: ['to', 'subject', 'body'], void_invoice: [],
      create_restatement: ['title', 'line_description', 'net_amount', 'offset_description', 'notes'],
      log_credit: ['amount', 'reason'], zero_balance: [],
    };
    const actions = (Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : []).map((a: any) => {
      const type = String(a?.type || '');
      if (!(type in ALLOWED_AGENT_ACTIONS)) return null;
      const src = a.params || {}; const params: any = {};
      for (const k of ALLOWED_AGENT_ACTIONS[type]) {
        if (src[k] === undefined || src[k] === null) continue;
        params[k] = typeof src[k] === 'number' ? src[k] : String(src[k]).slice(0, k === 'body' ? 4000 : 300);
      }
      return { type, label: String(a.label || type).slice(0, 60), why: String(a.why || '').slice(0, 200), params };
    }).filter(Boolean);

    const answer = { answer: String(parsed.answer || '').slice(0, 4000),
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 4).map((f: any) => ({ ref: String(f.ref || ''), quote: String(f.quote || '').slice(0, 200) })) : [],
      actions };

    const ins = (await pool.query(
      'INSERT INTO invoice_ai_queries (invoice_id, user_id, question, answer) VALUES ($1,$2,$3,$4::jsonb) RETURNING id, created_at',
      [id, user.id, question, JSON.stringify(answer)])).rows[0];
    res.json({ ok: true, id: ins.id, question, answer, created_at: ins.created_at, asked_by: user.displayName, cache: askCache });
  } catch (e: any) {
    console.error('[finance-agent] failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'Ask failed.' });
  }
});

// ── Finance Agent action executor ───────────────────────────────────────────────
// Runs ONE agent-proposed action after an explicit staff click. Deliberately small,
// hard-validated vocabulary; nothing here emails a customer (draft_reply is inserted
// into the composer client-side for review), nothing touches GoCardless or QuickBooks.
router.post('/invoices/:id/agent-action', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const type = String((req.body || {}).type || '');
  const params: any = (req.body || {}).params || {};
  const inv = (await pool.query('SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL LIMIT 1', [id])).rows[0];
  if (!inv) { res.status(404).json({ ok: false, error: 'Invoice not found.' }); return; }
  try {
    if (type === 'void_invoice') {
      if (inv.status === 'void') { res.json({ ok: false, error: 'Already void.' }); return; }
      await pool.query("UPDATE invoices SET status='void', payment_status='void', balance=0, updated_at=NOW() WHERE id=$1", [id]);
      await logActivity(user.id, 'status_changed', 'invoices', id, `Finance Agent (approved by ${user.displayName}): voided ${inv.invoice_number}, balance zeroed`);
      res.json({ ok: true, done: `Voided ${inv.invoice_number} (balance zeroed). No customer email sent.` }); return;
    }
    if (type === 'zero_balance') {
      if (Number(inv.balance) === 0) { res.json({ ok: false, error: 'Balance is already zero.' }); return; }
      if (!(inv.status === 'void' || inv.payment_status === 'paid' || inv.payment_status === 'void')) { res.json({ ok: false, error: 'Balance can only be zeroed on paid or void invoices.' }); return; }
      await pool.query('UPDATE invoices SET balance=0, updated_at=NOW() WHERE id=$1', [id]);
      await logActivity(user.id, 'updated', 'invoices', id, `Finance Agent (approved by ${user.displayName}): zeroed stale balance on ${inv.invoice_number}`);
      res.json({ ok: true, done: 'Stale balance zeroed.' }); return;
    }
    if (type === 'log_credit') {
      const amount = Math.round((parseFloat(String(params.amount)) || 0) * 100) / 100;
      if (!inv.customer_id) { res.json({ ok: false, error: 'Invoice has no customer.' }); return; }
      if (!(amount > 0 && amount <= 100000)) { res.json({ ok: false, error: 'Credit amount must be between £0.01 and £100,000.' }); return; }
      const reason = String(params.reason || '').slice(0, 300) || `Finance Agent credit re ${inv.invoice_number}`;
      await pool.query('INSERT INTO customer_credits (customer_id, amount, reason, source_invoice_id, created_by) VALUES ($1,$2,$3,$4,$5)',
        [inv.customer_id, amount.toFixed(2), reason, id, user.id]);
      await logActivity(user.id, 'created', 'invoices', id, `Finance Agent (approved by ${user.displayName}): logged £${amount.toFixed(2)} credit — ${reason}`);
      res.json({ ok: true, done: `Logged a £${amount.toFixed(2)} credit against ${inv.customer_name || 'the customer'}.` }); return;
    }
    if (type === 'create_restatement') {
      if (!inv.customer_id) { res.json({ ok: false, error: 'Invoice has no customer.' }); return; }
      const net = Math.round((parseFloat(String(params.net_amount)) || 0) * 100) / 100;
      if (!(net > 0 && net <= 100000)) { res.json({ ok: false, error: 'net_amount must be between £0.01 and £100,000 (ex VAT).' }); return; }
      const title = String(params.title || '').slice(0, 200).trim();
      const lineDesc = String(params.line_description || '').slice(0, 500).trim();
      if (!title || !lineDesc) { res.json({ ok: false, error: 'Title and line description are required.' }); return; }
      const offsetDesc = String(params.offset_description || '').slice(0, 500).trim();
      const notes = String(params.notes || '').slice(0, 1500).trim() || null;
      const today = new Date().toISOString().slice(0, 10);
      const vat = Math.round(net * 20) / 100;
      const total = offsetDesc ? 0 : Math.round((net + vat) * 100) / 100;
      const client = await pool.connect();
      let newId = 0, num = '';
      try {
        await client.query('BEGIN');
        num = await nextInvoiceNumber(inv.invoice_scheme === 'CS' ? 'CS' : 'IT');
        const ins = await client.query(
          `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, title, status, payment_status, payment_method,
             issue_date, due_date, currency_code, notes, subtotal, tax_total, total, balance, created_by)
           VALUES ($1,$2,$3,$4,'issued','unpaid',$5,$6,$6,'GBP',$7,$8,$9,$10,$10,$11) RETURNING id`,
          [inv.customer_id, num, inv.invoice_scheme || 'IT', title, inv.payment_method || 'upfront', today, notes,
           (offsetDesc ? 0 : net).toFixed(2), (offsetDesc ? 0 : vat).toFixed(2), total.toFixed(2), user.id]);
        newId = ins.rows[0].id;
        await client.query(`INSERT INTO invoice_items (invoice_id, sort_order, description, quantity, unit_price, tax_rate, line_total) VALUES ($1,1,$2,1,$3,20,$3)`, [newId, lineDesc, net.toFixed(2)]);
        if (offsetDesc) await client.query(`INSERT INTO invoice_items (invoice_id, sort_order, description, quantity, unit_price, tax_rate, line_total) VALUES ($1,2,$2,1,$3,20,$3)`, [newId, offsetDesc, (-net).toFixed(2)]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      await logActivity(user.id, 'created', 'invoices', newId, `Finance Agent (approved by ${user.displayName}): created restatement ${num} (${offsetDesc ? '£0 due — already collected' : 'total £' + total.toFixed(2)}) re ${inv.invoice_number}`);
      res.json({ ok: true, done: `Created ${num}${offsetDesc ? ' — £0 due (offset by the collected payment)' : ` — total £${total.toFixed(2)}`}.`, link: '/invoices/' + newId }); return;
    }
    res.status(400).json({ ok: false, error: 'Unknown or unsupported action type.' });
  } catch (e: any) {
    console.error('[finance-agent action] failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'Action failed.' });
  }
});

// ── Finance Agent v3 — conversational endpoints (invoice + customer scope) ──────
router.post('/finance-agent/ask', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b: any = req.body || {};
  try {
    const r = await askFinance({
      scope: b.scope === 'customer' ? 'customer' : 'invoice',
      invoiceId: parseInt(String(b.invoice_id || ''), 10) || null,
      customerId: parseInt(String(b.customer_id || ''), 10) || null,
      conversationId: parseInt(String(b.conversation_id || ''), 10) || null,
      question: String(b.question || ''), userId: user.id, userName: user.displayName,
    });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e: any) {
    console.error('[finance-agent] ask failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'Ask failed.' });
  }
});

router.get('/finance-agent/conversations', requireAuth, async (req: Request, res: Response) => {
  const scope = req.query.scope === 'customer' ? 'customer' : 'invoice';
  const refId = parseInt(String(req.query.id || ''), 10) || 0;
  res.json({ ok: true, conversations: refId ? await listFinanceConversations(scope, refId) : [] });
});

router.get('/finance-agent/conversation/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10) || 0;
  res.json({ ok: true, messages: id ? await getFinanceConversation(id) : [] });
});

// The agent's second brain — read + tidy (archiving is a staff curation act, logged implicitly).
router.get('/finance-agent/memories', requireAuth, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  res.json({ ok: true, memories: await listFinanceMemories(customerId) });
});
router.post('/finance-agent/memory/:id/archive', requireAuth, async (req: Request, res: Response) => {
  const ok = await archiveFinanceMemory(parseInt(String(req.params.id), 10) || 0);
  res.json({ ok });
});

// Jump to an invoice's Finance Agent by NUMBER (used by the case-page button when an
// inbound email's subject cites an invoice). Own path so it can't shadow /invoices/:id.
router.get('/invoice-lookup/:number', requireAuth, async (req: Request, res: Response) => {
  const n = String(req.params.number || '').trim();
  const row = (await pool.query('SELECT id FROM invoices WHERE invoice_number=$1 AND deleted_at IS NULL LIMIT 1', [n])).rows[0];
  if (!row) { res.status(404).render('error', { message: 'No invoice numbered ' + n + '.' }); return; }
  res.redirect('/invoices/' + row.id + '?ask=1');
});

export default router;