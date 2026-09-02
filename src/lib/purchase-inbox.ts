import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { pool } from '../db/pool';
import { graphConfigured, graphListInbox, graphListAttachments, GraphMessage, graphSendMail } from './graph';
import { getSetting, setSetting } from './settings';
import { parseAndStoreDoc } from './invoice-read';
import { aliasTokensFor, isFxBilled, FX_MIN, FX_MAX } from './purchase-match';
import { aiReadInvoiceDoc, aiJudgeMatch, learnFromMatch, getSupplierProfile } from './purchase-agent';
import { supplierKey } from './purchase-dupes';

// ── Invoice inbox ───────────────────────────────────────────────────────────────
// Polls a DEDICATED mailbox (invoice@lumenmsp.co.uk) and pools any PDF/image
// attachments into purchase_documents so they can be previewed and attached to a
// bank transaction. Completely separate from the support mail sync — it reads its
// own mailbox, never creates tickets, and tracks its own last-sync watermark.

const DEFAULT_MAILBOX = 'invoices@lumenmsp.co.uk';
const GROUP = 'purchases';
const MAILBOX_KEY = 'invoice_mailbox';
const LAST_KEY = 'invoice_last_sync';

// Where pooled invoice files live (private — streamed via an auth-gated route, not /static).
export const PURCHASE_DOCS_DIR = path.join(process.cwd(), 'uploads', 'purchase-docs');

// Keep every real attachment as a possible invoice — only inline logos/signatures are skipped.
function looksLikeInvoiceDoc(name: string, contentType: string, isInline: boolean): boolean {
  const ct = (contentType || '').toLowerCase();
  const nm = name || '';
  // A PDF is always the invoice — by filename OR content-type (incl. x-pdf/acrobat, and the generic
  // octet-stream some senders use) — and counts even when the sender flagged it inline.
  if (/\.pdf$/i.test(nm) || ct.includes('application/pdf') || ct.includes('x-pdf') || ct.includes('acrobat')) return true;
  // Inline items are usually logos/signatures embedded in the body — skip those.
  if (isInline) return false;
  // Otherwise keep EVERY real attachment (PDF, image, Word/Excel, etc.) so a forwarded invoice
  // always lands in the inbox ready to attach — we'd rather pool an extra file than miss the bill.
  return true;
}

export async function getInvoiceMailbox(): Promise<string> {
  return (await getSetting(GROUP, MAILBOX_KEY)) || DEFAULT_MAILBOX;
}

const esc = (s: string) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);

// Heads-up when an invoice email couldn't be imported, so it gets handled manually.
// Goes to the bookkeeper (if set) otherwise the invoice mailbox itself. Best-effort.
async function notifyImportFailure(m: GraphMessage, reason: string): Promise<void> {
  try {
    const to = (await getSetting(GROUP, 'bookkeeper_email')) || (await getInvoiceMailbox());
    if (!to) return;
    await graphSendMail({
      to,
      subject: 'Invoice NOT imported — manual import needed',
      html: `<p>An invoice emailed to the invoice inbox could <b>not be imported automatically</b>. Please import it manually into the Purchase Ledger.</p>
        <ul>
          <li><b>From:</b> ${esc(m.fromName || '')} &lt;${esc(m.from || '')}&gt;</li>
          <li><b>Subject:</b> ${esc(m.subject || '(no subject)')}</li>
          <li><b>Received:</b> ${esc(m.receivedDateTime || '')}</li>
          <li><b>Reason:</b> ${esc(reason || 'unknown')}</li>
        </ul>
        <p>Open the original email in <b>${esc(await getInvoiceMailbox())}</b> and add the invoice via Purchase Ledger → Invoice inbox → Upload.</p>`,
      saveToSentItems: false,
    });
    console.log('[invoice-inbox] failure notice sent to', to);
  } catch (e) {
    console.error('[invoice-inbox] failure-notice send failed:', (e as Error).message);
  }
}

