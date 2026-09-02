import cron from 'node-cron';
import { pool } from '../db/pool';
import { getSetting } from './settings';
import { graphConfigured, graphSendMail } from './graph';
import { classifyNoInvoice, normaliseCounterparty } from './purchase-match';
import { getInvoiceMailbox } from './purchase-inbox';
import { activeRules, suppressedBy } from './purchase-rules';

// ── The Purchase Agent's anomaly list ────────────────────────────────────────────
// A worklist, not a log. Every finding is one row keyed by what it IS, so a condition
// that persists updates its row rather than breeding new ones, and a row Terry or Natalie
// dismisses stays dismissed. A finding that stops being true resolves itself silently —
// nobody should have to tidy up after this.
//
// Severity is about money, not tidiness:
//   high   — money is at risk right now (about to pay twice, a bill nobody paid)
//   medium — something changed that we would want to have noticed (a price jump, a bill
//            that did not arrive, a payment with no invoice behind it)
//   info   — worth knowing (a supplier we have never bought from before)

const UNPAID_AFTER_DAYS = 45;      // a DD supplier can take ~6 weeks; past that it is a question
const NO_INVOICE_AFTER_DAYS = 30;  // a payment this old with no invoice is a missing document
const PRICE_JUMP_RATIO = 1.25;     // 25% up on the supplier's own average
const PRICE_JUMP_MIN_DELTA = 20;   // ...and at least £20, so pennies never raise a flag

export interface Finding {
  key: string; kind: string; severity: 'high' | 'medium' | 'info';
  title: string; detail?: string | null; amount?: number | null;
  documentId?: number | null; txnId?: number | null; supplierKey?: string | null;
}

const money = (v: any) => '£' + Math.abs(Number(v) || 0).toFixed(2);
const dISO = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : '-');

// ── Detectors ───────────────────────────────────────────────────────────────────

// An invoice whose earlier copy is already attached to a payment. The duplicate checker
// found it; this puts it in front of a human as money at risk.
async function findAlreadyPaid(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT d.id, d.file_name, d.parsed_amount, d.dupe_reason, d.dupe_paid_txn_id, t.counterparty, t.booked_at
       FROM purchase_documents d LEFT JOIN bank_transactions t ON t.id = d.dupe_paid_txn_id
      WHERE d.dupe_status = 'paid' AND d.status <> 'attached' AND d.archived_at IS NULL`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'already_paid:' + r.id, kind: 'already_paid', severity: 'high' as const,
    title: `${r.file_name} looks ALREADY PAID` + (r.parsed_amount ? ` (${money(r.parsed_amount)})` : ''),
    detail: r.dupe_reason || `An earlier copy is attached to a payment to ${r.counterparty || 'a supplier'} on ${dISO(r.booked_at)}.`,
    amount: r.parsed_amount != null ? Number(r.parsed_amount) : null, documentId: r.id, txnId: r.dupe_paid_txn_id,
  }));
}

// An invoice we hold, with a total, that no payment has ever been matched to and that is
// now old enough that a Direct Debit would have collected. Either it is unpaid, or the
// payment is there and we failed to spot it. Both need a human.
async function findUnpaidInvoices(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT id, file_name, from_name, from_email, parsed_amount, parsed_invoice_no, received_at, created_at
       FROM purchase_documents
      WHERE status <> 'attached' AND archived_at IS NULL AND parsed_amount IS NOT NULL
        AND COALESCE(received_at, created_at) < NOW() - ($1 || ' days')::interval
      ORDER BY parsed_amount DESC LIMIT 100`, [String(UNPAID_AFTER_DAYS)]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'unpaid:' + r.id, kind: 'unpaid_invoice', severity: 'high' as const,
    title: `No payment found for ${money(r.parsed_amount)} — ${r.from_name || r.from_email || r.file_name}`,
    detail: `Invoice ${r.parsed_invoice_no || '(no number read)'} received ${dISO(r.received_at || r.created_at)}, still unmatched after ${UNPAID_AFTER_DAYS} days. Either it has not been paid, or the payment is on the statement and nothing linked it.`,
    amount: Number(r.parsed_amount), documentId: r.id,
  }));
}

