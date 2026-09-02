import { Router, Request, Response, NextFunction } from 'express';
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
import { hashFile, findByHash, assessAndStore, rescanAllDuplicates, backfillHashes } from '../lib/purchase-dupes';
import { attachDocToTxn } from '../lib/purchase-inbox';
import { aiReadUnreadable, aiReadInvoiceDoc } from '../lib/purchase-agent';
import { refreshAnomalies, listAnomalies, dismissAnomaly, sendAnomalyDigest } from '../lib/purchase-anomalies';
import { replyToAnomaly, notesFor, listRules, setRuleStatus } from '../lib/purchase-rules';
import { autoCategoriseOutstanding } from '../lib/purchase-match';
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
const BULK_MAX_FILES = 1000;
const BULK_MAX_BYTES = 25 * 1024 * 1024;

// Multer runs as middleware BEFORE the route handler, so anything it rejects — too many
// files, one file too big — never reaches the handler's try/catch and surfaces as a bare
// "Internal Server Error" with nothing to act on. (Seen live 2026-09-02 on a folder upload.)
// This wraps it so every failure comes back as a sentence saying what happened and what to
// do, and so the part-written temp files are cleaned up rather than left on disk.
function bulkUpload(req: Request, res: Response, next: NextFunction): void {
  docUpload.array('files', BULK_MAX_FILES)(req, res, (err: any) => {
    if (!err) { next(); return; }
    for (const f of ((req.files as any[]) || [])) { try { fs.unlinkSync(f.path); } catch { /* nothing to clean */ } }
    const code = err && err.code;
    const msg =
      code === 'LIMIT_FILE_COUNT'
        ? `That folder holds more than ${BULK_MAX_FILES} invoice files. Nothing was added. Upload it in parts — pick a subfolder at a time, or a year at a time.`
      : code === 'LIMIT_FILE_SIZE'
        ? `One of those files is bigger than ${Math.round(BULK_MAX_BYTES / 1024 / 1024)} MB, which is larger than any invoice should be. Nothing was added — take that file out and try again.`
      : code === 'LIMIT_UNEXPECTED_FILE'
        ? 'The browser sent a file the upload was not expecting. Nothing was added — reload the page and pick the folder again.'
      : `The upload failed before anything was read: ${String(err.message || code || 'unknown error')}. Nothing was added.`;
    console.error('[purchases] bulk upload rejected:', code || err);
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(msg));
  });
}
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(PURCHASE_DOCS_DIR, { recursive: true }); cb(null, PURCHASE_DOCS_DIR); },
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
  }),
  // Bulk folder uploads walk a whole tree, so the caps are per-BATCH, not per-invoice:
  // up to 1,000 files and 25 MB each (scanned invoices are big). The browser filters the
  // tree down to invoice-shaped files before anything is sent.
  limits: { fileSize: BULK_MAX_BYTES, files: BULK_MAX_FILES },
});
// Cached QB expense categories — QB is slow and was being hit on every page render.
let _catsCache: { at: number; cats: any[]; qbOn: boolean } | null = null;
const CATS_TTL = 5 * 60 * 1000;

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };

// Report-only categories that DON'T exist in QuickBooks (e.g. TOK / NOK Director Loan).
// Stored as "local:<name>" so they show in the dropdown + on the report but are skipped
// when pushing to QB. Configurable in settings; defaults to the two director loans.
const DEFAULT_EXTRA_CATEGORIES = 'TOK Director Loan\nNOK Director Loan\nWages';
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
  // The anomaly list is what Terry and Natalie work from, so it is on the screen they land
  // on rather than behind a tab. Read only — the nightly sweep does the computing.
  const anomalies = await listAnomalies('open');
  const [notes, rules] = await Promise.all([
    notesFor(anomalies.map((a: any) => a.id)),
    listRules(),
  ]);
  res.render('purchases/index', {
    user: req.session.user!, toDo, anomalies, notes, rules,
    open: req.query.open ? parseInt(String(req.query.open), 10) : null,
    notice: req.query.msg || null, error: req.query.err || null,
  });
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
    `SELECT d.*, t.counterparty AS txn_payee, t.amount AS txn_amount, t.matched_by, t.match_confidence, t.match_reason,
            a.ai_supplier, a.ai_gross, a.ai_summary, a.ai_concerns, a.ai_period,
            st.counterparty AS suggest_payee, st.amount AS suggest_amount, st.booked_at AS suggest_booked_at
       FROM purchase_documents d
       LEFT JOIN bank_transactions t  ON t.id  = d.bank_transaction_id
       LEFT JOIN bank_transactions st ON st.id = d.suggest_txn_id
       LEFT JOIN purchase_doc_ai a    ON a.document_id = d.id
      WHERE d.archived_at IS ${showArchived ? 'NOT NULL' : 'NULL'}
      ORDER BY d.suggest_txn_id IS NULL, d.status='attached', d.created_at DESC, d.id DESC`
  ).catch(() => ({ rows: [] }))).rows;
  const inboxCount = Number((await pool.query("SELECT COUNT(*)::int n FROM purchase_documents WHERE archived_at IS NULL AND status<>'attached'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  const archivedCount = Number((await pool.query("SELECT COUNT(*)::int n FROM purchase_documents WHERE archived_at IS NOT NULL").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  // Flagged possible duplicates — 'paid' (the earlier copy is already attached to a payment)
  // leads, because that is the one that costs money if it slips through.
  const dupeDocs = (await pool.query(
    `SELECT d.*, o.file_name AS dupe_of_name, o.rel_path AS dupe_of_rel, o.status AS dupe_of_status,
            t.counterparty AS paid_payee, t.amount AS paid_amount, t.booked_at AS paid_at
       FROM purchase_documents d
       LEFT JOIN purchase_documents o ON o.id = d.dupe_of_id
       LEFT JOIN bank_transactions t ON t.id = d.dupe_paid_txn_id
      WHERE d.dupe_status IN ('likely','paid')
      ORDER BY d.dupe_status='likely', d.created_at DESC, d.id DESC`
  ).catch(() => ({ rows: [] }))).rows;
  const dupeCount = dupeDocs.length;
  const view = ['inbox', 'reconciled', 'suppliers', 'duplicates'].includes(String(req.query.view)) ? String(req.query.view) : 'expenses';
  const qbPushEnabled = (await getSetting('purchases', 'qb_push_enabled')) === '1';
  // Supplier directory (address book of who we buy from) — name/address/phone etc.
  const suppliers = (await pool.query("SELECT * FROM suppliers WHERE is_active = true ORDER BY lower(name)").catch(() => ({ rows: [] }))).rows;
  res.render('purchases/expenses', {
    user: req.session.user!, txns, splitsByTxn, cats, qbOn, qbPushEnabled, period, months, closed, accounts,
    docs, inboxCount, archivedCount, showArchived, view, suppliers, invoiceMailbox: await getInvoiceMailbox(),
    dupeDocs, dupeCount, bulkMaxFiles: BULK_MAX_FILES,
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
    // If the receipt was captured with a category (mobile logger) and the txn isn't
    // categorised yet, carry the category across.
    if (d.category_id) {
      await pool.query("UPDATE bank_transactions SET qb_account_id=$1, qb_account_name=$2 WHERE id=$3 AND (qb_account_id IS NULL OR qb_account_id='')", [d.category_id, d.category_name, txnId]);
    }
    // One door for every match, so provenance is recorded and the supplier profile learns
    // from a human's decision exactly as it does from an automatic one. A person choosing
    // this link is the BEST training signal the agent gets.
    await attachDocToTxn(d, txnId, 'human', null, 'Attached by ' + (req.session.user!.displayName || 'a user'));
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

// Drop invoices into the pool by hand — one file, a multi-select, or a WHOLE FOLDER TREE
// (the browser's folder picker walks every subfolder and posts each file with its relative
// path). Every file is sha256'd on arrival:
//   • byte-identical to something already pooled  → SKIPPED, the temp file is removed;
//   • otherwise imported, parsed, then duplicate-assessed and flagged if it looks like an
//     invoice we already hold — flagged, never blocked, because a genuine repeat monthly
//     bill is indistinguishable from a duplicate without a human.
// The result is a summary, not a bare count: on a folder backload you need to know what
// was skipped and what needs a second look.
router.post('/purchases/inbox/upload', bulkUpload, async (req: Request, res: Response) => {
  const files = (req.files as any[]) || [];
  // The browser sends the tree position of each file alongside it, in the same order, so a
  // bulk-uploaded invoice still says which subfolder it came from.
  let relPaths: string[] = [];
  try { const raw = (req.body && req.body.rel_paths) || ''; if (raw) relPaths = JSON.parse(String(raw)); } catch { relPaths = []; }
  const batchId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  let added = 0, skipped = 0, flagged = 0, paidWarn = 0, failed = 0;
  const skippedNames: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const rel = (relPaths[i] && String(relPaths[i])) || null;
      // Chrome puts the relative path in the filename for folder uploads; keep just the leaf
      // for display and the full path for provenance.
      const displayName = String(f.originalname || 'invoice').split(/[\\/]/).pop() || 'invoice';
      const relDir = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;

      const hash = hashFile(f.path);
      if (hash) {
        const existing = await findByHash(hash);
        if (existing) {
          // Exact same bytes — nothing to review, just don't pool it twice. Bin the upload.
          try { fs.unlinkSync(f.path); } catch { /* leave it, harmless */ }
          skipped++;
          if (skippedNames.length < 5) skippedNames.push(displayName);
          continue;
        }
      }

      const ins = await pool.query(
        `INSERT INTO purchase_documents (source, from_name, subject, received_at, file_name, file_path, content_type, size_bytes, status, file_hash, rel_path, batch_id)
         VALUES ('upload',$1,$2,NOW(),$3,$4,$5,$6,'new',$7,$8,$9) RETURNING id`,
        [relDir ? 'Bulk upload — ' + relDir : 'Manual upload', displayName, displayName, f.path, f.mimetype || null, f.size || null, hash, relDir, batchId]
      );
      const docId = ins.rows[0].id;
      added++;
      // Parse first — the duplicate check needs the invoice number and total to say anything.
      try { await parseAndStoreDoc({ id: docId, file_path: f.path, content_type: f.mimetype || null, file_name: displayName }); } catch { /* parse best-effort */ }
      try {
        const v = await assessAndStore(docId);
        if (v.status === 'paid') paidWarn++; else if (v.status === 'likely') flagged++;
      } catch (e) { console.error('[purchases] dupe check failed for doc', docId, (e as Error).message); }
    } catch (e) {
      console.error('[purchases] bulk upload failed for', f && f.originalname, (e as Error).message);
      failed++;
    }
  }

  if (added) {
    await logActivity(req.session.user!.id, 'created', 'invoices', 0,
      `Purchase inbox: bulk upload added ${added} invoice(s), skipped ${skipped} exact duplicate(s), flagged ${flagged + paidWarn}`);
  }
  if (!added && !skipped && failed) {
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(
      `None of the ${failed} file(s) could be added. The server log has the reason — pm2 logs lumenmsp-portal.`));
    return;
  }
  const bits = [`Added ${added} invoice(s)`];
  if (skipped) bits.push(`skipped ${skipped} exact duplicate${skipped === 1 ? '' : 's'}${skippedNames.length ? ' (' + skippedNames.join(', ') + (skipped > skippedNames.length ? ', …' : '') + ')' : ''}`);
  if (paidWarn) bits.push(`${paidWarn} look ALREADY PAID`);
  if (flagged) bits.push(`${flagged} possible duplicate${flagged === 1 ? '' : 's'}`);
  if (failed) bits.push(`${failed} failed`);
  const tail = (flagged + paidWarn) ? ' — review them on the Duplicates tab.' : '.';
  res.redirect('/purchases/expenses?view=' + ((flagged + paidWarn) ? 'duplicates' : 'inbox') + '&msg=' + encodeURIComponent(bits.join(', ') + tail));
});

// Re-check the WHOLE pool for duplicates. The pool predates this check, so the first run is
// the one that finds what's already in there. Also backfills sha256 for older documents so
// the exact-duplicate skip works against everything received before today.
router.post('/purchases/inbox/rescan-dupes', async (req: Request, res: Response) => {
  try {
    const hashed = await backfillHashes();
    const r = await rescanAllDuplicates();
    await logActivity(req.session.user!.id, 'updated', 'invoices', 0,
      `Purchase inbox: duplicate rescan — ${r.scanned} checked, ${r.likely} possible, ${r.paid} already-paid`);
    const hashNote = hashed ? ` (fingerprinted ${hashed} older file(s))` : '';
    res.redirect('/purchases/expenses?view=duplicates&msg=' + encodeURIComponent(
      `Checked ${r.scanned} document(s)${hashNote}: ${r.paid} look already paid, ${r.likely} possible duplicate(s).`));
  } catch (e: any) {
    res.redirect('/purchases/expenses?view=duplicates&err=' + encodeURIComponent(e.message || 'Duplicate rescan failed.'));
  }
});

// Bulk actions on the Duplicates tab. A folder backload produces duplicates in batches, not
// one at a time, so clearing them one row at a time is the wrong shape of work.
//
// "separate bill" is sticky (a rescan never re-flags those), "archive" keeps the document but
// takes it out of the inbox, and "delete" removes the file and the row for good. Delete
// REFUSES anything already attached to a payment — that is the receipt for a real expense,
// and no bulk action should be able to take it away by accident.
router.post('/purchases/inbox/dupes/bulk', async (req: Request, res: Response) => {
  const b = req.body || {};
  const action = String(b.action || '');
  // Sent as one comma-separated field. The rows already contain their own forms, and a form
  // cannot legally nest inside another, so the selection is collected by script into a
  // standalone form rather than by wrapping the tables.
  const raw = Array.isArray(b.ids) ? b.ids.join(',') : String(b.ids || '');
  const ids = raw.split(',').map((v: string) => parseInt(v.trim(), 10)).filter(Boolean).slice(0, 2000);
  if (!ids.length) { res.redirect('/purchases/expenses?view=duplicates&err=' + encodeURIComponent('Nothing was selected.')); return; }

  let done = 0, refused = 0;
  if (action === 'separate') {
    const r = await pool.query("UPDATE purchase_documents SET dupe_status='dismissed', dupe_reason=NULL WHERE id = ANY($1)", [ids]);
    done = r.rowCount || 0;
  } else if (action === 'archive') {
    const r = await pool.query("UPDATE purchase_documents SET archived_at=NOW() WHERE id = ANY($1) AND archived_at IS NULL", [ids]);
    done = r.rowCount || 0;
  } else if (action === 'delete') {
    const rows = (await pool.query('SELECT id, file_path, status FROM purchase_documents WHERE id = ANY($1)', [ids])).rows;
    const deletable = rows.filter((d: any) => d.status !== 'attached');
    refused = rows.length - deletable.length;
    for (const d of deletable) {
      if (d.file_path) { try { fs.unlinkSync(d.file_path); } catch { /* already gone */ } }
    }
    if (deletable.length) {
      const r = await pool.query('DELETE FROM purchase_documents WHERE id = ANY($1)', [deletable.map((d: any) => d.id)]);
      done = r.rowCount || 0;
    }
  } else {
    res.redirect('/purchases/expenses?view=duplicates&err=' + encodeURIComponent('Unknown action.')); return;
  }

  await logActivity(req.session.user!.id, action === 'delete' ? 'deleted' : 'updated', 'invoices', 0,
    `Purchase duplicates: ${action} on ${done} document(s)${refused ? `, ${refused} refused (attached to a payment)` : ''}`);
  const word = action === 'delete' ? 'Deleted' : action === 'archive' ? 'Archived' : 'Marked as separate bills';
  res.redirect('/purchases/expenses?view=duplicates&msg=' + encodeURIComponent(
    `${word}: ${done} document(s)` +
    (refused ? `. ${refused} left alone because ${refused === 1 ? 'it is' : 'they are'} attached to a payment — unlink first if you really mean to remove ${refused === 1 ? 'it' : 'them'}.` : '.')));
});

// Accept a match Claude proposed but was not confident enough to apply. This is the
// training signal that matters most — a human agreeing goes into the supplier profile.
router.post('/purchases/doc/:id/accept-suggestion', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const d = id ? (await pool.query('SELECT * FROM purchase_documents WHERE id=$1', [id])).rows[0] : null;
  if (!d || !d.suggest_txn_id) { res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent('That suggestion is no longer available.')); return; }
  await attachDocToTxn(d, d.suggest_txn_id, 'human', d.suggest_confidence, 'Accepted Claude\'s suggestion: ' + (d.suggest_reason || ''));
  await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchases: accepted Claude's suggested match for "${d.file_name}"`);
  res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent('Match accepted — the supplier profile has learned from it.'));
});

