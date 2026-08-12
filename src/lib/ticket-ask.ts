import { pool } from '../db/pool';
import { aiAskText, aiAskCached, parseJsonAnswer, stripTrailingJson, AskUsage } from './ai-compose';

// ── Ask Claude across every case ────────────────────────────────────────────────
// "How many reports have we had from Larkmead about slow printers?" is a question the
// helpdesk could never answer, because the search box only matched a ticket number, a
// subject line and a customer name - and nobody writes "slow printer" in the subject.
// The answer lives in the message bodies and the engineers' notes.
//
// Reading every case for every question would be absurdly expensive, so this is a
// two-pass engine:
//   1. PLAN + SHORTLIST - a cheap model turns the question into search terms, a customer
//      and a date window; SQL then finds candidate cases across subjects, descriptions,
//      message bodies AND notes. Recall matters more than precision here: it is better to
//      hand Claude thirty cases and have it reject twenty than to miss the one that counts.
//   2. READ + ANSWER - the shortlisted cases go to Claude in full, in a cached block, and
//      it decides which genuinely match, counts them and cites them.
//
// The shortlist is capped. When the cap bites we SAY SO in the answer rather than quietly
// reporting a count that is really "the first 60 we looked at".

const MAX_CASES = 60;
const MAX_CHARS_PER_CASE = 6000;
// Five, not eight. Every extra term is another full pass over every message body in the
// shortlist, and measured against a 20k-case / 120k-message fixture the difference between
// three terms and eight was 0.2s versus 6.5s. Recall barely moves; latency moves 30x.
const MAX_TERMS = 5;
// A hard ceiling so a pathological question can never tie up a worker. Postgres kills the
// query, we catch it, and the user gets told how to narrow it rather than a spinner forever.
const SEARCH_TIMEOUT_MS = 25000;

export interface AskPlan {
  keywords: string[];
  customer: string | null;
  monthsBack: number | null;
  includeClosed: boolean;
}

export interface TicketAskResult {
  answer: string;
  count: number | null;
  cases: { id: number; ticketNumber: string; customer: string | null; subject: string; why: string }[];
  scanned: number;
  capped: boolean;
  plan: AskPlan;
  usage?: AskUsage;
}

const PLAN_SYSTEM = [
  'You turn a helpdesk question into a database search plan for a UK managed-service provider.',
  'Return STRICT JSON only, no markdown fences:',
  '{"keywords":["..."],"customer":null,"monthsBack":null,"includeClosed":true}',
  '',
  '- keywords: 2-5 single words or short phrases that would appear in the TEXT of a matching case - the words a customer or engineer would actually type. Include obvious synonyms and the singular form (a question about "slow printers" should yield printer, printing, slow, spooler, queue). Do NOT include the customer name, dates, or filler words like "how many", "reports", "issues", "problems".',
  '- customer: the customer or company name if the question names one, else null. Copy it as written.',
  '- monthsBack: how far back to look if the question implies a period ("this year" -> 12, "last month" -> 1, "since April" -> count the months), else null for all time.',
  '- includeClosed: true unless the question is clearly only about currently-open work.',
].join('\n');

export async function planSearch(question: string): Promise<AskPlan> {
  let plan: AskPlan = { keywords: [], customer: null, monthsBack: null, includeClosed: true };
  try {
    const raw = await aiAskText(PLAN_SYSTEM, `QUESTION: ${question}`, 300);
    const p = parseJsonAnswer<any>(raw, {});
    plan = {
      keywords: Array.isArray(p.keywords) ? p.keywords.map((k: any) => String(k).trim()).filter(Boolean).slice(0, MAX_TERMS) : [],
      customer: p.customer ? String(p.customer).trim().slice(0, 120) : null,
      monthsBack: Number.isFinite(Number(p.monthsBack)) && Number(p.monthsBack) > 0 ? Math.min(120, Math.round(Number(p.monthsBack))) : null,
      includeClosed: p.includeClosed !== false,
    };
  } catch { /* fall through to the keyword fallback below */ }

  // If the planner gave us nothing usable, fall back to the question's own content words.
  if (!plan.keywords.length) {
    const stop = new Set(['how', 'many', 'what', 'when', 'which', 'have', 'has', 'had', 'we', 'us', 'our', 'the', 'a', 'an',
      'about', 'from', 'for', 'with', 'and', 'or', 'any', 'are', 'is', 'was', 'were', 'reports', 'report', 'issue', 'issues',
      'problem', 'problems', 'tickets', 'ticket', 'cases', 'case', 'been', 'that', 'this', 'they', 'them', 'all', 'been']);
    plan.keywords = question.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w)).slice(0, MAX_TERMS);
  }
  return plan;
}

export interface ShortlistRow {
  id: number; ticket_number: string; subject: string; description: string | null;
  status: string; category: string | null; created_at: Date; customer_name: string | null; hits: number;
}

