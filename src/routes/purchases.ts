import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireFinance } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { getSetting, setSetting } from '../lib/settings';
import { QuickBooks } from '../lib/quickbooks';
import { syncOpenBanking } from '../lib/openbanking';
import { syncInvoiceInbox, getInvoiceMailbox, autoMatchInvoices } from '../lib/purchase-inbox';
import { parseAndStoreDoc } from '../lib/invoice-read';
import { renderExpenseReportPdf, loadExpenseReport } from '../lib/expense-report';
import { graphSendMail, graphConfigured } from '../lib/graph';
import { config } from '../config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse: csvParseSync } = require('csv-parse/sync');

const router = Router();
router.use('/purchases', requireAuth, requireFinance); // purchase ledger is finance-only

const RECEIPTS_DIR = path.join(process.cwd(), 'uploads', 'receipts');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(RECEIPTS_DIR, { recursive: true }); cb(null, RECEIPTS_DIR); },
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});
import { PURCHASE_DOCS_DIR } from '../lib/purchase-inbox';
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(PURCHASE_DOCS_DIR, { recursive: true }); cb(null, PURCHASE_DOCS_DIR); },
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});
// Cached QB expense categories — QB is slow and was being hit on every page render.
let _catsCache: { at: number; cats: any[]; qbOn: boolean } | null = null;
const CATS_TTL = 5 * 60 * 1000;

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };

// Report-only categories that DON'T exist in QuickBooks (e.g. TOK / NOK Director Loan).
// Stored as "local:<name>" so they show in the dropdown + on the report but are skipped
// when pushing to QB. Configurable in settings; defaults to the two director loans.
const DEFAULT_EXTRA_CATEGORIES = 'TOK Director Loan\nNOK Director Loan';
async function getExtraCategories(): Promise<{ Id: string; Name: string; local: boolean }[]> {
  const raw = await getSetting('purchases', 'extra_categories');
  const text = (raw === null || raw === undefined) ? DEFAULT_EXTRA_CATEGORIES : raw;
  return String(text).split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((n) => ({ Id: 'local:' + n, Name: n, local: true }));
}

// Shared category list (QB expense/COGS accounts, cached 5 min, + report-only categories).
// Used by both the expense reconciliation page and the mobile receipt logger.
export async function loadPurchaseCats(): Promise<{ cats: any[]; qbOn: boolean }> {
  let cats: any[] = []; let qbOn = false;
  if (_catsCache && Date.now() - _catsCache.at < CATS_TTL) { cats = _catsCache.cats.slice(); qbOn = _catsCache.qbOn; }
  else {
    try { const qb = await QuickBooks.load(); qbOn = qb.isConnected(); if (qbOn) cats = await qb.getExpenseAccounts(); } catch { /* QB off */ }
    _catsCache = { at: Date.now(), cats: cats.slice(), qbOn };
  }
  cats = cats.concat(await getExtraCategories());
  return { cats, qbOn };
}
const pick = (r: any, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); } return ''; };
// Parse a bank-statement date. Handles DD/MM/YYYY (UK banks), DD-MM-YYYY, and ISO. Native Date() reads DD/MM as US MM/DD, so do it explicitly.
const parseDate = (s: string): Date | null => {
  s = String(s || '').trim(); if (!s) return null;
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { let [, d, mo, y] = m; if (y.length === 2) y = '20' + y; const dt = new Date(Number(y), Number(mo) - 1, Number(d)); return isNaN(dt.getTime()) ? null : dt; }
  const dt = new Date(s); return isNaN(dt.getTime()) ? null : dt;
};