// Reject a suggestion. The proposal is dropped; nothing is attached and nothing is learned.
router.post('/purchases/doc/:id/reject-suggestion', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query('UPDATE purchase_documents SET suggest_txn_id=NULL, suggest_confidence=NULL, suggest_reason=NULL WHERE id=$1', [id]);
  res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent('Suggestion dismissed.'));
});

// Have Claude LOOK at the invoices no text parser could read — scans, photos, and PDFs
// that carry their text as outlines. This is the OCR pass, and it runs once per document.
router.post('/purchases/inbox/ai-read', async (req: Request, res: Response) => {
  try {
    const r = await aiReadUnreadable(40);
    await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchases: Claude read ${r.read}/${r.considered} unreadable invoice(s)`);
    res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent(
      r.considered ? `Claude read ${r.read} of ${r.considered} invoice(s) that had no readable text${r.failed ? `; ${r.failed} could not be read` : ''}.`
                   : 'Nothing needed reading — every pooled invoice already has its figures.'));
  } catch (e: any) {
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(e.message || 'Claude could not read the invoices.'));
  }
});

// Read ONE document with Claude, on demand from the inbox card.
router.post('/purchases/doc/:id/ai-read', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const d = id ? (await pool.query('SELECT * FROM purchase_documents WHERE id=$1', [id])).rows[0] : null;
  if (!d) { res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent('Document not found.')); return; }
  try {
    const r = await aiReadInvoiceDoc(d);
    res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent(
      r ? `Read: ${r.supplier || 'supplier not stated'}, ${r.gross != null ? '£' + Number(r.gross).toFixed(2) : 'no total found'}${r.invoiceNo ? ', invoice ' + r.invoiceNo : ''}.`
        : 'Claude could not read that document.'));
  } catch (e: any) {
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(e.message || 'Read failed.'));
  }
});

// ── Anomalies ─────────────────────────────────────────────────────────────────────
router.post('/purchases/anomalies/refresh', async (req: Request, res: Response) => {
  try {
    const r = await refreshAnomalies();
    res.redirect('/purchases?msg=' + encodeURIComponent(
      `Checked the ledger: ${r.open} open item(s)${r.resolved ? `, ${r.resolved} no longer apply` : ''}${r.suppressed ? `, ${r.suppressed} held back by your rules` : ''}.`));
  } catch (e: any) {
    res.redirect('/purchases?err=' + encodeURIComponent(e.message || 'Anomaly check failed.'));
  }
});

router.post('/purchases/anomalies/:id/dismiss', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await dismissAnomaly(id, req.session.user!.id);
  res.redirect('/purchases?msg=' + encodeURIComponent('Dismissed — it will not come back.'));
});

// Answer a finding in your own words. Claude reads the answer against what it knows,
// replies, and where the answer is a standing instruction it PROPOSES a rule — which does
// nothing until a person accepts it.
router.post('/purchases/anomalies/:id/reply', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const text = String((req.body || {}).text || '').trim();
  if (!id || !text) { res.redirect('/purchases?err=' + encodeURIComponent('Write something first.')); return; }
  try {
    const r = await replyToAnomaly(id, text, req.session.user!.id, req.session.user!.displayName || 'A colleague');
    await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchase anomaly #${id}: replied${r.ruleId ? ' (rule proposed)' : ''}`);
    res.redirect('/purchases?open=' + id + '&msg=' + encodeURIComponent(
      r.ruleId ? 'Claude has replied and proposed a rule — accept it and it starts applying.' : 'Claude has replied.'));
  } catch (e: any) {
    res.redirect('/purchases?open=' + id + '&err=' + encodeURIComponent(e.message || 'Could not send that.'));
  }
});

