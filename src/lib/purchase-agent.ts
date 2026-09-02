import fs from 'fs';
import { pool } from '../db/pool';
import { aiAskDoc, aiAskText, parseJsonAnswer, docKindFor, docMediaType } from './ai-compose';
import { normaliseCounterparty, aliasTokensFor } from './purchase-match';
import { supplierKey } from './purchase-dupes';
import { activeRules, contextFor } from './purchase-rules';

// ── The Purchase Agent's reading and reasoning ───────────────────────────────────
// Step one of a purchase agent that eventually runs the ledger end to end. Three jobs,
// each deliberately narrow, each leaving evidence a human can audit and undo:
//
//   READ    — a scanned or photographed invoice has no extractable text, so every text
//             heuristic downstream is blind. Claude is given the file to LOOK at. This is
//             the OCR answer: no tesseract to install, patch or babysit on the App Server,
//             and it reads layout and context, not just glyphs.
//   JUDGE   — when amount + supplier + date cannot settle a match, Claude gets the invoice
//             facts, the shortlist of candidate payments, and WHAT WE HAVE LEARNED about
//             that supplier, and returns a verdict with a confidence and its reasoning.
//   LEARN   — every confirmed match teaches the supplier profile: the descriptors its
//             processor puts on the statement, how long it takes to collect, what it
//             normally costs, how often it bills. That memory is what makes the next
//             match easy and what makes an odd bill visible.
//
// Cost discipline: the rules run first and settle the ordinary cases for nothing. Claude
// is called ONLY for what the rules could not read or could not settle.

const MAX_DOC_BYTES = 4 * 1024 * 1024; // Anthropic caps document size; skip anything huge.

// ── READ ────────────────────────────────────────────────────────────────────────
export interface AiInvoiceRead {
  supplier: string | null; invoiceNo: string | null; date: string | null;
  net: number | null; vat: number | null; gross: number | null;
  currency: string | null; period: string | null; summary: string | null; concerns: string | null;
}

const READ_SYSTEM = [
  'You read supplier invoices for a UK IT company and return structured facts. You are looking at the document itself.',
  'Return STRICT JSON only, no prose, with exactly these keys:',
  '{"supplier":string|null,"invoiceNo":string|null,"date":"YYYY-MM-DD"|null,"net":number|null,"vat":number|null,"gross":number|null,"currency":string|null,"period":string|null,"summary":string|null,"concerns":string|null}',
  'RULES:',
  '- gross is the amount the customer must PAY for THIS invoice, VAT included. On a statement showing an account balance carried forward, gross is this invoice only, never the running balance.',
  '- Use null, never a guess, for anything not clearly on the page. A wrong number is far worse than a missing one.',
  '- currency is the ISO code shown (GBP, USD, EUR). If the document shows $ with no other clue, say USD.',
  '- period is the service period the bill covers if stated (e.g. "1-31 Aug 2026"), else null.',
  '- summary is ONE short line naming what was actually bought.',
  '- concerns: anything wrong on the face of it - the arithmetic does not add up, it is a duplicate or copy, it is addressed to someone else, it is a credit note not an invoice, it is already marked paid. Otherwise null.',
].join('\n');

