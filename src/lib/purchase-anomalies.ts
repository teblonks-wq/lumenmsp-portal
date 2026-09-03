import cron from 'node-cron';
import { pool } from '../db/pool';
import { getSetting } from './settings';
import { graphConfigured, graphSendMail } from './graph';
import { classifyNoInvoice, classifyNoInvoiceLive, normaliseCounterparty, aliasTokensFor } from './purchase-match';
import { getInvoiceMailbox } from './purchase-inbox';
import { activeRules, suppressedBy } from './purchase-rules';
import { isInternalSender } from './purchase-dupes';
import { resolveSupplier } from './supplier-master';

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

// ── One payment, several invoices ───────────────────────────────────────────────
// Found 2026-09-02 from the bookkeeper's own list. A £2,565.00 payment to Aventis was down
// as "No Invoice" — but Aventis is the LANDLORD, it collects the Gemini House rent in two-
// and three-month blocks, and £2,565.00 is exactly three months at £855.00. All three
// invoices were already in the pool. Nobody needed to go and find anything.
//
// The matcher could not see it because it matches ONE document to ONE payment. So a payment
// covering several invoices looks like a payment with no invoice for ever, and every month
// it goes back on the chase list. This finds those instead of sending somebody hunting for
// paperwork they already hold.
async function findPaymentCoversSeveral(): Promise<Finding[]> {
  const payments = (await pool.query(
    `SELECT t.id, t.booked_at, t.amount, t.counterparty, t.description
       FROM bank_transactions t
      WHERE t.amount < 0 AND t.status <> 'ignored' AND t.attachment_path IS NULL
        AND t.booked_at > NOW() - INTERVAL '400 days'
      ORDER BY ABS(t.amount) DESC LIMIT 300`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  if (!payments.length) return [];

  const docs = (await pool.query(
    `SELECT d.id, d.file_name, d.parsed_amount, d.parsed_invoice_no, d.received_at,
            COALESCE(a.ai_supplier, d.from_name, d.file_name) AS supplier
       FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
      WHERE d.status <> 'attached' AND d.archived_at IS NULL AND d.parsed_amount IS NOT NULL
        AND (d.doc_type IS NULL OR d.doc_type = 'invoice')`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  if (!docs.length) return [];

  const out: Finding[] = [];
  const used = new Set<number>();
  for (const p of payments) {
    const target = Math.round(Math.abs(Number(p.amount)) * 100);
    const payeeKey = normaliseCounterparty(p.counterparty || p.description || '');
    if (!payeeKey) continue;
    // Candidates: same supplier by name OR by the processor aliases (Aventis collects for
    // Re-Leased/Hurstwood, so the payee and the invoice never share a name).
    const aliases = aliasTokensFor(((p.counterparty || '') + ' ' + (p.description || '')).toLowerCase());
    const cands = docs.filter((d: any) => {
      if (used.has(d.id)) return false;
      const sk = normaliseCounterparty(d.supplier || '');
      if (!sk) return false;
      if (sk === payeeKey || sk.includes(payeeKey) || payeeKey.includes(sk)) return true;
      return aliases.some((al) => sk.includes(al) || al.includes(sk));
    }).slice(0, 10);
    if (cands.length < 2) continue;

    // Exact subset that sums to the payment, up to 6 invoices. Bounded on purpose: this runs
    // over the whole ledger nightly and an unbounded subset-sum would not.
    const cents = cands.map((d: any) => Math.round(Number(d.parsed_amount) * 100));
    let hit: number[] | null = null;
    const n = Math.min(cands.length, 10);
    for (let mask = 1; mask < (1 << n) && !hit; mask++) {
      let bits = 0; for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
      if (bits < 2 || bits > 6) continue;
      let sum = 0; for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += cents[i];
      if (sum === target) { hit = []; for (let i = 0; i < n; i++) if (mask & (1 << i)) hit.push(i); }
    }
    if (!hit) continue;
    const picked = hit.map((i) => cands[i]);
    picked.forEach((d: any) => used.add(d.id));
    out.push({
      key: 'covers:' + p.id, kind: 'covers_several', severity: 'medium',
      title: `${money(p.amount)} to ${p.counterparty || 'a supplier'} covers ${picked.length} invoices you already hold`,
      detail: `Nothing to go and find. ${picked.map((d: any) => `${d.parsed_invoice_no || d.file_name} ${money(d.parsed_amount)}`).join(' + ')} = ${money(p.amount)}. The matcher links one invoice to one payment, so this looked like a payment with no invoice.`,
      amount: Number(p.amount), txnId: p.id, documentId: picked[0].id,
      supplierKey: normaliseCounterparty(picked[0].supplier || ''),
    });
  }
  return out;
}

// An email that announces an invoice but does not contain one. Terry, 2 Sep: "sometimes an
// email says it is an invoice but it will say invoice click or whatever… to protect our
// business we need every invoice for tax reasons unless we ignore it."
//
// So this is not noise to be filtered away — it is EVIDENCE OF AN INVOICE WE DO NOT HOLD.
// The right response is to go and fetch it from the supplier's portal, and until somebody
// does, it stays on the list.
async function findMissingBehindNotification(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT d.id, d.file_name, d.subject, d.from_name, d.from_email, d.received_at, a.ai_supplier
       FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
      WHERE d.archived_at IS NULL AND d.status <> 'attached'
        AND (d.doc_type = 'notification' OR a.ai_doc_type = 'notification')`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'no_doc:' + r.id, kind: 'invoice_not_received', severity: 'medium' as const,
    title: `${r.ai_supplier || r.from_name || 'A supplier'} said an invoice is ready — but we do not have it`,
    detail: `"${String(r.subject || r.file_name).slice(0, 120)}" arrived ${dISO(r.received_at)} announcing an invoice, with no invoice on it. We need the document itself for tax, so somebody has to fetch it from the supplier's portal. This stays here until it arrives.`,
    documentId: r.id,
  }));
}

// An invoice addressed to somebody other than us. Terry, 2 Sep: "check who the invoice is
// TO — if it is Lumen it is a purchase, if it is a customer it is probably a sales invoice."
// One of ours in the purchase pile is not a small filing error: left alone it becomes money
// we appear to owe, and it can be matched to a payment and hide a real bill.
async function findNotOurPurchases(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT d.id, d.file_name, d.rel_path, a.ai_billed_to, a.ai_supplier, a.ai_gross
       FROM purchase_documents d JOIN purchase_doc_ai a ON a.document_id = d.id
      WHERE a.ai_to_us = false AND d.archived_at IS NULL AND d.status <> 'attached'`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'not_ours:' + r.id, kind: 'not_a_purchase', severity: 'medium' as const,
    title: `${r.file_name} is billed to ${r.ai_billed_to || 'somebody other than us'} — this looks like one of OUR sales invoices`,
    detail: `A purchase invoice is addressed to Lumen. This one is not, so it has probably landed in the purchase pool by mistake${r.rel_path ? ` (from ${r.rel_path})` : ''}. It is being kept out of matching until somebody says otherwise.`,
    amount: r.ai_gross != null ? Number(r.ai_gross) : null, documentId: r.id,
  }));
}

// A possible duplicate — the same invoice arriving as a different file. Raised as a finding
// like any other so it gets a conversation, and so answering it can teach a rule rather than
// being a yes/no button that forgets why.
async function findPossibleDuplicates(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT d.id, d.file_name, d.parsed_amount, d.dupe_reason, d.dupe_of_id,
            a.ai_supplier, o.file_name AS other_name
       FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
       LEFT JOIN purchase_documents o ON o.id = d.dupe_of_id
      WHERE d.dupe_status = 'likely' AND d.status <> 'attached' AND d.archived_at IS NULL`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => ({
    key: 'dupe:' + r.id, kind: 'possible_duplicate', severity: 'medium' as const,
    title: `${r.file_name} may be the same invoice as ${r.other_name || 'another one we hold'}`,
    detail: r.dupe_reason || null,
    amount: r.parsed_amount != null ? Number(r.parsed_amount) : null,
    documentId: r.id,
    supplierKey: r.ai_supplier ? String(r.ai_supplier).toLowerCase().split(' ').slice(0, 2).join(' ') : null,
  }));
}