// A proposed rule does nothing until this is clicked. Accepting a suppress rule is
// deliberately creating a blind spot, so it is a human's decision, never Claude's.
router.post('/purchases/rules/:id/:decision(accept|reject)', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const accept = req.params.decision === 'accept';
  if (id) {
    await setRuleStatus(id, accept ? 'active' : 'rejected');
    await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchase rule #${id} ${accept ? 'accepted' : 'rejected'}`);
  }
  res.redirect('/purchases?msg=' + encodeURIComponent(accept
    ? 'Rule accepted — it applies from the next check.'
    : 'Rule rejected — nothing changed.'));
});

// Switch a live rule back off. Its findings start appearing again on the next sweep.
router.post('/purchases/rules/:id/off', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await setRuleStatus(id, 'rejected');
  res.redirect('/purchases?msg=' + encodeURIComponent('Rule switched off — anything it was hiding will come back on the next check.'));
});

// Send the Monday digest now (the cron sends it at 07:30 on a Monday).
router.post('/purchases/anomalies/digest', async (req: Request, res: Response) => {
  try {
    const r = await sendAnomalyDigest();
    res.redirect('/purchases?msg=' + encodeURIComponent(
      r.sent ? `Digest sent to ${r.to} (${r.count} item(s)).`
             : r.count ? 'Nothing was sent — no recipient is set, or Microsoft Graph is not configured.'
                       : 'Nothing to send — the list is empty.'));
  } catch (e: any) {
    res.redirect('/purchases?err=' + encodeURIComponent(e.message || 'Digest failed.'));
  }
});

