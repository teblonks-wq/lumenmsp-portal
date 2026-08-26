import type { SiteYearStats } from './oneboard-baseline';

// ── The year pool ─────────────────────────────────────────────────────────────────
// The board's panels answer "what happened in the dates you picked". These answer
// "what does this branch look like across 2026 so far" — the same metrics, the same
// heatmap shape, drawn from the whole cached year in oneboard_day_stats.
//
// They are RATES, not counts. Across 236 days a count says "412 missed at 09:00",
// which needs dividing by something before it means anything; a rate says "21% of the
// calls arriving at 09:00 go unanswered", which is a fact you can act on and which
// compares honestly between a busy branch and a quiet one.
//
// Pure: numbers in, numbers and a sentence out. No database, no clock.

export interface YearSeries {
  days: number;
  from: string | null; to: string | null;
  hourTotal: number[];          // 24 — every call in that hour across the year
  hourMissed: number[];         // 24
  dowTotal: number[];           // 7
  dowMissed: number[];          // 7
  dowDays: number[];            // 7 — how many Mondays, Tuesdays… the year holds
}

export function yearSeries(stats: SiteYearStats): YearSeries {
  const hourTotal = Array(24).fill(0) as number[];
  const hourMissed = Array(24).fill(0) as number[];
  const dowTotal = Array(7).fill(0) as number[];
  const dowMissed = Array(7).fill(0) as number[];
  const dowDays = Array(7).fill(0) as number[];
  let days = 0;
  stats.byDow.forEach((b, d) => {
    days += b.days;
    dowDays[d] = b.days;
    dowTotal[d] = b.total;
    dowMissed[d] = b.missed;
    for (let h = 0; h < 24; h++) {
      hourTotal[h] += b.hourTotal[h] || 0;
      hourMissed[h] += Math.max(0, (b.hourTotal[h] || 0) - (b.hourAnswered[h] || 0));
    }
  });
  return { days, from: stats.firstDay, to: stats.lastDay, hourTotal, hourMissed, dowTotal, dowMissed, dowDays };
}

/** Across a whole year, a slot carrying fewer than this many calls cannot support a
 *  percentage — 1 missed of 3 is not "33% missed", it is three calls. Those cells read
 *  blank rather than alarming, exactly as an hour under 5 calls does on the day view. */
export const YEAR_MIN_SAMPLE = 20;

export interface RateCell {
  key: string; label: string;
  pct: number | null;           // null = too few calls across the whole year to judge
  missed: number; total: number;
  days: number;
}

const DOW3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOWFULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function rate(missed: number, total: number): number | null {
  return total >= YEAR_MIN_SAMPLE ? Math.round((missed / total) * 100) : null;
}

/** % of each hour's calls that went unanswered, across the year. */
export function yearMissedRateByHour(y: YearSeries, hours: number[]): RateCell[] {
  return hours.map((h) => ({
    key: String(h), label: String(h).padStart(2, '0') + ':00',
    pct: rate(y.hourMissed[h], y.hourTotal[h]),
    missed: y.hourMissed[h], total: y.hourTotal[h], days: y.days,
  }));
}

/** % of each weekday's calls that went unanswered, across the year. */
export function yearMissedRateByDow(y: YearSeries): RateCell[] {
  return DOW3.map((name, d) => ({
    key: name, label: name,
    pct: rate(y.dowMissed[d], y.dowTotal[d]),
    missed: y.dowMissed[d], total: y.dowTotal[d], days: y.dowDays[d],
  }));
}

/** Share of the year's incoming calls that arrive in each hour. Sums to 100%. */
export function yearShareByHour(y: YearSeries, hours: number[]): RateCell[] {
  const all = y.hourTotal.reduce((n, v) => n + v, 0);
  return hours.map((h) => ({
    key: String(h), label: String(h).padStart(2, '0') + ':00',
    pct: all >= YEAR_MIN_SAMPLE ? Math.round((y.hourTotal[h] / all) * 100) : null,
    missed: y.hourMissed[h], total: y.hourTotal[h], days: y.days,
  }));
}