export async function syncInvoiceInbox(): Promise<{ fetched: number; pooled: number; failed: number }> {
  if (!graphConfigured()) return { fetched: 0, pooled: 0, failed: 0 };
  const mailbox = await getInvoiceMailbox();
  if (!mailbox) return { fetched: 0, pooled: 0, failed: 0 };

  // First run: look back 7 days (suppliers may have sent before we switched it on).
  const last = (await getSetting(GROUP, LAST_KEY)) ||
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const msgs = await graphListInbox(mailbox, last);
  fs.mkdirSync(PURCHASE_DOCS_DIR, { recursive: true });
  let pooled = 0;
  let failed = 0;
  let maxIso = last;

  for (const m of msgs) {
    try {
      let docsForMsg = 0; // how many invoice attachments we pooled from this message
      let attachFailed = false;
      if (m.hasAttachments) {
        const atts = await graphListAttachments(mailbox, m.id);
        for (const a of atts) {
          if (!looksLikeInvoiceDoc(a.name, a.contentType, a.isInline)) continue;
          const safe = (a.name || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
          const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe;
          const dest = path.join(PURCHASE_DOCS_DIR, filename);
          try { fs.writeFileSync(dest, Buffer.from(a.base64, 'base64')); }
          catch (e) { console.error('[invoice-inbox] save failed:', a.name, (e as Error).message); attachFailed = true; await notifyImportFailure(m, 'Could not save attachment "' + a.name + '": ' + (e as Error).message); failed++; continue; }
          const ins = await pool.query(
            `INSERT INTO purchase_documents (source, from_email, from_name, subject, received_at, file_name, file_path, content_type, size_bytes, status, graph_message_id)
             VALUES ('email',$1,$2,$3,$4,$5,$6,$7,$8,'new',$9)
             ON CONFLICT (graph_message_id, file_name) DO NOTHING RETURNING id`,
            [m.from || null, m.fromName || null, m.subject || null, m.receivedDateTime, a.name, dest, a.contentType || null, a.size || null, m.id]
          );
          if (ins.rowCount) {
            pooled++; docsForMsg++;
            try { await parseAndStoreDoc({ id: ins.rows[0].id, file_path: dest, content_type: a.contentType || null, file_name: a.name }); } catch { /* parse best-effort */ }
          }
        }
      }
      // No invoice attachment → the invoice is in the email body itself. Save the body as
      // an HTML document so it can be previewed and attached like any other invoice.
      // (Skipped if an attachment existed but failed to save — that already raised a notice.)
      if (docsForMsg === 0 && !attachFailed) {
        const bodyHtml = (m.bodyHtml && m.bodyHtml.trim())
          ? m.bodyHtml
          : '<pre style="white-space:pre-wrap;font:14px/1.5 sans-serif;padding:16px;">' +
            (m.bodyText || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]) + '</pre>';
        const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-email-body.html';
        const dest = path.join(PURCHASE_DOCS_DIR, filename);
        try {
          fs.writeFileSync(dest, bodyHtml);
          const bodyName = (m.subject ? m.subject.replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 60) + ' ' : '') + '(email body).html';
          const ins = await pool.query(
            `INSERT INTO purchase_documents (source, from_email, from_name, subject, received_at, file_name, file_path, content_type, size_bytes, status, graph_message_id)
             VALUES ('email',$1,$2,$3,$4,$5,$6,'text/html',$7,'new',$8)
             ON CONFLICT (graph_message_id, file_name) DO NOTHING RETURNING id`,
            [m.from || null, m.fromName || null, m.subject || null, m.receivedDateTime, bodyName, dest, Buffer.byteLength(bodyHtml), m.id]
          );
          if (ins.rowCount) {
            pooled++;
            try { await parseAndStoreDoc({ id: ins.rows[0].id, file_path: dest, content_type: 'text/html', file_name: bodyName }); } catch { /* parse best-effort */ }
          }
        } catch (e) { console.error('[invoice-inbox] body save failed:', (e as Error).message); await notifyImportFailure(m, 'Could not save email body: ' + (e as Error).message); failed++; }
      }
      if (m.receivedDateTime > maxIso) maxIso = m.receivedDateTime;
    } catch (e) {
      console.error('[invoice-inbox] message handling failed:', (e as Error).message);
      await notifyImportFailure(m, (e as Error).message);
      failed++;
      if (m.receivedDateTime > maxIso) maxIso = m.receivedDateTime;
    }
  }

  await setSetting(GROUP, LAST_KEY, maxIso);
  // Best-effort auto-match of anything new (and any still-unmatched docs).
  try { await autoMatchInvoices(); } catch (e) { console.error('[invoice-inbox] automatch failed:', (e as Error).message); }
  return { fetched: msgs.length, pooled, failed };
}