export class SearchTooBroad extends Error {}

/** Cases whose subject, description, messages OR notes mention the terms. Ranked by how
 *  many DISTINCT terms they hit, so the most on-topic cases survive the cap.
 *
 *  Shape matters here. The obvious version - a correlated EXISTS over messages and notes
 *  per ticket - did not finish in TEN MINUTES against a 20k-case, 120k-message fixture.
 *  This narrows to candidate cases first (customer, date window, not deleted) and only
 *  then searches their text, so naming a customer turns a scan of every message in the
 *  estate into an indexed lookup of one customer's. Same fixture: 0.2s-6.5s. */
export async function shortlistTickets(plan: AskPlan): Promise<{ rows: ShortlistRow[]; capped: boolean }> {
  const terms = plan.keywords.length ? plan.keywords : ['*'];
  const params: any[] = [terms.map((k) => '%' + k + '%')];
  const cand: string[] = ['t.deleted_at IS NULL', 't.is_spam = false'];

  if (plan.customer) { params.push('%' + plan.customer + '%'); cand.push(`c.name ILIKE $${params.length}`); }
  if (plan.monthsBack) { params.push(plan.monthsBack); cand.push(`t.created_at >= NOW() - make_interval(months => $${params.length})`); }
  if (!plan.includeClosed) cand.push("t.status NOT IN ('resolved','closed')");

  params.push(MAX_CASES + 1);
  const sql = `
    WITH terms AS (SELECT unnest($1::text[]) AS t),
    cand AS (
      SELECT t.id, t.ticket_number, t.subject, t.description, t.status, t.category, t.created_at,
             c.name AS customer_name
        FROM inbox_tickets t
        LEFT JOIN customers c ON c.id = t.customer_id
       WHERE ${cand.join(' AND ')}
    ),
    raw AS (
      SELECT cand.id AS tid, terms.t FROM cand, terms
        WHERE cand.subject ILIKE terms.t OR COALESCE(cand.description,'') ILIKE terms.t
      UNION ALL
      SELECT m.ticket_id, terms.t FROM inbox_messages m JOIN cand ON cand.id = m.ticket_id, terms
        WHERE COALESCE(m.body_text,'') ILIKE terms.t OR COALESCE(m.body_html,'') ILIKE terms.t
      UNION ALL
      SELECT n.ticket_id, terms.t FROM inbox_notes n JOIN cand ON cand.id = n.ticket_id, terms
        WHERE n.note_type <> 'system_log' AND COALESCE(n.body,'') ILIKE terms.t
    ),
    scored AS (SELECT tid, COUNT(DISTINCT t)::int AS hits FROM raw GROUP BY tid)
    SELECT cand.*, s.hits
      FROM scored s JOIN cand ON cand.id = s.tid
     ORDER BY s.hits DESC, cand.created_at DESC
     LIMIT $${params.length}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`);
    const r = await client.query(sql, params);
    await client.query('COMMIT');
    const capped = r.rows.length > MAX_CASES;
    return { rows: r.rows.slice(0, MAX_CASES) as ShortlistRow[], capped };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    // 57014 = statement_timeout. Anything else is a real fault worth surfacing as-is.
    if (e?.code === '57014') throw new SearchTooBroad('That search was too broad to run across the whole case history. Name the customer, or a period ("this year", "since April"), and it will come straight back.');
    throw e;
  } finally {
    client.release();
  }
}

/** HTML → text that KEEPS hidden content (quoted history, footers): the answer is often
 *  in the part the rendered view collapses. */
function plain(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export async function buildTicketCorpus(rows: ShortlistRow[]): Promise<string> {
  if (!rows.length) return '(no cases matched the search terms)';
  const ids = rows.map((r) => r.id);
  const [msgs, notes] = await Promise.all([
    pool.query(
      `SELECT ticket_id, message_direction, from_name, from_email, body_html, body_text,
              COALESCE(received_at, created_at) AS at
         FROM inbox_messages WHERE ticket_id = ANY($1::int[]) ORDER BY ticket_id, at`, [ids]),
    pool.query(
      `SELECT n.ticket_id, n.note_type, n.body, n.created_at AS at, u.display_name AS author
         FROM inbox_notes n LEFT JOIN users u ON u.id = n.user_id
        WHERE n.ticket_id = ANY($1::int[]) AND n.note_type <> 'system_log'
        ORDER BY n.ticket_id, n.created_at`, [ids]),
  ]);

  const byTicket = new Map<number, string[]>();
  for (const m of msgs.rows) {
    const t = plain(m.body_html || '') || String(m.body_text || '');
    if (!t) continue;
    const who = m.message_direction === 'outbound' ? 'Lumen' : (m.from_name || m.from_email || 'customer');
    const when = new Date(m.at).toISOString().slice(0, 10);
    if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, []);
    byTicket.get(m.ticket_id)!.push(`  ${who} (${when}): ${t}`);
  }
  for (const n of notes.rows) {
    const t = plain(n.body || '');
    if (!t) continue;
    const when = new Date(n.at).toISOString().slice(0, 10);
    if (!byTicket.has(n.ticket_id)) byTicket.set(n.ticket_id, []);
    byTicket.get(n.ticket_id)!.push(`  NOTE ${n.author || 'system'} (${when}): ${t}`);
  }

  return rows.map((r) => {
    const head = `[CASE ${r.ticket_number}] ${r.subject || '(no subject)'}\n` +
      `  Customer: ${r.customer_name || 'unassigned'} | Status: ${r.status} | Category: ${r.category || '-'} | Opened: ${new Date(r.created_at).toISOString().slice(0, 10)}` +
      (r.description ? `\n  Description: ${plain(r.description)}` : '');
    let body = (byTicket.get(r.id) || []).join('\n');
    const room = MAX_CHARS_PER_CASE - head.length;
    if (body.length > room) body = body.slice(0, Math.max(0, room)) + '\n  …(rest of this case trimmed)…';
    return head + (body ? '\n' + body : '');
  }).join('\n\n---\n\n');
}

