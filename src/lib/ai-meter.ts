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
  [/loc\.ts/, 'loc'],
  [/mcp\.ts/, 'mcp'],
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
