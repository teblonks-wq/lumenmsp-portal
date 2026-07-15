import { OneBoardData, OneBoardSite, ONEBOARD_HOURS } from './oneboard';

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
  rows.push('Missed calls by hour');
  rows.push(['Site', ...hourHead].map(q).join(','));
  for (const s of sites) rows.push([s.label, ...ONEBOARD_HOURS.map((h) => s.missedByHour[h] || 0)].map(q).join(','));
  rows.push('');
  rows.push('All incoming calls by hour');
  rows.push(['Site', ...hourHead].map(q).join(','));
  for (const s of sites) rows.push([s.label, ...ONEBOARD_HOURS.map((h) => s.totalByHour[h] || 0)].map(q).join(','));

  return '\uFEFF' + rows.join('\r\n') + '\r\n';   // BOM so Excel opens it as UTF-8
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
  .sc-prev { font-size: 8.5px; color: #94a3b8; margin-top: 6px; }
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
  ` : '<div class="card">No sites selected or configured for this period.</div>'}
  <div class="foot">Generated ${generated} &middot; Lumen IT Solutions &middot; portal.lumenmsp.co.uk</div>
</body></html>`;
}