// An invoice we hold, with a total, that no payment has ever been matched to and that is
// now old enough that a Direct Debit would have collected. Either it is unpaid, or the
// payment is there and we failed to spot it. Both need a human.
// ── The matching backlog is not an anomaly list ─────────────────────────────────
// Two detectors used to look at the SAME failure from opposite ends: an invoice we hold
// with no payment against it, and a payment with no invoice behind it. When they are the
// same transaction, the ledger reported one problem twice — and neither line was a
// question about the business. It was the matcher admitting it had not joined them up.
//
// Terry, 2026-09-02: "there is more to look at not less ... I don't want to have to check
// every line for validity as I may as well do it the old fashioned way."
//
// So they are paired FIRST. A pair becomes one row with an Attach button — a decision that
// takes a click, not an investigation. What is left over is grouped by supplier, because
// fourteen Amazon orders are one question ("where are the Amazon invoices for May to
// July?"), not fourteen. Nothing is hidden: every underlying row is still on the ledger,
// still counted, still chaseable. What changes is how many times a human is asked.

const GROUP_FROM = 2;      // two or more from one supplier travel as one finding
const SMALL_ITEM = 25;     // a lone payment under this is card spend, not a finding
const PAIR_DAYS = 60;      // an invoice and its payment sit within about two months

