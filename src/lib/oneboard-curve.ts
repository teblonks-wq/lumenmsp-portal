import { ONEBOARD_HOURS } from './oneboard-core';
import type { DowBucket, SiteYearStats } from './oneboard-baseline';

// ── The demand curve — "when in the day are we actually meeting demand?" ──────────
// Every function here is PURE: numbers in, numbers or SVG out, no database, no clock.
// That is deliberate — src/scripts/test-oneboard.ts exercises this file directly, and
// the PDF exporter and the on-screen board must draw the SAME picture from the same
// maths rather than each hand-rolling it.
//
// One axis only: height is calls per hour. Whether an hour is being met is carried by
// the marker's colour AND shape (never colour alone), because a second y-scale for
// answer-rate would invent a correlation that isn't in the data.

/** Below this many real calls in an hour, an answer rate is noise — 0 of 1 is not "0%
 *  cover", it is one call. Such hours are drawn grey and excluded from the verdict. */
export const CURVE_MIN_SAMPLE = 5;
/** How far under target still counts as "close" rather than "short". */
export const CURVE_NEAR_BAND = 10;
export const CURVE_TARGET_DEFAULT = 90;

export type HourVerdict = 'met' | 'near' | 'short' | 'quiet';

export interface CurveHour {
  hour: number;
  total: number;            // calls in this hour across the selected range
  answered: number;
  avg: number;              // calls in this hour on an average day of the range
  rate: number | null;      // answered % this range, null when below CURVE_MIN_SAMPLE
  baseAvg: number | null;   // calls in this hour on a typical day of the baseline year
  baseRate: number | null;  // answered % for this hour across the baseline year
  verdict: HourVerdict;
}

export interface RangeBaseline {
  daysCovered: number;                       // days of history the mean is built from
  firstDay: string | null;
  lastDay: string | null;
  expected: { total: number; answered: number; missed: number; rate: number };
  hourAvg: number[];                         // 24 — DOW-weighted to the selected range
  hourRate: (number | null)[];               // 24
  gapDays: number;                           // days in the range whose weekday has no history
}

function mean(part: number, days: number): number {
  return days > 0 ? part / days : 0;
}

/**
 * Scale a year of history onto the dates actually on screen, weighted by weekday.
 *
 * A flat "per day" mean is wrong for exactly the reason the board already warns about
 * on the day-of-week panel: a Mon–Fri range and a Mon–Sun range are not the same five
 * days, and a Sunday with the doors shut is not evidence of a quiet business. So the
 * expectation for a range is the sum, over its days, of the mean for THAT WEEKDAY.
 */
export function baselineForRange(stats: SiteYearStats, daysSeenByDow: number[]): RangeBaseline {
  const byDow: DowBucket[] = stats.byDow;
  const allDays = byDow.reduce((n, b) => n + b.days, 0);
  const allTotal = byDow.reduce((n, b) => n + b.total, 0);
  const allAns = byDow.reduce((n, b) => n + b.answered, 0);
  const allHour = Array(24).fill(0) as number[];
  const allHourAns = Array(24).fill(0) as number[];
  for (const b of byDow) for (let h = 0; h < 24; h++) { allHour[h] += b.hourTotal[h] || 0; allHourAns[h] += b.hourAnswered[h] || 0; }

  let total = 0, answered = 0, gapDays = 0, rangeDays = 0;
  const hourSum = Array(24).fill(0) as number[];
  const hourAnsSum = Array(24).fill(0) as number[];

  for (let d = 0; d < 7; d++) {
    const seen = daysSeenByDow[d] || 0;
    if (!seen) continue;
    rangeDays += seen;
    const b = byDow[d];
    // No history for this weekday (a range containing the only Sunday of the year) —
    // fall back to the overall daily mean and say how many days that covers.
    const useAll = !b || !b.days;
    if (useAll) gapDays += seen;
    const days = useAll ? allDays : b.days;
    const t = useAll ? allTotal : b.total;
    const a = useAll ? allAns : b.answered;
    const ht = useAll ? allHour : b.hourTotal;
    const ha = useAll ? allHourAns : b.hourAnswered;
    total += seen * mean(t, days);
    answered += seen * mean(a, days);
    for (let h = 0; h < 24; h++) {
      hourSum[h] += seen * mean(ht[h] || 0, days);
      hourAnsSum[h] += seen * mean(ha[h] || 0, days);
    }
  }

  const expTotal = Math.round(total);
  const expAns = Math.round(answered);
  return {
    daysCovered: stats.daysCovered,
    firstDay: stats.firstDay,
    lastDay: stats.lastDay,
    expected: {
      total: expTotal,
      answered: expAns,
      missed: Math.max(0, expTotal - expAns),
      rate: total > 0 ? Math.round((answered / total) * 100) : 0,
    },
    hourAvg: hourSum.map((n) => (rangeDays ? n / rangeDays : 0)),
    hourRate: hourSum.map((n, h) => (n >= 1 ? (hourAnsSum[h] / n) * 100 : null)),
    gapDays,
  };
}

