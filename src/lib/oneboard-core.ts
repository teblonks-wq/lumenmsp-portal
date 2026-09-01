import { createHash } from 'crypto';
import { type CallJourney, type LogicConfig } from './insights-journeys';

// ── OneBoard shared primitives ────────────────────────────────────────────────────
// The small pieces that the live board (oneboard.ts), the baseline cache
// (oneboard-baseline.ts) and the demand curve (oneboard-curve.ts) all need: the
// Europe/London clock, the Monday-first week, the site-logic reader. They live here so
// those modules never have to import each other — a cycle between them would leave one
// half-initialised at require time (the lib/gpo lesson).
//
// NOTHING in this file touches the database or the network, so the test script can
// import it without a live .env.

export const ONEBOARD_HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 07:00–19:00
export const DOW_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Monday-first index for a YYYY-MM-DD day string. JS getUTCDay() is Sunday-first, and a
 *  working week that starts on Sunday reads wrong to everyone who works here. */
export function dowIndex(day: string): number {
  return (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

// Europe/London wall-clock parts for an ISO timestamp — the same clock the customer reads.
const LDN_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});
export function ldn(iso: string): { day: string; hour: number } {
  const parts = LDN_FMT.formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: parseInt(g('hour'), 10) || 0 };
}

/**
 * Normalise whatever Postgres hands back for a date column into 'YYYY-MM-DD'.
 *
 * node-pg parses a `date`/`timestamp` into a JavaScript **Date object**, not a string.
 * `String(thatDate).slice(0, 10)` therefore yields "Thu Jan 01", not "2026-01-01" — and
 * because every comparison in this module is a plain string compare, "2026-08-24" sorts
 * BEFORE "Thu Jan 01" ('2' < 'T'). That silently convinced the baseline builder that its
 * window ended before it began, so it returned "nothing to do" instantly, for months,
 * without an error. (Found 2026-08-25. The same read exists in the board's
 * compare-previous-period guard, which had been suppressing itself the same way.)
 *
 * Two hand-rolled date reads is how this happened. There is now one.
 */
export function asDay(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const str = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);   // already a day, or an ISO timestamp
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every calendar day in [from, to] so quiet days still show as zero rows, not gaps. */
export function dayList(from: string, to: string, cap = 120): { day: string; label: string }[] {
  const out: { day: string; label: string }[] = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end && out.length < cap) {
    out.push({
      day: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function siteLogicOf(row: any): LogicConfig | null {
  const logic: LogicConfig = row.logic_config || {};
  if (!logic.source_of_truth_group?.length && !logic.staff_extensions?.length) return null; // unconfigured
  if (row.business_hours) logic.business_hours = row.business_hours;
  return logic;
}

/** A short hash of everything that changes what a site's journeys ARE. Cached day stats
 *  carry it, so retuning a site's groups, staff list or business hours invalidates that
 *  site's history instead of silently averaging two different definitions together. */
export function logicFingerprint(row: any): string {
  const key = JSON.stringify({ l: row.logic_config || null, b: row.business_hours || null });
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ── The baseline window ───────────────────────────────────────────────────────────
// Pure date arithmetic, kept here so src/scripts/test-oneboard.ts can prove the January
// edge without a database. What the board calls "the 2026 average" is the current
// calendar year while there is enough of it, and a rolling twelve months when there is
// not — otherwise the whole panel would vanish every New Year's Day and come back a
// month later, which reads as a broken dashboard.

export const BASELINE_FLOOR = '2026-01-01';     // Tollring history floor (tollring-sync HISTORY_FLOOR)
export const BASELINE_WINDOW_DAYS = 365;        // never reach further back than a year
export const BASELINE_MIN_DAYS = 28;            // below this a "typical day" is noise, so we say nothing
const BASELINE_YEAR_MIN_DAYS = 90;              // …and a calendar year shorter than this is not yet a year

/** Today in Europe/London — the baseline never includes today, because a part-finished
 *  day averaged in with whole ones drags "a typical day" down all morning. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function baselineWindow(today: string = londonToday()): { from: string; to: string } {
  const to = addDays(today, -1);
  const yearStart = to.slice(0, 4) + '-01-01';
  const rolling = addDays(to, -(BASELINE_WINDOW_DAYS - 1));
  const useYear = yearStart > rolling && yearStart <= addDays(to, -(BASELINE_YEAR_MIN_DAYS - 1));
  const from = useYear ? yearStart : rolling;
  return { from: from < BASELINE_FLOOR ? BASELINE_FLOOR : from, to };
}

/** "2026 average" while the window sits inside one year, "12-month average" once it doesn't. */
export function baselineLabel(from: string, to: string): string {
  return from.slice(0, 4) === to.slice(0, 4) ? `${to.slice(0, 4)} average` : '12-month average';
}

/** What every OneBoard surface reads off a set of journeys. Kept as one exported type
 *  because five places consume it — the board partial, the CSV, the PDF, the Ask Insights
 *  corpus and the compare block — and a field added here has to reach all of them. */
export interface BoardMetrics {
  total: number;
  answered: number;
  missed: number;
  rate: number;             // % answered
  avgWaitAnswered: number;  // seconds, mean over ANSWERED journeys only
  avgWaitMissed: number;    // seconds, mean over everything not answered
}

export function metricsOf(journeys: CallJourney[]): BoardMetrics {
  const total = journeys.length;
  const answeredJourneys = journeys.filter((j) => j.status === 'Answered');
  const missedJourneys   = journeys.filter((j) => j.status !== 'Answered');
  const answered = answeredJourneys.length;
  const missed = total - answered; // Missed + Abandoned + anything not answered — "missed includes abandoned"

  // Wait is reported SPLIT and never blended. A single average mixes the caller answered in
  // twenty seconds with the caller who rang for five minutes and gave up, and lands on a
  // number describing neither. The Larkmead work of 28 Aug is the worked example of what
  // that hides — see [C] Larkmead voicemail gap - investigation and safeguards.md.
  const meanWait = (js: CallJourney[]): number =>
    js.length ? Math.round(js.reduce((sum, j) => sum + (j.wait_secs || 0), 0) / js.length) : 0;

  return {
    total, answered, missed,
    rate: total ? Math.round((answered / total) * 100) : 0,
    avgWaitAnswered: meanWait(answeredJourneys),
    avgWaitMissed: meanWait(missedJourneys),
  };
}