// ── Auto-match ──────────────────────────────────────────────────────────────────
// Best-effort: tie a pooled invoice to a bank transaction without anyone clicking.
// We can't reliably read the PDF, so we match on signals we DO have: an amount in the
// subject/filename, the supplier name (from the sender), and date proximity. We only
// auto-attach when it's high-confidence AND unambiguous; everything else waits for a human.

function extractAmount(s: string): number | null {
  const m = String(s || '').match(/(?:£|gbp\s*)?(\d{1,3}(?:,\d{3})*\.\d{2})\b/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}
const GENERIC_DOMAINS = /^(gmail|outlook|hotmail|yahoo|icloud|me|live|aol|msn)$/i;
function supplierTokens(doc: any): string[] {
  const out: string[] = [];
  if (doc.from_name) {
    const cleaned = String(doc.from_name).replace(/\b(ltd|limited|plc|llp|invoices?|billing|accounts?|finance|noreply|no-reply|donotreply)\b/gi, '').trim();
    const w = cleaned.split(/\s+/)[0];
    if (w && w.length >= 3) out.push(w.toLowerCase());
  }
  if (doc.from_email) {
    const dom = (String(doc.from_email).split('@')[1] || '').split('.')[0];
    if (dom && dom.length >= 3 && !GENERIC_DOMAINS.test(dom)) out.push(dom.toLowerCase());
  }
  return out;
}

export interface AutoMatchResult { matched: number; considered: number; byClaude: number; suggested: number; aiRead: number }

export async function autoMatchInvoices(opts?: { useAi?: boolean }): Promise<AutoMatchResult> {
  // Claude costs money per call, so it is opt-outable and only ever reached below, after
  // the free rules have had their go.
  const useAi = opts?.useAi ?? ((await getSetting(GROUP, 'ai_matching')) !== '0');
  const docs = (await pool.query(
    `SELECT d.*, a.ai_supplier FROM purchase_documents d
       LEFT JOIN purchase_doc_ai a ON a.document_id = d.id
      WHERE d.status <> 'attached' AND d.archived_at IS NULL
      ORDER BY d.received_at DESC NULLS LAST`
  )).rows;
  let matched = 0, byClaude = 0, suggested = 0, aiRead = 0;
  for (const d of docs) {
    // Backfill: read the invoice text if we haven't yet, so we have its gross total.
    if (!d.parse_status) { try { await parseAndStoreDoc(d); const r = await pool.query('SELECT parsed_amount, parsed_invoice_no FROM purchase_documents WHERE id=$1', [d.id]); d.parsed_amount = r.rows[0]?.parsed_amount; d.parsed_invoice_no = r.rows[0]?.parsed_invoice_no; } catch { /* ignore */ } }
    // A scan or photo yields no text at all, and nothing downstream can match on nothing.
    // Have Claude LOOK at the document. This is the OCR step, and it runs once per document.
    if (useAi && !d.ai_read_status && (d.parse_status === 'no_text' || d.parse_status === 'error' || d.parsed_amount == null)) {
      try {
        const r = await aiReadInvoiceDoc(d);
        if (r) {
          aiRead++;
          const row = (await pool.query('SELECT parsed_amount, parsed_invoice_no, parsed_date FROM purchase_documents WHERE id=$1', [d.id])).rows[0];
          if (row) { d.parsed_amount = row.parsed_amount; d.parsed_invoice_no = row.parsed_invoice_no; d.parsed_date = row.parsed_date; }
        }
      } catch (e) { console.error('[invoice-inbox] AI read failed:', (e as Error).message); }
    }
    const tokens = supplierTokens(d);
    // Prefer the amount read off the invoice itself; fall back to the subject/filename.
    const amount = (d.parsed_amount != null ? Number(d.parsed_amount) : null) ?? extractAmount(d.subject || '') ?? extractAmount(d.file_name || '');
    if (!amount && !tokens.length) continue; // nothing to match on
    const anchor = d.received_at || d.created_at;
    // Candidate transactions: money out, not yet pushed, no receipt yet, within ±45 days.
    const cands = (await pool.query(
      `SELECT id, amount, counterparty, description, reference, booked_at FROM bank_transactions
        WHERE amount < 0 AND status IN ('new','categorised') AND attachment_path IS NULL
          AND booked_at BETWEEN $1::timestamp - INTERVAL '45 days' AND $1::timestamp + INTERVAL '45 days'`,
      [anchor]
    )).rows;
    // Bank references often carry the supplier's own invoice number — the single strongest
    // signal we have, and until Sep 2026 it was parsed off the PDF and then never used.
    // Only trusted at 5+ characters: a 3-digit "042" collides with half the statement.
    const invNo = String(d.parsed_invoice_no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const invNoUsable = invNo.length >= 5;
    const scored = cands.map((t: any) => {
      const hay = ((t.counterparty || '') + ' ' + (t.description || '') + ' ' + (t.reference || '')).toLowerCase();
      const hayAlnum = hay.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const invNoHit = invNoUsable && hayAlnum.includes(invNo);
      // The statement descriptor often names the PROCESSOR, not the supplier
      // (FastSpring→MSP360, BlueSnap→Atera, Aventis→rent, DWS→Giacom…). Fold the
      // alias tokens for this transaction into the supplier check.
      const aliases = aliasTokensFor(hay);
      const supplierHit = tokens.some((tok) => hay.includes(tok)) || aliases.some((al) => tokens.some((tok) => tok.includes(al) || al.includes(tok)));
      const amountHit = amount != null && Math.abs(Number(t.amount)) === amount;
      // USD-billed card charges (Anthropic/CrashPlan/MSP360) land in GBP at a
      // 0.68–0.95 ratio of the invoice total — a fuzzy hit, only trusted with a supplier hit.
      const ratio = amount ? Math.abs(Number(t.amount)) / amount : 0;
      const fxHit = !amountHit && amount != null && supplierHit && isFxBilled(hay) && ratio >= FX_MIN && ratio <= FX_MAX;
      const days = Math.abs((new Date(t.booked_at).getTime() - new Date(anchor).getTime()) / 86400000);
      let score = 0;
      if (amountHit) score += 3;
      if (fxHit) score += 2;
      if (supplierHit) score += 2;
      if (invNoHit) score += 4;
      if (days <= 14) score += 1;
      return { t, score, amountHit, fxHit, supplierHit, invNoHit };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best) continue;
    // High-confidence to auto-attach: the invoice total matches a payment AND either the
    // supplier name also matches, OR that exact total is unique in the window (so there's
    // no other candidate it could be). It must also clearly beat the runner-up.
    // FX-billed suppliers qualify on supplier + ratio when the fuzzy hit is unique.
    const exactAmountMatches = scored.filter((s) => s.amountHit).length;
    const fxMatches = scored.filter((s) => s.fxHit).length;
    // The supplier's own invoice number appearing in the bank reference is decisive on its
    // own, PROVIDED only one transaction carries it — two would mean the number is noise.
    const invNoMatches = scored.filter((s) => s.invNoHit).length;
    const confident = (best.invNoHit && invNoMatches === 1)
      || (best.amountHit
      && (best.supplierHit || exactAmountMatches === 1)
      && (scored.length < 2 || best.score - scored[1].score >= 2))
      || (best.fxHit && fxMatches === 1 && (scored.length < 2 || best.score - scored[1].score >= 2));
    if (confident) {
      const why = best.invNoHit ? `invoice number ${d.parsed_invoice_no} appears in the bank reference`
        : best.amountHit ? 'invoice total matches the payment exactly' + (best.supplierHit ? ' and the supplier matches' : ' and no other payment in the window matches that total')
        : 'supplier matches and the USD/GBP conversion is in range';
      await attachDocToTxn(d, best.t.id, 'rules', null, why);
      matched++;
      continue;
    }

    // ── The rules could not settle it. Ask Claude. ────────────────────────────────
    // Only reached for genuinely ambiguous documents, so this is a small fraction of the
    // pool. Claude is given the invoice, the shortlist, and what we have LEARNED about
    // this supplier from matches a human already confirmed.
    if (!useAi || !scored.length) continue;
    const shortlist = scored.slice(0, 10).map((sc) => sc.t);
    let verdict = null as Awaited<ReturnType<typeof aiJudgeMatch>>;
    try { verdict = await aiJudgeMatch(d, shortlist, await getSupplierProfile(supplierKey(d))); }
    catch (e) { console.error('[invoice-inbox] AI judge failed:', (e as Error).message); }
    if (!verdict) continue;

    // Claude raising a concern is worth a human's eye whatever it decided about the match.
    if (verdict.concern) {
      await pool.query(
        `INSERT INTO purchase_anomalies (dedupe_key, kind, severity, title, detail, amount, document_id, supplier_key, status, first_seen_at, last_seen_at)
         VALUES ($1,'ai_concern','medium',$2,$3,$4,$5,$6,'open',NOW(),NOW())
         ON CONFLICT (dedupe_key) DO UPDATE SET detail=EXCLUDED.detail, last_seen_at=NOW()`,
        ['ai_concern:' + d.id, 'Claude flagged something on ' + (d.file_name || 'an invoice'), verdict.concern,
         d.parsed_amount != null ? Number(d.parsed_amount) : null, d.id, supplierKey(d) || null]
      ).catch(() => {});
    }
    if (!verdict.txnId) continue;

    // A verdict does not get to overrule the arithmetic. If some OTHER payment is the
    // unique exact match for this invoice total, Claude picking a different one is a
    // contradiction, and a contradiction is a human's call, not an auto-attach.
    const exactElsewhere = scored.some((sc) => sc.amountHit && sc.t.id !== verdict!.txnId) && exactAmountMatches === 1;
    if (verdict.confidence >= 90 && !exactElsewhere) {
      await attachDocToTxn(d, verdict.txnId, 'claude', verdict.confidence, verdict.reason);
      matched++; byClaude++;
    } else if (verdict.confidence >= 60) {
      // Not sure enough to act. Propose it — one click on the screen accepts it.
      await pool.query(
        'UPDATE purchase_documents SET suggest_txn_id=$1, suggest_confidence=$2, suggest_reason=$3 WHERE id=$4',
        [verdict.txnId, verdict.confidence, verdict.reason + (exactElsewhere ? ' [held back: another payment is the exact-amount match]' : ''), d.id]
      ).catch(() => {});
      suggested++;
    }
  }
  return { matched, considered: docs.length, byClaude, suggested, aiRead };
}

// The ONE place an invoice becomes attached to a payment, so provenance is always recorded
// and the supplier profile always learns. Every caller — rules, Claude, a human clicking
// Accept — comes through here.
export async function attachDocToTxn(
  doc: any, txnId: number, by: 'rules' | 'claude' | 'human', confidence: number | null, reason: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE bank_transactions SET attachment_path=$1, attachment_name=$2, matched_by=$3, match_confidence=$4,
            match_reason=$5, matched_at=NOW(), updated_at=NOW() WHERE id=$6`,
    [doc.file_path, doc.file_name, by, confidence, reason, txnId]
  );
  await pool.query(
    "UPDATE purchase_documents SET status='attached', bank_transaction_id=$1, suggest_txn_id=NULL, suggest_confidence=NULL, suggest_reason=NULL WHERE id=$2",
    [txnId, doc.id]
  );
  try { await learnFromMatch(doc.id, txnId); } catch (e) { console.error('[invoice-inbox] learn failed:', (e as Error).message); }
}

let _started = false;
export function startInvoiceInbox(): void {
  if (_started || !graphConfigured()) return;
  _started = true;
  cron.schedule('*/15 * * * *', () => {
    syncInvoiceInbox()
      .then((r) => { if (r.pooled) console.log(`[invoice-inbox] +${r.pooled} invoice doc(s) pooled`); })
      .catch((e) => console.error('[invoice-inbox] error:', e.message));
  });
  console.log('[invoice-inbox] started — polling invoice mailbox every 15m');
}
