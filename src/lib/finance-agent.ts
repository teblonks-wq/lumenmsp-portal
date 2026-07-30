import { pool } from '../db/pool';
import { aiAskText } from './ai-compose';
import { GoCardless } from './gocardless';
import { QuickBooks } from './quickbooks';
import { getComms } from '../routes/comms';

// ── Finance Agent v3 — conversational, customer-wide, reconciliation-grade ──────
// (Terry, 2026-07-30: follow-ups, better format, adviser on the invoice overview,
// full GoCardless access, "real searchable and relatable answers" — the acceptance
// case: "Minchinhampton Post Office claimed they had overpaid".)
//
// Two scopes share one engine:
//   invoice  — one invoice + its thread (the v2 corpus, kept)
//   customer — EVERY invoice + EVERY GoCardless payment on the mandate + credits,
//              with the reconciliation PRE-COMPUTED in code so the model narrates
//              verified arithmetic instead of doing sums itself.
// Conversations persist (finance_ai_conversations / finance_ai_messages) so staff
// can follow up; each turn rebuilds the data pack fresh (live GC/QB) and carries
// the prior Q&A as context. Answers are markdown (tables encouraged), rendered
// client-side by the shared partial.

const money = (v: any) => '£' + (Number(v) || 0).toFixed(2);
const dISO = (v: any) => v ? new Date(v).toISOString().slice(0, 10) : '-';

function plainText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Invoice-scope corpus (v2, compacted) ────────────────────────────────────────
async function buildInvoiceBlocks(invoiceId: number): Promise<{ blocks: string[]; customerId: number | null } | null> {
  const inv = (await pool.query(
    `SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = $1 AND i.deleted_at IS NULL LIMIT 1`, [invoiceId])).rows[0];
  if (!inv) return null;
  const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id', [invoiceId])).rows;
  const blocks: string[] = [];
  blocks.push(`[INV] Invoice ${inv.invoice_number || '(unnumbered draft)'} — "${inv.title || ''}" | Customer: ${inv.customer_name || 'none'} | Status: ${inv.status} / payment ${inv.payment_status} | Scheme: ${inv.invoice_scheme || '-'} | Issued ${dISO(inv.issue_date)}, due ${dISO(inv.due_date)} | Subtotal ${money(inv.subtotal)} + VAT ${money(inv.tax_total)} = TOTAL ${money(inv.total)} | Balance on record: ${money(inv.balance)} | QuickBooks id: ${inv.quickbooks_invoice_id || 'not pushed'} | GoCardless payment: ${inv.gocardless_payment_id || 'not submitted'} | GC payout ref: ${inv.gocardless_payout_ref || '-'}` + (inv.notes ? `\nNotes: ${String(inv.notes).slice(0, 1200)}` : ''));
  items.forEach((it: any, i: number) => blocks.push(`[L${i + 1}] ${it.description} | qty ${it.quantity} × ${money(it.unit_price)} @ ${it.tax_rate}% VAT = ${money(it.line_total)}`));

  if (inv.gocardless_payment_id) {
    try {
      const gc = await GoCardless.load();
      if (gc.isConfigured()) {
        const pmt = await gc.getPayment(inv.gocardless_payment_id);
        const collected = Number(pmt?.amount || 0) / 100;
        const mismatch = Math.abs(collected - Number(inv.total || 0)) > 0.005;
        blocks.push(`[GC] LIVE GoCardless payment ${inv.gocardless_payment_id}: collected ${money(collected)} | status ${pmt?.status || '?'} | charge date ${pmt?.charge_date || '?'} | description "${pmt?.description || ''}"` +
          (mismatch ? `\n!!! MISMATCH: money actually collected (${money(collected)}) does NOT equal the invoice's current total (${money(inv.total)}) — the document was probably edited after collection.` : `\nCollected amount matches the invoice total.`));
      }
    } catch (e: any) { blocks.push(`[GC] GoCardless lookup failed: ${String(e.message || '').slice(0, 140)}`); }
  }
  if (inv.quickbooks_invoice_id) {
    try {
      const qbc = await QuickBooks.load();
      if (qbc.isConnected()) {
        const qi = await qbc.getInvoice(String(inv.quickbooks_invoice_id));
        if (qi) {
          const qbTotal = Number(qi.TotalAmt || 0);
          const drift = Math.abs(qbTotal - Number(inv.total || 0)) > 0.005;
          blocks.push(`[QB] QuickBooks #${inv.quickbooks_invoice_id} (DocNumber ${qi.DocNumber || '-'}): total ${money(qbTotal)} | balance ${money(qi.Balance ?? qbTotal)} | date ${qi.TxnDate || '-'} | customer "${qi.CustomerRef?.name || ''}"` +
            (drift ? `\n!!! QB DRIFT: QuickBooks holds ${money(qbTotal)} but the portal document totals ${money(inv.total)} — edited after push.` : `\nQuickBooks matches the portal document.`));
        }
      }
    } catch (e: any) { blocks.push(`[QB] QuickBooks lookup failed: ${String(e.message || '').slice(0, 140)}`); }
  }
  if (inv.customer_id) {
    const crs = (await pool.query('SELECT id, amount, reason, status, source_invoice_id, applied_invoice_id, created_at FROM customer_credits WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 15', [inv.customer_id])).rows;
    if (crs.length) blocks.push('[CRED] Customer credits:\n' + crs.map((cr: any) => `[C${cr.id}] ${money(cr.amount)} ${cr.status} — ${String(cr.reason || '').slice(0, 120)} (source inv id ${cr.source_invoice_id || '-'}, applied to inv id ${cr.applied_invoice_id || '-'}, ${dISO(cr.created_at)})`).join('\n'));
  }
  const thread = await getComms('invoice', invoiceId);
  for (const m of thread.slice(-12)) {
    const who = m.direction === 'outbound' ? `Lumen (${m.sent_by_name || 'sent'}) → ${m.to_email || ''}` : `from ${m.from_name || m.from_email || 'customer'}`;
    blocks.push(`[T${m.id}] ${who} · ${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')} | ${m.subject || ''}\n${plainText(m.body || '').slice(0, 6000)}`);
  }
  return { blocks, customerId: inv.customer_id || null };
}

