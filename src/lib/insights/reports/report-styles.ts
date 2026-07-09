/** Shared inline CSS for all generated report HTML files */
export const REPORT_CSS = `
  :root {
    --green: #4ade80; --teal: #06b6d4; --blue: #3b82f6;
    --dark: #0f172a;  --navy: #1e293b; --accent: #06b6d4;
    --text: #111827;  --muted: #6b7280; --line: #e5e7eb;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 17px; color: var(--text); background: #f0f2f5; padding: 24px; }
  .report-wrap { max-width: 1400px; margin: 0 auto; }

  /* Header */
  .report-header { background: var(--dark); padding: 26px 30px; border-radius: 10px; margin-bottom: 26px; border-bottom: 3px solid transparent; border-image: linear-gradient(90deg,var(--green),var(--blue)) 1; }
  .report-header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .report-logo { font-size: 24px; font-weight: 800; background: linear-gradient(135deg,var(--green),var(--blue)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .report-title { color: #e2e8f0; font-size: 21px; font-weight: 600; }
  .report-meta  { color: #94a3b8; font-size: 15px; }

  /* Cards */
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 26px 28px; margin-bottom: 20px; }
  .card-title { font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); margin-bottom: 18px; }

  /* Stat grid */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .stat { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; }
  .stat-val { font-size: 40px; font-weight: 800; color: var(--accent); line-height: 1; }
  .stat-lbl { font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; margin-top: 7px; }
  .stat-good  .stat-val { color: #16a34a; }
  .stat-warn  .stat-val { color: #d97706; }
  .stat-bad   .stat-val { color: #dc2626; }

  /* Tables */
  .tbl { width: 100%; border-collapse: collapse; font-size: 16px; }
  .tbl th { text-align: left; padding: 11px 13px; border-bottom: 2px solid var(--line); font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); font-weight: 700; }
  .tbl td { padding: 12px 13px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .tbl tbody tr:hover { background: #f9fafb; }
  .tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
  .tbl .good { color: #16a34a; font-weight: 600; }
  .tbl .warn { color: #d97706; }
  .tbl .bad  { color: #dc2626; }

  /* Badges */
  .badge { font-size: 13px; font-weight: 600; padding: 3px 9px; border-radius: 20px; display: inline-block; }
  .badge-answered  { background: #dcfce7; color: #166534; }
  .badge-missed    { background: #fee2e2; color: #b91c1c; }
  .badge-abandoned { background: #fef3c7; color: #92400e; }
  .badge-overflow  { background: #ede9fe; color: #6d28d9; }
  .badge-voicemail { background: #e0f2fe; color: #0369a1; }

  /* Heatmap */
  .heatmap { overflow-x: auto; }
  .heatmap table { border-collapse: collapse; font-size: 14px; }
  .heatmap th { padding: 6px 8px; color: var(--muted); font-weight: 600; text-align: center; }
  .heatmap td { width: 50px; height: 40px; text-align: center; border-radius: 4px; font-size: 14px; color: #fff; }
  .heatmap .row-label { color: var(--text); font-weight: 600; text-align: right; padding-right: 10px; background: none; width: auto; }

  /* Bar chart (8-week trend) */
  .bars { display: flex; align-items: flex-end; gap: 8px; height: 120px; margin-top: 10px; }
  .bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
  .bar { width: 100%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .bar-lbl { font-size: 13px; color: var(--muted); }

  /* Answer rate indicator */
  .rate-bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; margin-top: 6px; }
  .rate-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg,var(--green),var(--teal)); }

  /* ── Print / Save-as-PDF — make the PDF match the on-screen report ──────────
     The page is just printed to PDF, so without this the toolbar, buttons and the
     scrollable All-Calls box (clipped to 400px) all leak into the PDF. */
  @media print {
    @page { margin: 12mm; }
    /* force backgrounds/colours (dark header, coloured stats) to actually render */
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { background: #fff !important; padding: 0 !important; }
    .report-wrap { max-width: none !important; margin: 0 !important; }
    /* drop the fixed toolbar, its spacer, and every action button */
    #report-toolbar, div[style*="height:52px"] { display: none !important; }
    button, .btn-secondary { display: none !important; }
    /* expand any scroll boxes so the whole table prints instead of a 400px window */
    [style*="overflow-y:auto"], [style*="overflow-x:auto"], [style*="max-height"], .table-wrap, .heatmap {
      max-height: none !important; overflow: visible !important;
    }
    /* Let TALL cards (Daily Breakdown, Staff table) flow across a page boundary instead of
       being bumped whole onto the next page — that bump is what left the big blank gap at the
       foot of page 1. Keep individual rows intact, keep the title with its content, and repeat
       the table head on every page the table spans. Only small blocks (stat cards) avoid-break. */
    .card { box-shadow: none !important; border-radius: 8px; break-inside: auto; page-break-inside: auto; }
    .card-title { break-after: avoid; page-break-after: avoid; }
    .stat-grid { break-inside: avoid; page-break-inside: avoid; }
    .stat { break-inside: avoid; page-break-inside: avoid; }
    .tbl thead { display: table-header-group; }   /* repeat header on each printed page */
    .tbl tbody tr { break-inside: avoid; page-break-inside: avoid; }
    .tbl tbody tr:hover { background: none !important; }
    .report-header { border-radius: 0; }
  }
`;

