import { OneBoardData, OneBoardSite, ONEBOARD_HOURS } from './oneboard';
import { formatWait } from './insights-journeys';
import { curveSvg, CURVE_PALETTE_PRINT, VERDICT_LABEL } from './oneboard-curve';

// ── OneBoard take-away exports — CSV (the data) and PDF (the view) ─────────────────
// Both are built from the SAME OneBoardData the on-screen board renders, so what the
// customer downloads is exactly what they saw. Colours follow the LumenMSP scheme:
// accent #0ea5b7, missed = red sequential ramp, all-calls = brand teal ramp,
// status trio #16a34a / #d97706 / #dc2626.

const HEAT_MISSED = ['#f8fafc', '#fee2e2', '#fca5a5', '#f87171', '#dc2626', '#7f1d1d'];
const HEAT_ALL    = ['#f8fafc', '#d7eef3', '#a5dbe6', '#5cb8ca', '#1f8fa6', '#0e6377'];

function heatCell(n: number, max: number, steps: string[]): { bg: string; ink: string } {
  if (!max || !n) return { bg: steps[0], ink: '#94a3b8' };
  const i = Math.min(5, Math.max(1, Math.ceil((n / max) * 5)));
  return { bg: steps[i], ink: i >= 4 ? '#ffffff' : '#0f172a' };
}

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function includedSites(data: OneBoardData): OneBoardSite[] {
  return data.sites.filter((s) => s.included && s.configured && s.metrics);
}

export function exportFilename(insName: string, from: string, to: string, ext: string): string {
  const base = `OneBoard - ${insName || 'export'} - ${from} to ${to}`.replace(/[^A-Za-z0-9 ._-]/g, '').trim();
  return `${base}.${ext}`;
}

// ── CSV — three sections (daily, missed-by-hour, all-calls-by-hour) in one file ────
export function oneBoardCsv(data: OneBoardData, from: string, to: string): string {
  const q = (v: any) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows: string[] = [];
  const sites = includedSites(data);
  const hourHead = ONEBOARD_HOURS.map((h) => String(h).padStart(2, '0') + ':00');

  rows.push(['OneBoard', data.insName].map(q).join(','));
  rows.push(['Period', `${from} to ${to}`, 'Business hours only (local time); missed includes abandoned'].map(q).join(','));
  rows.push('');
  rows.push('Daily calls');
  rows.push(['Site', 'Date', 'Total calls', 'Answered', 'Missed', 'Answer rate %'].map(q).join(','));
  for (const s of sites) {
    for (const d of s.daily) {
      const rate = d.total ? Math.round((d.answered / d.total) * 100) : 0;
      rows.push([s.label, d.day, d.total, d.answered, d.missed, rate].map(q).join(','));
    }
    const m = s.metrics!;
    rows.push([s.label, 'TOTAL', m.total, m.answered, m.missed, m.rate].map(q).join(','));
  }
  rows.push('');
  rows.push('Average wait');
  rows.push(['Site', 'Answered (seconds)', 'Missed (seconds)', 'Answered', 'Missed'].map(q).join(','));
  for (const s of sites) {
    const m = s.metrics!;
    rows.push([s.label, m.avgWaitAnswered, m.avgWaitMissed, formatWait(m.avgWaitAnswered), formatWait(m.avgWaitMissed)].map(q).join(','));
  }
  rows.push('');
  rows.push('Missed calls by hour');
  rows.push(['Site', ...hourHead].map(q).join(','));
  for (const s of sites) rows.push([s.label, ...ONEBOARD_HOURS.map((h) => s.missedByHour[h] || 0)].map(q).join(','));
  rows.push('');
  rows.push('All incoming calls by hour');
  rows.push(['Site', ...hourHead].map(q).join(','));
  for (const s of sites) rows.push([s.label, ...ONEBOARD_HOURS.map((h) => s.totalByHour[h] || 0)].map(q).join(','));

  // The mean, and what the period did against it. Expected figures are weighted by the
  // weekdays this period actually contains, so a Mon-Fri range is compared with normal
  // Mon-Fris and not dragged down by the year's Sundays.
  const withBase = sites.filter((s) => s.baseline);
  if (withBase.length) {
    rows.push('');
    rows.push(`${data.baselineName} (${data.baselineFrom} to ${data.baselineTo}), weighted to the weekdays in this period`);
    rows.push(['Site', 'Expected calls', 'Expected answered', 'Expected missed', 'Expected answer rate %',
               'Actual calls', 'Actual answer rate %', 'Calls vs average %', 'Answer rate vs average (points)',
               'Days of history behind the average'].map(q).join(','));
    for (const s of withBase) {
      const e = s.baseline!.expected, m = s.metrics!;
      rows.push([s.label, e.total, e.answered, e.missed, e.rate, m.total, m.rate,
                 e.total ? Math.round(((m.total - e.total) / e.total) * 100) : '',
                 m.rate - e.rate, s.baseline!.daysCovered].map(q).join(','));
    }
  }

  const withCurve = sites.filter((s) => s.curve && s.curve.length);
  if (withCurve.length) {
    rows.push('');
    rows.push(`Demand through the day (answer target ${data.target}%)`);
    rows.push(['Site', 'Hour', 'Avg calls per day', `${data.baselineName} calls per day`,
               'Calls in period', 'Answered in period', 'Answered %', `Verdict at ${data.target}%`].map(q).join(','));
    for (const s of withCurve) {
      for (const c of s.curve) {
        rows.push([s.label, String(c.hour).padStart(2, '0') + ':00', c.avg.toFixed(2),
                   c.baseAvg == null ? '' : c.baseAvg.toFixed(2),
                   c.total, c.answered, c.rate == null ? '' : c.rate, VERDICT_LABEL[c.verdict]].map(q).join(','));
      }
    }
  }

  return '\uFEFF' + rows.join('\r\n') + '\r\n';   // BOM so Excel opens it as UTF-8
}

