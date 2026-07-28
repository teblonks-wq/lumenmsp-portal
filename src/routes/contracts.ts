import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { buildContractDoc } from '../lib/contract-doc';
import { SUPPLIER } from '../lib/contract-template';
import { htmlToPdf } from '../lib/pdf';
import { buildContractFromRateCard, pushContractToTemplate } from '../lib/contract-billing';
import { dueRenewals } from '../lib/contract-renewals';
import { clientIp, documentFooterHtml, PDF_OPTS, renderContractHtml, snapshotContract, typedSignatureSvg } from '../lib/contract-sign';
import { coverFromLines, SUPPLIER as SUP } from '../lib/contract-template';
import { config } from '../config';
import { sendMail } from '../lib/mailer';
import { contractEmailHtml, contractSignedEmailHtml } from '../lib/emails';
import {
  clientIp as evIp, getDocEvents, logDocEvent, newPixelToken, pixelImg, userAgent as evUa,
} from '../lib/doc-events';

const router = Router();
const STATUSES = ['draft', 'active', 'expired', 'cancelled'];
const SERVICE_TYPES = ['IT', 'Cloud', 'Comms', 'Hardware'];
const PAY_METHODS = ['upfront', 'delivery', 'direct_debit'];
const FREQS = ['monthly', 'annual', 'one_off'];
const SECTIONS = ['IT', 'Cloud', 'Backup', 'Comms', 'Hardware'];
const COVERS = ['business', 'extended', 'always'];
const intOr = (v: any, d: number): number => { const x = parseInt(String(v ?? ''), 10); return isNaN(x) ? d : x; };

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const num = (v: any): number => { const x = parseFloat((v ?? '').toString()); return isNaN(x) ? 0 : x; };
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

