import crypto from 'crypto';
import fs from 'fs';
import { pool } from '../db/pool';
import { Relation, phrase, isAlarming } from './purchase-terms';

// ── Purchase-ledger duplicate detection ──────────────────────────────────────────
// Two different problems, deliberately handled differently:
//
//  1. THE SAME FILE arrives twice — re-uploaded, forwarded again, or picked up in a
//     bulk folder load that overlaps an earlier one. Byte-identical, so a sha256 of
//     the file settles it with no judgement at all. These are SKIPPED at import.
//
//  2. THE SAME INVOICE arrives as a DIFFERENT file — the supplier re-sends it, or the
//     emailed PDF and a scanned copy both land. The bytes differ, so this is a
//     judgement call on supplier + invoice number + amount + date. These are IMPORTED
//     and FLAGGED for a human, never blocked: a genuine repeat monthly bill for the
//     same amount looks exactly like a duplicate, and refusing it would lose a real
//     invoice. Nothing here ever deletes or hides a document on its own.
//
// The one that matters financially is (2) escalating to 'paid': the earlier copy is
// already attached to a bank payment, so paying this one pays the bill twice.

export function hashFile(filePath: string): string | null {
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (e) { console.error('[purchase-dupes] hash failed:', filePath, (e as Error).message); return null; }
}

// A stable-ish supplier key for a pooled doc. Emailed invoices have a sender; bulk
// uploads usually only have a filename (often "Giacom_Invoice_1234.pdf"), so fall back
// to that. Two significant words is enough to pair "Giacom Ltd" with "giacom.com".
const GENERIC_DOMAINS = /^(gmail|outlook|hotmail|yahoo|icloud|me|live|aol|msn)$/i;
const NOISE = /\b(ltd|limited|plc|llp|uk|com|co|www|inc|invoices?|inv|billing|accounts?|finance|noreply|no-reply|donotreply|statement|receipt|bill|copy|scan|final)\b/gi;

// OUR OWN domains. A message from one of these is somebody here FORWARDING a supplier's
// invoice — it is not a supplier. Getting this wrong is not cosmetic: on 2 Sep every invoice
// Terry forwarded was keyed to the supplier "terry o", which meant
//   • the rules he wrote were attached to "terry o" and could never match a real supplier,
//     so the same questions kept being asked however many rules he accepted;
//   • the learned profiles were pooled under him rather than per supplier;
//   • and Claude, seeing the sender and the payee share a name, started writing about a
//     "potential conflict of interest or self-billing arrangement" about its own user.
const INTERNAL_DOMAINS = /(?:^|\.)(?:lumensolutions|lumenmsp|lumen-msp)\.co\.uk$/i;

export function isInternalSender(email: string | null | undefined): boolean {
  const dom = String(email || '').split('@')[1];
  return !!dom && INTERNAL_DOMAINS.test(dom.trim().toLowerCase());
}

/** Who the invoice is FROM — which is what the document says, not who emailed it.
 *  Order: the supplier Claude read off the page, then an EXTERNAL sender, then the filename. */
export function supplierKey(doc: any): string {
  const parts: string[] = [];

  // 1. What the invoice itself says. Always right when we have it.
  if (doc.ai_supplier) parts.push(String(doc.ai_supplier));

  // 2. The sender — but only when the sender is not us.
  if (!parts.length && !isInternalSender(doc.from_email)) {
    if (doc.from_name) parts.push(String(doc.from_name));
    if (doc.from_email) {
      const dom = (String(doc.from_email).split('@')[1] || '').split('.')[0];
      if (dom && !GENERIC_DOMAINS.test(dom)) parts.push(dom);
    }
  }

  // 3. A forward, a bulk upload, or a sender that told us nothing: the filename is what is left.
  if (!parts.length && doc.file_name) parts.push(String(doc.file_name).replace(/\.[a-z0-9]+$/i, ''));

  return parts.join(' ')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
}