// Payments already explained by findPaymentCoversSeveral, so they are never reported twice.
let coveredIds = new Set<number>();

const STOP = new Set(['ltd','limited','plc','llp','the','and','uk','com','co','inv','invoice',
  'payment','ref','card','online','purchase','services','service','group','holdings','www','net','store']);

function nameTokens(s: any): Set<string> {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)));
}
function shareAToken(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (b.has(w)) return true;
  return false;
}
const penny = (v: any) => Math.round(Math.abs(Number(v) || 0) * 100);

// Both sides of the backlog, paired where they obviously belong together.
// Pairing is deliberately timid: same amount to the penny, a distinctive word in common,
// within PAIR_DAYS — and ONE candidate each way. Three £855.00 rent invoices against three
// £855.00 payments are ambiguous, so they are left alone rather than guessed at.
interface Backlog {
  pairs: { doc: any; txn: any }[];
  docs: any[];      // unmatched invoices with no payment found
  txns: any[];      // unmatched payments with no invoice found
}

async function backlog(): Promise<Backlog> {
  const docs = (await pool.query(
    `SELECT d.id, d.file_name, d.from_name, d.from_email, d.parsed_amount, d.parsed_invoice_no,
            d.received_at, d.created_at, a.ai_supplier
       FROM purchase_documents d LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
      WHERE d.status <> 'attached' AND d.archived_at IS NULL AND d.parsed_amount IS NOT NULL
        AND COALESCE(d.received_at, d.created_at) < NOW() - ($1 || ' days')::interval
        AND COALESCE(d.doc_type,'invoice') NOT IN ('statement','sales_invoice','not_a_purchase')
      ORDER BY d.parsed_amount DESC`, [String(UNPAID_AFTER_DAYS)]
  ).catch(() => ({ rows: [] as any[] }))).rows;

  const rawTxns = (await pool.query(
    `SELECT t.id, t.counterparty, t.description, t.amount, t.booked_at, t.qb_account_name
       FROM bank_transactions t
      WHERE t.amount < 0 AND t.status IN ('new','categorised') AND t.attachment_path IS NULL
        AND t.booked_at < NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM bank_transaction_splits s WHERE s.transaction_id = t.id AND s.attachment_path IS NOT NULL)
      ORDER BY ABS(t.amount) DESC`, [String(NO_INVOICE_AFTER_DAYS)]
  ).catch(() => ({ rows: [] as any[] }))).rows;

  // The ignore list is the ONLY reason money may leave with no invoice behind it.
  const txns: any[] = [];
  for (const t of rawTxns) {
    if (coveredIds.has(t.id)) continue;   // already explained by findPaymentCoversSeveral
    if (await classifyNoInvoiceLive((t.counterparty || '') + ' ' + (t.description || ''))) continue;
    // The supplier master is now the authority on whether paperwork is even expected.
    // invoice_expected='never' always carries a reason, which is what the old pattern-based
    // ignore list could not do — and is why the landlord could sit on it as "financing".
    const sup = await resolveSupplier({ counterparty: t.counterparty, description: t.description });
    if (sup) {
      const row = (await pool.query('SELECT invoice_expected FROM suppliers WHERE id=$1', [sup.supplierId]).catch(() => ({ rows: [] as any[] }))).rows[0];
      if (row && row.invoice_expected === 'never') continue;
    }
    txns.push(t);
  }

  for (const d of docs) d.__tok = nameTokens(d.ai_supplier || d.from_name || d.from_email || d.file_name);
  for (const t of txns) t.__tok = nameTokens((t.counterparty || '') + ' ' + (t.description || ''));

  // Candidate lists both ways, then keep only the mutually unambiguous ones.
  const candFor = new Map<number, any[]>();
  const claims = new Map<number, number>();      // docId -> how many payments want it
  for (const t of txns) {
    const hits = docs.filter((d) => penny(d.parsed_amount) === penny(t.amount)
      && shareAToken(d.__tok, t.__tok)
      && Math.abs(new Date(t.booked_at).getTime() - new Date(d.received_at || d.created_at).getTime()) < PAIR_DAYS * 864e5);
    if (hits.length) { candFor.set(t.id, hits); for (const h of hits) claims.set(h.id, (claims.get(h.id) || 0) + 1); }
  }

  const pairs: { doc: any; txn: any }[] = [];
  const usedDocs = new Set<number>(), usedTxns = new Set<number>();
  for (const t of txns) {
    const hits = candFor.get(t.id);
    if (!hits || hits.length !== 1) continue;          // this payment has a choice — do not guess
    const d = hits[0];
    if ((claims.get(d.id) || 0) !== 1) continue;       // that invoice is wanted by others — do not guess
    pairs.push({ doc: d, txn: t });
    usedDocs.add(d.id); usedTxns.add(t.id);
  }

  return {
    pairs,
    docs: docs.filter((d) => !usedDocs.has(d.id)),
    txns: txns.filter((t) => !usedTxns.has(t.id)),
  };
}