// ── Purchase Ledger hub ──────────────────────────────────────────────────────────
router.get('/purchases', async (req: Request, res: Response) => {
  const toDo = Number((await pool.query("SELECT COUNT(*)::int n FROM bank_transactions WHERE status IN ('new','categorised') AND amount < 0").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  res.render('purchases/index', { user: req.session.user!, toDo, notice: req.query.msg || null, error: req.query.err || null });
});

// ── Expense Reconciliation (month by month, with close) ────────────────────────────
router.get('/purchases/expenses', async (req: Request, res: Response) => {
  // Months that have transactions, newest first; default to the latest (or this calendar month).
  const months = (await pool.query("SELECT DISTINCT to_char(booked_at,'YYYY-MM') AS m FROM bank_transactions ORDER BY m DESC").catch(() => ({ rows: [] }))).rows.map((r: any) => r.m);
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (!months.includes(thisMonth)) months.unshift(thisMonth);
  // Always default to the current calendar month unless a period is explicitly chosen.
  const period = String(req.query.period || thisMonth);
  const txns = (await pool.query(
    "SELECT * FROM bank_transactions WHERE amount < 0 AND to_char(booked_at,'YYYY-MM')=$1 ORDER BY status='pushed', booked_at DESC", [period]
  ).catch(() => ({ rows: [] }))).rows;
  // Splits (category allocations) for these transactions.
  const splitsByTxn: Record<number, any[]> = {};
  if (txns.length) {
    const sp = (await pool.query('SELECT * FROM bank_transaction_splits WHERE transaction_id = ANY($1) ORDER BY id', [txns.map((t: any) => t.id)]).catch(() => ({ rows: [] }))).rows;
    for (const s of sp) { (splitsByTxn[s.transaction_id] = splitsByTxn[s.transaction_id] || []).push(s); }
  }
  const closed = !!(await getSetting('purchases', 'closed_' + period));
  // Categories (cached QB list + report-only categories) — shared with the mobile logger.
  const { cats, qbOn } = await loadPurchaseCats();
  const accounts = (await pool.query("SELECT id, name FROM bank_account_refs WHERE is_active=true ORDER BY sort_order, name").catch(() => ({ rows: [] }))).rows;
  // Pooled supplier invoices (from the invoice@ mailbox + uploads), newest first. The Archived tab
  // shows ones the user has filed away so the live inbox stays uncluttered.
  const showArchived = req.query.docs === 'archived';
  const docs = (await pool.query(
    `SELECT d.*, t.counterparty AS txn_payee, t.amount AS txn_amount
       FROM purchase_documents d LEFT JOIN bank_transactions t ON t.id = d.bank_transaction_id
      WHERE d.archived_at IS ${showArchived ? 'NOT NULL' : 'NULL'}
      ORDER BY d.status='attached', d.created_at DESC, d.id DESC`
  ).catch(() => ({ rows: [] }))).rows;
  const inboxCount = Number((await pool.query("SELECT COUNT(*)::int n FROM purchase_documents WHERE archived_at IS NULL AND status<>'attached'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  const archivedCount = Number((await pool.query("SELECT COUNT(*)::int n FROM purchase_documents WHERE archived_at IS NOT NULL").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  const view = ['inbox', 'reconciled', 'suppliers'].includes(String(req.query.view)) ? String(req.query.view) : 'expenses';
  const qbPushEnabled = (await getSetting('purchases', 'qb_push_enabled')) === '1';
  // Supplier directory (address book of who we buy from) — name/address/phone etc.
  const suppliers = (await pool.query("SELECT * FROM suppliers WHERE is_active = true ORDER BY lower(name)").catch(() => ({ rows: [] }))).rows;
  res.render('purchases/expenses', {
    user: req.session.user!, txns, splitsByTxn, cats, qbOn, qbPushEnabled, period, months, closed, accounts,
    docs, inboxCount, archivedCount, showArchived, view, suppliers, invoiceMailbox: await getInvoiceMailbox(),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Stream a pooled invoice/receipt inline so it previews in the lightbox (finance-gated).
router.get('/purchases/doc/:id/view', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const d = id ? (await pool.query('SELECT * FROM purchase_documents WHERE id=$1', [id])).rows[0] : null;
  if (!d || !fs.existsSync(d.file_path)) { res.status(404).send('Not found'); return; }
  // The global CSP sets frame-ancestors 'none', which blocks this file from rendering in the
  // expenses lightbox's own iframe. Relax it to same-origin for this file-serving route only.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Derive the type from the filename so the lightbox always previews inline — many senders attach
  // PDFs as application/octet-stream, which the browser won't render. Fall back to the stored type.
  const n = (d.file_name || '').toLowerCase();
  const ct = /\.pdf$/.test(n) ? 'application/pdf'
    : /\.png$/.test(n) ? 'image/png'
    : /\.(jpe?g)$/.test(n) ? 'image/jpeg'
    : /\.gif$/.test(n) ? 'image/gif'
    : /\.webp$/.test(n) ? 'image/webp'
    : /\.tiff?$/.test(n) ? 'image/tiff'
    : /\.html?$/.test(n) ? 'text/html'
    : (d.content_type && d.content_type !== 'application/octet-stream' ? d.content_type : 'application/octet-stream');
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', 'inline; filename="' + (d.file_name || 'document').replace(/[^\w.\-]/g, '_') + '"');
  fs.createReadStream(d.file_path).pipe(res);
});

// Attach a pooled invoice to a bank transaction (or a split) from the lightbox picker.
router.post('/purchases/doc/:id/attach', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const txnId = parseInt(String(req.body.txn_id || ''), 10);
  const splitId = parseInt(String(req.body.split_id || ''), 10);
  if (!id || (!txnId && !splitId)) { res.status(400).json({ ok: false, error: 'Missing doc or transaction.' }); return; }
  const d = (await pool.query('SELECT * FROM purchase_documents WHERE id=$1', [id])).rows[0];
  if (!d) { res.status(404).json({ ok: false, error: 'Document not found.' }); return; }
  if (splitId) {
    const sp = (await pool.query('SELECT transaction_id FROM bank_transaction_splits WHERE id=$1', [splitId])).rows[0];
    if (!sp) { res.status(404).json({ ok: false, error: 'Split not found.' }); return; }
    await pool.query('UPDATE bank_transaction_splits SET attachment_path=$1, attachment_name=$2 WHERE id=$3', [d.file_path, d.file_name, splitId]);
    await pool.query("UPDATE purchase_documents SET status='attached', bank_transaction_id=$1 WHERE id=$2", [sp.transaction_id, id]);
  } else {
    await pool.query('UPDATE bank_transactions SET attachment_path=$1, attachment_name=$2, updated_at=NOW() WHERE id=$3', [d.file_path, d.file_name, txnId]);
    // If the receipt was captured with a category (mobile logger) and the txn isn't
    // categorised yet, carry the category across.
    if (d.category_id) {
      await pool.query("UPDATE bank_transactions SET qb_account_id=$1, qb_account_name=$2 WHERE id=$3 AND (qb_account_id IS NULL OR qb_account_id='')", [d.category_id, d.category_name, txnId]);
    }
    await pool.query("UPDATE purchase_documents SET status='attached', bank_transaction_id=$1 WHERE id=$2", [txnId, id]);
  }
  await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchases: attached pooled invoice "${d.file_name}"`);
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Invoice attached.'));
});

// Unlink / delete a pooled invoice.
router.post('/purchases/doc/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) {
    const d = (await pool.query('SELECT file_path FROM purchase_documents WHERE id=$1', [id])).rows[0];
    if (d?.file_path) { try { fs.unlinkSync(d.file_path); } catch { /* already gone */ } }
    await pool.query('DELETE FROM purchase_documents WHERE id=$1', [id]);
  }
  res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent('Invoice removed from inbox.'));
});

// Archive a pooled invoice — hides it from the live inbox but keeps it on the Archived tab.
router.post('/purchases/doc/:id/archive', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query('UPDATE purchase_documents SET archived_at=NOW() WHERE id=$1', [id]).catch(() => {});
  res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent('Archived.'));
});

// Restore an archived invoice back into the live inbox.
router.post('/purchases/doc/:id/unarchive', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query('UPDATE purchase_documents SET archived_at=NULL WHERE id=$1', [id]).catch(() => {});
  res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent('Restored to inbox.'));
});

// Manually drop an invoice/receipt into the pool (one that wasn't emailed in).
router.post('/purchases/inbox/upload', docUpload.array('files', 10), async (req: Request, res: Response) => {
  const files = (req.files as any[]) || [];
  let added = 0;
  for (const f of files) {
    const ins = await pool.query(
      `INSERT INTO purchase_documents (source, from_name, subject, received_at, file_name, file_path, content_type, size_bytes, status)
       VALUES ('upload',$1,$2,NOW(),$3,$4,$5,$6,'new') RETURNING id`,
      ['Manual upload', f.originalname, f.originalname, f.path, f.mimetype || null, f.size || null]
    );
    added++;
    try { await parseAndStoreDoc({ id: ins.rows[0].id, file_path: f.path, content_type: f.mimetype || null, file_name: f.originalname }); } catch { /* parse best-effort */ }
  }
  res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent(`Added ${added} document(s) to the invoice inbox.`));
});

// Try to auto-match pooled invoices to bank transactions (amount + supplier + date).
router.post('/purchases/inbox/automatch', async (_req: Request, res: Response) => {
  try {
    const r = await autoMatchInvoices();
    res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent(`Auto-match: linked ${r.matched} invoice(s) to transactions.`));
  } catch (e: any) {
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(e.message || 'Auto-match failed.'));
  }
});

// Pull the invoices@ mailbox now (also runs on a 15-min cron).
router.post('/purchases/inbox/sync', async (req: Request, res: Response) => {
  try {
    const r = await syncInvoiceInbox();
    res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent(`Invoice inbox: pooled ${r.pooled} new document(s)` + (r.failed ? `, ${r.failed} failed (bounceback sent — import manually).` : '.')));
  } catch (e: any) {
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(e.message || 'Could not reach the invoice mailbox.'));
  }
});

// Close a month — locks it (no more categorising/pushing). Next month carries on fresh.
router.post('/purchases/close', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim();
  if (period) { await setSetting('purchases', 'closed_' + period, new Date().toISOString()); await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchases: closed month ${period}`); }
  res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&msg=' + encodeURIComponent('Month ' + period + ' closed.'));
});

// Re-open a closed month.
router.post('/purchases/reopen', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim();
  if (period) await setSetting('purchases', 'closed_' + period, '');
  res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&msg=' + encodeURIComponent('Month ' + period + ' re-opened.'));
});

// CSV import of bank transactions (interim source until Open Banking is connected).
router.post('/purchases/import', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.redirect('/purchases/expenses?err=' + encodeURIComponent('No file uploaded.')); return; }
  const accountRefId = parseInt(String(req.body.account_ref_id || ''), 10) || null;
  if (!accountRefId) { res.redirect('/purchases/expenses?err=' + encodeURIComponent('Choose which account this statement is for.')); return; }
  const acct = (await pool.query('SELECT name FROM bank_account_refs WHERE id=$1', [accountRefId])).rows[0];
  const acctName = acct?.name || null;
  let recs: any[] = [];
  try { recs = csvParseSync(req.file.buffer ?? fs.readFileSync(req.file.path), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true }); }
  catch (e: any) { res.redirect('/purchases/expenses?err=' + encodeURIComponent('Could not parse CSV: ' + e.message)); return; }
  let added = 0, dups = 0, bad = 0, moneyIn = 0;
  for (const r of recs) {
    const dateStr = pick(r, ['Date', 'date', 'Transaction Date', 'booked_at']);
    const desc = pick(r, ['Description', 'description', 'Narrative', 'Details', 'Notes', 'Type']);
    const amtRaw = pick(r, ['Amount (GBP)', 'Amount', 'amount', 'Value', 'Amount(GBP)']);
    const debit = pick(r, ['Debit', 'Money Out', 'Paid Out', 'Out (GBP)']);
    let amount = num(amtRaw); if (!amount && debit) amount = -Math.abs(num(debit));
    if (!dateStr || amount === 0) { bad++; continue; }
    if (amount > 0) { moneyIn++; continue; } // purchase ledger = expenses only; ignore money-in
    const d = parseDate(dateStr); if (!d) { bad++; continue; }
    const ref = pick(r, ['Reference', 'reference', 'Ref']);
    const cp = pick(r, ['Counter Party', 'Counterparty', 'Payee', 'Merchant', 'counterparty']);
    const ext = pick(r, ['Transaction ID', 'id', 'external_id']) || (d.toISOString().slice(0, 10) + '|' + desc + '|' + amount);
    try {
      // Duplicate check: same account + same day + same amount + same payee/description already in.
      const exists = await pool.query(
        `SELECT 1 FROM bank_transactions
          WHERE account_ref_id IS NOT DISTINCT FROM $1 AND date_trunc('day',booked_at)=date_trunc('day',$2::timestamp)
            AND amount=$3 AND COALESCE(counterparty,'')=COALESCE($4,'') AND COALESCE(description,'')=COALESCE($5,'') LIMIT 1`,
        [accountRefId, d, amount.toFixed(2), cp || null, desc || null]
      );
      if (exists.rowCount) { dups++; continue; }
      const ins = await pool.query(
        `INSERT INTO bank_transactions (source, external_id, account_ref_id, account_name, booked_at, amount, description, counterparty, reference, status)
         VALUES ('csv',$1,$2,$3,$4,$5,$6,$7,$8,'new') ON CONFLICT (source, external_id) DO NOTHING`,
        [ext, accountRefId, acctName, d, amount.toFixed(2), desc || null, cp || null, ref || null]
      );
      if (ins.rowCount) added++; else dups++;
    } catch { bad++; }
  }
  await logActivity(req.session.user!.id, 'created', 'invoices', 0, `Purchases: imported ${added}, ${dups} duplicate(s) skipped`);
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent(`Imported ${added} expense(s)` + (dups ? `, skipped ${dups} duplicate(s)` : '') + (moneyIn ? `, ignored ${moneyIn} money-in row(s)` : '') + (bad ? `, ${bad} unreadable row(s)` : '') + '.'));
});