async function nextContractNumber(): Promise<string> {
  const { rows } = await pool.query('SELECT contract_number FROM contracts');
  let max = 0;
  for (const r of rows) { const m = String(r.contract_number).match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return 'CON-' + String(max + 1).padStart(4, '0');
}

async function saveLines(client: any, contractId: number, body: any): Promise<void> {
  const desc = asArray(body['desc']);
  const qty = asArray(body['qty']);
  const price = asArray(body['price']);
  const freq = asArray(body['freq']);
  const prodId = asArray(body['product_id']);
  const sect = asArray(body['section']);
  const det = asArray(body['detail']);
  const tStart = asArray(body['line_term_start']);
  const tEnd = asArray(body['line_term_end']);
  const tNotice = asArray(body['line_notice']);

  // The support product on the contract decides the cover level, so the hours printed in the
  // document always match what the customer is billed for. Null when no line names a cover
  // tier, leaving any existing choice alone rather than resetting it to the default.
  const derivedCover = coverFromLines(desc.map((d: any) => String(d || '')));
  if (derivedCover) {
    await client.query('UPDATE contracts SET support_cover=$1 WHERE id=$2', [derivedCover, contractId]);
  }

  await client.query('DELETE FROM contract_lines WHERE contract_id = $1', [contractId]);
  let sort = 1;
  for (let i = 0; i < desc.length; i++) {
    const d = (desc[i] || '').toString().trim();
    if (!d) continue;
    const q = num(qty[i]) || 1, p = num(price[i]);
    const f = FREQS.includes(freq[i]) ? freq[i] : 'monthly';
    const pid = prodId[i] ? (parseInt(prodId[i], 10) || null) : null;
    const sec = SECTIONS.includes(sect[i]) ? sect[i] : 'IT';
    // A licence or backup block carries its own annual term, which need not line up with the
    // contract term (Staybrook: contract 01/08, licences 01/07).
    const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim());
    const ln = parseInt(String(tNotice[i] ?? ''), 10);
    await client.query(
      `INSERT INTO contract_lines (contract_id, product_id, description, quantity, unit_price, billing_frequency,
                                   section, detail, term_start, term_end, notice_days, line_total, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [contractId, pid, d, q, p, f, sec, nz(det[i]),
       isDate(tStart[i]) ? tStart[i] : null, isDate(tEnd[i]) ? tEnd[i] : null,
       isNaN(ln) ? null : ln, q * p, sort++]
    );
  }
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/contracts', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const status = ((req.query.status as string) || '').trim();
  const search = ((req.query.search as string) || '').trim();
  const where: string[] = ['ct.deleted_at IS NULL'];
  const params: any[] = [];
  if (status && STATUSES.includes(status)) { params.push(status); where.push('ct.status = $' + params.length); }
  if (search) { params.push('%' + search + '%'); where.push(`(ct.contract_number ILIKE $${params.length} OR ct.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }
  const { rows } = await pool.query(
    `SELECT ct.id, ct.contract_number, ct.title, ct.status, ct.service_type, ct.start_date, ct.end_date,
            ct.sign_status, c.name AS customer_name, c.id AS customer_id,
            (SELECT COALESCE(SUM(line_total),0) FROM contract_lines cl WHERE cl.contract_id=ct.id AND cl.billing_frequency='monthly') AS monthly_total
     FROM contracts ct LEFT JOIN customers c ON c.id = ct.customer_id
     WHERE ${where.join(' AND ')} ORDER BY ct.id DESC`, params
  );
  const stat = await pool.query(`SELECT status, COUNT(*)::int n FROM contracts WHERE deleted_at IS NULL GROUP BY status`);
  const statusCounts: Record<string, number> = {};
  stat.rows.forEach((r: any) => { statusCounts[r.status] = r.n; });

  // Renewals: anchored on the NOTICE deadline (end date minus notice days), not the end
  // date — the notice date is the one that costs money to miss.
  const renewals = await dueRenewals(90);
  if (status === 'renewals') {
    res.render('contracts/list', { user, contracts: [], status, search, statusCounts, renewals, renewalCount: renewals.length });
    return;
  }
  res.render('contracts/list', { user, contracts: rows, status, search, statusCounts, renewals: [], renewalCount: renewals.length });
});

// ── New ──────────────────────────────────────────────────────────────────────────
router.get('/contracts/new', requireAuth, async (req: Request, res: Response) => {
  const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
  const preselectCustomer = req.query.customer ? parseInt(String(req.query.customer), 10) : null;
  res.render('contracts/form', { user: req.session.user!, contract: null, lines: [], customers: customers.rows,
    preselectCustomer, error: null, msg: null });
});

// ── Create ──────────────────────────────────────────────────────────────────────
router.post('/contracts', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  const title = (b.title || '').trim();
  if (!title) {
    const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
    res.render('contracts/form', { user, contract: b, lines: [], customers: customers.rows, preselectCustomer: null, error: 'Title is required.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cn = await nextContractNumber();
    const { rows } = await client.query(
      `INSERT INTO contracts (customer_id, contract_number, title, status, service_type, start_date, end_date, term_months, notice_days, auto_renew, renewal_mode, payment_method, notes, created_by, support_cover)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, cn, title,
        STATUSES.includes(b.status) ? b.status : 'draft',
        SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'IT',
        nz(b.start_date),
        // End date follows from start + term unless one is typed in explicitly.
        nz(b.end_date) || (nz(b.start_date) ? addMonths(String(b.start_date), intOr(b.term_months, 12)) : null),
        intOr(b.term_months, 12), parseInt(b.notice_days, 10) || 30,
        b.auto_renew === 'on' || b.auto_renew === '1',
        b.renewal_mode === 'signed_extension' ? 'signed_extension' : 'auto',
        PAY_METHODS.includes(b.payment_method) ? b.payment_method : 'upfront',
        nz(b.notes), user.id,
        COVERS.includes(b.support_cover) ? b.support_cover : 'business',
      ]
    );
    await saveLines(client, rows[0].id, b);
    await client.query('COMMIT');
    res.redirect('/contracts/' + rows[0].id);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ── Detail ────────────────────────────────────────────────────────────────────
router.get('/contracts/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const r = await pool.query(
    `SELECT ct.*, c.name AS customer_name FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
     WHERE ct.id=$1 AND ct.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const lines = await pool.query('SELECT * FROM contract_lines WHERE contract_id=$1 ORDER BY sort_order, id', [id]);
  // Optional same-site return path (e.g. the customer screen's Contracts tab).
  const backQ = String(req.query.back || '');
  res.render('contracts/detail', {
    user, contract: r.rows[0], lines: lines.rows, appUrl: config.APP_URL,
    back: /^\/(?!\/)/.test(backQ) ? backQ : null,
    msg: req.query.msg ? String(req.query.msg) : null,
    err: req.query.err ? String(req.query.err) : null,
    events: await getDocEvents('contract', id),
  });
});

// ── Edit ──────────────────────────────────────────────────────────────────────
router.get('/contracts/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM contracts WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const [lines, customers] = await Promise.all([
    pool.query('SELECT * FROM contract_lines WHERE contract_id=$1 ORDER BY sort_order, id', [id]),
    pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`),
  ]);
  res.render('contracts/form', { user: req.session.user!, contract: r.rows[0], lines: lines.rows,
    customers: customers.rows, preselectCustomer: null,
    error: req.query.err ? String(req.query.err) : null,
    msg: req.query.msg ? String(req.query.msg) : null });
});

// ── Update ──────────────────────────────────────────────────────────────────────
router.post('/contracts/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE contracts SET customer_id=$1, title=$2, status=$3, service_type=$4, start_date=$5, end_date=$6,
         notice_days=$7, auto_renew=$8, payment_method=$9, notes=$10,
         term_months=$12, renewal_mode=$13, support_cover=$14, updated_at=NOW()
       WHERE id=$11 AND deleted_at IS NULL`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, (b.title || '').trim(),
        STATUSES.includes(b.status) ? b.status : 'draft',
        SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'IT',
        nz(b.start_date),
        nz(b.end_date) || (nz(b.start_date) ? addMonths(String(b.start_date), intOr(b.term_months, 12)) : null),
        parseInt(b.notice_days, 10) || 30,
        b.auto_renew === 'on' || b.auto_renew === '1', PAY_METHODS.includes(b.payment_method) ? b.payment_method : 'upfront',
        nz(b.notes), id,
        intOr(b.term_months, 12), b.renewal_mode === 'signed_extension' ? 'signed_extension' : 'auto',
        COVERS.includes(b.support_cover) ? b.support_cover : 'business',
      ]
    );
    await saveLines(client, id, b);
    await client.query('COMMIT');
    res.redirect('/contracts/' + id);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

router.post('/contracts/:id/status', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const status = String(req.body.status || '');
  if (STATUSES.includes(status)) await pool.query('UPDATE contracts SET status=$1 WHERE id=$2', [status, id]);
  res.redirect('/contracts/' + id);
});

router.post('/contracts/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE contracts SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id=$2', [user.id, id]);
  await logActivity(user.id, 'deleted', 'contracts', id, 'Deleted contract #' + id);
  res.redirect('/contracts');
});