// "This is a separate bill" — clears the flag for good. Sticky: a rescan never re-flags it.
router.post('/purchases/doc/:id/dupe-dismiss', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query("UPDATE purchase_documents SET dupe_status='dismissed', dupe_reason=NULL WHERE id=$1", [id]);
  res.redirect('/purchases/expenses?view=duplicates&msg=' + encodeURIComponent('Marked as a separate bill — it will not be flagged again.'));
});

// Try to auto-match pooled invoices to bank transactions (amount + supplier + date).
router.post('/purchases/inbox/automatch', async (_req: Request, res: Response) => {
  try {
    const r = await autoMatchInvoices();
    const bits = [`linked ${r.matched} invoice(s)`];
    if (r.byClaude) bits.push(`${r.byClaude} of them judged by Claude`);
    if (r.aiRead) bits.push(`${r.aiRead} scanned invoice(s) read`);
    if (r.suggested) bits.push(`${r.suggested} suggestion(s) waiting for you`);
    res.redirect('/purchases/expenses?view=inbox&msg=' + encodeURIComponent('Auto-match: ' + bits.join(', ') + '.'));
  } catch (e: any) {
    res.redirect('/purchases/expenses?view=inbox&err=' + encodeURIComponent(e.message || 'Auto-match failed.'));
  }
});

