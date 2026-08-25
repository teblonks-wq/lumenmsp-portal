import { CURVE_PALETTE_SCREEN, type CurvePalette } from './oneboard-curve';
import type { SiteYearStats } from './oneboard-baseline';

// ── The year pool ─────────────────────────────────────────────────────────────────
// The board's panels all answer "what happened in the dates you picked". These answer
// "what does this branch look like across 2026 so far" — the same metrics, drawn from
// the whole cached year in oneboard_day_stats rather than the selected range.
//
// The unit is PER DAY, not the year's total. A total says "412 missed at 09:00" which
// sounds enormous and means nothing without dividing by the number of days in your
// head; the year total is in the tooltip for anyone who wants it.
//
// Pure: numbers in, an SVG string out. No database, no clock.

export interface YearSeries {
  days: number;                 // days of history behind these figures
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

export interface YearBar {
  key: string; label: string;
  perDay: number;        // the bar height
  total: number;         // across the whole year — tooltip only
  days: number;          // days the mean is over
  share: number;         // this bar as a share of the row, 0..1 (missed rate, or share of calls)
  shareLabel: string;
}

/** Missed calls per day, by hour of the day, across the year. */
export function yearMissedByHour(y: YearSeries, hours: number[]): YearBar[] {
  return hours.map((h) => ({
    key: String(h),
    label: String(h).padStart(2, '0'),
    perDay: y.days ? y.hourMissed[h] / y.days : 0,
    total: y.hourMissed[h],
    days: y.days,
    share: y.hourTotal[h] ? y.hourMissed[h] / y.hourTotal[h] : 0,
    shareLabel: y.hourTotal[h] ? `${Math.round((y.hourMissed[h] / y.hourTotal[h]) * 100)}% of that hour's calls` : 'no calls',
  }));
}

/** Every incoming call per day, by hour of the day, across the year. */
export function yearCallsByHour(y: YearSeries, hours: number[]): YearBar[] {
  const all = y.hourTotal.reduce((n, v) => n + v, 0);
  return hours.map((h) => ({
    key: String(h),
    label: String(h).padStart(2, '0'),
    perDay: y.days ? y.hourTotal[h] / y.days : 0,
    total: y.hourTotal[h],
    days: y.days,
    share: all ? y.hourTotal[h] / all : 0,
    shareLabel: all ? `${Math.round((y.hourTotal[h] / all) * 100)}% of the day's calls` : 'no calls',
  }));
}

const DOW3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Missed calls per day, by day of the week, across the year. */
export function yearMissedByDow(y: YearSeries): YearBar[] {
  return DOW3.map((name, d) => ({
    key: name,
    label: name,
    perDay: y.dowDays[d] ? y.dowMissed[d] / y.dowDays[d] : 0,
    total: y.dowMissed[d],
    days: y.dowDays[d],
    share: y.dowTotal[d] ? y.dowMissed[d] / y.dowTotal[d] : 0,
    shareLabel: y.dowTotal[d] ? `${Math.round((y.dowMissed[d] / y.dowTotal[d]) * 100)}% of that day's calls` : 'no calls',
  }));
}

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
function n1(v: number): string { return v >= 10 ? v.toFixed(0) : v.toFixed(1); }

/**
 * One row of bars — thin marks, hairline grid, a single direct label on the tallest
 * bar and every other value in a tooltip. One colour for the whole series: these are
 * one measure over an ordered scale, so a per-bar ramp would double-encode the height
 * and buy nothing.
 */
export function yearBarSvg(opts: {
  label: string; bars: YearBar[]; unit: string;
  tone?: 'missed' | 'calls';
  palette?: CurvePalette; width?: number; height?: number;
}): string {
  const p = opts.palette || CURVE_PALETTE_SCREEN;
  const colour = opts.tone === 'calls' ? p.accent : p.bad;
  const W = opts.width || 780, H = opts.height || 168;
  const padL = 40, padR = 14, padT = 18, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bars = opts.bars;
  if (!bars.length) return '';

  const peak = Math.max(...bars.map((b) => b.perDay));
  const yMax = peak <= 0 ? 1 : peak <= 2 ? Math.ceil(peak * 2) / 2 : Math.ceil(peak);
  const Y = (v: number) => padT + plotH - Math.min(1, v / yMax) * plotH;
  const slot = plotW / bars.length;
  const bw = Math.max(3, Math.min(38, slot - 8));
  const X = (i: number) => padL + slot * i + slot / 2;
  const ax = (v: number) => (yMax >= 10 ? v.toFixed(0) : v.toFixed(1));

  const grid = [0, 0.5, 1].map((f) => {
    const y = padT + plotH - f * plotH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${y + 3.5}" text-anchor="end" font-size="9.5" fill="${p.faint}">${ax(yMax * f)}</text>`;
  }).join('');

  const body = bars.map((b, i) => {
    const yBase = padT + plotH, yTop = Y(b.perDay);
    const h = Math.max(b.perDay > 0 ? 1 : 0, yBase - yTop);
    const tip = `${opts.label} ${b.label} — ${n1(b.perDay)} ${opts.unit} on an average day`
      + ` · ${b.total} in total over ${b.days} day${b.days === 1 ? '' : 's'} · ${b.shareLabel}`;
    const bar = b.days
      ? `<rect x="${X(i) - bw / 2}" y="${yBase - h}" width="${bw}" height="${h}" fill="${colour}" rx="2"/>`
      : `<text x="${X(i)}" y="${yBase - 4}" text-anchor="middle" font-size="9" fill="${p.faint}" opacity="0.7">none</text>`;
    return `<g><title>${esc(tip)}</title>`
      + `<rect x="${X(i) - slot / 2}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>`
      + bar + `</g>`
      + `<text x="${X(i)}" y="${H - 9}" text-anchor="middle" font-size="9.5" fill="${p.faint}">${esc(b.label)}</text>`;
  }).join('');

  let peakI = 0; bars.forEach((b, i) => { if (b.perDay > bars[peakI].perDay) peakI = i; });
  const lbl = bars[peakI].perDay > 0
    ? `<text x="${X(peakI)}" y="${Math.max(padT - 4, Y(bars[peakI].perDay) - 6)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${p.ink}">${n1(bars[peakI].perDay)}</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-label="${esc(opts.label)} — ${esc(opts.unit)} per day across the year" style="display:block;max-width:100%;">`
    + grid
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${p.grid}" stroke-width="1"/>`
    + body + lbl + `</svg>`;
}