// Pull transactions from Open Banking (needs provider creds).
router.post('/purchases/sync', async (req: Request, res: Response) => {
  try {
    const n = await syncOpenBanking();
    res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Open Banking sync: ' + n + ' transaction(s).'));
  } catch (e: any) {
    res.redirect('/purchases/expenses?err=' + encodeURIComponent(e.message || 'Open Banking not configured.'));
  }
});

// Categorise a transaction (QB COS account) and/or attach a receipt.
router.post('/purchases/txn/:id', upload.single('receipt'), async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); const b = req.body;
  if (!id) { res.redirect('/purchases/expenses'); return; }
  const acctId = (b.qb_account_id || '').trim() || null;
  const acctName = (b.qb_account_name || '').trim() || null;
  const fields: string[] = []; const vals: any[] = []; let i = 1;
  if (acctId !== undefined) { fields.push(`qb_account_id=$${i++}`); vals.push(acctId); fields.push(`qb_account_name=$${i++}`); vals.push(acctName); }
  if (req.file) { fields.push(`attachment_path=$${i++}`); vals.push(req.file.path); fields.push(`attachment_name=$${i++}`); vals.push(req.file.originalname); }
  // Lock (→ categorised) when there's a category OR an invoice is attached (this request or already on
  // the row). A locked row with no QB category just shows as reconciled and is skipped by the QB push.
  const lockNow = !!acctId || !!req.file;
  fields.push(`status=CASE WHEN $${i} OR attachment_path IS NOT NULL THEN 'categorised' ELSE status END`); vals.push(lockNow);
  vals.push(id);
  await pool.query(`UPDATE bank_transactions SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${i + 1}`, vals);
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Saved'));
});