// ── Customer-scope corpus: ALL invoices + ALL GC payments + pre-computed recon ──
async function buildCustomerBlocks(customerId: number): Promise<{ blocks: string[] } | null> {
  const cust = (await pool.query('SELECT id, name, gocardless_mandate_id, billing_contact_id FROM customers WHERE id=$1 AND deleted_at IS NULL', [customerId])).rows[0];
  if (!cust) return null;
  const blocks: string[] = [];

  const invs = (await pool.query(
    `SELECT id, invoice_number, title, invoice_scheme, status, payment_status, issue_date, due_date,
            subtotal, tax_total, total, balance, gocardless_payment_id, gocardless_payout_ref, quickbooks_invoice_id, emailed_at
       FROM invoices WHERE customer_id=$1 AND deleted_at IS NULL AND COALESCE(is_recurring,false)=false AND COALESCE(staged,false)=false
      ORDER BY issue_date NULLS LAST, id`, [customerId])).rows;

  let payments: any[] = [];
  let gcErr = '';
  if (cust.gocardless_mandate_id) {
    try {
      const gc = await GoCardless.load();
      if (gc.isConfigured()) payments = await gc.listPayments(cust.gocardless_mandate_id);
    } catch (e: any) { gcErr = String(e.message || '').slice(0, 140); }
  }

  // ── Reconciliation, computed here — the model narrates, it does not do sums ──
  const invByGcId = new Map<string, any>();
  for (const iv of invs) if (iv.gocardless_payment_id) invByGcId.set(String(iv.gocardless_payment_id), iv);
  const GOOD = new Set(['paid_out', 'confirmed', 'submitted', 'pending_submission', 'pending_customer_approval']);
  const collected = payments.filter((p) => GOOD.has(String(p.status)));
  const failed = payments.filter((p) => !GOOD.has(String(p.status)));
  let totalCollected = 0;
  const payLines: string[] = []; const overCollections: string[] = []; const unmatchedPays: string[] = [];
  for (const p of collected) {
    const amt = Number(p.amount || 0) / 100;
    totalCollected += amt;
    const match = invByGcId.get(String(p.id));
    let note: string;
    if (match) {
      const diff = amt - Number(match.total || 0);
      note = `→ ${match.invoice_number}` + (Math.abs(diff) > 0.005 ? ` !!! collected ${money(amt)} vs invoice total ${money(match.total)} (diff ${diff > 0 ? '+' : ''}${money(Math.abs(diff)).slice(1)}${diff > 0 ? ' OVER' : ' UNDER'})` : ' ✓ matches');
      if (diff > 0.005) overCollections.push(`${match.invoice_number}: collected ${money(amt)} vs ${money(match.total)} → ${money(diff)} over`);
    } else {
      note = '→ NO portal invoice carries this payment id' + (p.description ? ` (description: "${String(p.description).slice(0, 60)}")` : '');
      unmatchedPays.push(`${p.id} ${money(amt)} on ${p.charge_date || '?'} — "${String(p.description || '').slice(0, 60)}"`);
    }
    payLines.push(`| ${p.charge_date || '?'} | ${money(amt)} | ${p.status} | ${String(p.description || '').slice(0, 48)} | ${note} |`);
  }
  const totalInvoiced = invs.filter((iv: any) => iv.status !== 'void' && iv.status !== 'draft').reduce((s: number, iv: any) => s + Number(iv.total || 0), 0);
  const credits = (await pool.query('SELECT id, amount, reason, status, source_invoice_id, applied_invoice_id, created_at FROM customer_credits WHERE customer_id=$1 ORDER BY created_at', [customerId])).rows;
  const openCredit = credits.filter((c: any) => c.status === 'open').reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
  const appliedCredit = credits.filter((c: any) => c.status === 'applied').reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
  const unpaid = invs.filter((iv: any) => iv.status !== 'void' && iv.payment_status !== 'paid' && iv.status !== 'draft');

  blocks.push(`[CUST] ${cust.name} (id ${cust.id}) | GC mandate: ${cust.gocardless_mandate_id || 'NONE — no Direct Debit'}${gcErr ? ` | GC list failed: ${gcErr}` : ''}`);
  blocks.push(`[RECON] PRE-COMPUTED RECONCILIATION (authoritative — narrate this, do not re-derive):
- Invoices issued (non-void, non-draft): ${invs.filter((iv: any) => iv.status !== 'void' && iv.status !== 'draft').length} totalling ${money(totalInvoiced)}
- GoCardless collections (submitted/confirmed/paid_out): ${collected.length} totalling ${money(totalCollected)}
- Failed/cancelled GC payments: ${failed.length}${failed.length ? ' — ' + failed.slice(0, 6).map((p: any) => `${money(Number(p.amount) / 100)} ${p.status} ${p.charge_date || ''}`).join('; ') : ''}
- Credits: ${money(openCredit)} open + ${money(appliedCredit)} applied (credit rows below)
- Currently unpaid invoices: ${unpaid.length}${unpaid.length ? ' — ' + unpaid.map((iv: any) => `${iv.invoice_number || '(draft)'} ${money(iv.total)}`).join('; ') : ''}
- Net cash position vs invoiced: collected ${money(totalCollected)} − invoiced ${money(totalInvoiced)} = ${money(totalCollected - totalInvoiced)} ${totalCollected - totalInvoiced > 0.005 ? '(customer has paid MORE than invoiced)' : totalCollected - totalInvoiced < -0.005 ? '(customer has paid LESS than invoiced)' : '(square)'}
- Payments exceeding their invoice: ${overCollections.length ? overCollections.join('; ') : 'none'}
- Payments with no matching portal invoice: ${unmatchedPays.length ? unmatchedPays.join('; ') : 'none'}`);
  blocks.push('[INVOICES] Every invoice (portal record):\n| # | Title | Issued | Total | Balance | Status | GC ref | Payout |\n' +
    invs.map((iv: any) => `| ${iv.invoice_number || '(draft)'} | ${String(iv.title || '').slice(0, 40)} | ${dISO(iv.issue_date)} | ${money(iv.total)} | ${money(iv.balance)} | ${iv.status}/${iv.payment_status} | ${iv.gocardless_payment_id ? '…' + String(iv.gocardless_payment_id).slice(-6) : '-'} | ${iv.gocardless_payout_ref || '-'} |`).join('\n'));
  if (payLines.length) blocks.push('[PAYMENTS] Every GoCardless collection on the mandate (LIVE):\n| Charged | Amount | Status | Description | Match |\n' + payLines.join('\n'));
  if (credits.length) blocks.push('[CRED] Credits:\n' + credits.map((cr: any) => `[C${cr.id}] ${money(cr.amount)} ${cr.status} — ${String(cr.reason || '').slice(0, 120)} (${dISO(cr.created_at)})`).join('\n'));
  const thread = await getComms('customer', customerId);
  for (const m of thread.slice(-8)) {
    const who = m.direction === 'outbound' ? `Lumen → ${m.to_email || ''}` : `from ${m.from_name || m.from_email || 'customer'}`;
    blocks.push(`[T${m.id}] ${who} · ${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')} | ${m.subject || ''}\n${plainText(m.body || '').slice(0, 4000)}`);
  }
  return { blocks };
}