// ── Draft a contract from the customer's rate card ─────────────────────────────
// The fast path onto contracts for existing customers: their rate card already holds the
// agreed services and prices, so it is pulled in wholesale rather than retyped. Lands as a
// DRAFT so nothing reaches a customer without being looked at.
router.post('/contracts/from-rate-card', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const customerId = parseInt(String(req.body.customer_id), 10);
  const back = String(req.body.back || '') || '/contracts';
  if (!customerId) { res.redirect(back + '?err=' + encodeURIComponent('Choose a customer first.')); return; }
  try {
    const r = await buildContractFromRateCard(customerId, user.id, nextContractNumber);
    if (!r.contractId) {
      res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent(r.reason || 'Could not build a contract.'));
      return;
    }
    await logActivity(user.id, 'created', 'contracts', r.contractId,
      'Drafted contract from the rate card (' + r.lines + ' lines)');
    res.redirect('/contracts/' + r.contractId + '/edit?msg=' +
      encodeURIComponent(r.lines + ' service(s) pulled in — £' + r.monthly.toFixed(2) +
        '/month. Check the sections, quantities and term, then save.'));
  } catch (e) {
    console.error('[contract-from-rate-card] failed:', e);
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent('Could not build the contract from the rate card.'));
  }
});

// ── Push contract lines back onto the customer's rate card ────────────────────
// Services are entered once, on the contract, and flow to billing from there. Deliberately an
// explicit action rather than a side effect of saving: this writes to a live recurring invoice
// template, so it should happen when someone means it, not on every draft edit.
router.post('/contracts/:id/push-billing', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = await pushContractToTemplate(id);
    if (r.reason) { res.redirect('/contracts/' + id + '?err=' + encodeURIComponent(r.reason)); return; }
    const bits = [] as string[];
    if (r.added) bits.push(r.added + ' added');
    if (r.updated) bits.push(r.updated + ' updated');
    if (r.removed) bits.push(r.removed + ' removed');
    await logActivity(user.id, 'updated', 'contracts', id, 'Pushed contract lines to billing template');
    res.redirect('/contracts/' + id + '?msg=' + encodeURIComponent(
      bits.length ? 'Billing template updated — ' + bits.join(', ') + '.' : 'Billing template already up to date.'));
  } catch (e) {
    console.error('[contract-billing] push failed:', e);
    res.redirect('/contracts/' + id + '?err=' + encodeURIComponent('Could not update the billing template.'));
  }
});

