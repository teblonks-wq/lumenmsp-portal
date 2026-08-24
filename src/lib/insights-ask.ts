import { OneBoardData, OneBoardSite, ONEBOARD_HOURS, DOW_LABELS } from './oneboard';
import { aiAskCached, parseJsonAnswer, stripTrailingJson, AskUsage } from './ai-compose';

// ── Ask Insights ────────────────────────────────────────────────────────────────
// The staffing questions nobody could answer without exporting to Excel first:
// "if I got another receptionist for Cholsey, when should they work?", "when do we miss
// the most calls?", "is Monday morning really our problem or does it just feel like it?"
//
// The corpus is the whole OneBoard grid rendered as text. It is small (a few thousand
// tokens even for a multi-site customer) and IDENTICAL between one question and the next,
// so it goes in a cache_control block - the second and third question in a sitting pay a
// fraction of the first one's input cost.

export interface InsightsAnswer {
  /** The decision, in one line. This is the bit somebody actually needs. */
  headline: string;
  /** Two or three short paragraphs of reasoning - NO arithmetic. */
  answer: string;
  /** The hour-by-hour sums. Kept out of the way behind "Show the working", because the
   *  numbers are what makes the answer checkable and also what makes it unreadable. */
  working: string;
  points: { label: string; value: string }[];
  /** Set when the question asks for a longer period than the board is showing. */
  periodWarning: string | null;
  usage?: AskUsage;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const avg = (n: number, d: number) => (d > 0 ? (n / d).toFixed(1) : '0.0');

function siteBlock(s: OneBoardSite, data: OneBoardData): string {
  if (!s.configured || !s.metrics) return `SITE: ${s.label}\n  (no call logic configured - no data)`;
  const m = s.metrics;
  const lines: string[] = [];
  lines.push(`SITE: ${s.label}`);
  lines.push(`  Totals: ${m.total} calls, ${m.answered} answered, ${m.missed} missed (${m.rate}% answered)`);
  if (s.prev) {
    lines.push(`  Previous equivalent period: ${s.prev.total} calls, ${s.prev.missed} missed (${s.prev.rate}% answered)`);
  }
  // "Up on last week" and "normal" are different questions and the model must be able to
  // tell them apart, so the mean for these same weekdays is given as its own line.
  if (s.baseline) {
    const e = s.baseline.expected;
    const volume = e.total ? Math.round(((m.total - e.total) / e.total) * 100) : 0;
    lines.push(`  NORMAL FOR THESE WEEKDAYS (${data.baselineName}, built from ${s.baseline.daysCovered} days ${data.baselineFrom} to ${data.baselineTo}): ${e.total} calls, ${e.missed} missed (${e.rate}% answered).`);
    lines.push(`    This period is ${volume >= 0 ? '+' : ''}${volume}% on call volume and ${m.rate - e.rate >= 0 ? '+' : ''}${m.rate - e.rate} percentage points on answer rate versus that normal.`);
    if (s.baseline.gapDays) lines.push(`    (${s.baseline.gapDays} day(s) in this range are a weekday with no history of its own, so the overall daily mean was used for them.)`);
  }
  if (s.curve?.length) {
    lines.push(`  DEMAND THROUGH THE DAY - calls per day in each hour, this period v ${data.baselineName}, and whether the hour cleared the ${data.target}% answer target:`);
    for (const c of s.curve) {
      const base = c.baseAvg == null ? '' : ` (normally ${avg(c.baseAvg, 1)})`;
      const rate = c.rate == null ? 'too few calls to judge' : `${c.rate}% answered, ${c.verdict}`;
      lines.push(`    ${String(c.hour).padStart(2, '0')}:00 ${avg(c.avg, 1)} calls/day${base} - ${rate}`);
    }
  }

  lines.push('  BY DAY OF WEEK (the range covers a different number of each weekday, so the per-day averages are the fair comparison):');
  for (let d = 0; d < 7; d++) {
    const seen = s.daysSeenByDow[d] || 0;
    if (!seen) continue;
    const tot = s.totalByDow[d] || 0;
    const mis = s.missedByDow[d] || 0;
    lines.push(`    ${DOW_LABELS[d]}: ${tot} calls, ${mis} missed (${pct(mis, tot)}% missed) over ${seen} ${DOW_LABELS[d]}${seen === 1 ? '' : 's'} = ${avg(tot, seen)} calls/day, ${avg(mis, seen)} missed/day`);
  }

  const hdr = ONEBOARD_HOURS.map((h) => String(h).padStart(2, '0')).join(' ');
  lines.push(`  MISSED CALLS BY WEEKDAY x HOUR (columns ${hdr}, Europe/London):`);
  for (let d = 0; d < 7; d++) {
    if (!(s.daysSeenByDow[d] || 0)) continue;
    const row = ONEBOARD_HOURS.map((h) => String(s.missedByDowHour[d]?.[h] ?? 0).padStart(2, ' ')).join(' ');
    lines.push(`    ${DOW_LABELS[d].slice(0, 3)}: ${row}`);
  }
  lines.push(`  ALL INCOMING CALLS BY WEEKDAY x HOUR (same columns):`);
  for (let d = 0; d < 7; d++) {
    if (!(s.daysSeenByDow[d] || 0)) continue;
    const row = ONEBOARD_HOURS.map((h) => String(s.totalByDowHour[d]?.[h] ?? 0).padStart(2, ' ')).join(' ');
    lines.push(`    ${DOW_LABELS[d].slice(0, 3)}: ${row}`);
  }
  return lines.join('\n');
}

export function buildInsightsCorpus(data: OneBoardData, from: string, to: string): string {
  const included = data.sites.filter((s) => s.included);
  const spanDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const head = [
    `CUSTOMER: ${data.insName}`,
    `PERIOD: ${from} to ${to} inclusive (${spanDays} days)`,
    'DEFINITIONS: "missed" includes abandoned calls - a caller who hung up waiting counts as missed.',
    'All times are Europe/London wall-clock. Hourly columns cover 07:00-19:00 only; calls outside those hours are in the totals but not the grid.',
    `DEFINITIONS: "${data.baselineName}" is the mean for the SAME WEEKDAYS across ${data.baselineFrom} to ${data.baselineTo} - it answers "is this normal", where the previous-period figures answer "are we up or down". An hour is judged only when it carried enough calls to judge; hours marked "quiet" are not evidence of poor cover.`,
    data.compareNote ? `NOTE: ${data.compareNote}` : null,
  ].filter(Boolean).join('\n');
  // The blank line matters: without it the last header line runs straight into "SITE:".
  return head + '\n\n' + included.map((s) => siteBlock(s, data)).join('\n\n') + '\n';
}

const SYSTEM = [
  'You are the call-data analyst for Lumen IT Solutions, a UK managed-service provider. You are answering a question from Lumen staff or a customer manager about ONE customer\'s inbound call performance.',
  'You are given a grid of that customer\'s calls: totals, a weekday breakdown, and missed/total calls by weekday x hour.',
  '',
  'ANSWER THE QUESTION THAT WAS ASKED, FIRST AND PLAINLY. If somebody asks which days and hours to hire for, the first thing they read must be the days and the hours - not a caveat, not a description of the data. Caveats come after the answer, never before it.',
  '',
  'How to answer:',
  '- Work from the numbers given. NEVER invent a figure. If the grid genuinely cannot answer, say plainly what is missing and what you WOULD need.',
  '- Staffing and cover questions are the point of this tool. Commit to a specific recommendation: named weekdays, clock hours, and how many of the missed calls that shift would have covered.',
  '- Prefer PER-DAY averages when comparing weekdays. The range rarely holds the same number of each weekday, and raw weekday totals mislead - the grid gives you both, use the average.',
  '- Distinguish "lots of calls" from "lots of MISSED calls". A busy hour that is fully answered needs no help; a quiet hour where half the callers give up does.',
  '- Be honest about thin data, but do not let it stop you answering. Give the recommendation, then say how confident it is and what would firm it up.',
  '- British English. Concise and direct. No preamble, no restating the question.',
  '',
  'Reply with STRICT JSON only. No prose before it, no prose after it, no markdown fences:',
  '{"headline":"...","answer":"...","working":"...","points":[{"label":"...","value":"..."}]}',
  '',
  '- headline: THE ANSWER, one line, no more than about 15 words. For a hiring question that means the days and the hours, e.g. "Monday and Tuesday, 08:00-10:00 and 16:00-18:00". Never put a caveat in the headline.',
  '- answer: 2-4 SHORT paragraphs (\\n between them) saying why, and how confident it is. Plain sentences. Keep the hour-by-hour sums OUT of here.',
  '- working: all the arithmetic - the per-hour figures and the addition that gets to the totals you quote. This is displayed behind a "Show the working" toggle, so it can be as dense as it needs to be. Empty string if there is no arithmetic.',
  '- points: 0 to 4 key figures for on-screen chips, e.g. label "Worst hour" value "Tue 09:00 - 13 missed of 23".',
].join('\n');

/** The board shows what it shows. If somebody asks for two months while looking at one
 *  week, that mismatch is the single most important thing to tell them - and it is a fact
 *  about the page, not something the model should have to infer. */
export function periodMismatch(question: string, from: string, to: string): string | null {
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const m = question.toLowerCase().match(/(\d+)\s*(month|week|year)/);
  if (!m) return null;
  const want = Number(m[1]) * (m[2] === 'month' ? 30 : m[2] === 'year' ? 365 : 7);
  if (want <= days * 1.5) return null;
  return `You asked about ${m[1]} ${m[2]}${Number(m[1]) === 1 ? '' : 's'}, but this board is showing ${days} day${days === 1 ? '' : 's'} (${from} to ${to}). The answer below is based on those ${days} days only — widen the date range above and ask again for the fuller picture.`;
}

export async function askInsights(
  data: OneBoardData, from: string, to: string, question: string,
): Promise<InsightsAnswer> {
  const corpus = buildInsightsCorpus(data, from, to);
  const { text, usage } = await aiAskCached(SYSTEM, corpus, `QUESTION: ${question}`, { maxTokens: 1800, strong: true });
  const parsed = parseJsonAnswer<{ headline?: string; answer?: string; working?: string; points?: any[] }>(
    text, { answer: stripTrailingJson(text) });
  return {
    headline: String(parsed.headline || '').slice(0, 200),
    answer: String(parsed.answer || stripTrailingJson(text)).slice(0, 6000),
    working: String(parsed.working || '').slice(0, 6000),
    points: Array.isArray(parsed.points)
      ? parsed.points.slice(0, 4).map((p: any) => ({ label: String(p?.label || '').slice(0, 40), value: String(p?.value || '').slice(0, 80) })).filter((p) => p.label && p.value)
      : [],
    periodWarning: periodMismatch(question, from, to),
    usage,
  };
}
