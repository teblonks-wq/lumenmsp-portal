import crypto from 'crypto';
import fs from 'fs';
import { pool } from '../db/pool';

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

export function supplierKey(doc: any): string {
  const parts: string[] = [];
  if (doc.from_name) parts.push(String(doc.from_name));
  if (doc.from_email) {
    const dom = (String(doc.from_email).split('@')[1] || '').split('.')[0];
    if (dom && !GENERIC_DOMAINS.test(dom)) parts.push(dom);
  }
  // Manual/bulk uploads carry no sender — the filename is all we have.
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

// Invoice numbers are only comparable once stripped of separators and case.
function normInvNo(v: any): string { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Dates arrive in whatever format the invoice used; compare only when both parsed.
function sameDate(a: any, b: any): boolean {
  const x = String(a || '').trim().toLowerCase(), y = String(b || '').trim().toLowerCase();
  return !!x && x === y;
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

  const others = (await pool.query(
    `SELECT d.id, d.from_name, d.from_email, d.file_name, d.parsed_invoice_no, d.parsed_amount,
            d.parsed_date, d.status, d.bank_transaction_id, d.received_at, d.created_at,
            t.booked_at AS txn_booked_at, t.counterparty AS txn_payee, t.amount AS txn_amount
       FROM purchase_documents d
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

    let reason: string | null = null, strength = 0;
    if (invNo && oInv && invNo === oInv) {
      // An invoice number repeating is the strongest signal there is; with the amount
      // agreeing too it is as close to certain as this can get without a human.
      reason = 'same invoice number ' + (doc.parsed_invoice_no || invNo) + (sameAmount ? ' and same total' : '');
      strength = sameAmount ? 4 : 3;
    } else if (sameSupplier && sameAmount && sameDate(doc.parsed_date, o.parsed_date)) {
      reason = 'same supplier, same total and same invoice date';
      strength = 3;
    } else if (sameSupplier && sameAmount) {
      // Could equally be a genuine repeat monthly charge — flag, never block.
      reason = 'same supplier and same total (could be a repeat monthly bill)';
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
  if (o.status === 'attached' && o.bank_transaction_id) {
    const when = o.txn_booked_at ? new Date(o.txn_booked_at).toLocaleDateString('en-GB') : 'an earlier date';
    return {
      status: 'paid',
      ofId: o.id,
      paidTxnId: o.bank_transaction_id,
      reason: 'Looks ALREADY PAID — ' + best.reason + '; the earlier copy (' + o.file_name + ') is attached to a payment to ' +
        (o.txn_payee || 'a supplier') + ' on ' + when + '.',
    };
  }
  return { status: 'likely', ofId: o.id, paidTxnId: null, reason: 'Possible duplicate of ' + o.file_name + ' — ' + best.reason + '.' };
}

// Assess one document and store the verdict. A human 'dismissed' verdict is sticky —
// a rescan must never re-flag something Terry has already said is a separate bill.
export async function assessAndStore(docId: number): Promise<DupeVerdict> {
  const d = (await pool.query('SELECT * FROM purchase_documents WHERE id=$1', [docId])).rows[0];
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