// ── A reference shared by many invoices is not an invoice number ────────────────
// Found live 2 Sep by reading the whole duplicates list: "BF13A7E2" was recorded as the
// invoice number on Stripe invoices in March, April, May, June AND August, and "0FD3D5D9"
// on every RoboShadow one. They are ACCOUNT ids — the real numbers are BF13A7E2-52562,
// -55795, -59075. Treating the shared prefix as an invoice number made five months of
// separate bills look like one invoice paid five times.
//
// No supplier-specific rule can catch this; the data says it instead. A value appearing on
// three or more documents cannot be identifying one of them, so it is not used as evidence.
const SHARED_MIN = 3;
let _sharedCache: Set<string> | null = null;
let _sharedAt = 0;

async function sharedReferences(): Promise<Set<string>> {
  if (_sharedCache && Date.now() - _sharedAt < 60_000) return _sharedCache;
  const rows = (await pool.query(
    `SELECT upper(regexp_replace(parsed_invoice_no,'[^A-Za-z0-9]','','g')) AS n, COUNT(*)::int c
       FROM purchase_documents
      WHERE parsed_invoice_no IS NOT NULL AND parsed_invoice_no <> ''
      GROUP BY 1 HAVING COUNT(*) >= $1`, [SHARED_MIN]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  _sharedCache = new Set(rows.map((r: any) => r.n));
  _sharedAt = Date.now();
  return _sharedCache;
}

export function invalidateSharedReferences(): void { _sharedCache = null; }

// Invoice numbers are only comparable once stripped of separators and case.
function normInvNo(v: any): string { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Dates arrive in whatever format the invoice used; compare only when both parsed.
function sameDate(a: any, b: any): boolean {
  const x = String(a || '').trim().toLowerCase(), y = String(b || '').trim().toLowerCase();
  return !!x && x === y;
}

// A RECEIPT and the INVOICE it pays are the same purchase documented twice. That is worth
// noticing — you only want one of them on the ledger — but it is NOT the "you are about to
// pay this twice" case, and dressing it up as one wastes the alarm. Seen live 2 Sep: an
// Anthropic receipt and its own invoice, same charge id, flagged as a double payment.
const RECEIPT_NAME = /\breceipts?\b/i;
function isReceipt(doc: any): boolean {
  return RECEIPT_NAME.test(String(doc?.file_name || '')) || String(doc?.ai_doc_type || '') === 'receipt';
}

export interface DupeVerdict {
  status: 'likely' | 'paid' | null;
  ofId: number | null;
  paidTxnId: number | null;
  reason: string | null;
}

// Is this pooled document a re-arrival of one we already hold? Compares against every
// OTHER document in the pool (archived ones included — an archived invoice was still
// received). Read-only; the caller decides what to write.
export async function assessDuplicate(doc: any): Promise<DupeVerdict> {
  const none: DupeVerdict = { status: null, ofId: null, paidTxnId: null, reason: null };
  const key = supplierKey(doc);
  const invNo = normInvNo(doc.parsed_invoice_no);
  const amount = doc.parsed_amount != null ? Number(doc.parsed_amount) : null;
  // With no invoice number AND no amount there is nothing safe to compare on — a
  // filename alone produces false positives on every monthly bill.
  if (!invNo && amount == null) return none;

  // A reference used across many documents identifies the ACCOUNT, not this invoice.
  const shared = await sharedReferences();
  const invNoUsable = !!invNo && !shared.has(invNo);

  const others = (await pool.query(
    `SELECT d.id, d.from_name, d.from_email, d.file_name, d.parsed_invoice_no, d.parsed_amount,
            d.parsed_date, d.status, d.bank_transaction_id, d.received_at, d.created_at,
            a.ai_supplier, a.ai_doc_type,
            t.booked_at AS txn_booked_at, t.counterparty AS txn_payee, t.amount AS txn_amount
       FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
       LEFT JOIN bank_transactions t ON t.id = d.bank_transaction_id
      WHERE d.id <> $1
        AND (d.parsed_invoice_no IS NOT NULL OR d.parsed_amount IS NOT NULL)
      ORDER BY d.id`,
    [doc.id]
  ).catch(() => ({ rows: [] as any[] }))).rows;

  let best: { row: any; reason: string; strength: number } | null = null;
  for (const o of others) {
    const oKey = supplierKey(o);
    const oInv = normInvNo(o.parsed_invoice_no);
    const oAmt = o.parsed_amount != null ? Number(o.parsed_amount) : null;
    const sameSupplier = !!key && !!oKey && (key === oKey || key.includes(oKey) || oKey.includes(key));
    const sameAmount = amount != null && oAmt != null && Math.abs(amount - oAmt) < 0.005;

    // ── The veto: DIFFERENT INVOICE NUMBERS MEAN DIFFERENT INVOICES ──────────────
    // Not a hint to weigh — a fact. A supplier does not issue one invoice under two
    // numbers. Without this, every subscription and every monthly rent looks like a
    // duplicate of itself: Anthropic TXPMYYAL-0003 and -0004 are both £90 a month apart,
    // and Gemini House rent INV-2179 and INV-2267 are both £855. (Reported live 2 Sep.)
    if (invNoUsable && oInv && !shared.has(oInv) && invNo !== oInv) continue;

    // Same again for the date. Two invoices bearing different dates are two bills, however
    // alike the amounts. Only applied when BOTH were read — an unread date proves nothing.
    const bothDated = !!String(doc.parsed_date || '').trim() && !!String(o.parsed_date || '').trim();
    if (bothDated && !sameDate(doc.parsed_date, o.parsed_date)) continue;

    let reason: string | null = null, strength = 0;
    if (invNoUsable && oInv && !shared.has(oInv) && invNo === oInv) {
      // An invoice number repeating is the strongest signal there is; with the amount
      // agreeing too it is as close to certain as this can get without a human.
      reason = 'same invoice number ' + (doc.parsed_invoice_no || invNo) + (sameAmount ? ' and same total' : '');
      strength = sameAmount ? 4 : 3;
    } else if (sameSupplier && sameAmount && bothDated) {
      // Same supplier, same total, same date, and neither carries a number that separates
      // them — that is a genuine duplicate rather than a recurring charge.
      reason = 'same supplier, same total and same invoice date';
      strength = 3;
    } else if (sameSupplier && sameAmount && !invNoUsable && !oInv) {
      // Neither document gave up an invoice number or a date, so there is nothing left to
      // tell a duplicate from a repeat monthly charge. Worth a human's eye, nothing more.
      reason = 'same supplier and same total, and neither invoice gave a number or a date to tell them apart';
      strength = 2;
    } else if (sameSupplier && sameAmount && o.status === 'attached') {
      // The earlier copy has ALREADY BEEN PAID. Nothing above ruled these out as the same
      // invoice — the numbers do not contradict and the dates do not contradict — so this
      // is the one case worth a little noise, because the error it prevents is paying a
      // bill twice. Deliberately more willing to ask than the branches above.
      reason = 'same supplier and same total as an invoice already attached to a payment';
      strength = 2;
    }
    if (!reason) continue;
    // An earlier copy already attached to a payment outranks everything: that is the
    // "you are about to pay this twice" case.
    const bump = o.status === 'attached' ? 10 : 0;
    if (!best || strength + bump > best.strength) best = { row: o, reason, strength: strength + bump };
  }

  if (!best) return none;
  const o = best.row;

  // Name the RELATION rather than reaching for the nearest word. An invoice and its own
  // receipt are one purchase; a repeat of a regular charge is two real bills; only the same
  // invoice arriving twice is duplication. See lib/purchase-terms.ts.
  const rel: Relation = isReceipt(doc) !== isReceipt(o)
    ? 'same_purchase'
    : (best.strength >= 3 ? 'same_invoice' : 'coincidence');

  if (!isAlarming(rel)) {
    const which = rel === 'same_purchase'
      ? (isReceipt(doc) ? `this is the receipt for ${o.file_name}` : `this is the invoice for ${o.file_name}`)
      : `${o.file_name} shares the total`;
    return {
      status: 'likely', ofId: o.id, paidTxnId: null,
      reason: phrase(rel, 'likely', `${which}. ${best.reason}.`),
    };
  }

  if (o.status === 'attached' && o.bank_transaction_id) {
    const when = o.txn_booked_at ? new Date(o.txn_booked_at).toLocaleDateString('en-GB') : 'an earlier date';
    // 'paid' is the loudest thing this system says, so it is reserved for the case that
    // earns it: the SAME INVOICE, already attached to a payment. Anything softer says so.
    return {
      status: 'paid',
      ofId: o.id,
      paidTxnId: o.bank_transaction_id,
      reason: `Paying this would pay the bill twice — ${best.reason}, and that copy (${o.file_name}) is already attached to a payment to ${o.txn_payee || 'a supplier'} on ${when}.`,
    };
  }
  return { status: 'likely', ofId: o.id, paidTxnId: null, reason: phrase('same_invoice', 'likely', `${o.file_name} — ${best.reason}.`) };
}

// Assess one document and store the verdict. A human 'dismissed' verdict is sticky —
// a rescan must never re-flag something Terry has already said is a separate bill.
export async function assessAndStore(docId: number): Promise<DupeVerdict> {
  const d = (await pool.query(
    `SELECT d.*, a.ai_supplier, a.ai_doc_type FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id WHERE d.id=$1`, [docId])).rows[0];
  if (!d) return { status: null, ofId: null, paidTxnId: null, reason: null };
  if (d.dupe_status === 'dismissed') return { status: null, ofId: null, paidTxnId: null, reason: null };
  const v = await assessDuplicate(d);
  await pool.query(
    'UPDATE purchase_documents SET dupe_status=$1, dupe_of_id=$2, dupe_paid_txn_id=$3, dupe_reason=$4 WHERE id=$5',
    [v.status, v.ofId, v.paidTxnId, v.reason, docId]
  );
  return v;
}

// Sweep the whole existing pool. The pool predates this check, so everything already in
// it has never been looked at — this is what finds the duplicates you're already sitting on.
export async function rescanAllDuplicates(): Promise<{ scanned: number; likely: number; paid: number }> {
  const ids = (await pool.query(
    "SELECT id FROM purchase_documents WHERE dupe_status IS DISTINCT FROM 'dismissed' ORDER BY id"
  ).catch(() => ({ rows: [] as any[] }))).rows.map((r: any) => r.id);
  let likely = 0, paid = 0;
  for (const id of ids) {
    const v = await assessAndStore(id);
    if (v.status === 'likely') likely++;
    else if (v.status === 'paid') paid++;
  }
  return { scanned: ids.length, likely, paid };
}

// Backfill sha256 for documents pooled before hashing existed, so the exact-duplicate
// skip works against the historic pool from the very first bulk upload.
export async function backfillHashes(): Promise<number> {
  const rows = (await pool.query(
    'SELECT id, file_path FROM purchase_documents WHERE file_hash IS NULL'
  ).catch(() => ({ rows: [] as any[] }))).rows;
  let done = 0;
  for (const r of rows) {
    const h = hashFile(r.file_path);
    if (!h) continue;
    await pool.query('UPDATE purchase_documents SET file_hash=$1 WHERE id=$2', [h, r.id]);
    done++;
  }
  return done;
}

// Has this exact file already been pooled? Returns the existing document, if any.
export async function findByHash(hash: string): Promise<any | null> {
  if (!hash) return null;
  const r = await pool.query(
    'SELECT id, file_name, rel_path, created_at, status FROM purchase_documents WHERE file_hash=$1 ORDER BY id LIMIT 1',
    [hash]
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows[0] || null;
}