// ── Conversation plumbing ───────────────────────────────────────────────────────
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_ai_conversations (
      id          SERIAL PRIMARY KEY,
      scope       TEXT NOT NULL,
      invoice_id  INTEGER,
      customer_id INTEGER,
      title       TEXT,
      user_id     INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error('ensure finance_ai_conversations failed:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_ai_messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error('ensure finance_ai_messages failed:', e.message));
  await pool.query('CREATE INDEX IF NOT EXISTS finance_ai_messages_conv_idx ON finance_ai_messages (conversation_id)').catch(() => {});
})();

const ALLOWED_ACTIONS: Record<string, string[]> = {
  draft_reply: ['to', 'subject', 'body'], void_invoice: [],
  create_restatement: ['title', 'line_description', 'net_amount', 'offset_description', 'notes'],
  log_credit: ['amount', 'reason'], zero_balance: [],
};

export async function askFinance(args: {
  scope: 'invoice' | 'customer'; invoiceId?: number | null; customerId?: number | null;
  conversationId?: number | null; question: string; userId: number; userName: string;
}): Promise<{ ok: boolean; error?: string; conversationId?: number | null; answer?: any }> {
  const question = String(args.question || '').trim().slice(0, 800);
  if (!question) return { ok: false, error: 'Ask a question first.' };

  const built = args.scope === 'invoice'
    ? await buildInvoiceBlocks(Number(args.invoiceId))
    : await buildCustomerBlocks(Number(args.customerId));
  if (!built) return { ok: false, error: args.scope === 'invoice' ? 'Invoice not found.' : 'Customer not found.' };

  // Conversation: create or continue.
  let convId = Number(args.conversationId) || null;
  if (convId) {
    const own = (await pool.query('SELECT id FROM finance_ai_conversations WHERE id=$1', [convId])).rows[0];
    if (!own) convId = null;
  }
  if (!convId) {
    convId = (await pool.query(
      'INSERT INTO finance_ai_conversations (scope, invoice_id, customer_id, title, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [args.scope, args.invoiceId || null, args.customerId || null, question.slice(0, 120), args.userId])).rows[0].id;
  }
  const history = (await pool.query(
    'SELECT role, content FROM finance_ai_messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 12', [convId])).rows.reverse();

  let corpus = built.blocks.join('\n\n---\n\n');
  if (corpus.length > 150000) corpus = corpus.slice(0, 75000) + '\n\n[... omitted ...]\n\n' + corpus.slice(-75000);

  const convo = history.map((m: any) => {
    const c = m.content || {};
    return m.role === 'user' ? `STAFF ASKED: ${c.text || ''}` : `YOU ANSWERED:\n${String(c.answer_md || c.answer || '').slice(0, 3000)}`;
  }).join('\n\n');

  const system = [
    "You are the finance adviser inside Lumen IT Solutions' portal, talking to a staff member. Answer billing questions — usually a customer's query — using ONLY the data provided.",
    'Format: answer in clean MARKDOWN ("answer_md"). Use a short verdict paragraph FIRST, then compact tables (| col | col |) for invoice/payment breakdowns, bold for key figures. Keep it tight — this renders in a chat panel.',
    'The [RECON] block (customer scope) is PRE-COMPUTED and authoritative — narrate it, never re-derive the arithmetic. [GC]/[PAYMENTS] are live GoCardless truth about money. [QB] is what the accounts system holds.',
    'This is a CONVERSATION: prior turns may appear before the data. Answer follow-ups in context; the data pack is rebuilt fresh each turn.',
    'When asked "did customer X overpay": compare collected vs invoiced (RECON), call out any payment-vs-invoice mismatches and failed payments, state a clear verdict with the exact figure, and suggest wording the staff member could send the customer.',
    '- If the data cannot answer, say exactly that — NEVER invent figures.',
    '- Reply with STRICT JSON only — no fences:',
    '  {"answer_md":"...","findings":[{"ref":"RECON","quote":"verbatim snippet (max 140 chars)"}],"actions":[]}',
    '- findings: 0-4, quotes verbatim from the blocks. Valid refs: any block tag that appears in the data.',
    args.scope === 'invoice'
      ? '- actions: up to 3 one-click proposals (staff must approve each). Types: draft_reply {to,subject,body — plain text, no sign-off}, void_invoice {}, create_restatement {title,line_description,net_amount(ex-VAT),offset_description,notes}, log_credit {amount,reason}, zero_balance {}. Only when clearly justified.'
      : '- actions: customer scope supports only draft_reply {to,subject,body} — propose it when a customer reply is the natural next step.',
  ].join('\n');

  const userMsg = (convo ? `CONVERSATION SO FAR:\n\n${convo}\n\n---\n\n` : '') + `NEW QUESTION: ${question}\n\nDATA:\n\n${corpus}`;
  const raw = await aiAskText(system, userMsg, 1200);
  let parsed: any;
  try {
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    parsed = JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw);
  } catch { parsed = { answer_md: raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim(), findings: [] }; }

  const actions = (Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : []).map((a: any) => {
    const type = String(a?.type || '');
    if (!(type in ALLOWED_ACTIONS)) return null;
    if (args.scope === 'customer' && type !== 'draft_reply') return null;
    const src = a.params || {}; const params: any = {};
    for (const k of ALLOWED_ACTIONS[type]) {
      if (src[k] === undefined || src[k] === null) continue;
      params[k] = typeof src[k] === 'number' ? src[k] : String(src[k]).slice(0, k === 'body' ? 4000 : 300);
    }
    return { type, label: String(a.label || type).slice(0, 60), why: String(a.why || '').slice(0, 200), params };
  }).filter(Boolean);

  const answer = {
    answer_md: String(parsed.answer_md || parsed.answer || '').slice(0, 8000),
    findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 4).map((f: any) => ({ ref: String(f.ref || ''), quote: String(f.quote || '').slice(0, 200) })) : [],
    actions,
  };

  await pool.query('INSERT INTO finance_ai_messages (conversation_id, role, content) VALUES ($1,$2,$3::jsonb)',
    [convId, 'user', JSON.stringify({ text: question, by: args.userName })]);
  await pool.query('INSERT INTO finance_ai_messages (conversation_id, role, content) VALUES ($1,$2,$3::jsonb)',
    [convId, 'assistant', JSON.stringify(answer)]);
  await pool.query('UPDATE finance_ai_conversations SET updated_at=NOW() WHERE id=$1', [convId]);

  return { ok: true, conversationId: convId, answer };
}

export async function listFinanceConversations(scope: string, refId: number): Promise<any[]> {
  return (await pool.query(
    `SELECT v.id, v.title, v.created_at, v.updated_at, u.display_name AS started_by,
            (SELECT COUNT(*) FROM finance_ai_messages m WHERE m.conversation_id=v.id) AS messages
       FROM finance_ai_conversations v LEFT JOIN users u ON u.id=v.user_id
      WHERE v.scope=$1 AND ${scope === 'invoice' ? 'v.invoice_id' : 'v.customer_id'}=$2
      ORDER BY v.updated_at DESC LIMIT 30`, [scope, refId])).rows;
}

export async function getFinanceConversation(id: number): Promise<any[]> {
  return (await pool.query(
    'SELECT id, role, content, created_at FROM finance_ai_messages WHERE conversation_id=$1 ORDER BY id', [id])).rows;
}