// ── The observation ───────────────────────────────────────────────────────────────
// One plain sentence per chart, computed from the cells and nothing else. It must say
// something a reader could act on, and it must never reach past what the numbers show:
// no causes, no advice, no "probably". When the data cannot support a statement, it
// says that instead of inventing one.

function judged(cells: RateCell[]): RateCell[] { return cells.filter((c) => c.pct != null); }

function worstBest(cells: RateCell[]): { worst: RateCell; best: RateCell } | null {
  const j = judged(cells);
  if (j.length < 2) return null;
  const sorted = [...j].sort((a, b) => (b.pct as number) - (a.pct as number));
  return { worst: sorted[0], best: sorted[sorted.length - 1] };
}

/** "Worst at 09:00 — 21% of that hour's calls missed, against 6% at your best hour." */
export function observeMissedByHour(cells: RateCell[]): string {
  const j = judged(cells);
  if (!j.length) return 'Too few calls in any hour across the year to judge a rate.';
  const wb = worstBest(cells);
  const overallMissed = j.reduce((n, c) => n + c.missed, 0);
  const overallTotal = j.reduce((n, c) => n + c.total, 0);
  const overall = overallTotal ? Math.round((overallMissed / overallTotal) * 100) : 0;
  if (!wb) return `${overall}% of calls go unanswered across the year, but only one hour carries enough calls to judge.`;
  const quiet = cells.length - j.length;
  const gap = (wb.worst.pct as number) - (wb.best.pct as number);
  const lead = `**${wb.worst.label}** is the weakest hour of the year at **${wb.worst.pct}% missed**`
    + (gap >= 3
      ? `, against ${wb.best.pct}% at ${wb.best.label} — a ${gap}-point spread across the working day.`
      : `, and the day is even — only ${gap} point${gap === 1 ? '' : 's'} separate the best and worst hours.`);
  return `${lead} ${overall}% of calls are missed across the year overall.`
    + (quiet ? ` ${quiet} hour${quiet === 1 ? '' : 's'} carried too few calls to judge.` : '');
}

/** "Monday is the worst day at 14% missed, against 8% on Thursday." */
export function observeMissedByDow(cells: RateCell[]): string {
  const j = judged(cells);
  if (!j.length) return 'Too few calls on any weekday across the year to judge a rate.';
  const wb = worstBest(cells);
  const open = j.filter((c) => c.days > 0).length;
  if (!wb) return `Only one weekday carries enough calls across the year to judge (${j[0].label}, ${j[0].pct}% missed).`;
  const gap = (wb.worst.pct as number) - (wb.best.pct as number);
  if (gap < 3) {
    return `The week is flat: every open day sits within ${gap} point${gap === 1 ? '' : 's'} of the others, `
      + `between ${wb.best.pct}% and ${wb.worst.pct}% missed. Nothing here points at one day.`;
  }
  return `**${DOWFULL[DOW3.indexOf(wb.worst.label)] || wb.worst.label}** is the weakest day of the year at `
    + `**${wb.worst.pct}% missed**, against ${wb.best.pct}% on ${DOWFULL[DOW3.indexOf(wb.best.label)] || wb.best.label} `
    + `— a ${gap}-point spread across ${open} open days.`;
}

/** "Half the year's calls arrive before 11:00; 09:00 alone carries 18%." */
export function observeCallShare(cells: RateCell[]): string {
  const j = judged(cells);
  if (!j.length) return 'Too few calls across the year to describe the shape of the day.';
  let peak = j[0];
  for (const c of j) if ((c.pct as number) > (peak.pct as number)) peak = c;
  // How many hours, taken busiest-first, cover half the day's calls? A blunt but honest
  // measure of how concentrated the demand is.
  const sorted = [...j].sort((a, b) => (b.pct as number) - (a.pct as number));
  let acc = 0, need = 0;
  for (const c of sorted) { acc += c.pct as number; need++; if (acc >= 50) break; }
  return `**${peak.label}** is the busiest hour of the year, carrying **${peak.pct}%** of all incoming calls. `
    + `Half the day's calls land in just ${need} hour${need === 1 ? '' : 's'}.`;
}