// One row per obvious pair: "we are holding the invoice for this payment."
function pairFindings(b: Backlog): Finding[] {
  return b.pairs.map(({ doc, txn }) => ({
    key: 'needs_match:' + txn.id + ':' + doc.id, kind: 'needs_match', severity: 'medium' as const,
    title: `We already hold the invoice for ${money(txn.amount)} to ${txn.counterparty || 'this supplier'}`,
    detail: `${doc.file_name}${doc.parsed_invoice_no ? ` (invoice ${doc.parsed_invoice_no})` : ''} is ${money(doc.parsed_amount)} — the same amount, the same supplier, received ${dISO(doc.received_at || doc.created_at)} against a payment on ${dISO(txn.booked_at)}. Nothing linked them. One click and this is done.`,
    amount: Number(txn.amount), documentId: doc.id, txnId: txn.id,
  }));
}

// Payments with genuinely nothing to match, grouped by who they went to.
function paymentFindings(b: Backlog): Finding[] {
  const bySupplier = new Map<string, any[]>();
  for (const t of b.txns) {
    const k = normaliseCounterparty(t.counterparty || '') || 'unknown';
    (bySupplier.get(k) || bySupplier.set(k, []).get(k)!).push(t);
  }
  const out: Finding[] = [];
  const smalls: any[] = [];
  for (const [key, list] of bySupplier) {
    const total = list.reduce((n, t) => n + Math.abs(Number(t.amount) || 0), 0);
    const label = list[0].counterparty || key;
    if (list.length >= GROUP_FROM) {
      const dates = list.map((t) => new Date(t.booked_at)).sort((a, c) => +a - +c);
      out.push({
        key: 'no_invoice_grp:' + key, kind: 'payments_no_invoice', severity: 'medium',
        title: `${label} — ${list.length} payments totalling ${money(total)} with no invoice`,
        detail: `Between ${dISO(dates[0])} and ${dISO(dates[dates.length - 1])}. Largest ${money(Math.max(...list.map((t) => Math.abs(Number(t.amount)))))}. `
          + `This is ONE question — where are this supplier's invoices for that period — not ${list.length} separate ones. `
          + `Answer it once and every payment in the group comes off the list together.`,
        amount: total, supplierKey: key, txnId: list[0].id,
      });
      continue;
    }
    if (Math.abs(Number(list[0].amount)) < SMALL_ITEM) { smalls.push(list[0]); continue; }
    const t = list[0];
    out.push({
      key: 'no_invoice:' + t.id, kind: 'payment_no_invoice', severity: 'medium',
      title: `${money(t.amount)} paid to ${t.counterparty || 'unknown'} with no invoice`,
      detail: `Left the bank on ${dISO(t.booked_at)}${t.qb_account_name ? `, coded to ${t.qb_account_name}` : ''}. Nothing in the invoice pool matches it, and we hold no invoice of that amount from anyone.`,
      amount: Number(t.amount), txnId: t.id,
    });
  }
  // Everything small and one-off in a single line. Still on the ledger, still chaseable —
  // just not worth interrupting anyone about individually.
  if (smalls.length) {
    const total = smalls.reduce((n, t) => n + Math.abs(Number(t.amount) || 0), 0);
    out.push({
      key: 'no_invoice_small', kind: 'small_spend_no_invoice', severity: 'info',
      title: `${smalls.length} small payments under ${money(SMALL_ITEM)} with no receipt — ${money(total)} in total`,
      detail: smalls.slice(0, 12).map((t) => `${dISO(t.booked_at)} ${t.counterparty || '?'} ${money(t.amount)}`).join(' · ')
        + (smalls.length > 12 ? ` · and ${smalls.length - 12} more` : ''),
      amount: total,
    });
  }
  return out;
}