export function reportHtml(title: string, period: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<!-- Report toolbar — hidden when printing -->
<div id="report-toolbar" style="position:fixed;top:0;left:0;right:0;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:8px;padding:8px 20px;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.06);">
  <span style="font-weight:700;font-size:14px;color:#111;flex:1;">Lumen MSP Insights</span>
  <button onclick="window.print()" style="padding:6px 14px;background:#0090a0;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">&#128438; Save as PDF</button>
  <button onclick="if(window.opener||window.history.length<=1){window.close();}else{history.back();}" style="padding:6px 14px;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">&#10005; Close</button>
</div>
<div style="height:52px;"></div>
<div class="report-wrap">
  <div class="report-header">
    <div class="report-header-top">
      <span class="report-logo">Lumen MSP Insights</span>
      <span class="report-title">${title}</span>
    </div>
    <div class="report-meta">${period}</div>
  </div>
  ${body}
</div>
<style>@media print { #report-toolbar, div[style*="height:52px"] { display:none !important; } }</style>
<script>
function downloadCsv(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = Array.from(table.querySelectorAll('tr'));
  const csv  = rows.map(row =>
    Array.from(row.querySelectorAll('th,td'))
      .map(cell => {
        const text = cell.innerText.replace(/\\n/g,' ').trim();
        return text.includes(',') || text.includes('"') ? '"' + text.replace(/"/g,'""') + '"' : text;
      }).join(',')
  ).join('\\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (tableId || 'calls') + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}
</script>
</body>
</html>`;
}

export function rateColour(rate: number): string {
  if (rate >= 80) return 'good';
  if (rate >= 60) return 'warn';
  return 'bad';
}

export function heatmapColour(value: number, max: number): string {
  if (!max || value === 0) return 'background:#f3f4f6;color:#9ca3af;';
  const intensity = Math.min(value / max, 1);
  const r = Math.round(220 - intensity * 80);
  const g = Math.round(38  + intensity * 20);
  const b = Math.round(38  + intensity * 10);
  return `background:rgb(${r},${g},${b});color:#fff;`;
}

export function statusBadge(status: string): string {
  const cls: Record<string, string> = {
    answered:  'badge-answered',
    missed:    'badge-missed',
    abandoned: 'badge-abandoned',
    overflowed:'badge-overflow',
    voicemail: 'badge-voicemail',
  };
  const label = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  return `<span class="badge ${cls[status.toLowerCase()] || ''}">${label}</span>`;
}