// Ignore / un-ignore a transaction (kept out of the reconcile list and the QB push).
router.post('/purchases/txn/:id/ignore', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/purchases/expenses'); return; }
  const ignore = String(req.body.ignore ?? '1') !== '0';
  if (ignore) {
    await pool.query("UPDATE bank_transactions SET status='ignored', updated_at=NOW() WHERE id=$1 AND status<>'pushed'", [id]);
  } else {
    // Restore: categorised if it already has a category, otherwise back to new.
    await pool.query("UPDATE bank_transactions SET status=CASE WHEN qb_account_id IS NOT NULL AND qb_account_id<>'' THEN 'categorised' ELSE 'new' END, updated_at=NOW() WHERE id=$1 AND status='ignored'", [id]);
  }
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent(ignore ? 'Transaction ignored.' : 'Transaction restored.'));
});

// Branded landscape "Expense and Tax Receipts Report" PDF for a month (download).
router.get('/purchases/report', async (req: Request, res: Response) => {
  const period = String(req.query.period || new Date().toISOString().slice(0, 7));
  try {
    const pdf = await renderExpenseReportPdf(period);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Expense-and-Tax-Receipts-Report-${period}.pdf"`);
    res.end(pdf);
  } catch (e: any) {
    res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&err=' + encodeURIComponent('Could not build report: ' + (e.message || e)));
  }
});

