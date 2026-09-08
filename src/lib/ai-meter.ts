import { pool } from '../db/pool';

// ── The Portal meters its own AI spend ──────────────────────────────────────────
// Terry, 2026-09-03, after $288 landed in two days: "we need a dashboard in portal showing
// usage."
//
// Anthropic's console reports by API KEY, so the most it can ever say is "the Portal".
// It cannot say "the purchase matcher re-judged 3,000 documents" or "ticket categorisation
// runs every minute". Only the Portal knows that, so the Portal is where the meter belongs.
//
// One row per call, attributed to the feature that made it, priced when it was made.
// Recording is BEST EFFORT and wrapped: a meter that can break the thing it measures is
// worse than no meter.

// Prices per MILLION tokens, USD. Kept here rather than fetched, so a call is always priced
// even when nothing else is reachable — and so history is never rewritten by a price change.
// Cache reads are a tenth of input; cache writes are input × 1.25.
const PRICES: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /opus/i,   in: 15.00, out: 75.00 },
  { match: /sonnet/i, in:  3.00, out: 15.00 },
  { match: /haiku/i,  in:  0.80, out:  4.00 },
];
const FALLBACK = { in: 3.00, out: 15.00 };

export interface CallUsage {
  inputTokens?: number; outputTokens?: number;
  cacheReadTokens?: number; cacheCreationTokens?: number;
}

export function priceOf(model: string, u: CallUsage): number {
  const p = PRICES.find((x) => x.match.test(model || '')) || FALLBACK;
  const inTok = Number(u.inputTokens || 0);
  const outTok = Number(u.outputTokens || 0);
  const cacheRead = Number(u.cacheReadTokens || 0);
  const cacheWrite = Number(u.cacheCreationTokens || 0);
  return (
    (inTok / 1e6) * p.in +
    (outTok / 1e6) * p.out +
    (cacheRead / 1e6) * (p.in * 0.10) +
    (cacheWrite / 1e6) * (p.in * 1.25)
  );
}

export interface RecordArgs {
  feature: string; model: string; usage?: CallUsage; ms?: number;
  ok?: boolean; error?: string | null;
  refType?: string | null; refId?: number | null; userId?: number | null;
}