// Money out with no invoice behind it. Tax, financing and payroll never have one, so those
// are excluded by the same classifier the reconcile screen uses.
async function findPaymentsWithoutInvoice(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT t.id, t.counterparty, t.description, t.amount, t.booked_at, t.qb_account_name
       FROM bank_transactions t
      WHERE t.amount < 0 AND t.status IN ('new','categorised') AND t.attachment_path IS NULL
        AND t.booked_at < NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM bank_transaction_splits s WHERE s.transaction_id = t.id AND s.attachment_path IS NOT NULL)
      ORDER BY ABS(t.amount) DESC LIMIT 100`, [String(NO_INVOICE_AFTER_DAYS)]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  const out: Finding[] = [];
  for (const r of rows) {
    const desc = (r.counterparty || '') + ' ' + (r.description || '');
    if (classifyNoInvoice(desc)) continue; // HMRC, financing, payroll — no invoice is expected
    out.push({
      key: 'no_invoice:' + r.id, kind: 'payment_no_invoice', severity: 'medium',
      title: `${money(r.amount)} paid to ${r.counterparty || 'unknown'} with no invoice`,
      detail: `Left the bank on ${dISO(r.booked_at)}${r.qb_account_name ? `, coded to ${r.qb_account_name}` : ''}. Nothing in the invoice pool has been matched to it.`,
      amount: Number(r.amount), txnId: r.id,
    });
  }
  return out;
}

// A supplier billing materially more than it normally does. Uses the profile the agent
// learned from confirmed matches, so it only fires once we actually know what normal is.
async function findPriceJumps(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT p.supplier_key, p.display_name, p.avg_amount, p.last_amount, p.match_count, p.last_paid_at
       FROM purchase_supplier_profiles p
      WHERE p.match_count >= 3 AND p.avg_amount IS NOT NULL AND p.last_amount IS NOT NULL
        AND p.last_amount > p.avg_amount * $1 AND p.last_amount - p.avg_amount >= $2
        AND p.last_paid_at > NOW() - INTERVAL '90 days'`,
    [PRICE_JUMP_RATIO, PRICE_JUMP_MIN_DELTA]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => {
    const pct = Math.round(((Number(r.last_amount) / Number(r.avg_amount)) - 1) * 100);
    return {
      key: 'price_jump:' + r.supplier_key + ':' + Number(r.last_amount).toFixed(2),
      kind: 'price_jump', severity: 'medium' as const,
      title: `${r.display_name || r.supplier_key} charged ${money(r.last_amount)} — ${pct}% above its usual`,
      detail: `Average over ${r.match_count} previous bills is ${money(r.avg_amount)}. Last collected ${dISO(r.last_paid_at)}. Worth checking whether the sell price followed the buy price.`,
      amount: Number(r.last_amount), supplierKey: r.supplier_key,
    };
  });
}

// A supplier that bills like clockwork and then does not. A missing bill is a bill that
// arrives later as two, or a service quietly cancelled.
async function findMissingBills(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT supplier_key, display_name, cadence_days, last_invoice_at, avg_amount, match_count
       FROM purchase_supplier_profiles
      WHERE match_count >= 3 AND cadence_days BETWEEN 20 AND 40 AND last_invoice_at IS NOT NULL
        AND last_invoice_at < NOW() - (cadence_days * 1.6 || ' days')::interval
        AND last_invoice_at > NOW() - INTERVAL '365 days'`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'missing_bill:' + r.supplier_key, kind: 'missing_bill', severity: 'medium' as const,
    title: `No bill from ${r.display_name || r.supplier_key} since ${dISO(r.last_invoice_at)}`,
    detail: `It normally bills about every ${r.cadence_days} days (${r.match_count} bills seen, typically ${money(r.avg_amount)}). Nothing has arrived.`,
    amount: r.avg_amount != null ? Number(r.avg_amount) : null, supplierKey: r.supplier_key,
  }));
}

// Money leaving to somebody we have never bought from before. Usually fine, occasionally
// the first sign of something that should not be happening.
async function findNewSuppliers(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT id, counterparty, description, amount, booked_at FROM bank_transactions
      WHERE amount < 0 AND booked_at > NOW() - INTERVAL '30 days' AND counterparty IS NOT NULL
      ORDER BY ABS(amount) DESC LIMIT 200`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  if (!rows.length) return [];
  const known = new Set<string>();
  for (const r of (await pool.query('SELECT supplier_key FROM purchase_supplier_profiles').catch(() => ({ rows: [] as any[] }))).rows) known.add(r.supplier_key);
  for (const r of (await pool.query(
    `SELECT DISTINCT counterparty FROM bank_transactions
      WHERE amount < 0 AND booked_at <= NOW() - INTERVAL '30 days' AND counterparty IS NOT NULL`
  ).catch(() => ({ rows: [] as any[] }))).rows) known.add(normaliseCounterparty(r.counterparty));

  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const r of rows) {
    const key = normaliseCounterparty(r.counterparty);
    if (!key || known.has(key) || seen.has(key)) continue;
    if (classifyNoInvoice((r.counterparty || '') + ' ' + (r.description || ''))) continue;
    seen.add(key);
    out.push({
      key: 'new_supplier:' + key, kind: 'new_supplier', severity: 'info',
      title: `First payment to ${r.counterparty} — ${money(r.amount)}`,
      detail: `Nothing has been paid to this payee before ${dISO(r.booked_at)}.`,
      amount: Number(r.amount), txnId: r.id, supplierKey: key,
    });
  }
  return out;
}