// Email the branded report (+ the period's receipts/invoices) to the bookkeeper.
router.post('/purchases/report/send', async (req: Request, res: Response) => {
  const period = String(req.body.period || new Date().toISOString().slice(0, 7));
  const to = (await getSetting('purchases', 'bookkeeper_email')) || '';
  const cc = (await getSetting('purchases', 'bookkeeper_cc')) || '';
  const bcc = (await getSetting('purchases', 'bookkeeper_bcc')) || '';
  if (!to) { res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&err=' + encodeURIComponent('Set a bookkeeper email first (Admin → Purchase Ledger).')); return; }
  if (!graphConfigured()) { res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&err=' + encodeURIComponent('Email isn\'t configured (Graph).')); return; }
  try {
    const data = await loadExpenseReport(period);
    const monthLabel = new Date(period + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    // Portal-only: no attachments — the email is a notification linking to the read-only dashboard.
    await graphSendMail({
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject: `Expenses ready to review — ${monthLabel}`,
      html: `<p>The expenses for <strong>${monthLabel}</strong> are ready to review.</p>
        <ul><li>Total expenses: £${data.total.toLocaleString('en-GB', { minimumFractionDigits: 2 })}</li>
        <li>Transactions: ${data.rows.length}</li></ul>
        <p style="margin:16px 0;"><a href="${(config.APP_URL || 'https://portal.lumenmsp.co.uk')}/bookkeeper" style="display:inline-block;background:#0891b2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">View expenses &amp; receipts online</a></p>
        <p style="color:#6b7280;font-size:13px;">Sign in with your Microsoft account to view every month's expenses and open each receipt. Nothing is attached to this email.</p>
        <p>Lumen IT Solutions Limited</p>`,
    });
    await logActivity(req.session.user!.id, 'created', 'invoices', 0, `Purchases: emailed ${period} expenses link to bookkeeper`);
    res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&msg=' + encodeURIComponent(`Expenses link for ${monthLabel} sent to ${to}.`));
  } catch (e: any) {
    res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&err=' + encodeURIComponent('Could not send report: ' + (e.message || e)));
  }
});

// Unlock a saved (categorised) transaction so it can be edited again — keeps its category/receipt.
router.post('/purchases/txn/:id/unlock', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query("UPDATE bank_transactions SET status='new', updated_at=NOW() WHERE id=$1 AND status='categorised'", [id]);
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Unlocked.'));
});

// Unlink the attached invoice/receipt from a transaction (and free the pooled invoice).
router.post('/purchases/txn/:id/unlink-invoice', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) {
    await pool.query('UPDATE bank_transactions SET attachment_path=NULL, attachment_name=NULL, updated_at=NOW() WHERE id=$1', [id]);
    // If a pooled invoice was linked to it, return it to the inbox.
    await pool.query("UPDATE purchase_documents SET status='new', bank_transaction_id=NULL WHERE bank_transaction_id=$1", [id]);
  }
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Invoice unlinked.'));
});

const wantsJson = (req: Request) => req.xhr || String(req.get('accept') || '').includes('application/json');

// Save split allocations for a transaction (replace set; preserve attachments on kept lines).
router.post('/purchases/txn/:id/splits', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(400).json({ ok: false }); return; }
  let lines: any[] = [];
  try { lines = JSON.parse(req.body.lines || '[]'); } catch { lines = []; }
  const keepIds: number[] = [];
  for (const ln of lines) {
    const amt = Math.abs(Number(ln.amount) || 0);
    if (!amt) continue;
    const cat = String(ln.cat || '').trim() || null;
    const catName = String(ln.name || '').trim() || null;
    const sid = parseInt(String(ln.id || ''), 10);
    if (sid) {
      await pool.query('UPDATE bank_transaction_splits SET amount=$1, qb_account_id=$2, qb_account_name=$3 WHERE id=$4 AND transaction_id=$5', [amt.toFixed(2), cat, catName, sid, id]);
      keepIds.push(sid);
    } else {
      const ins = await pool.query('INSERT INTO bank_transaction_splits (transaction_id, amount, qb_account_id, qb_account_name) VALUES ($1,$2,$3,$4) RETURNING id', [id, amt.toFixed(2), cat, catName]);
      keepIds.push(ins.rows[0].id);
    }
  }
  if (keepIds.length) await pool.query('DELETE FROM bank_transaction_splits WHERE transaction_id=$1 AND NOT (id = ANY($2))', [id, keepIds]);
  else await pool.query('DELETE FROM bank_transaction_splits WHERE transaction_id=$1', [id]);
  if (wantsJson(req)) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Splits saved.'));
});