// End date = start + N months, less a day (a 12-month term from 01/08/2025 ends 31/07/2026).
function addMonths(startIso: string, months: number): string {
  const d = new Date(startIso + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp for short months
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const iso = (v: any): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

// Every contract needs a term 1 before it can be extended; older contracts pre-date the
// terms table, so it is backfilled from the contract's own dates on first use.
async function ensureFirstTerm(client: any, contractId: number): Promise<void> {
  const n = (await client.query('SELECT COUNT(*)::int n FROM contract_terms WHERE contract_id=$1', [contractId])).rows[0].n;
  if (n > 0) return;
  const c = (await client.query('SELECT start_date, end_date, term_months FROM contracts WHERE id=$1', [contractId])).rows[0];
  if (!c || !c.start_date) return;
  const start = new Date(c.start_date).toISOString().slice(0, 10);
  const months = c.term_months || 12;
  const end = c.end_date ? new Date(c.end_date).toISOString().slice(0, 10) : addMonths(start, months);
  await client.query(
    `INSERT INTO contract_terms (contract_id, seq, start_date, end_date, months, source, notes)
     VALUES ($1,1,$2,$3,$4,'original','Backfilled from the contract record')`,
    [contractId, start, end, months]);
}

// ── Override the dates before it goes out ──────────────────────────────────────
router.post('/contracts/:id/dates', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const back = String(req.body.back || '') === 'send' ? '/contracts/' + id + '/send' : '/contracts/' + id;
  const c = (await pool.query('SELECT sign_status FROM contracts WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!c) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  if (c.sign_status === 'signed' || c.sign_status === 'countersigned') {
    res.redirect(back + '?err=' + encodeURIComponent('This agreement is already signed — its dates cannot be changed.'));
    return;
  }
  const start = iso(req.body.start_date);
  const months = parseInt(String(req.body.term_months || ''), 10);
  if (!start) { res.redirect(back + '?err=' + encodeURIComponent('Enter a valid start date.')); return; }
  const m = isNaN(months) || months < 1 ? 12 : months;
  // An explicit end date wins; otherwise it follows from start + term.
  const end = iso(req.body.end_date) || addMonths(start, m);
  const notice = parseInt(String(req.body.notice_days || ''), 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE contracts SET start_date=$1, end_date=$2, term_months=$3,
         notice_days=COALESCE($4, notice_days) WHERE id=$5`,
      [start, end, m, isNaN(notice) ? null : notice, id]);
    // Keep term 1 in step so the document and the term history do not disagree.
    await client.query(
      `UPDATE contract_terms SET start_date=$1, end_date=$2, months=$3
        WHERE contract_id=$4 AND seq=1`, [start, end, m, id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity(user.id, 'updated', 'contracts', id, 'Changed contract dates');
  res.redirect(back + '?msg=' + encodeURIComponent('Dates updated — the preview below reflects them.'));
});

// ── Extend the term ────────────────────────────────────────────────────────────
router.get('/contracts/:id/extend', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT ct.*, c.name AS customer_name FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
      WHERE ct.id=$1 AND ct.deleted_at IS NULL LIMIT 1`, [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const contract = r.rows[0];
  const terms = (await pool.query('SELECT * FROM contract_terms WHERE contract_id=$1 ORDER BY seq', [id])).rows;
  const currentEnd = contract.end_date ? new Date(contract.end_date).toISOString().slice(0, 10) : null;
  const suggestedStart = currentEnd
    ? new Date(new Date(currentEnd + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  res.render('contracts/extend', {
    user, contract, terms, suggestedStart,
    defaultMonths: contract.term_months || 12,
    err: req.query.err ? String(req.query.err) : null,
  });
});

router.post('/contracts/:id/extend', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const raw = String(req.body.months || '');
  const months = parseInt(raw === 'custom' ? String(req.body.custom_months || '') : raw, 10);
  if (isNaN(months) || months < 1 || months > 120) {
    res.redirect('/contracts/' + id + '/extend?err=' + encodeURIComponent('Choose an extension length between 1 and 120 months.'));
    return;
  }
  const start = iso(req.body.start_date);
  if (!start) { res.redirect('/contracts/' + id + '/extend?err=' + encodeURIComponent('Enter a valid start date for the extension.')); return; }
  const end = iso(req.body.end_date) || addMonths(start, months);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureFirstTerm(client, id);
    const seq = (((await client.query('SELECT COALESCE(MAX(seq),0) s FROM contract_terms WHERE contract_id=$1', [id])).rows[0].s) || 0) + 1;
    await client.query(
      `INSERT INTO contract_terms (contract_id, seq, start_date, end_date, months, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, seq, start, end, months,
       String(req.body.source) === 'auto_renew' ? 'auto_renew' : 'signed_extension', nz(req.body.notes)]);

    // The extension is a fresh document with its own signature cycle: clear the previous
    // signatures and mint a new link on send, so an old link cannot sign the new term.
    const autoOnly = String(req.body.source) === 'auto_renew';
    await client.query(
      `UPDATE contracts SET end_date=$1, current_doc_kind='extension',
         sign_status = CASE WHEN $2::boolean THEN sign_status ELSE 'unsigned' END,
         sign_token  = CASE WHEN $2::boolean THEN sign_token  ELSE NULL END,
         sent_to     = CASE WHEN $2::boolean THEN sent_to     ELSE NULL END,
         sent_at     = CASE WHEN $2::boolean THEN sent_at     ELSE NULL END,
         view_count  = CASE WHEN $2::boolean THEN view_count  ELSE 0 END,
         client_sign_name=NULL, client_sign_position=NULL, client_sign_email=NULL,
         client_signed_at=NULL, client_sign_ip=NULL, client_sign_user_agent=NULL, client_signature_svg=NULL,
         supplier_sign_name=NULL, supplier_sign_position=NULL, supplier_signed_at=NULL, supplier_signature_svg=NULL
       WHERE id=$3`, [end, autoOnly, id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await logActivity(user.id, 'updated', 'contracts', id, 'Extended contract by ' + months + ' months');
  if (String(req.body.source) === 'auto_renew') {
    res.redirect('/contracts/' + id + '?msg=' + encodeURIComponent('Term recorded as auto-renewed for ' + months + ' months. No signature required.'));
  } else {
    res.redirect('/contracts/' + id + '/send?msg=' + encodeURIComponent('Extension of ' + months + ' months prepared — review it below, then send for signature.'));
  }
});

// ── Review & send for signature ────────────────────────────────────────────────
// The preview is the point of this screen: nothing goes out until someone has looked at the
// PDF the customer will actually be asked to sign.
router.get('/contracts/:id/send', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT ct.*, c.name AS customer_name FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
      WHERE ct.id=$1 AND ct.deleted_at IS NULL LIMIT 1`, [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const contract = r.rows[0];
  const contacts = contract.customer_id ? (await pool.query(
    `SELECT full_name, job_title, email FROM customer_contacts
      WHERE customer_id=$1 AND archived=false AND (is_service_contact=true OR is_primary=true) AND email IS NOT NULL
      ORDER BY is_service_contact DESC, is_primary DESC, full_name`, [contract.customer_id])).rows : [];
  const ctx = await buildContractDoc(id);
  res.render('contracts/send', {
    user, contract, contacts, appUrl: config.APP_URL,
    reviewFlags: ctx ? ctx.reviewFlags : [],
    docKind: ctx ? ctx.docKind : 'agreement',
    err: req.query.err ? String(req.query.err) : null,
    msg: req.query.msg ? String(req.query.msg) : null,
  });
});

router.post('/contracts/:id/send', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const sendTo = nz(req.body.send_to);
  if (!sendTo) { res.redirect('/contracts/' + id + '/send?err=' + encodeURIComponent('Enter an email address.')); return; }
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `UPDATE contracts SET sign_status = CASE WHEN sign_status IN ('signed','countersigned') THEN sign_status ELSE 'sent' END,
       sign_token = COALESCE(sign_token, $1), sent_to = $2, sent_at = NOW() WHERE id = $3`,
    [token, sendTo, id]);

  const c = (await pool.query(
    `SELECT ct.contract_number, ct.title, ct.sign_token, ct.customer_id, ct.start_date, ct.end_date,
            ct.term_months, ct.current_doc_kind, c.name AS customer_name
       FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id WHERE ct.id=$1`, [id])).rows[0];
  const link = config.APP_URL + '/c/' + c.sign_token;
  const isExt = c.current_doc_kind === 'extension';

  // Personalise from the contact record when the address is one we know.
  let contactName = '';
  if (c.customer_id) {
    contactName = (await pool.query(
      'SELECT full_name FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1',
      [c.customer_id, sendTo])).rows[0]?.full_name || '';
  }
  const ctx = await buildContractDoc(id);
  const gb = (d: any) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const money = (n: number) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // One token per send, so an open ties back to this specific email rather than the
  // document in general (and a resend does not inherit the previous send's opens).
  const pixelToken = newPixelToken();
  const sentEventId = await logDocEvent('contract', id, 'sent', {
    customerId: c.customer_id, actor: sendTo, pixelToken,
    meta: { recipient: sendTo, kind: isExt ? 'extension' : 'agreement', by: user.displayName },
  });

  try {
    await sendMail({
      to: sendTo,
      subject: `${c.contract_number} — your ${isExt ? 'service agreement extension' : 'service agreement'} for signature`,
      html: (sentEventId ? pixelImg(config.APP_URL, pixelToken) : '') + contractEmailHtml({
        contactName, contractNumber: c.contract_number, title: c.title, isExtension: isExt,
        startDate: gb(isExt && ctx?.extension ? ctx.extension.startDate : c.start_date),
        endDate: gb(isExt && ctx?.extension ? ctx.extension.endDate : c.end_date),
        termMonths: isExt && ctx?.extension ? ctx.extension.months : (c.term_months || undefined),
        monthly: ctx ? money(ctx.totals.monthly) : undefined,
        message: String(req.body.message || '').trim(),
        link, portalUrl: config.APP_URL + '/my',
      }),
      signatureName: user.displayName,
    });
  } catch (e) {
    console.error('[contract-send] mail failed:', e);
    res.redirect('/contracts/' + id + '?err=' + encodeURIComponent('Link created, but the email could not be sent. Copy the signing link from the send screen.'));
    return;
  }
  await logActivity(user.id, 'updated', 'contracts', id, 'Sent contract for signature to ' + sendTo);
  res.redirect('/contracts/' + id + '?msg=' + encodeURIComponent('Sent to ' + sendTo + ' for signature.'));
});

// ── Counter-signature (Lumen side) ─────────────────────────────────────────────
router.post('/contracts/:id/countersign', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const c = (await pool.query('SELECT sign_status FROM contracts WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!c) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  if (c.sign_status !== 'signed') {
    res.redirect('/contracts/' + id + '?err=' + encodeURIComponent('The customer has not signed this yet.'));
    return;
  }
  await pool.query(
    `UPDATE contracts SET sign_status='countersigned', status='active',
       supplier_sign_name=$1, supplier_sign_position=$2, supplier_signed_at=NOW(),
       supplier_signature_svg=$3 WHERE id=$4`,
    [nz(req.body.name) || SUP.serviceContact.split('—')[0].trim(), nz(req.body.position) || 'Managing Director',
     typedSignatureSvg(nz(req.body.name) || SUP.serviceContact.split('—')[0].trim()), id]);
  await logDocEvent('contract', id, 'countersigned', {
    actor: nz(req.body.name) || user.displayName, ip: evIp(req), userAgent: evUa(req),
  });
  try { await snapshotContract(id, 'agreement', 'Counter-signed by ' + (nz(req.body.name) || 'Lumen'), user.id); }
  catch (e) { console.error('[contract-sign] countersign snapshot failed:', e); }
  await logActivity(user.id, 'updated', 'contracts', id, 'Counter-signed contract #' + id);
  res.redirect('/contracts/' + id + '?msg=' + encodeURIComponent('Counter-signed. The agreement is now active.'));
});

// ── PUBLIC signing page (no login — the link IS the credential) ────────────────
async function loadByToken(token: string) {
  const r = await pool.query(
    `SELECT ct.*, c.name AS customer_name FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
      WHERE ct.sign_token=$1 AND ct.deleted_at IS NULL LIMIT 1`, [token]);
  return r.rows[0] || null;
}

router.get('/c/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const contract = await loadByToken(token);
  if (!contract) { res.status(404).render('error', { message: 'This signing link is not valid. It may have been withdrawn — please contact us.' }); return; }
  await pool.query(
    `UPDATE contracts SET view_count = view_count + 1,
       sign_status = CASE WHEN sign_status='sent' THEN 'viewed' ELSE sign_status END WHERE sign_token=$1`, [token]);
  // Served by us, so this is evidence rather than an inference.
  await logDocEvent('contract', contract.id, 'opened', {
    customerId: contract.customer_id, actor: contract.sent_to,
    ip: evIp(req), userAgent: evUa(req), meta: { version: contract.version },
  });
  const prefillRow = contract.customer_id ? (await pool.query(
    `SELECT full_name, job_title, email FROM customer_contacts
      WHERE customer_id=$1 AND archived=false AND lower(email)=lower($2) LIMIT 1`,
    [contract.customer_id, contract.sent_to || ''])).rows[0] : null;
  res.render('contracts/public-sign', {
    contract, token, supplier: SUP, appUrl: config.APP_URL,
    customerName: contract.customer_name, signed: !!contract.client_signed_at,
    error: req.query.err ? String(req.query.err) : null,
    prefill: { name: prefillRow?.full_name || '', position: prefillRow?.job_title || '', email: contract.sent_to || '' },
  });
});

// Token-gated PDF. Serves the frozen signed copy once one exists, so what the customer
// downloads after signing is byte-identical to what they signed.
router.get('/c/:token/document.pdf', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const contract = await loadByToken(token);
  if (!contract) { res.status(404).render('error', { message: 'This link is not valid.' }); return; }
  const frozen = (await pool.query(
    'SELECT file_path FROM contract_documents WHERE contract_id=$1 ORDER BY version DESC LIMIT 1', [contract.id])).rows[0];
  if (req.query.dl) {
    await logDocEvent('contract', contract.id, 'downloaded', {
      customerId: contract.customer_id, actor: contract.sent_to,
      ip: evIp(req), userAgent: evUa(req), meta: { version: contract.version },
    });
  }
  const send = (buf: Buffer) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + `; filename="${contract.contract_number}.pdf"`);
    res.send(buf);
  };
  if (frozen && fs.existsSync(frozen.file_path)) { send(fs.readFileSync(frozen.file_path)); return; }
  const ctx = await buildContractDoc(contract.id);
  if (!ctx) { res.status(404).render('error', { message: 'Agreement not found.' }); return; }
  try {
    const html = await renderContractHtml(ctx, { watermark: !contract.client_signed_at });
    send(await htmlToPdf(html, { ...PDF_OPTS, footerHtml: documentFooterHtml() }));
  } catch (e) {
    console.error('[contract-public] pdf failed:', e);
    res.status(500).render('error', { message: 'The agreement could not be produced. Please contact us.' });
  }
});

router.post('/c/:token/sign', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const contract = await loadByToken(token);
  if (!contract) { res.status(404).render('error', { message: 'This link is not valid.' }); return; }
  if (contract.client_signed_at) { res.redirect('/c/' + token); return; }
  const name = nz(req.body.name), position = nz(req.body.position), email = nz(req.body.email);
  if (!name || !position || !email || !req.body.agree) {
    res.redirect('/c/' + token + '?err=' + encodeURIComponent('Please complete every field and confirm you agree.'));
    return;
  }
  await pool.query(
    `UPDATE contracts SET sign_status='signed', client_sign_name=$1, client_sign_position=$2,
       client_sign_email=$3, client_signed_at=NOW(), client_sign_ip=$4, client_sign_user_agent=$5,
       client_signature_svg=$6 WHERE sign_token=$7`,
    [name, position, email, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 400),
     typedSignatureSvg(name), token]);

  await logDocEvent('contract', contract.id, 'signed', {
    customerId: contract.customer_id, actor: name + ' <' + email + '>',
    ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
    meta: { position, version: contract.version },
  });

  // Freeze what was signed. Without this the signature points at a document that could later
  // be regenerated differently.
  try { await snapshotContract(contract.id, 'agreement', 'Signed by ' + name + (position ? ', ' + position : '')); }
  catch (e) { console.error('[contract-sign] snapshot failed:', e); }

  try {
    await sendMail({
      to: email,
      subject: `${contract.contract_number} — signed copy of your ${contract.current_doc_kind === 'extension' ? 'extension' : 'agreement'}`,
      html: contractSignedEmailHtml({
        contactName: name, contractNumber: contract.contract_number, title: contract.title,
        isExtension: contract.current_doc_kind === 'extension',
        signedBy: name + (position ? ', ' + position : ''),
        signedAt: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        downloadLink: config.APP_URL + '/c/' + token + '/document.pdf?dl=1',
        portalUrl: config.APP_URL + '/my',
      }),
      // Carries the branded signature block so the receipt looks like every other email
      // they get from us, rather than a bare system message.
      signatureName: 'The Lumen MSP Team',
    });
  } catch (e) { console.error('[contract-sign] confirmation mail failed:', e); }
  res.redirect('/c/' + token);
});