// Invoices we hold that nothing has paid, grouped the same way.
// Who an invoice is FROM, never who forwarded it. A forwarded invoice carries Terry's name
// in from_name, and keying on that produced "Terry O'Kelly — 13 invoices totalling
// £23,324.47", which is not a supplier and not a finding — it is the identification failing.
// Same guard as supplierKey() in purchase-dupes: the invoice's own words first, an EXTERNAL
// sender second, the filename last.
function docSupplier(d: any): { key: string; label: string; identified: boolean } {
  if (d.ai_supplier && String(d.ai_supplier).trim()) {
    const l = String(d.ai_supplier).trim();
    return { key: normaliseCounterparty(l) || l.toLowerCase(), label: l, identified: true };
  }
  if (!isInternalSender(d.from_email)) {
    const l = String(d.from_name || d.from_email || '').trim();
    if (l) return { key: normaliseCounterparty(l) || l.toLowerCase(), label: l, identified: true };
  }
  return { key: '__unidentified', label: 'Supplier not identified', identified: false };
}

function invoiceFindings(b: Backlog): Finding[] {
  const bySupplier = new Map<string, any[]>();
  const labels = new Map<string, string>();
  for (const d of b.docs) {
    const s = docSupplier(d);
    labels.set(s.key, s.label);
    (bySupplier.get(s.key) || bySupplier.set(s.key, []).get(s.key)!).push(d);
  }
  const out: Finding[] = [];
  for (const [key, list] of bySupplier) {
    const total = list.reduce((n, d) => n + Math.abs(Number(d.parsed_amount) || 0), 0);
    const label = labels.get(key) || key;
    // Invoices whose supplier we cannot name are ONE finding about identification, not a
    // pile of findings about payment. Naming the supplier is the fix, and it is a different
    // job from chasing a payment.
    if (key === '__unidentified') {
      out.push({
        key: 'unidentified_invoices', kind: 'supplier_unknown', severity: 'medium',
        title: `${list.length} invoices totalling ${money(total)} we cannot attribute to a supplier`,
        detail: `These arrived forwarded, so the sender is one of us rather than the supplier, and nothing on the face of them has been read as a supplier name yet. `
          + `They are not unpaid — we simply do not know whose they are. Reading them, or adding the sender as an alias on the Suppliers screen, resolves the whole group.`,
        amount: total, documentId: list[0].id,
      });
      continue;
    }
    if (list.length >= GROUP_FROM) {
      out.push({
        key: 'unpaid_grp:' + key, kind: 'unpaid_invoices', severity: 'high',
        title: `${label} — ${list.length} invoices totalling ${money(total)} with no payment found`,
        detail: `Oldest received ${dISO(list.map((d) => new Date(d.received_at || d.created_at)).sort((a, c) => +a - +c)[0])}. `
          + `Either they have not been paid, or the payments are on the statement and nothing linked them. `
          + `Check one and the rest of this supplier's usually follow.`,
        amount: total, supplierKey: key, documentId: list[0].id,
      });
      continue;
    }
    const d = list[0];
    out.push({
      key: 'unpaid:' + d.id, kind: 'unpaid_invoice', severity: 'high',
      title: `No payment found for ${money(d.parsed_amount)} — ${label}`,
      detail: `Invoice ${d.parsed_invoice_no || '(no number read)'} received ${dISO(d.received_at || d.created_at)}, still unmatched after ${UNPAID_AFTER_DAYS} days, and no payment of that amount is sitting unexplained.`,
      amount: Number(d.parsed_amount), documentId: d.id,
    });
  }
  return out;
}