// Remove all splits → back to a single line.
router.post('/purchases/txn/:id/unsplit', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query('DELETE FROM bank_transaction_splits WHERE transaction_id=$1', [id]);
  if (wantsJson(req)) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Split removed.'));
});

// Lock a transaction (split txns lock here; single txns lock via the categorise save).
router.post('/purchases/txn/:id/lock', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) {
    const r = (await pool.query("SELECT (qb_account_id IS NOT NULL AND qb_account_id<>'') AS hascat, (SELECT COUNT(*) FROM bank_transaction_splits WHERE transaction_id=$1)::int AS nsplits FROM bank_transactions WHERE id=$1", [id])).rows[0];
    if (r && (r.hascat || r.nsplits > 0)) await pool.query("UPDATE bank_transactions SET status='categorised', updated_at=NOW() WHERE id=$1 AND status<>'pushed'", [id]);
  }
  if (wantsJson(req)) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Locked.'));
});

// Upload a receipt/invoice to a specific split.
router.post('/purchases/split/:id/receipt', upload.single('receipt'), async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id && req.file) await pool.query('UPDATE bank_transaction_splits SET attachment_path=$1, attachment_name=$2 WHERE id=$3', [req.file.path, req.file.originalname, id]);
  if (wantsJson(req)) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Receipt added to split.'));
});

// Unlink a split's invoice/receipt (and free a pooled invoice if it was one).
router.post('/purchases/split/:id/unlink', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) {
    const s = (await pool.query('SELECT attachment_path FROM bank_transaction_splits WHERE id=$1', [id])).rows[0];
    await pool.query('UPDATE bank_transaction_splits SET attachment_path=NULL, attachment_name=NULL WHERE id=$1', [id]);
    if (s?.attachment_path) await pool.query("UPDATE purchase_documents SET status='new', bank_transaction_id=NULL WHERE file_path=$1", [s.attachment_path]);
  }
  if (wantsJson(req)) { res.json({ ok: true }); return; }
  res.redirect('/purchases/expenses?msg=' + encodeURIComponent('Invoice unlinked.'));
});

// ── Bookkeeper / Purchase Ledger settings (Admin) ──────────────────────────────────
router.get('/purchases/settings', async (req: Request, res: Response) => {
  let banks: any[] = []; let qbOn = false;
  try { const qb = await QuickBooks.load(); qbOn = qb.isConnected(); if (qbOn) banks = await qb.getBankAccounts(); } catch { /* QB off */ }
  const g = async (k: string) => (await getSetting('purchases', k)) || '';
  const accounts = (await pool.query("SELECT * FROM bank_account_refs ORDER BY sort_order, name").catch(() => ({ rows: [] }))).rows;
  res.render('purchases/settings', {
    user: req.session.user!, banks, qbOn, accounts,
    bookkeeperName: await g('bookkeeper_name'), bookkeeperEmail: await g('bookkeeper_email'),
    bookkeeperCc: await g('bookkeeper_cc'), bookkeeperBcc: await g('bookkeeper_bcc'),
    obSecretId: await getSetting('openbanking', 'secret_id') || '', obAccountId: await getSetting('openbanking', 'account_id') || '',
    invoiceMailbox: await getInvoiceMailbox(),
    extraCategories: (await getExtraCategories()).map((c) => c.Name).join('\n'),
    qbPushEnabled: (await getSetting('purchases', 'qb_push_enabled')) === '1',
    notice: req.query.msg || null,
  });
});

// Add / edit / delete a managed bank account (the list you import statements against).
router.post('/purchases/accounts', async (req: Request, res: Response) => {
  const name = String(req.body.name || '').trim();
  if (name) {
    const qbId = (req.body.qb_account_id || '').trim() || null;
    const qbName = (req.body.qb_account_name || '').trim() || null;
    await pool.query('INSERT INTO bank_account_refs (name, qb_account_id, qb_account_name) VALUES ($1,$2,$3)', [name, qbId, qbName]);
  }
  res.redirect('/purchases/settings?msg=' + encodeURIComponent('Account added'));
});
router.post('/purchases/accounts/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); if (!id) { res.redirect('/purchases/settings'); return; }
  await pool.query('UPDATE bank_account_refs SET name=$1, qb_account_id=$2, qb_account_name=$3, is_active=$4 WHERE id=$5',
    [String(req.body.name || '').trim(), (req.body.qb_account_id || '').trim() || null, (req.body.qb_account_name || '').trim() || null, req.body.is_active === 'on', id]);
  res.redirect('/purchases/settings?msg=' + encodeURIComponent('Account saved'));
});
router.post('/purchases/accounts/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); if (id) await pool.query('DELETE FROM bank_account_refs WHERE id=$1', [id]);
  res.redirect('/purchases/settings?msg=' + encodeURIComponent('Account deleted'));
});

