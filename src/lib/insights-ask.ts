import { OneBoardData, OneBoardSite, ONEBOARD_HOURS, DOW_LABELS } from './oneboard';
import { aiAskCached, parseJsonAnswer, AskUsage } from './ai-compose';

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
  answer: string;
  points: { label: string; value: string }[];
  usage?: AskUsage;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const avg = (n: number, d: number) => (d > 0 ? (n / d).toFixed(1) : '0.0');

function siteBlock(s: OneBoardSite): string {
  if (!s.configured || !s.metrics) return `SITE: ${s.label}\n  (no call logic configured - no data)`;
  const m = s.metrics;
  const lines: string[] = [];
  lines.push(`SITE: ${s.label}`);
  lines.push(`  Totals: ${m.total} calls, ${m.answered} answered, ${m.missed} missed (${m.rate}% answered)`);
  if (s.prev) {
    lines.push(`  Previous equivalent period: ${s.prev.total} calls, ${s.prev.missed} missed (${s.prev.rate}% answered)`);
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
    data.compareNote ? `NOTE: ${data.compareNote}` : null,
  ].filter(Boolean).join('\n');
  // The blank line matters: without it the last header line runs straight into "SITE:".
  return head + '\n\n' + included.map(siteBlock).join('\n\n') + '\n';
}

const SYSTEM = [
  'You are the call-data analyst for Lumen IT Solutions, a UK managed-service provider. You are answering a question from Lumen staff or a customer manager about ONE customer\'s inbound call performance.',
  'You are given a grid of that customer\'s calls: totals, a weekday breakdown, and missed/total calls by weekday x hour.',
  '',
  'How to answer:',
  '- Work from the numbers given. NEVER invent a figure. If the grid cannot answer the question, say plainly what is missing and what you WOULD need.',
  '- Staffing and cover questions ("when should another receptionist work?", "what hours should we add?") are the point of this tool. Answer them concretely: name the weekdays and the clock hours, and say how many of the missed calls that shift would have been on hand for. Show the arithmetic in one line so it can be checked.',
  '- Prefer PER-DAY averages when comparing weekdays. The range rarely holds the same number of each weekday, and raw weekday totals mislead - the grid gives you both, use the average.',
  '- Call out the difference between "lots of calls" and "lots of MISSED calls". A busy hour that is fully answered needs no help; a quiet hour where half the callers give up does.',
  '- Be honest about small numbers. If a recommendation rests on a handful of calls or a single week, say so rather than dressing it up.',
  '- British English. Concise and direct - the reader is busy. No preamble, no restating the question.',
  '',
  'Reply with STRICT JSON only, no markdown fences:',
  '{"answer":"your answer, 2-6 short paragraphs, plain text with \\n between paragraphs","points":[{"label":"short label","value":"the number or finding"}]}',
  '0 to 4 points, each a key figure worth putting on screen (e.g. label "Worst hour" value "Mon 09:00 - 14 missed"). Omit points entirely for a question that has no headline number.',
].join('\n');

export async function askInsights(
  data: OneBoardData, from: string, to: string, question: string,
): Promise<InsightsAnswer> {
  const corpus = buildInsightsCorpus(data, from, to);
  const { text, usage } = await aiAskCached(SYSTEM, corpus, `QUESTION: ${question}`, { maxTokens: 1500, strong: true });
  const parsed = parseJsonAnswer<{ answer?: string; points?: any[] }>(text, { answer: text, points: [] });
  return {
    answer: String(parsed.answer || text).slice(0, 6000),
    points: Array.isArray(parsed.points)
      ? parsed.points.slice(0, 4).map((p: any) => ({ label: String(p?.label || '').slice(0, 40), value: String(p?.value || '').slice(0, 80) })).filter((p) => p.label && p.value)
      : [],
    usage,
  };
}