// ── Colouring ─────────────────────────────────────────────────────────────────────
// A rate gets ABSOLUTE bands, not a scale-to-the-max ramp. "Deepest red = the worst
// cell here" makes a good year look as alarming as a bad one; 30% missed should be the
// same colour in January as in August, and on every branch.

// TEN steps of four points each. The first cut of this used five uneven bands and put
// everything from 20% to 29% in one colour — which is precisely where this data sits, so
// 21% and 26% rendered identically and the screen said "these hours are the same" when
// they are not. Keep these edges in step with RATE_STEPS/RATE_EDGES in oneboard-board.ejs.
export const RATE_BANDS = [0, 4, 8, 12, 16, 20, 24, 28, 32];   // upper edges; 32+ is the last band

export function rateBand(pct: number | null): number {
  if (pct == null) return -1;               // not judged
  if (pct <= 0) return 0;
  for (let i = 1; i < RATE_BANDS.length; i++) if (pct < RATE_BANDS[i]) return i;
  return RATE_BANDS.length;
}

// ── "How many calls do we actually get at 9am?" ───────────────────────────────────
// Alex Cumiskey, 2026-08-26: "the average incoming calls per hour per branch … for all
// calls since we have been on the new system."
//
// The share-of-day percentage above answers a different question ("when is our busiest
// hour"), and a percentage cannot be staffed against. This one is a COUNT: on a typical
// day, this many calls arrive in this hour.
//
// The denominator is the trap. Dividing by every day in the year would spread the week's
// calls across the branch's closed Sundays and quietly understate every working hour —
// the same mistake the baseline avoids by weighting per weekday. So the divisor is OPEN
// days only: weekdays the branch actually took calls on across the year.

export interface AvgCell {
  key: string; label: string;
  avg: number | null;      // calls per open day in this hour; null = never open in this hour
  total: number;           // calls in this hour across the year
  days: number;            // open days the average is over
}

/** Days the branch was open, judged by whether that weekday carried any calls all year.
 *  A weekday with nothing across a whole year is a closed day, not a quiet one. */
export function openDays(y: YearSeries): number {
  let n = 0;
  for (let d = 0; d < 7; d++) if ((y.dowTotal[d] || 0) > 0) n += y.dowDays[d] || 0;
  return n;
}

/** Average incoming calls per hour, on a typical open day. */
export function yearAvgCallsByHour(y: YearSeries, hours: number[]): AvgCell[] {
  const days = openDays(y);
  return hours.map((h) => ({
    key: String(h), label: String(h).padStart(2, '0') + ':00',
    avg: days > 0 && (y.hourTotal[h] || 0) > 0 ? (y.hourTotal[h] || 0) / days : (days > 0 ? 0 : null),
    total: y.hourTotal[h] || 0, days,
  }));
}

/** "Busiest at 09:00 with 14.2 calls an hour; the day averages 6.1 across 11 open hours." */
export function observeAvgCallsByHour(cells: AvgCell[]): string {
  const live = cells.filter((c) => c.avg != null && (c.total > 0));
  if (!live.length) return 'No calls recorded in any hour across the year.';
  let peak = live[0];
  for (const c of live) if ((c.avg as number) > (peak.avg as number)) peak = c;
  const totalCalls = live.reduce((n, c) => n + c.total, 0);
  const days = live[0].days;
  const perDay = days ? totalCalls / days : 0;
  const mean = live.length ? perDay / live.length : 0;
  const one = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
  return `**${peak.label}** is the busiest hour at **${one(peak.avg as number)} calls an hour** on a typical day. `
    + `The branch takes ${one(perDay)} calls a day across ${live.length} open hour${live.length === 1 ? '' : 's'}, `
    + `averaging ${one(mean)} an hour. Based on ${days} open day${days === 1 ? '' : 's'}.`;
}