export function verdictFor(total: number, answered: number, target: number): HourVerdict {
  if (total < CURVE_MIN_SAMPLE) return 'quiet';
  const rate = (answered / total) * 100;
  if (rate >= target) return 'met';
  if (rate >= target - CURVE_NEAR_BAND) return 'near';
  return 'short';
}

export function buildCurve(input: {
  totalByHour: number[]; missedByHour: number[]; days: number;
  baseline: RangeBaseline | null; target: number;
}): CurveHour[] {
  const { totalByHour, missedByHour, days, baseline, target } = input;
  return ONEBOARD_HOURS.map((h) => {
    const total = totalByHour[h] || 0;
    const answered = Math.max(0, total - (missedByHour[h] || 0));
    return {
      hour: h,
      total,
      answered,
      avg: days > 0 ? total / days : 0,
      rate: total >= CURVE_MIN_SAMPLE ? Math.round((answered / total) * 100) : null,
      baseAvg: baseline ? baseline.hourAvg[h] : null,
      baseRate: baseline && baseline.hourRate[h] != null ? Math.round(baseline.hourRate[h] as number) : null,
      verdict: verdictFor(total, answered, target),
    };
  });
}

export interface CurveSummary {
  met: number; near: number; short: number; quiet: number; judged: number;
  weakest: CurveHour | null;       // worst judged hour
  peak: CurveHour | null;          // busiest hour
  callsMet: number;                // calls answered inside hours that met the target
  callsJudged: number;
}

export function summariseCurve(curve: CurveHour[]): CurveSummary {
  const s: CurveSummary = { met: 0, near: 0, short: 0, quiet: 0, judged: 0, weakest: null, peak: null, callsMet: 0, callsJudged: 0 };
  for (const c of curve) {
    s[c.verdict]++;
    if (!s.peak || c.total > s.peak.total) s.peak = c;
    if (c.verdict === 'quiet') continue;
    s.judged++;
    s.callsJudged += c.total;
    if (c.verdict === 'met') s.callsMet += c.total;
    if (!s.weakest || (c.rate ?? 100) < (s.weakest.rate ?? 100)) s.weakest = c;
  }
  if (s.peak && s.peak.total === 0) s.peak = null;
  return s;
}

// ── Drawing ───────────────────────────────────────────────────────────────────────
// Two palettes for one renderer: the board uses the Portal's tokens so it follows the
// theme, the PDF uses the same colours as literals because Puppeteer prints a page with
// no stylesheet of ours. Same shapes, same maths, same picture.

export interface CurvePalette {
  ink: string; muted: string; faint: string; grid: string; surface: string;
  accent: string; accentSoft: string; ok: string; warn: string; bad: string; quiet: string;
}

export const CURVE_PALETTE_SCREEN: CurvePalette = {
  ink: 'var(--ink)', muted: 'var(--muted)', faint: 'var(--faint)', grid: 'var(--line)', surface: 'var(--surface)',
  accent: 'var(--accent)', accentSoft: 'var(--accent-soft)', ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', quiet: 'var(--faint)',
};
export const CURVE_PALETTE_PRINT: CurvePalette = {
  ink: '#0f172a', muted: '#64748b', faint: '#94a3b8', grid: '#e2e8f0', surface: '#ffffff',
  accent: '#0ea5b7', accentSoft: '#d7eef3', ok: '#16a34a', warn: '#d97706', bad: '#dc2626', quiet: '#cbd5e1',
};

function verdictColour(v: HourVerdict, p: CurvePalette): string {
  return v === 'met' ? p.ok : v === 'near' ? p.warn : v === 'short' ? p.bad : p.quiet;
}

export const VERDICT_LABEL: Record<HourVerdict, string> = {
  met: 'target met', near: 'just under target', short: 'under target', quiet: 'too few calls to judge',
};

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Marker shapes, so met/near/short survive a colourblind reader, a mono print and a
 *  forced-colours browser. Circle = met, diamond = near, triangle = short, ring = quiet. */
function marker(v: HourVerdict, x: number, y: number, p: CurvePalette): string {
  const fill = verdictColour(v, p);
  const ring = `stroke="${p.surface}" stroke-width="2"`;
  if (v === 'met') return `<circle cx="${x}" cy="${y}" r="4.5" fill="${fill}" ${ring}/>`;
  if (v === 'near') return `<path d="M${x} ${y - 5.5}L${x + 5.5} ${y}L${x} ${y + 5.5}L${x - 5.5} ${y}Z" fill="${fill}" ${ring}/>`;
  if (v === 'short') return `<path d="M${x} ${y - 5.8}L${x + 5.4} ${y + 4.4}L${x - 5.4} ${y + 4.4}Z" fill="${fill}" ${ring}/>`;
  return `<circle cx="${x}" cy="${y}" r="3.4" fill="${p.surface}" stroke="${fill}" stroke-width="1.6"/>`;
}