// ── Supplier directory (address book of who we buy from) ────────────────────────────
const SUPP_BACK = '/purchases/expenses?view=suppliers';
// Order matches the SQL below: name, contact_name, phone, email, url(website), account_ref, address, notes.
const supplierFields = (b: any) => [
  String(b.name || '').trim(),
  String(b.contact_name || '').trim() || null,
  String(b.phone || '').trim() || null,
  String(b.email || '').trim() || null,
  String(b.website || '').trim() || null,
  String(b.account_ref || '').trim() || null,
  String(b.address || '').trim() || null,
  String(b.notes || '').trim() || null,
];
router.post('/purchases/suppliers', async (req: Request, res: Response) => {
  const f = supplierFields(req.body);
  if (!f[0]) { res.redirect(SUPP_BACK + '&err=' + encodeURIComponent('Supplier name is required')); return; }
  await pool.query(
    'INSERT INTO suppliers (name, contact_name, phone, email, url, account_ref, address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', f);
  res.redirect(SUPP_BACK + '&msg=' + encodeURIComponent('Supplier added'));
});
router.post('/purchases/suppliers/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); if (!id) { res.redirect(SUPP_BACK); return; }
  const f = supplierFields(req.body);
  if (!f[0]) { res.redirect(SUPP_BACK + '&err=' + encodeURIComponent('Supplier name is required')); return; }
  await pool.query(
    'UPDATE suppliers SET name=$1, contact_name=$2, phone=$3, email=$4, url=$5, account_ref=$6, address=$7, notes=$8 WHERE id=$9', [...f, id]);
  res.redirect(SUPP_BACK + '&msg=' + encodeURIComponent('Supplier saved'));
});
router.post('/purchases/suppliers/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); if (id) await pool.query('UPDATE suppliers SET is_active=false WHERE id=$1', [id]);
  res.redirect(SUPP_BACK + '&msg=' + encodeURIComponent('Supplier removed'));
});