// Print happens entirely in the browser, so the page reports it back.
router.post('/c/:token/event', async (req: Request, res: Response) => {
  const contract = await loadByToken(String(req.params.token));
  const ev = String(req.body?.event || '');
  if (contract && (ev === 'printed' || ev === 'downloaded')) {
    await logDocEvent('contract', contract.id, ev as any, {
      customerId: contract.customer_id, actor: contract.sent_to,
      ip: evIp(req), userAgent: evUa(req), meta: { version: contract.version },
    });
  }
  res.status(204).end();
});

// ── Generated agreement document ───────────────────────────────────────────────
// The MSA is assembled from the template + this contract's data rather than kept as a
// Word file, so the change-control table, parties block and priced tables cannot drift
// out of step with the record. `?html=1` renders the same markup in the browser for a
// fast look without spinning up Chromium.
router.get('/contracts/:id/document', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const ctx = await buildContractDoc(id);
  if (!ctx) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  res.render('contracts/document', { ...ctx, watermark: true, documentHash: null });
});

router.get('/contracts/:id/document.pdf', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const ctx = await buildContractDoc(id);
  if (!ctx) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  res.app.render('contracts/document', { ...ctx, watermark: true, documentHash: null }, async (err: any, html?: string) => {
    if (err || !html) { console.error('[contract-doc] render failed:', err); res.status(500).render('error', { message: 'Document render failed.' }); return; }
    try {
      // Page furniture lives in Chromium's margin boxes, not in the document flow — a
      // position:fixed footer used to print over any table that ran onto a new page.
      const footer =
        `<div style="width:100%;padding:0 16mm;font-family:Arial,Helvetica,sans-serif;font-size:6.5pt;color:#9ca3af;text-align:center;line-height:1.5;">` +
        `${SUPPLIER.tradingStatement.replace(/&/g, '&amp;')}<br>` +
        `Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
      const pdf = await htmlToPdf(html, {
        margin: { top: '14mm', right: '16mm', bottom: '20mm', left: '16mm' },
        footerHtml: footer,
        headerHtml: '<span></span>',
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + `; filename="${ctx.contract.contract_number}.pdf"`);
      res.send(pdf);
    } catch (e) {
      console.error('[contract-doc] PDF error:', e);
      res.status(500).render('error', { message: 'PDF generation failed (Chromium may be missing on the server).' });
    }
  });
});

export default router;