const ANSWER_SYSTEM = [
  'You are the helpdesk analyst for Lumen IT Solutions, a UK managed-service provider. You are answering a question about their WHOLE case history.',
  'You are given a shortlist of cases found by a keyword search. The search casts a wide net, so SOME OF THEM WILL NOT ACTUALLY MATCH - your job is to read them and decide.',
  '',
  'Rules:',
  '- Judge each case on what it is really about, not on whether a word appeared. A case that merely mentions a printer in a signature block is not a printer fault.',
  '- COUNTING questions ("how many...") must give a number, and that number must equal the number of cases you cite. Count cases, not messages.',
  '- Cite the cases you counted by their ticket number, each with a few words on why it qualifies.',
  '- If none of the shortlisted cases genuinely match, say so plainly and give the count as 0. Do not stretch to find matches.',
  '- Never invent a case, a ticket number or a detail. Everything comes from the shortlist.',
  '- Look for the pattern behind the answer where there is one worth naming - a recurring site, a common cause, a customer it keeps happening to. One or two sentences, only if it is real.',
  '- British English. Direct and brief. No preamble.',
  '',
  'Reply with STRICT JSON only, no markdown fences:',
  '{"answer":"2-5 short paragraphs, plain text, \\n between paragraphs","count":0,"cases":[{"ticketNumber":"INC-1234","why":"a few words"}]}',
  'Set "count" to null for a question that is not asking for a number. List at most 25 cases even if more match - and if you do trim the list, say so in the answer.',
].join('\n');

export async function askTickets(question: string): Promise<TicketAskResult> {
  const plan = await planSearch(question);
  const { rows, capped } = await shortlistTickets(plan);

  if (!rows.length) {
    return {
      answer: `Nothing in the case history matches that.\n\nI searched every case (subjects, descriptions, message bodies and engineers' notes) for: ${plan.keywords.join(', ')}${plan.customer ? `, limited to customers matching "${plan.customer}"` : ''}${plan.monthsBack ? `, in the last ${plan.monthsBack} months` : ''}.\n\nIf you expected results, the wording may be different in the cases themselves — try the words an engineer would have typed.`,
      count: 0, cases: [], scanned: 0, capped: false, plan,
    };
  }

  const corpus = await buildTicketCorpus(rows);
  const capNote = capped
    ? `\n\nIMPORTANT: the keyword search matched MORE than ${MAX_CASES} cases and only the ${MAX_CASES} strongest are shown above. Say in your answer that the true figure is at least your count, not exactly it.`
    : '';
  const { text, usage } = await aiAskCached(ANSWER_SYSTEM, corpus, `QUESTION: ${question}${capNote}`, { maxTokens: 2000, strong: true });
  const parsed = parseJsonAnswer<any>(text, { answer: stripTrailingJson(text), count: null, cases: [] });

  const byNumber = new Map(rows.map((r) => [String(r.ticket_number).toUpperCase(), r]));
  const cases = (Array.isArray(parsed.cases) ? parsed.cases : []).slice(0, 25).map((c: any) => {
    const num = String(c?.ticketNumber || '').trim().toUpperCase();
    const row = byNumber.get(num);
    return row
      ? { id: row.id, ticketNumber: row.ticket_number, customer: row.customer_name, subject: row.subject, why: String(c?.why || '').slice(0, 160) }
      : null;
  }).filter(Boolean) as TicketAskResult['cases'];

  return {
    answer: String(parsed.answer || stripTrailingJson(text)).slice(0, 8000),
    count: Number.isFinite(Number(parsed.count)) ? Number(parsed.count) : null,
    cases, scanned: rows.length, capped, plan, usage,
  };
}