// The invoice's own arithmetic does not add up. Claude read net, VAT and gross off the
// page; if they disagree the document is wrong, misread, or not what it claims to be.
async function findVatMismatches(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT a.document_id, a.ai_net, a.ai_vat, a.ai_gross, a.ai_supplier, d.file_name
       FROM purchase_doc_ai a JOIN purchase_documents d ON d.id = a.document_id
      WHERE a.ai_net IS NOT NULL AND a.ai_vat IS NOT NULL AND a.ai_gross IS NOT NULL
        AND ABS((a.ai_net + a.ai_vat) - a.ai_gross) > 0.02
        AND d.archived_at IS NULL`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'vat:' + r.document_id, kind: 'vat_mismatch', severity: 'info' as const,
    title: `${r.ai_supplier || r.file_name}: net + VAT does not equal the total`,
    detail: `Read as ${money(r.ai_net)} net + ${money(r.ai_vat)} VAT = ${money(Number(r.ai_net) + Number(r.ai_vat))}, but the total says ${money(r.ai_gross)}.`,
    amount: Number(r.ai_gross), documentId: r.document_id,
  }));
}

// ── The sweep ───────────────────────────────────────────────────────────────────
// Kinds this function is authoritative for. An open row of one of these kinds that is NOT
// re-raised has stopped being true, so it resolves. 'ai_concern' is raised by the matcher
// as it reads, so it is NOT in this list and is never auto-resolved from here.
const OWNED_KINDS = ['already_paid', 'unpaid_invoice', 'payment_no_invoice', 'price_jump', 'missing_bill', 'new_supplier', 'vat_mismatch'];

export async function refreshAnomalies(): Promise<{ raised: number; resolved: number; open: number; suppressed: number }> {
  const all: Finding[] = [];
  for (const fn of [findAlreadyPaid, findUnpaidInvoices, findPaymentsWithoutInvoice, findPriceJumps, findMissingBills, findNewSuppliers, findVatMismatches]) {
    try { all.push(...await fn()); }
    catch (e) { console.error('[purchase-anomalies] detector failed:', (e as Error).message); }
  }

  // Rules a human accepted after answering a finding. A suppress rule is a deliberate blind
  // spot, so it is applied here and NOWHERE ELSE — one place to look when something expected
  // stops appearing. 'already_paid' can never be suppressed: paying a bill twice is the one
  // finding no standing instruction should be able to hide.
  const rules = await activeRules();
  const found: Finding[] = [];
  let suppressed = 0;
  for (const f of all) {
    if (f.kind !== 'already_paid') {
      const r = suppressedBy(rules, f.kind, f.supplierKey ?? null);
      if (r) { suppressed++; continue; }
    }
    found.push(f);
  }

  for (const f of found) {
    await pool.query(
      `INSERT INTO purchase_anomalies (dedupe_key, kind, severity, title, detail, amount, document_id, txn_id, supplier_key, status, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',NOW(),NOW())
       ON CONFLICT (dedupe_key) DO UPDATE SET
         title = EXCLUDED.title, detail = EXCLUDED.detail, amount = EXCLUDED.amount,
         severity = EXCLUDED.severity, last_seen_at = NOW()`,
      [f.key, f.kind, f.severity, f.title, f.detail || null, f.amount ?? null,
       f.documentId ?? null, f.txnId ?? null, f.supplierKey ?? null]
    ).catch((e) => console.error('[purchase-anomalies] upsert failed:', e.message));
  }

  // Anything of an owned kind that is open and was not re-raised has been dealt with.
  // Dismissed rows are never touched — a human's decision is not undone by a sweep.
  const keys = found.map((f) => f.key);
  const res = await pool.query(
    `UPDATE purchase_anomalies SET status='resolved'
      WHERE status='open' AND kind = ANY($1) AND NOT (dedupe_key = ANY($2))`,
    [OWNED_KINDS, keys.length ? keys : ['']]
  ).catch(() => ({ rowCount: 0 }));

  const open = Number((await pool.query("SELECT COUNT(*)::int n FROM purchase_anomalies WHERE status='open'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  return { raised: found.length, resolved: res.rowCount || 0, open, suppressed };
}

export async function listAnomalies(status = 'open'): Promise<any[]> {
  return (await pool.query(
    `SELECT * FROM purchase_anomalies WHERE status=$1
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               ABS(COALESCE(amount,0)) DESC, id DESC`, [status]
  ).catch(() => ({ rows: [] as any[] }))).rows;
}

export async function dismissAnomaly(id: number, userId: number): Promise<void> {
  await pool.query("UPDATE purchase_anomalies SET status='dismissed', dismissed_by=$1, dismissed_at=NOW() WHERE id=$2", [userId, id]);
}

// ── Monday digest ───────────────────────────────────────────────────────────────
// The panel only works if somebody opens the screen. This is the safety net.
const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);

export async function sendAnomalyDigest(): Promise<{ sent: boolean; count: number; to: string }> {
  const rows = await listAnomalies('open');
  const to = ((await getSetting('purchases', 'anomaly_recipients')) || (await getSetting('purchases', 'bookkeeper_email')) || (await getInvoiceMailbox()) || '').trim();
  if (!to || !graphConfigured()) return { sent: false, count: rows.length, to };
  if (!rows.length) return { sent: false, count: 0, to }; // nothing to say: say nothing

  const high = rows.filter((r) => r.severity === 'high');
  const rest = rows.filter((r) => r.severity !== 'high');
  const section = (title: string, list: any[]) => !list.length ? '' :
    `<h3 style="margin:18px 0 6px;font:600 15px system-ui;">${esc(title)}</h3><ul style="margin:0;padding-left:18px;font:14px/1.55 system-ui;">` +
    list.slice(0, 40).map((r) => `<li style="margin-bottom:6px;"><strong>${esc(r.title)}</strong>${r.detail ? `<br><span style="color:#555;">${esc(r.detail)}</span>` : ''}</li>`).join('') +
    (list.length > 40 ? `<li>…and ${list.length - 40} more</li>` : '') + '</ul>';

  await graphSendMail({
    to,
    subject: `Purchase Ledger — ${rows.length} open item${rows.length === 1 ? '' : 's'}${high.length ? ` (${high.length} needing attention)` : ''}`,
    html: `<div style="font:14px/1.55 system-ui;color:#111;">
      <p>The Purchase Agent's open list as of this morning.</p>
      ${section('Money at risk', high)}
      ${section('Worth a look', rest)}
      <p style="margin-top:20px;color:#555;">Work through them on the Purchase Ledger screen, where each one can be opened or dismissed.</p></div>`,
    saveToSentItems: false,
  });
  return { sent: true, count: rows.length, to };
}

let _started = false;
export function startPurchaseAnomalies(): void {
  if (_started) return;
  _started = true;
  // Re-sweep every night so the panel is current whenever somebody opens the screen.
  cron.schedule('35 2 * * *', () => {
    refreshAnomalies()
      .then((r) => console.log(`[purchase-anomalies] nightly sweep: ${r.raised} raised, ${r.resolved} resolved, ${r.open} open`))
      .catch((e) => console.error('[purchase-anomalies] sweep error:', e.message));
  });
  // Monday 07:30 digest, after the sweep has run.
  cron.schedule('30 7 * * 1', () => {
    sendAnomalyDigest()
      .then((r) => { if (r.sent) console.log(`[purchase-anomalies] digest sent to ${r.to} (${r.count} items)`); })
      .catch((e) => console.error('[purchase-anomalies] digest error:', e.message));
  });
  console.log('[purchase-anomalies] started — nightly sweep 02:35, Monday digest 07:30');
}