// The three of them share one pass over the ledger, so the pairing is done once.
async function findBacklog(): Promise<Finding[]> {
  const b = await backlog();
  return [...pairFindings(b), ...invoiceFindings(b), ...paymentFindings(b)];
}

// A supplier billing materially more than it normally does. Uses the profile the agent
// learned from confirmed matches, so it only fires once we actually know what normal is.
async function findPriceJumps(): Promise<Finding[]> {
  const rows = (await pool.query(
    `SELECT p.supplier_key, p.kind, p.display_name, p.avg_amount, p.last_amount, p.match_count, p.last_paid_at
       FROM purchase_supplier_profiles p
      WHERE p.match_count >= 3 AND p.avg_amount IS NOT NULL AND p.last_amount IS NOT NULL
        AND p.kind <> 'unknown'
        AND p.last_amount > p.avg_amount * $1 AND p.last_amount - p.avg_amount >= $2
        AND p.last_paid_at > NOW() - INTERVAL '90 days'`,
    [PRICE_JUMP_RATIO, PRICE_JUMP_MIN_DELTA]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows.map((r: any) => {
    const pct = Math.round(((Number(r.last_amount) / Number(r.avg_amount)) - 1) * 100);
    return {
      key: 'price_jump:' + r.supplier_key + ':' + r.kind + ':' + Number(r.last_amount).toFixed(2),
      kind: 'price_jump', severity: 'medium' as const,
      title: `${r.display_name || r.supplier_key} — ${r.kind} charge up ${pct}% to ${money(r.last_amount)}`,
      detail: `Compared only against this supplier's other ${r.kind} bills (${r.match_count} of them, averaging ${money(r.avg_amount)}) — never against a different sort of spend. Last collected ${dISO(r.last_paid_at)}. Worth checking whether the sell price followed the buy price.`,
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
    if (await classifyNoInvoiceLive((r.counterparty || '') + ' ' + (r.description || ''))) continue;
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
const OWNED_KINDS = ['already_paid', 'covers_several', 'invoice_not_received', 'not_a_purchase', 'possible_duplicate', 'needs_match', 'supplier_unknown', 'unpaid_invoice', 'unpaid_invoices', 'payment_no_invoice', 'payments_no_invoice', 'small_spend_no_invoice', 'price_jump', 'missing_bill', 'new_supplier', 'vat_mismatch'];

export async function refreshAnomalies(): Promise<{ raised: number; resolved: number; open: number; suppressed: number }> {
  const all: Finding[] = [];
  for (const fn of [findAlreadyPaid, findPaymentCoversSeveral, findMissingBehindNotification, findNotOurPurchases, findPossibleDuplicates, findBacklog, findPriceJumps, findMissingBills, findNewSuppliers, findVatMismatches]) {
    try {
      const found = await fn();
      if (fn === findPaymentCoversSeveral) coveredIds = new Set(found.map((f) => f.txnId!).filter(Boolean));
      all.push(...found);
    }
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
  // Only OPEN rows are resolved. 'answered' and 'dismissed' are human decisions and a sweep
  // does not get to overwrite either of them.
  const res = await pool.query(
    `UPDATE purchase_anomalies SET status='resolved'
      WHERE status='open' AND kind = ANY($1) AND NOT (dedupe_key = ANY($2))`,
    [OWNED_KINDS, keys.length ? keys : ['']]
  ).catch(() => ({ rowCount: 0 }));

  // A concern is frozen text written while the agent was trying to match a document. Once
  // that document is attached, archived, or turns out not to be a purchase invoice at all,
  // the concern has been answered by events — and 233 of 400 open findings were exactly
  // this, never clearing because nothing owned them.
  await pool.query(
    `UPDATE purchase_anomalies SET status='resolved'
      WHERE status='open' AND kind='ai_concern' AND document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM purchase_documents d
           WHERE d.id = purchase_anomalies.document_id
             AND (d.status = 'attached' OR d.archived_at IS NOT NULL
                  OR COALESCE(d.doc_type,'invoice') IN ('statement','sales_invoice','not_a_purchase'))
        )
        AND NOT EXISTS (SELECT 1 FROM purchase_anomaly_notes n WHERE n.anomaly_id = purchase_anomalies.id)`
  ).catch(() => {});

  // Any finding pointing at a document that no longer exists is debris — including
  // 'ai_concern', which nothing else ever clears.
  await pool.query(
    `UPDATE purchase_anomalies SET status='resolved', document_id=NULL
      WHERE status IN ('open','answered') AND document_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM purchase_documents d WHERE d.id = purchase_anomalies.document_id)`
  ).catch(() => {});

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

// ── What paperwork are we actually missing? ─────────────────────────────────────
// Terry, 2026-09-02: "I will definitely have to go looking for some invoices, but I need to
// know WHICH ONES we do not have."
//
// That is a different question from the worklist. The worklist is "what needs a decision";
// this is "what do I have to go and fetch". It is grouped BY SUPPLIER because that is how
// the fetching happens — one login, one portal, download everything missing at once — and it
// ignores nothing except the payees on the ignore list, because for tax every real purchase
// needs its invoice.
export interface MissingGroup {
  supplier: string;
  payee: string;
  count: number;
  total: number;
  oldest: string | null;
  newest: string | null;
  website: string | null;
  payments: Array<{ id: number; booked_at: string; amount: number; reference: string | null; description: string | null; coded_to: string | null; locked: boolean }>;
}

export async function missingPaperwork(): Promise<{
  groups: MissingGroup[]; totalPayments: number; totalValue: number;
  announced: any[]; unreadable: number;
}> {
  const rows = (await pool.query(
    `SELECT t.id, t.booked_at, t.amount, t.counterparty, t.description, t.reference,
            t.qb_account_name AS coded_to, t.status
       FROM bank_transactions t
      WHERE t.amount < 0
        AND t.status <> 'ignored'
        AND t.attachment_path IS NULL
        AND NOT EXISTS (SELECT 1 FROM bank_transaction_splits s
                         WHERE s.transaction_id = t.id AND s.attachment_path IS NOT NULL)
      ORDER BY t.booked_at DESC`
  ).catch(() => ({ rows: [] as any[] }))).rows;

  const suppliers = (await pool.query('SELECT name, url FROM suppliers WHERE is_active = true')
    .catch(() => ({ rows: [] as any[] }))).rows;

  const byKey = new Map<string, MissingGroup>();
  let totalPayments = 0, totalValue = 0;
  for (const r of rows) {
    const desc = (r.counterparty || '') + ' ' + (r.description || '');
    // The ignore list is the ONLY reason a payment may have no invoice behind it.
    if (await classifyNoInvoiceLive(desc)) continue;
    const key = normaliseCounterparty(r.counterparty || r.description || '') || '(unnamed)';
    let g = byKey.get(key);
    if (!g) {
      const sup = suppliers.find((s: any) => {
        const n = normaliseCounterparty(s.name);
        return n && (n === key || n.includes(key) || key.includes(n));
      });
      g = { supplier: sup?.name || (r.counterparty || key), payee: r.counterparty || key,
            count: 0, total: 0, oldest: null, newest: null, website: sup?.url || null, payments: [] };
      byKey.set(key, g);
    }
    const amt = Math.abs(Number(r.amount) || 0);
    g.count++; g.total += amt;
    const d = dISO(r.booked_at);
    if (!g.oldest || d < g.oldest) g.oldest = d;
    if (!g.newest || d > g.newest) g.newest = d;
    g.payments.push({ id: r.id, booked_at: d, amount: amt, reference: r.reference,
                      description: r.description, coded_to: r.coded_to, status: r.status,
                      locked: r.status !== 'new' } as any);
    totalPayments++; totalValue += amt;
  }

  // Invoices a supplier TOLD us about and we still do not hold. Different from a payment with
  // no invoice: here we know the document exists and where to get it.
  const announced = (await pool.query(
    `SELECT d.id, d.file_name, d.subject, d.from_name, d.from_email, d.received_at, a.ai_supplier
       FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
      WHERE d.archived_at IS NULL AND d.status <> 'attached'
        AND (d.doc_type = 'notification' OR a.ai_doc_type = 'notification')
      ORDER BY d.received_at DESC`
  ).catch(() => ({ rows: [] as any[] }))).rows;

  // Held but unreadable — we HAVE these, they just cannot be read. Not a fetching job.
  const unreadable = Number((await pool.query(
    `SELECT COUNT(*)::int n FROM purchase_documents
      WHERE archived_at IS NULL AND parsed_amount IS NULL
        AND (doc_type IS NULL OR doc_type = 'invoice')`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);

  const groups = [...byKey.values()].sort((a, b) => b.total - a.total);
  return { groups, totalPayments, totalValue, announced, unreadable };
}