// The demand curve, drawn by the SAME curveSvg() the board uses — a take-away that
// disagreed with the screen would be worse than no take-away at all. Only the palette
// changes: Puppeteer prints a page with none of our CSS variables in scope.
function curveSection(data: OneBoardData, sites: OneBoardSite[]): string {
  const withCurve = sites.filter((s) => s.curve && s.curve.length);
  if (!withCurve.length) return '';
  const key = `<div class="key">
    <span><svg width="24" height="8"><line x1="1" y1="4" x2="23" y2="4" stroke="#0ea5b7" stroke-width="2"/></svg> This period</span>
    <span><svg width="24" height="8"><line x1="1" y1="4" x2="23" y2="4" stroke="#64748b" stroke-width="2" stroke-dasharray="5 4"/></svg> ${esc(data.baselineName)}</span>
    <span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#16a34a"/></svg> Target met</span>
    <span><svg width="12" height="12"><path d="M6 1.2L10.8 6L6 10.8L1.2 6Z" fill="#d97706"/></svg> Within 10 points</span>
    <span><svg width="12" height="12"><path d="M6 1L11 10.6L1 10.6Z" fill="#dc2626"/></svg> Under target</span>
    <span><svg width="12" height="12"><circle cx="6" cy="6" r="3" fill="none" stroke="#cbd5e1" stroke-width="1.5"/></svg> Too few calls to judge</span>
  </div>`;
  const blocks = withCurve.map((s) => {
    const cs = s.curveSummary;
    const line = !cs || !cs.judged
      ? 'Too few calls in this period to judge cover hour by hour.'
      : `Target met in <b>${cs.met} of ${cs.judged}</b> busy hours &middot; `
        + `<b>${Math.round((cs.callsMet / (cs.callsJudged || 1)) * 100)}%</b> of calls arrive in an hour that clears it`
        + (cs.weakest && cs.weakest.rate != null ? ` &middot; weakest ${String(cs.weakest.hour).padStart(2, '0')}:00 (${cs.weakest.rate}%)` : '');
    return `<div class="curve">
      <div class="curve-h"><div class="curve-n">${esc(s.label)}</div><div class="curve-s">${line}</div></div>
      ${curveSvg({ label: s.label, curve: s.curve, target: data.target, palette: CURVE_PALETTE_PRINT, width: 980, height: 150, baselineLabel: data.baselineName })}
    </div>`;
  }).join('');
  return `<div class="card curve-card"><div class="card-t">Meeting demand through the day</div>
    <div class="card-n">Calls per hour on an average day of this period (solid) against the ${esc(data.baselineName.toLowerCase())} for the same weekdays (dashed). Markers show whether that hour cleared the ${data.target}% answer target; each branch is scaled to its own busiest hour.</div>
    ${key}${blocks}</div>`;
}