export async function recordAiCall(a: RecordArgs): Promise<void> {
  try {
    const u = a.usage || {};
    await pool.query(
      `INSERT INTO ai_calls (feature, model, okay, error_text, input_tokens, output_tokens,
                             cache_read_tokens, cache_create_tokens, cost_usd, ms, ref_type, ref_id, user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
      [a.feature || 'other', a.model || 'unknown', a.ok !== false, a.error ? String(a.error).slice(0, 400) : null,
       Math.round(Number(u.inputTokens || 0)), Math.round(Number(u.outputTokens || 0)),
       Math.round(Number(u.cacheReadTokens || 0)), Math.round(Number(u.cacheCreationTokens || 0)),
       priceOf(a.model, u).toFixed(6), Math.round(a.ms || 0),
       a.refType || null, a.refId ?? null, a.userId ?? null]
    );
  } catch { /* never let the meter break the thing it measures */ }
}

// ── Attribution ─────────────────────────────────────────────────────────────────
// The low-level call functions do not know which feature asked. Rather than thread a label
// through fifteen public functions (and forget one), we read it off the stack. Cheap next to
// a network round trip, and a miss costs a label, never a call.
const FEATURE_BY_FN: Array<[RegExp, string]> = [
  [/aiJudgeMatch/, 'purchase_judge'],
  [/aiReadInvoiceDoc|aiReadUnreadable/, 'purchase_read'],
  [/replyToAnomaly|purchase-rules/, 'purchase_rules'],
  [/aiClassifyTicketCategory/, 'ticket_category'],
  [/ticket-ask|askTicket/, 'ticket_ask'],
  [/insights-ask|askInsights/, 'insights_ask'],
  [/call-report|callReport/, 'call_report'],
  [/aiWriteItReport/, 'it_report'],
  [/aiMarketingPost|aiMassMailEmail|aiImproveEmailHtml/, 'marketing'],
  [/aiPolishText|aiComposeMessage/, 'compose'],
  [/gpo/, 'gpo_review'],
  [/script-review|scriptReview/, 'script_review'],
  [/finance-agent|financeAgent/, 'finance_agent'],
  [/device-ask|deviceAsk/, 'device_ask'],
  // 2026-09-08. The ticket composer's own AI reached the meter with nothing on the stack for
  // any pattern to catch, so 125 real calls sat under 'other' for six days. The phrase ribbon
  // fires on first focus of every composer, which is most of that volume — it deserves its own
  // name, because "the composer is cheap" and "something unnamed is running" read very
  // differently at 2am.
  [/aiTicketPhrases/, 'ticket_phrases'],
  [/aiComposeTicketReply/, 'ticket_reply'],
  // Route handlers that call aiAskCached inline. The handler is an anonymous arrow, so the
  // file path is the only thing on the stack to go on. These sit AFTER the named patterns
  // above — and after ticket-ask — so a more specific match always wins.
  [/routes[\\/]tickets/, 'ticket_ask'],
  [/routes[\\/]invoices/, 'invoice_ask'],
  // 'loc' removed 2026-09-08: lib/loc.ts counts lines of code and has never made an AI call,
  // so the pattern could only ever look like coverage it did not have.
  // 'mcp' kept as a LAST-RESORT catch-all for anything reached through the MCP server, and
  // fixed at the same time: the Portal runs compiled dist/*.js, so a stack frame reads
  // 'dist/routes/mcp.js' and never 'mcp.ts'. The original pattern could not fire.
  [/[\\/]mcp\.(ts|js)/, 'mcp'],
];

export function callerFeature(): string {
  const stack = new Error().stack || '';
  for (const [rx, name] of FEATURE_BY_FN) if (rx.test(stack)) return name;
  return 'other';
}

// ── What the dashboard asks ─────────────────────────────────────────────────────
export interface UsageRow { label: string; calls: number; inTokens: number; outTokens: number; cost: number }

export async function usageBy(field: 'feature' | 'model', days = 30): Promise<UsageRow[]> {
  const col = field === 'feature' ? 'feature' : 'model';
  const r = await pool.query(
    `SELECT ${col} AS label, COUNT(*)::int calls,
            SUM(input_tokens + cache_read_tokens + cache_create_tokens)::bigint in_tok,
            SUM(output_tokens)::bigint out_tok, SUM(cost_usd)::float cost
       FROM ai_calls WHERE created_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY cost DESC NULLS LAST`, [String(days)]
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows.map((x: any) => ({ label: x.label, calls: x.calls, inTokens: Number(x.in_tok || 0), outTokens: Number(x.out_tok || 0), cost: Number(x.cost || 0) }));
}

export async function usageByDay(days = 30): Promise<Array<{ day: string; calls: number; cost: number }>> {
  const r = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') day, COUNT(*)::int calls, SUM(cost_usd)::float cost
       FROM ai_calls WHERE created_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [String(days)]
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows.map((x: any) => ({ day: x.day, calls: x.calls, cost: Number(x.cost || 0) }));
}

export async function usageTotals(): Promise<{ today: number; week: number; month: number; callsToday: number; failedToday: number }> {
  const q = async (sql: string) => Number((await pool.query(sql).catch(() => ({ rows: [{ v: 0 }] }))).rows[0]?.v || 0);
  return {
    today: await q("SELECT COALESCE(SUM(cost_usd),0)::float v FROM ai_calls WHERE created_at >= date_trunc('day', NOW())"),
    week: await q("SELECT COALESCE(SUM(cost_usd),0)::float v FROM ai_calls WHERE created_at > NOW() - INTERVAL '7 days'"),
    month: await q("SELECT COALESCE(SUM(cost_usd),0)::float v FROM ai_calls WHERE created_at > NOW() - INTERVAL '30 days'"),
    callsToday: await q("SELECT COUNT(*)::int v FROM ai_calls WHERE created_at >= date_trunc('day', NOW())"),
    failedToday: await q("SELECT COUNT(*)::int v FROM ai_calls WHERE okay = false AND created_at >= date_trunc('day', NOW())"),
  };
}

// The most expensive single calls — where one document, ticket or question is doing damage.
export async function biggestCalls(limit = 20): Promise<any[]> {
  return (await pool.query(
    `SELECT * FROM ai_calls WHERE created_at > NOW() - INTERVAL '30 days'
      ORDER BY cost_usd DESC LIMIT $1`, [limit]
  ).catch(() => ({ rows: [] as any[] }))).rows;
}

// ── What every AI feature is, and which model slot it runs on ───────────────────
// Deliberately next to FEATURE_BY_FN: a new AI feature needs a pattern AND a row here, and
// keeping them apart is exactly how one gets added without the other — which is how 125 calls
// spent six days as 'other'. `feature` matches the label written to ai_calls, so the screen can
// put the catalogue and the real spend side by side.
//
// One row per OPERATION, not per feature: several features call the model twice at different
// strengths (Ask Portal plans on the cheap slot and answers on the strong one), and a table
// that hides that cannot answer "why did this cost what it did".
export type ModelSlot = 'cheap' | 'strong';
export interface FeatureOp {
  feature: string;      // the label recorded in ai_calls
  name: string;         // what a person would call it
  what: string;         // one line, plain English
  slot: ModelSlot;
  where: string;        // source file, so the next person can find it
  auto: boolean;        // can it fire with nobody pressing anything?
}

export const FEATURE_CATALOGUE: FeatureOp[] = [
  { feature: 'purchase_judge',  name: 'Purchase matching',        what: 'Judges whether a document matches a bank transaction.', slot: 'cheap',  where: 'lib/purchase-agent.ts', auto: true },
  { feature: 'purchase_read',   name: 'Invoice reading — text',   what: 'Turns an invoice\'s extracted text into structured JSON.', slot: 'cheap',  where: 'lib/purchase-agent.ts', auto: true },
  { feature: 'purchase_read',   name: 'Invoice reading — document', what: 'Sends the PDF or image itself when text extraction fails.', slot: 'strong', where: 'lib/purchase-agent.ts', auto: true },
  { feature: 'purchase_rules',  name: 'Anomaly reply',            what: 'Drafts the reply to a purchase anomaly.', slot: 'cheap',  where: 'lib/purchase-rules.ts', auto: true },
  { feature: 'ticket_category', name: 'Ticket auto-category',     what: 'Classifies each incoming email into a category.', slot: 'cheap',  where: 'lib/mailsync.ts, routes/chat.ts', auto: true },
  { feature: 'ticket_ask',      name: 'Ask Portal — plan',        what: 'Works out what to look up before it answers.', slot: 'cheap',  where: 'lib/ticket-ask.ts', auto: false },
  { feature: 'ticket_ask',      name: 'Ask Portal — answer',      what: 'Answers the question over the whole ticket thread.', slot: 'strong', where: 'lib/ticket-ask.ts', auto: false },
  { feature: 'ticket_ask',      name: 'Ticket list question',     what: 'Free-text question from the tickets screen.', slot: 'cheap',  where: 'routes/tickets.ts', auto: false },
  { feature: 'ticket_phrases',  name: 'Phrase ribbon',            what: 'Three suggested phrases — fires on FIRST FOCUS of every composer, so it is the highest-volume feature here.', slot: 'cheap',  where: 'routes/ai.ts', auto: false },
  { feature: 'ticket_reply',    name: 'Claude Update',            what: 'Turns a rough draft into a sendable ticket reply.', slot: 'strong', where: 'routes/ai.ts', auto: false },
  { feature: 'invoice_ask',     name: 'Invoice question',         what: 'Free-text question from the invoices screen.', slot: 'cheap',  where: 'routes/invoices.ts', auto: false },
  { feature: 'insights_ask',    name: 'Ask Insights',             what: 'Answers questions over the call analytics.', slot: 'strong', where: 'lib/insights-ask.ts', auto: false },
  { feature: 'call_report',     name: 'Call report narrative',    what: 'Writes the summary paragraph on a call report.', slot: 'cheap',  where: 'lib/call-report.ts', auto: false },
  { feature: 'it_report',       name: 'IT report narrative',      what: 'Writes the narrative for a customer IT report.', slot: 'cheap',  where: 'lib/it-report/generate.ts', auto: false },
  { feature: 'gpo_review',      name: 'Group policy review',      what: 'Reviews group policies and answers questions about them.', slot: 'strong', where: 'lib/gpo.ts', auto: false },
  { feature: 'script_review',   name: 'Script review',            what: 'Reviews an RMM script. Batches of these are the single biggest spend to date.', slot: 'strong', where: 'lib/script-review.ts', auto: false },
  { feature: 'device_ask',      name: 'Ask a device',             what: 'Answers questions about one device from its collected facts.', slot: 'strong', where: 'lib/device-ask.ts', auto: false },
  { feature: 'finance_agent',   name: 'Finance agent',            what: 'Answers finance questions over the books.', slot: 'cheap',  where: 'lib/finance-agent.ts', auto: false },
  { feature: 'marketing',       name: 'Marketing post',           what: 'Drafts a news or blog article.', slot: 'cheap',  where: 'routes/marketing.ts', auto: false },
  { feature: 'marketing',       name: 'Improve email HTML',       what: 'Tidies an email\'s HTML without changing its structure.', slot: 'cheap',  where: 'routes/marketing.ts', auto: false },
  { feature: 'marketing',       name: 'Mass-mail draft',          what: 'Writes a mass-mail email from rough notes.', slot: 'strong', where: 'routes/marketing.ts', auto: false },
  { feature: 'compose',         name: 'Compose message',          what: 'Turns dictated or typed notes into a clean message.', slot: 'cheap',  where: 'routes/ai.ts', auto: false },
  { feature: 'compose',         name: 'Improve with Claude',      what: 'Polishes any draft into clear British English.', slot: 'cheap',  where: 'routes/ai.ts', auto: false },
  { feature: 'compose',         name: 'Integrations key test',    what: 'The "test the key" call on the Integrations page.', slot: 'cheap',  where: 'routes/integrations.ts', auto: false },
  { feature: 'mcp',             name: 'MCP tools',                what: 'Catch-all for anything reached through the Portal\'s MCP server that no other pattern claims.', slot: 'cheap',  where: 'routes/mcp.ts', auto: false },
];

export interface CatalogueRow extends FeatureOp {
  model: string;          // what this operation will actually run, right now
  calls: number;          // for the FEATURE, over the window
  cost: number;           // for the FEATURE, over the window
  firstOfFeature: boolean;
}

/**
 * The catalogue joined to what the meter has actually seen. Call counts are per FEATURE, not
 * per operation — the meter records one label per call and cannot split it further — so they
 * are shown once against the first operation of each feature rather than repeated.
 */
export async function featureCatalogue(
  models: { cheap: string; strong: string }, days = 30,
): Promise<CatalogueRow[]> {
  const spend = new Map<string, { calls: number; cost: number }>();
  for (const r of await usageBy('feature', days)) spend.set(r.label, { calls: r.calls, cost: r.cost });

  // Dearest feature first, so the screen opens on what matters; operations keep their own order
  // within a feature because that is the order they run in.
  const costOf = (f: string) => spend.get(f)?.cost ?? 0;
  const order = [...new Set(FEATURE_CATALOGUE.map((o) => o.feature))]
    .sort((a, b) => costOf(b) - costOf(a) || a.localeCompare(b));

  const rows: CatalogueRow[] = [];
  for (const feature of order) {
    const ops = FEATURE_CATALOGUE.filter((o) => o.feature === feature);
    ops.forEach((op, i) => rows.push({
      ...op,
      model: op.slot === 'strong' ? models.strong : models.cheap,
      calls: spend.get(feature)?.calls ?? 0,
      cost: spend.get(feature)?.cost ?? 0,
      firstOfFeature: i === 0,
    }));
  }
  return rows;
}

/** A cheap slot pointing at anything but Haiku is a real cost story, so the screen says so. */
export function cheapSlotIsCheap(model: string): boolean {
  return /haiku/i.test(model || '');
}