export async function aiReadInvoiceDoc(doc: any): Promise<AiInvoiceRead | null> {
  const kind = docKindFor(doc.content_type, doc.file_name);
  if (!kind) { await setReadStatus(doc.id, 'unreadable'); return null; }
  let buf: Buffer;
  try { buf = fs.readFileSync(doc.file_path); }
  catch (e) { console.error('[purchase-agent] cannot read file', doc.file_path, (e as Error).message); await setReadStatus(doc.id, 'failed'); return null; }
  if (buf.length > MAX_DOC_BYTES) { await setReadStatus(doc.id, 'unreadable'); return null; }

  let raw: string;
  try {
    raw = await aiAskDoc(READ_SYSTEM, 'Read this invoice and return the JSON.', {
      kind, media_type: docMediaType(kind, doc.content_type, doc.file_name), data: buf.toString('base64'),
    }, 900);
  } catch (e) {
    console.error('[purchase-agent] Claude read failed for doc', doc.id, (e as Error).message);
    await setReadStatus(doc.id, 'failed');
    return null;
  }
  const r = parseJsonAnswer<AiInvoiceRead | null>(raw, null);
  if (!r) { await setReadStatus(doc.id, 'failed'); return null; }

  const num = (v: any) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  await pool.query(
    `INSERT INTO purchase_doc_ai (document_id, ai_supplier, ai_invoice_no, ai_date, ai_net, ai_vat, ai_gross, ai_currency, ai_period, ai_summary, ai_concerns, read_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (document_id) DO UPDATE SET ai_supplier=$2, ai_invoice_no=$3, ai_date=$4, ai_net=$5, ai_vat=$6,
       ai_gross=$7, ai_currency=$8, ai_period=$9, ai_summary=$10, ai_concerns=$11, read_at=NOW()`,
    [doc.id, r.supplier || null, r.invoiceNo || null, r.date || null, num(r.net), num(r.vat), num(r.gross),
     r.currency || null, r.period || null, r.summary || null, r.concerns || null]
  );
  // Feed what Claude read back into the columns the rest of the ledger already uses, but
  // NEVER overwrite a value the text parse read cleanly — that one came off the actual text.
  await pool.query(
    `UPDATE purchase_documents
        SET parsed_amount     = COALESCE(parsed_amount, $2),
            parsed_invoice_no = COALESCE(parsed_invoice_no, $3),
            parsed_date       = COALESCE(parsed_date, $4),
            ai_read_status    = 'ok'
      WHERE id = $1`,
    [doc.id, num(r.gross), r.invoiceNo || null, r.date || null]
  );
  return r;
}

async function setReadStatus(docId: number, st: string): Promise<void> {
  await pool.query('UPDATE purchase_documents SET ai_read_status=$1 WHERE id=$2', [st, docId]).catch(() => {});
}