// ── PDF — a standalone A4-landscape document that mirrors the on-screen board ──────
export function oneBoardPdfHtml(data: OneBoardData, opts: { from: string; to: string; compare: boolean }): string {
  const sites = includedSites(data);
  const fmtD = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const period = `${fmtD(opts.from)} – ${fmtD(opts.to)}`;
  const generated = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' });

  const delta = (cur: number, prev: number | null | undefined, invert: boolean) => {
    if (prev == null) return '';
    const d = cur - prev;
    if (d === 0) return '<span style="font-size:9px;color:#94a3b8;font-weight:600;">&nbsp;no change</span>';
    const good = invert ? d < 0 : d > 0;
    return `<span style="font-size:9px;color:${good ? '#16a34a' : '#dc2626'};font-weight:700;">&nbsp;${d > 0 ? '&#9650;' : '&#9660;'}${Math.abs(d)}</span>`;
  };

  const scorecards = sites.map((s) => {
    const m = s.metrics!, p = s.prev;
    return `<div class="sc">
      <div class="sc-name">${esc(s.label)}</div>
      <div class="sc-row">
        <div><div class="sc-n">${m.total}</div><div class="sc-l">Calls${delta(m.total, p?.total, false)}</div></div>
        <div><div class="sc-n" style="color:#16a34a;">${m.answered}</div><div class="sc-l">Answered</div></div>
        <div><div class="sc-n" style="color:#dc2626;">${m.missed}</div><div class="sc-l">Missed${delta(m.missed, p?.missed, true)}</div></div>
        <div><div class="sc-n">${m.rate}%</div><div class="sc-l">Answer rate${p ? delta(m.rate, p.rate, false) : ''}</div></div>
      </div>
      <div class="sc-base">Avg wait &middot; answered <b>${formatWait(m.avgWaitAnswered)}</b> &middot; missed <b>${formatWait(m.avgWaitMissed)}</b></div>
      ${s.baseline ? `<div class="sc-base">${esc(data.baselineName)} for these dates: <b>${s.baseline.expected.total}</b> calls${
        s.baseline.expected.total ? ` (${m.total >= s.baseline.expected.total ? '+' : ''}${Math.round(((m.total - s.baseline.expected.total) / s.baseline.expected.total) * 100)}%)` : ''
      } &middot; <b>${s.baseline.expected.rate}%</b> answered (${m.rate - s.baseline.expected.rate >= 0 ? '+' : ''}${m.rate - s.baseline.expected.rate}pp)</div>` : ''}
      ${p ? `<div class="sc-prev">Previous period: ${p.total} calls &middot; ${p.rate}% answered</div>` : ''}
    </div>`;
  }).join('');

  const days = sites[0] ? sites[0].daily : [];
  const dailyHead1 = sites.map((s) => `<th colspan="3" class="bl">${esc(s.label)}</th>`).join('');
  const dailyHead2 = sites.map(() => `<th class="num bl">Calls</th><th class="num">Ans</th><th class="num">Miss</th>`).join('');
  const dailyRows = days.map((_, di) => {
    const cells = sites.map((s) => {
      const d = s.daily[di] || { total: 0, answered: 0, missed: 0 };
      return `<td class="num bl">${d.total || '&mdash;'}</td><td class="num" style="color:#16a34a;">${d.total ? d.answered : ''}</td><td class="num" style="color:${d.missed ? '#dc2626' : '#94a3b8'};">${d.total ? d.missed : ''}</td>`;
    }).join('');
    return `<tr><td class="day">${esc(days[di].label)}</td>${cells}</tr>`;
  }).join('');

  const heatTable = (title: string, note: string, steps: string[], max: number, pick: (s: OneBoardSite, h: number) => number, legend: string) => {
    const head = ONEBOARD_HOURS.map((h) => `<th class="hh">${String(h).padStart(2, '0')}:00</th>`).join('');
    const body = sites.map((s) => {
      const cells = ONEBOARD_HOURS.map((h) => {
        const n = pick(s, h) || 0;
        const c = heatCell(n, max, steps);
        return `<td class="hc" style="background:${c.bg};color:${c.ink};">${n || ''}</td>`;
      }).join('');
      return `<tr><td class="day">${esc(s.label)}</td>${cells}</tr>`;
    }).join('');
    const sw = steps.map((c) => `<span class="sw" style="background:${c};"></span>`).join('');
    return `<div class="card avoid-break"><div class="card-t">${title}</div><div class="card-n">${note}</div>
      <table class="heat"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
      <div class="legend">Fewer ${sw} ${legend}</div></div>`;
  };

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>OneBoard — ${esc(data.insName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; font-size: 11px; }
  .hdr { background: #0f172a; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px; }
  .hdr-logo { font-size: 15px; font-weight: 800; background: linear-gradient(135deg, #10b981, #2563eb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .hdr-title { color: #e2e8f0; font-size: 13px; font-weight: 600; margin-left: 10px; }
  .hdr-meta { color: #94a3b8; font-size: 10px; margin-top: 5px; }
  .hdr-meta strong { color: #cbd5e1; }
  .cards { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .sc { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; flex: 1 1 200px; page-break-inside: avoid; }
  .sc-name { font-weight: 700; font-size: 11px; margin-bottom: 7px; }
  .sc-row { display: flex; gap: 12px; }
  .sc-n { font-size: 17px; font-weight: 700; line-height: 1; }
  .sc-l { font-size: 8.5px; color: #64748b; margin-top: 3px; }
  .sc-prev { font-size: 8.5px; color: #94a3b8; margin-top: 4px; }
  .sc-base { font-size: 8.5px; color: #475569; margin-top: 6px; padding-top: 5px; border-top: 1px solid #f1f5f9; }
  .curve { page-break-inside: avoid; border-top: 1px solid #f1f5f9; padding-top: 8px; margin-top: 8px; }
  .curve:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .curve-h { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .curve-n { font-size: 10px; font-weight: 700; }
  .curve-s { font-size: 8.5px; color: #64748b; }
  .key { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; font-size: 8.5px; color: #64748b; margin-bottom: 8px; }
  /* Keep a section heading with the chart it introduces - a page that opens with two
     unlabelled curves is a page nobody can read. */
  .curve-card .card-t, .curve-card .card-n, .key { page-break-after: avoid; break-after: avoid; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
  .card-t { font-size: 12px; font-weight: 700; }
  .card-n { font-size: 9px; color: #64748b; margin: 2px 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  th { font-size: 8.5px; color: #64748b; text-transform: uppercase; letter-spacing: .3px; padding: 4px 6px; border-bottom: 1.5px solid #e2e8f0; text-align: left; }
  td { padding: 4px 6px; border-bottom: 0.5px solid #f1f5f9; font-size: 10px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .bl { border-left: 1px solid #e2e8f0; }
  .day { white-space: nowrap; color: #334155; font-weight: 600; }
  .heat .hh { text-align: center; }
  .heat .hc { text-align: center; font-weight: 600; font-size: 9.5px; min-width: 26px; }
  .legend { display: flex; align-items: center; gap: 4px; font-size: 8.5px; color: #64748b; margin-top: 7px; }
  .sw { width: 14px; height: 8px; border: 0.5px solid #e2e8f0; border-radius: 2px; display: inline-block; }
  .foot { font-size: 8.5px; color: #94a3b8; margin-top: 4px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .avoid-break { page-break-inside: avoid; }
</style></head><body>
  <div class="hdr">
    <span class="hdr-logo">Lumen IT Solutions</span><span class="hdr-title">OneBoard &mdash; Whole-company call dashboard</span>
    <div class="hdr-meta">Customer: <strong>${esc(data.insName)}</strong> &nbsp;&middot;&nbsp; Period: <strong>${period}</strong> &nbsp;&middot;&nbsp; Business hours only (local time) &middot; missed includes abandoned</div>
  </div>
  ${sites.length ? `
  <div class="cards">${scorecards}</div>
  <div class="card"><div class="card-t">Daily calls &mdash; answered v missed</div><div class="card-n">Per branch, per day across the period.</div>
    <table><thead><tr><th>Day</th>${dailyHead1}</tr><tr><th></th>${dailyHead2}</tr></thead><tbody>${dailyRows}</tbody></table></div>
  ${heatTable('Missed calls by hour', 'Each cell = missed calls in that hour across the selected dates.', HEAT_MISSED, data.maxHeat, (s, h) => s.missedByHour[h], 'More missed')}
  ${heatTable('All incoming calls by hour', 'Each cell = every incoming call in that hour across the selected dates.', HEAT_ALL, data.maxHeatAll, (s, h) => s.totalByHour[h], 'More calls')}
  ${curveSection(data, sites)}
  ` : '<div class="card">No sites selected or configured for this period.</div>'}
  <div class="foot">Generated ${generated} &middot; Lumen IT Solutions &middot; portal.lumenmsp.co.uk</div>
</body></html>`;
}