/**
 * One branch's day as an area chart: filled curve = the selected range, dashed line =
 * the baseline year, one marker per hour carrying the verdict. Scaled to this branch's
 * own peak (branches differ by 10x — a shared scale would flatten the smaller one into
 * a straight line and hide exactly the shape this panel exists to show), which is why
 * the peak is direct-labelled.
 */
export function curveSvg(opts: {
  label: string; curve: CurveHour[]; target: number;
  palette?: CurvePalette; width?: number; height?: number; baselineLabel?: string;
}): string {
  const p = opts.palette || CURVE_PALETTE_SCREEN;
  const W = opts.width || 780, H = opts.height || 188;
  const padL = 40, padR = 14, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const c = opts.curve;
  if (!c.length) return '';
  const peak = Math.max(1, ...c.map((x) => Math.max(x.avg, x.baseAvg || 0)));
  const yMax = peak <= 2 ? Math.ceil(peak * 2) / 2 : Math.ceil(peak);
  const X = (i: number) => padL + (c.length === 1 ? plotW / 2 : (i * plotW) / (c.length - 1));
  const Y = (v: number) => padT + plotH - Math.min(1, v / yMax) * plotH;
  const n1 = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

  const grid = [0, 0.5, 1].map((f) => {
    const y = padT + plotH - f * plotH;
    // One decimal convention down the whole axis: "13 / 6.5 / 0.0" reads like three
    // different scales, which is exactly the sort of small wrongness that costs trust.
    const axis = (v: number) => (yMax >= 10 ? v.toFixed(0) : v.toFixed(1));
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${y + 3.5}" text-anchor="end" font-size="9.5" fill="${p.faint}">${axis(yMax * f)}</text>`;
  }).join('');

  const pts = c.map((x, i) => `${X(i)},${Y(x.avg)}`).join(' ');
  const area = `<path d="M${padL},${padT + plotH} L${pts.split(' ').join(' L')} L${X(c.length - 1)},${padT + plotH} Z" fill="${p.accentSoft}" opacity="0.75"/>`;
  const line = `<polyline points="${pts}" fill="none" stroke="${p.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const hasBase = c.some((x) => x.baseAvg != null);
  const basePts = hasBase ? c.map((x, i) => `${X(i)},${Y(x.baseAvg || 0)}`).join(' ') : '';
  const baseLine = hasBase
    ? `<polyline points="${basePts}" fill="none" stroke="${p.muted}" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" opacity="0.85"/>`
    : '';

  const marks = c.map((x, i) => {
    const rate = x.rate == null ? 'too few calls' : x.rate + '% answered';
    const base = x.baseAvg == null ? '' : ` · ${opts.baselineLabel || 'baseline'} ${n1(x.baseAvg)}/day${x.baseRate == null ? '' : ` at ${x.baseRate}%`}`;
    const tip = `${opts.label} ${String(x.hour).padStart(2, '0')}:00 — ${n1(x.avg)} calls/day, ${rate} (${VERDICT_LABEL[x.verdict]})${base}`;
    // A generous transparent hit area: the visible mark is ~11px, the target is 26px.
    return `<g><title>${esc(tip)}</title>`
      + `<rect x="${X(i) - 13}" y="${padT}" width="26" height="${plotH}" fill="transparent"/>`
      + marker(x.verdict, X(i), Y(x.avg), p) + `</g>`;
  }).join('');

  const axis = c.map((x, i) => (i % 2 === 0 || i === c.length - 1
    ? `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" font-size="9.5" fill="${p.faint}">${String(x.hour).padStart(2, '0')}</text>` : '')).join('');

  // One direct label — the busiest hour. Every other value is in the tooltip and the table.
  let peakLbl = '';
  const peakI = c.reduce((bi, x, i) => (x.avg > c[bi].avg ? i : bi), 0);
  if (c[peakI].avg > 0) {
    const px = X(peakI), py = Y(c[peakI].avg);
    const anchor = peakI === 0 ? 'start' : peakI === c.length - 1 ? 'end' : 'middle';
    peakLbl = `<text x="${px}" y="${Math.max(padT - 4, py - 11)}" text-anchor="${anchor}" font-size="10.5" font-weight="700" fill="${p.ink}">${n1(c[peakI].avg)}/day</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-label="${esc(opts.label)} — average calls per hour through the day, ${opts.target}% answer target" `
    + `style="display:block;max-width:100%;">`
    + grid
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${p.grid}" stroke-width="1"/>`
    + area + baseLine + line + marks + peakLbl + axis
    + `</svg>`;
}
