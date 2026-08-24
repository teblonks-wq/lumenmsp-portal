import { CURVE_PALETTE_SCREEN, verdictFor, type CurvePalette, type HourVerdict } from './oneboard-curve';

// ── The rest of the board, as charts ──────────────────────────────────────────────
// Same rules as oneboard-curve.ts and the same mark vocabulary, so the whole board
// reads as one thing: ONE axis per chart, the year average always a dashed reference
// line (never a second scale), verdicts carried by colour AND shape, thin marks, a
// hairline grid, and one direct label rather than a number on every mark.
//
// Everything here is PURE — plain numbers in, an SVG string out. src/scripts/
// test-oneboard.ts drives it directly, and the PDF exporter draws from the same
// functions as the screen, so a take-away can never disagree with the board.

export function escSvg(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function n1(v: number): string { return v >= 10 ? v.toFixed(0) : v.toFixed(1); }

/** Shared chrome: three hairline gridlines with labels, and a solid baseline. */
function frame(p: CurvePalette, padL: number, padT: number, plotH: number, W: number, padR: number, yMax: number): string {
  const ax = (v: number) => (yMax >= 10 ? v.toFixed(0) : v.toFixed(1));
  const grid = [0, 0.5, 1].map((f) => {
    const y = padT + plotH - f * plotH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${y + 3.5}" text-anchor="end" font-size="9.5" fill="${p.faint}">${ax(yMax * f)}</text>`;
  }).join('');
  return grid + `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${p.grid}" stroke-width="1"/>`;
}

function verdictColour(v: HourVerdict, p: CurvePalette): string {
  return v === 'met' ? p.ok : v === 'near' ? p.warn : v === 'short' ? p.bad : p.quiet;
}

// ── 1. Daily calls, against the average for that weekday ──────────────────────────
// The reference line MOVES with the day of the week on purpose. A flat "average day"
// line would put every Saturday under it and every Tuesday over it, which describes
// the shape of the week and says nothing about performance.

export interface DailyPoint {
  day: string; label: string;
  total: number; answered: number; missed: number;
  expected: number | null;            // the year's mean for THIS weekday
  verdict: HourVerdict;
}

export function buildDaily(
  daily: { day: string; label: string; total: number; answered: number; missed: number }[],
  dowOf: (day: string) => number,
  baseDowAvg: number[] | null,
  target: number
): DailyPoint[] {
  return daily.map((d) => ({
    day: d.day, label: d.label, total: d.total, answered: d.answered, missed: d.missed,
    expected: baseDowAvg ? baseDowAvg[dowOf(d.day)] : null,
    verdict: verdictFor(d.total, d.answered, target),
  }));
}

export function dailySvg(opts: {
  label: string; points: DailyPoint[]; target: number;
  palette?: CurvePalette; width?: number; height?: number; baselineLabel?: string;
}): string {
  const p = opts.palette || CURVE_PALETTE_SCREEN;
  const W = opts.width || 780, H = opts.height || 190;
  const padL = 40, padR = 14, padT = 18, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const pts = opts.points;
  if (!pts.length) return '';

  const peak = Math.max(1, ...pts.map((d) => Math.max(d.total, d.expected || 0)));
  const yMax = peak <= 2 ? Math.ceil(peak * 2) / 2 : Math.ceil(peak);
  const Y = (v: number) => padT + plotH - Math.min(1, v / yMax) * plotH;
  const slot = plotW / pts.length;
  const bw = Math.max(2, Math.min(26, slot - (slot > 6 ? 3 : 1)));
  const X = (i: number) => padL + slot * i + slot / 2;

  // Stacked bar: answered below, missed above, separated by a 2px gap of surface
  // rather than a drawn border.
  const bars = pts.map((d, i) => {
    if (!d.total) return '';
    const x = X(i) - bw / 2;
    const yTop = Y(d.total), yBase = padT + plotH;
    const missedH = (d.missed / d.total) * (yBase - yTop);
    const ansH = Math.max(0, (yBase - yTop) - missedH);
    const gap = missedH > 3 && ansH > 3 ? 2 : 0;
    const tip = `${opts.label} ${d.label} — ${d.total} calls, ${d.answered} answered, ${d.missed} missed`
      + (d.expected == null ? '' : ` · ${opts.baselineLabel || 'average'} for that weekday is ${n1(d.expected)}`);
    return `<g><title>${escSvg(tip)}</title>`
      + `<rect x="${x}" y="${yBase - ansH}" width="${bw}" height="${ansH}" fill="${p.accent}" rx="${bw > 6 ? 2 : 0}"/>`
      + (missedH > 0 ? `<rect x="${x}" y="${yTop}" width="${bw}" height="${Math.max(1, missedH - gap)}" fill="${p.bad}" rx="${bw > 6 ? 2 : 0}"/>` : '')
      + `</g>`;
  }).join('');

  // The average drawn as a STEP, one flat run per day, so it can never be mistaken
  // for a trend line through the data.
  const hasBase = pts.some((d) => d.expected != null);
  const baseLine = hasBase
    ? `<path d="${pts.map((d, i) => (d.expected == null ? '' : `M${X(i) - slot / 2},${Y(d.expected)} L${X(i) + slot / 2},${Y(d.expected)}`)).filter(Boolean).join(' ')}" fill="none" stroke="${p.muted}" stroke-width="2" stroke-dasharray="5 4" opacity="0.9"/>`
    : '';

  // One mark per day carrying the verdict — the same shapes as the demand curve.
  const marks = pts.map((d, i) => {
    if (!d.total) return '';
    const x = X(i), y = Y(d.total) - 7;
    const fill = verdictColour(d.verdict, p);
    if (d.verdict === 'met') return `<circle cx="${x}" cy="${y}" r="3.2" fill="${fill}"/>`;
    if (d.verdict === 'near') return `<path d="M${x} ${y - 4}L${x + 4} ${y}L${x} ${y + 4}L${x - 4} ${y}Z" fill="${fill}"/>`;
    if (d.verdict === 'short') return `<path d="M${x} ${y - 4.2}L${x + 4} ${y + 3.2}L${x - 4} ${y + 3.2}Z" fill="${fill}"/>`;
    return '';
  }).join('');

  const every = Math.max(1, Math.ceil(pts.length / 8));
  const axis = pts.map((d, i) => (i % every === 0
    ? `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" font-size="9" fill="${p.faint}">${escSvg(d.label)}</text>` : '')).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-label="${escSvg(opts.label)} — calls per day against the average for each weekday" style="display:block;max-width:100%;">`
    + frame(p, padL, padT, plotH, W, padR, yMax) + bars + baseLine + marks + axis + `</svg>`;
}

// ── 2. Day of the week — this period against the same weekday's year average ──────
// Per DAY, never totals. The range rarely holds the same number of each weekday, so a
// raw weekday total makes whichever weekday appeared most often look like the problem.

export interface DowPoint {
  dow: number; seen: number;
  perDay: number; missedPerDay: number;
  basePerDay: number | null; baseMissedPerDay: number | null;
}

export function buildDow(
  totalByDow: number[], missedByDow: number[], daysSeenByDow: number[],
  baseDowAvg: number[] | null, baseDowMissedAvg: number[] | null
): DowPoint[] {
  const out: DowPoint[] = [];
  for (let d = 0; d < 7; d++) {
    const seen = daysSeenByDow[d] || 0;
    out.push({
      dow: d, seen,
      perDay: seen ? (totalByDow[d] || 0) / seen : 0,
      missedPerDay: seen ? (missedByDow[d] || 0) / seen : 0,
      basePerDay: baseDowAvg ? baseDowAvg[d] : null,
      baseMissedPerDay: baseDowMissedAvg ? baseDowMissedAvg[d] : null,
    });
  }
  return out;
}

const DOW3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dowSvg(opts: {
  label: string; points: DowPoint[];
  palette?: CurvePalette; width?: number; height?: number; baselineLabel?: string;
}): string {
  const p = opts.palette || CURVE_PALETTE_SCREEN;
  const W = opts.width || 780, H = opts.height || 190;
  const padL = 40, padR = 14, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const pts = opts.points;
  const peak = Math.max(1, ...pts.map((d) => Math.max(d.perDay, d.basePerDay || 0)));
  const yMax = peak <= 2 ? Math.ceil(peak * 2) / 2 : Math.ceil(peak);
  const Y = (v: number) => padT + plotH - Math.min(1, v / yMax) * plotH;
  const slot = plotW / 7;
  const bw = Math.min(46, slot * 0.52);
  const X = (i: number) => padL + slot * i + slot / 2;

  const body = pts.map((d, i) => {
    const cx = X(i);
    const label = `<text x="${cx}" y="${H - 10}" text-anchor="middle" font-size="10" fill="${p.faint}">${DOW3[i]}</text>`;
    if (!d.seen) {
      return label + `<text x="${cx}" y="${padT + plotH - 6}" text-anchor="middle" font-size="9" fill="${p.faint}" opacity="0.7">none</text>`;
    }
    const yBase = padT + plotH, yTop = Y(d.perDay);
    const h = yBase - yTop;
    const missedH = d.perDay > 0 ? (d.missedPerDay / d.perDay) * h : 0;
    const ansH = Math.max(0, h - missedH);
    const gap = missedH > 3 && ansH > 3 ? 2 : 0;
    const tip = `${opts.label} ${DOW3[i]} — ${n1(d.perDay)} calls/day, ${n1(d.missedPerDay)} missed/day, over ${d.seen} ${DOW3[i]}${d.seen === 1 ? '' : 's'}`
      + (d.basePerDay == null ? '' : ` · ${opts.baselineLabel || 'average'} ${n1(d.basePerDay)}/day`);
    // The year average is a tick ACROSS the bar — a target marker rather than a second
    // bar, so the comparison is read at a glance without doubling the ink.
    const tick = d.basePerDay == null ? '' :
      `<line x1="${cx - bw / 2 - 4}" y1="${Y(d.basePerDay)}" x2="${cx + bw / 2 + 4}" y2="${Y(d.basePerDay)}" stroke="${p.muted}" stroke-width="2" stroke-dasharray="5 4"/>`;
    return `<g><title>${escSvg(tip)}</title>`
      + `<rect x="${cx - bw / 2}" y="${yBase - ansH}" width="${bw}" height="${ansH}" fill="${p.accent}" rx="2"/>`
      + (missedH > 0 ? `<rect x="${cx - bw / 2}" y="${yTop}" width="${bw}" height="${Math.max(1, missedH - gap)}" fill="${p.bad}" rx="2"/>` : '')
      + tick + `</g>` + label;
  }).join('');

  // No direct label here. The obvious one - the worst weekday - lands on top of the
  // tallest bar and collides with its own missed segment, and the sentence above the
  // chart already names it. A label that has to fight the mark it describes is worse
  // than no label.
  const lbl = '';

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-label="${escSvg(opts.label)} — calls per day by weekday against the year average" style="display:block;max-width:100%;">`
    + frame(p, padL, padT, plotH, W, padR, yMax) + body + lbl + `</svg>`;
}

// ── 3. Missed calls by hour, against the year's missed average ────────────────────

export interface MissedHourPoint { hour: number; avg: number; baseAvg: number | null; total: number; missed: number }

export function buildMissedHours(
  hours: number[], missedByHour: number[], totalByHour: number[], days: number, baseHourMissedAvg: number[] | null
): MissedHourPoint[] {
  return hours.map((h) => ({
    hour: h,
    avg: days > 0 ? (missedByHour[h] || 0) / days : 0,
    baseAvg: baseHourMissedAvg ? baseHourMissedAvg[h] : null,
    total: totalByHour[h] || 0,
    missed: missedByHour[h] || 0,
  }));
}

export function missedHourSvg(opts: {
  label: string; points: MissedHourPoint[];
  palette?: CurvePalette; width?: number; height?: number; baselineLabel?: string;
}): string {
  const p = opts.palette || CURVE_PALETTE_SCREEN;
  const W = opts.width || 780, H = opts.height || 176;
  const padL = 40, padR = 14, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const pts = opts.points;
  if (!pts.length) return '';
  const peak = Math.max(0.5, ...pts.map((d) => Math.max(d.avg, d.baseAvg || 0)));
  const yMax = peak <= 2 ? Math.ceil(peak * 2) / 2 : Math.ceil(peak);
  const Y = (v: number) => padT + plotH - Math.min(1, v / yMax) * plotH;
  const X = (i: number) => padL + (pts.length === 1 ? plotW / 2 : (i * plotW) / (pts.length - 1));

  const line = pts.map((d, i) => `${X(i)},${Y(d.avg)}`).join(' ');
  const area = `<path d="M${padL},${padT + plotH} L${line.split(' ').join(' L')} L${X(pts.length - 1)},${padT + plotH} Z" fill="${p.bad}" opacity="0.12"/>`;
  const stroke = `<polyline points="${line}" fill="none" stroke="${p.bad}" stroke-width="2" stroke-linejoin="round"/>`;
  const hasBase = pts.some((d) => d.baseAvg != null);
  const baseLine = hasBase
    ? `<polyline points="${pts.map((d, i) => `${X(i)},${Y(d.baseAvg || 0)}`).join(' ')}" fill="none" stroke="${p.muted}" stroke-width="2" stroke-dasharray="5 4" opacity="0.85"/>`
    : '';

  // A filled marker means this period is worse than the year average for that hour;
  // hollow means it is not. Shape and fill, never colour alone.
  const marks = pts.map((d, i) => {
    const tip = `${opts.label} ${String(d.hour).padStart(2, '0')}:00 — ${n1(d.avg)} missed/day (${d.missed} of ${d.total} calls this period)`
      + (d.baseAvg == null ? '' : ` · ${opts.baselineLabel || 'average'} ${n1(d.baseAvg)}/day`);
    const worse = d.baseAvg != null && d.avg > d.baseAvg + 0.05;
    return `<g><title>${escSvg(tip)}</title>`
      + `<rect x="${X(i) - 13}" y="${padT}" width="26" height="${plotH}" fill="transparent"/>`
      + `<circle cx="${X(i)}" cy="${Y(d.avg)}" r="${worse ? 4.5 : 3.2}" fill="${worse ? p.bad : p.surface}" stroke="${p.bad}" stroke-width="2"/></g>`;
  }).join('');

  const axis = pts.map((d, i) => (i % 2 === 0 || i === pts.length - 1
    ? `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" font-size="9.5" fill="${p.faint}">${String(d.hour).padStart(2, '0')}</text>` : '')).join('');

  let peakI = 0; pts.forEach((d, i) => { if (d.avg > pts[peakI].avg) peakI = i; });
  const peakLbl = pts[peakI].avg > 0
    ? `<text x="${X(peakI)}" y="${Math.max(padT - 4, Y(pts[peakI].avg) - 11)}" text-anchor="${peakI === 0 ? 'start' : peakI === pts.length - 1 ? 'end' : 'middle'}" font-size="10.5" font-weight="700" fill="${p.ink}">${n1(pts[peakI].avg)} missed/day</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-label="${escSvg(opts.label)} — missed calls per hour against the year average" style="display:block;max-width:100%;">`
    + frame(p, padL, padT, plotH, W, padR, yMax) + area + baseLine + stroke + marks + peakLbl + axis + `</svg>`;
}