// Read every pooled invoice the text parser could not read. This is the OCR pass.
export async function aiReadUnreadable(limit = 40): Promise<{ read: number; failed: number; considered: number }> {
  const docs = (await pool.query(
    `SELECT * FROM purchase_documents
      WHERE status <> 'attached' AND archived_at IS NULL
        AND (parse_status IN ('no_text','error') OR parsed_amount IS NULL)
        AND ai_read_status IS NULL
      ORDER BY created_at DESC LIMIT $1`, [limit]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  let read = 0, failed = 0;
  for (const d of docs) { const r = await aiReadInvoiceDoc(d); if (r) read++; else failed++; }
  return { read, failed, considered: docs.length };
}

// ── LEARN ───────────────────────────────────────────────────────────────────────
// One confirmed match teaches one supplier. Called on every attach, whoever made it.
export async function learnFromMatch(docId: number, txnId: number): Promise<void> {
  const d = (await pool.query('SELECT * FROM purchase_documents WHERE id=$1', [docId])).rows[0];
  const t = (await pool.query('SELECT * FROM bank_transactions WHERE id=$1', [txnId])).rows[0];
  if (!d || !t) return;
  const key = supplierKey(d);
  if (!key) return;

  const descriptor = normaliseCounterparty(t.counterparty || t.description || '');
  const amount = Math.abs(Number(t.amount) || 0);
  const invoiceDate = d.parsed_date ? new Date(d.parsed_date) : (d.received_at ? new Date(d.received_at) : null);
  const lagDays = invoiceDate && !isNaN(invoiceDate.getTime())
    ? Math.round((new Date(t.booked_at).getTime() - invoiceDate.getTime()) / 86400000) : null;

  const prev = (await pool.query('SELECT * FROM purchase_supplier_profiles WHERE supplier_key=$1', [key])).rows[0];
  let descriptors: string[] = [];
  try { descriptors = prev?.descriptors ? JSON.parse(prev.descriptors) : []; } catch { descriptors = []; }
  if (descriptor && !descriptors.includes(descriptor)) descriptors.push(descriptor);
  descriptors = descriptors.slice(-12); // a supplier does not need a hundred aliases

  const n = Number(prev?.match_count || 0);
  const avg = prev?.avg_amount != null ? Number(prev.avg_amount) : null;
  const newAvg = avg == null ? amount : (avg * n + amount) / (n + 1);
  // Cadence: how long since we last saw a bill from this supplier.
  const cadence = prev?.last_invoice_at && invoiceDate
    ? Math.abs(Math.round((invoiceDate.getTime() - new Date(prev.last_invoice_at).getTime()) / 86400000)) || null
    : null;
  const avgLag = prev?.avg_lag_days != null && lagDays != null
    ? Math.round((Number(prev.avg_lag_days) * n + lagDays) / (n + 1)) : lagDays;

  await pool.query(
    `INSERT INTO purchase_supplier_profiles
       (supplier_key, display_name, descriptors, qb_account_id, qb_account_name, match_count,
        last_amount, avg_amount, min_amount, max_amount, avg_lag_days, cadence_days, last_invoice_at, last_paid_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,$6,$6,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (supplier_key) DO UPDATE SET
       display_name   = COALESCE(purchase_supplier_profiles.display_name, EXCLUDED.display_name),
       descriptors    = EXCLUDED.descriptors,
       qb_account_id  = COALESCE(EXCLUDED.qb_account_id, purchase_supplier_profiles.qb_account_id),
       qb_account_name= COALESCE(EXCLUDED.qb_account_name, purchase_supplier_profiles.qb_account_name),
       match_count    = purchase_supplier_profiles.match_count + 1,
       last_amount    = EXCLUDED.last_amount,
       avg_amount     = $11,
       min_amount     = LEAST(purchase_supplier_profiles.min_amount, EXCLUDED.last_amount),
       max_amount     = GREATEST(purchase_supplier_profiles.max_amount, EXCLUDED.last_amount),
       avg_lag_days   = COALESCE($7, purchase_supplier_profiles.avg_lag_days),
       cadence_days   = COALESCE($8, purchase_supplier_profiles.cadence_days),
       last_invoice_at= COALESCE(EXCLUDED.last_invoice_at, purchase_supplier_profiles.last_invoice_at),
       last_paid_at   = EXCLUDED.last_paid_at,
       updated_at     = NOW()`,
    [key, d.from_name || d.from_email || null, JSON.stringify(descriptors), t.qb_account_id || null,
     t.qb_account_name || null, amount, avgLag, cadence,
     invoiceDate && !isNaN(invoiceDate.getTime()) ? invoiceDate : null, t.booked_at, newAvg]
  ).catch((e) => console.error('[purchase-agent] learn failed:', e.message));
}

export async function getSupplierProfile(key: string): Promise<any | null> {
  if (!key) return null;
  return (await pool.query('SELECT * FROM purchase_supplier_profiles WHERE supplier_key=$1', [key])
    .catch(() => ({ rows: [] as any[] }))).rows[0] || null;
}

// ── JUDGE ───────────────────────────────────────────────────────────────────────
export interface AiMatchVerdict { txnId: number | null; confidence: number; reason: string; concern: string | null }

const JUDGE_SYSTEM = [
  'You match a supplier invoice to the bank payment that settled it, for a UK IT company.',
  'Return STRICT JSON only: {"txnId":number|null,"confidence":0-100,"reason":string,"concern":string|null}',
  'WHAT YOU MUST KNOW ABOUT THIS LEDGER:',
  '- The statement descriptor is very often the PAYMENT PROCESSOR, not the supplier. FastSpring bills for MSP360, BlueSnap for Atera, Paddle for CrashPlan, Stripe for Ubiquiti, DWS is Giacom, Aventis collects rent invoiced by Re-Leased/Hurstwood.',
  '- Direct Debit suppliers collect up to about six weeks AFTER the invoice date. Some collect BEFORE it. A date gap is normal and is not evidence against a match.',
  '- Invoices billed in USD land on a GBP card at roughly 0.68-0.95 of the invoice total. An amount that is not equal is not automatically a mismatch.',
  '- LEARNED SUPPLIER FACTS are given to you where we have them. Prefer them over your own assumptions: they came from matches a human confirmed.',
  'HOW TO ANSWER:',
  '- txnId must be one of the candidate ids given, or null. Never invent an id.',
  '- confidence is your own honest number. Use 90+ ONLY when you would be comfortable with this being applied without anyone checking. If two candidates are equally good, say so in reason and cap confidence at 50.',
  '- null with a reason is a good answer. Leaving it for a human costs far less than a wrong link.',
  '- concern: raise anything the human should see - the invoice appears already paid, the amount does not match anything, the supplier is not one we recognise, this looks like a credit note. Otherwise null.',
].join('\n');

export async function aiJudgeMatch(doc: any, candidates: any[], profile: any | null): Promise<AiMatchVerdict | null> {
  if (!candidates.length) return null;
  const ai = (await pool.query('SELECT * FROM purchase_doc_ai WHERE document_id=$1', [doc.id])
    .catch(() => ({ rows: [] as any[] }))).rows[0];

  const money = (v: any) => (v == null ? 'unknown' : '£' + Math.abs(Number(v)).toFixed(2));
  const lines: string[] = [];
  lines.push('INVOICE TO MATCH');
  lines.push(`  Sender: ${doc.from_name || '-'} <${doc.from_email || '-'}>  |  File: ${doc.file_name}`);
  lines.push(`  Received: ${doc.received_at ? new Date(doc.received_at).toISOString().slice(0, 10) : '-'}`);
  lines.push(`  Total read off the invoice: ${money(doc.parsed_amount)}  |  Invoice no: ${doc.parsed_invoice_no || '-'}  |  Invoice date: ${doc.parsed_date || '-'}`);
  if (ai) {
    lines.push(`  Claude read the document itself: supplier "${ai.ai_supplier || '-'}", ${money(ai.ai_gross)} gross (${money(ai.ai_net)} net + ${money(ai.ai_vat)} VAT), currency ${ai.ai_currency || '-'}, period ${ai.ai_period || '-'}`);
    if (ai.ai_summary) lines.push(`  What was bought: ${ai.ai_summary}`);
    if (ai.ai_concerns) lines.push(`  Noted on the face of it: ${ai.ai_concerns}`);
  }
  if (profile) {
    let descs: string[] = [];
    try { descs = profile.descriptors ? JSON.parse(profile.descriptors) : []; } catch { /* ignore */ }
    lines.push('');
    lines.push('LEARNED SUPPLIER FACTS (from matches a human confirmed)');
    lines.push(`  Seen ${profile.match_count} time(s). Bank descriptors used: ${descs.length ? descs.join(' | ') : 'none recorded'}`);
    lines.push(`  Typical amount ${money(profile.avg_amount)} (range ${money(profile.min_amount)}-${money(profile.max_amount)}), last ${money(profile.last_amount)}`);
    if (profile.avg_lag_days != null) lines.push(`  Normally collects about ${profile.avg_lag_days} day(s) after the invoice date`);
    if (profile.cadence_days != null) lines.push(`  Bills roughly every ${profile.cadence_days} day(s)`);
    if (profile.qb_account_name) lines.push(`  Normally categorised as: ${profile.qb_account_name}`);
  }
  // Things a person has TOLD us about this supplier, which we could never have worked out.
  // These outrank anything inferred: a human's word closes it.
  try {
    const told = contextFor(await activeRules(), supplierKey(doc));
    if (told.length) {
      lines.push('');
      lines.push('WHAT WE HAVE BEEN TOLD (a person said this — believe it over your own inference)');
      told.forEach((t) => lines.push('  ' + t));
    }
  } catch { /* rules are an enhancement, never a blocker */ }
  lines.push('');
  lines.push('CANDIDATE PAYMENTS (money out, unmatched)');
  for (const c of candidates) {
    const hay = ((c.counterparty || '') + ' ' + (c.description || '') + ' ' + (c.reference || '')).toLowerCase();
    const aliases = aliasTokensFor(hay);
    lines.push(`  id=${c.id} | ${new Date(c.booked_at).toISOString().slice(0, 10)} | ${money(c.amount)} | payee "${c.counterparty || '-'}" | ref "${c.reference || '-'}" | desc "${String(c.description || '').slice(0, 90)}"`
      + (aliases.length ? ` | known to be: ${aliases.join(', ')}` : ''));
  }

  let raw: string;
  try { raw = await aiAskText(JUDGE_SYSTEM, lines.join('\n'), 700); }
  catch (e) { console.error('[purchase-agent] judge failed for doc', doc.id, (e as Error).message); return null; }
  const v = parseJsonAnswer<AiMatchVerdict | null>(raw, null);
  if (!v) return null;
  const id = Number(v.txnId);
  const valid = candidates.some((c: any) => c.id === id);
  return {
    txnId: valid ? id : null,
    confidence: Math.max(0, Math.min(100, Number(v.confidence) || 0)),
    reason: String(v.reason || '').slice(0, 600),
    concern: v.concern ? String(v.concern).slice(0, 400) : null,
  };
}