// Auto-categorise all outstanding transactions from how each payee was coded before
// (this ledger's own history first, then QuickBooks' historic Purchases). Fills the
// category but never locks the row — every suggestion still gets a human pass.
router.post('/purchases/autocategorise', async (req: Request, res: Response) => {
  try {
    const r = await autoCategoriseOutstanding();
    await logActivity(req.session.user!.id, 'updated', 'invoices', 0, `Purchases: auto-categorised ${r.applied}/${r.considered} outstanding (${r.fromLedger} from ledger history, ${r.fromQb} from QuickBooks)`);
    res.redirect('/purchases/expenses?msg=' + encodeURIComponent(
      `Auto-categorise: filled ${r.applied} of ${r.considered} outstanding` +
      (r.fromQb ? ` (${r.fromLedger} from ledger history, ${r.fromQb} from QuickBooks history)` : '') +
      (r.noHistory ? `; ${r.noHistory} payee(s) have no history yet — categorise once and they'll follow next time.` : '.')));
  } catch (e: any) {
    res.redirect('/purchases/expenses?err=' + encodeURIComponent(e.message || 'Auto-categorise failed.'));
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
    await pool.query('UPDATE bank_transactions SET attachment_path=NULL, attachment_name=NULL, matched_by=NULL, match_confidence=NULL, match_reason=NULL, matched_at=NULL, updated_at=NOW() WHERE id=$1', [id]);
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