// Supplier detail — profile + multiple website logins (passwords via the vault).
router.get('/purchases/suppliers/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const s = (await pool.query('SELECT * FROM suppliers WHERE id=$1', [id]).catch(() => ({ rows: [] as any[] }))).rows[0];
  if (!s) { res.redirect(SUPP_BACK); return; }
  const logins = (await pool.query(
    "SELECT id, name, login_url, username, (secret_encrypted IS NOT NULL) AS has_secret FROM supplier_credentials WHERE supplier_id=$1 AND deleted_at IS NULL ORDER BY lower(name)", [id]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  res.render('purchases/supplier', { user: req.session.user!, s, logins, msg: req.query.msg || null, err: req.query.err || null });
});

// Save settings (bookkeeper, QB bank account, Open Banking keys).
router.post('/purchases/settings', async (req: Request, res: Response) => {
  const b = req.body;
  if (b.qb_bank_account_id !== undefined) await setSetting('purchases', 'qb_bank_account_id', String(b.qb_bank_account_id || ''));
  if (b.bookkeeper_email !== undefined) await setSetting('purchases', 'bookkeeper_email', String(b.bookkeeper_email || ''));
  if (b.bookkeeper_name !== undefined) await setSetting('purchases', 'bookkeeper_name', String(b.bookkeeper_name || ''));
  if (b.bookkeeper_cc !== undefined) await setSetting('purchases', 'bookkeeper_cc', String(b.bookkeeper_cc || ''));
  if (b.bookkeeper_bcc !== undefined) await setSetting('purchases', 'bookkeeper_bcc', String(b.bookkeeper_bcc || ''));
  // Provision read-only bookkeeper logins for EVERYONE on the report distribution list (To + CC +
  // BCC) so they can all open the online dashboard, and revoke any bookkeeper login removed from
  // the list. Never clobbers an existing staff/customer account with the same email.
  if (b.bookkeeper_email !== undefined || b.bookkeeper_cc !== undefined || b.bookkeeper_bcc !== undefined) {
    const listRaw = [b.bookkeeper_email, b.bookkeeper_cc, b.bookkeeper_bcc].map((x: any) => String(x || '')).join(',');
    const emails = Array.from(new Set(listRaw.split(/[,;\n]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'))));
    const nm = String(b.bookkeeper_name || 'Bookkeeper');
    for (const em of emails) {
      const ex = (await pool.query('SELECT id, role FROM users WHERE email=$1 LIMIT 1', [em]).catch(() => ({ rows: [] as any[] }))).rows[0];
      if (!ex) await pool.query("INSERT INTO users (email, display_name, role, is_active) VALUES ($1,$2,'bookkeeper',true)", [em, nm]).catch(() => {});
      else if (ex.role === 'bookkeeper') await pool.query('UPDATE users SET is_active=true WHERE id=$1', [ex.id]).catch(() => {});
    }
    // Revoke bookkeeper logins no longer on the list.
    if (emails.length) await pool.query("UPDATE users SET is_active=false WHERE role='bookkeeper' AND lower(email) <> ALL($1::text[])", [emails]).catch(() => {});
    else await pool.query("UPDATE users SET is_active=false WHERE role='bookkeeper'").catch(() => {});
  }
  if (b.ob_secret_id !== undefined) await setSetting('openbanking', 'secret_id', String(b.ob_secret_id || ''));
  if (b.ob_account_id !== undefined) await setSetting('openbanking', 'account_id', String(b.ob_account_id || ''));
  if (b.invoice_mailbox !== undefined) await setSetting('purchases', 'invoice_mailbox', String(b.invoice_mailbox || '').trim());
  if (b.extra_categories !== undefined) await setSetting('purchases', 'extra_categories', String(b.extra_categories || '').trim());
  if (b.back !== undefined) await setSetting('purchases', 'qb_push_enabled', b.qb_push_enabled === 'on' ? '1' : '0');
  await logActivity(req.session.user!.id, 'updated', 'invoices', 0, 'Purchases: settings updated');
  const back = String(b.back || '/purchases/settings');
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=' + encodeURIComponent('Settings saved'));
});

// Submit — push categorised expenses to QuickBooks (Purchase + receipt attachment).
router.post('/purchases/submit', async (req: Request, res: Response) => {
  // Push to QuickBooks is off by default for now — re-enable in Admin → Purchase Ledger.
  if ((await getSetting('purchases', 'qb_push_enabled')) !== '1') {
    const p = String(req.body.period || '').trim();
    res.redirect('/purchases/expenses?period=' + encodeURIComponent(p) + '&err=' + encodeURIComponent('Push to QuickBooks is turned off for now. Enable it in Admin → Purchase Ledger when ready.'));
    return;
  }
  let qb: QuickBooks;
  try { qb = await QuickBooks.load(); } catch { res.redirect('/purchases/expenses?err=' + encodeURIComponent('QuickBooks not available.')); return; }
  if (!qb.isConnected()) { res.redirect('/purchases/expenses?err=' + encodeURIComponent('Connect QuickBooks first (Settings → Integrations).')); return; }
  const period = String(req.body.period || '').trim();
  // Each transaction posts against its own account's mapped QB bank account.
  const rows = (await pool.query(
    `SELECT t.*, a.qb_account_id AS bank_qb_id FROM bank_transactions t
       LEFT JOIN bank_account_refs a ON a.id = t.account_ref_id
      WHERE t.status='categorised' AND t.qb_account_id IS NOT NULL AND t.qb_account_id NOT LIKE 'local:%' AND t.amount < 0` + (period ? " AND to_char(t.booked_at,'YYYY-MM')=$1" : ''),
    period ? [period] : []
  )).rows;
  // Report-only categories (Director Loans etc.) stay as 'categorised' — they show on the
  // report but never post to QuickBooks (no QB account exists for them).
  const localKept = Number((await pool.query(
    "SELECT COUNT(*)::int n FROM bank_transactions WHERE status='categorised' AND qb_account_id LIKE 'local:%' AND amount < 0" + (period ? " AND to_char(booked_at,'YYYY-MM')=$1" : ''),
    period ? [period] : []
  )).rows[0].n);
  let pushed = 0, failed = 0, attached = 0, noBank = 0;
  for (const t of rows) {
    if (!t.bank_qb_id) { noBank++; continue; } // account not mapped to a QB bank account yet
    try {
      const purchaseId = await qb.createPurchase({
        bankAccountId: t.bank_qb_id, expenseAccountId: t.qb_account_id, amount: Number(t.amount),
        date: new Date(t.booked_at).toISOString().slice(0, 10), description: t.description || '', payee: t.counterparty || '',
      });
      if (t.attachment_path) {
        try { const ct = /\.pdf$/i.test(t.attachment_name || '') ? 'application/pdf' : 'image/jpeg'; if (await qb.attachToPurchase(purchaseId, t.attachment_path, t.attachment_name || 'receipt', ct)) attached++; } catch { /* attach best-effort */ }
      }
      await pool.query("UPDATE bank_transactions SET status='pushed', qb_purchase_id=$1, updated_at=NOW() WHERE id=$2", [purchaseId, t.id]);
      pushed++;
    } catch (e) { console.error('[purchases] push failed for txn', t.id, (e as Error).message); failed++; }
  }
  await logActivity(req.session.user!.id, 'created', 'invoices', 0, `Purchases: pushed ${pushed} expense(s) to QB (${attached} with receipt, ${failed} failed)`);
  res.redirect('/purchases/expenses?period=' + encodeURIComponent(period) + '&msg=' + encodeURIComponent(`Pushed ${pushed} expense(s) to QuickBooks (${attached} with receipt)` + (failed ? `, ${failed} failed` : '') + (noBank ? `, ${noBank} skipped (account not mapped to a QB bank account)` : '') + (localKept ? `, ${localKept} report-only (Director Loan) kept off QB` : '')));
});

export default router;
