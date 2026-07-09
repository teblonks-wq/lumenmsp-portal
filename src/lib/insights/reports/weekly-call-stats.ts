import {
  CallJourney, CallEventRow, LogicConfig, ReportMetrics,
  calcMetrics, groupByDay, formatWait, pct, isInHours, formatRoute
} from '../../insights-journeys';
import { reportHtml, rateColour, heatmapColour } from './report-styles';

const DAY_NAMES      = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAY_NAMES_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtDateShort(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

function renderScorecard(journeys: CallJourney[], config: LogicConfig): string {
  const m = calcMetrics(journeys);
  const rateClass    = rateColour(m.answerRate);

  // One scorecard stat per configured IVR option (generic — whatever label the site
  // mapped: Emergency, Voicemail, etc.), counting calls that chose that option.
  const ivrCards = (config.ivr_options || []).filter(o => o.group && o.label).map(o => {
    const g = o.group.trim().toLowerCase();
    const count = journeys.filter(j => j.steps.some(s => s.group.trim().toLowerCase() === g)).length;
    return { val: count, lbl: o.label, cls: '' };
  });

  const cards = [
    { val: m.total,      lbl: 'Total Calls',   cls: '' },
    { val: m.answered,   lbl: 'Answered',      cls: 'stat-good' },
    { val: m.missed,     lbl: 'Missed',        cls: m.missed > 0 ? 'stat-bad' : '' },
    { val: m.answerRate + '%', lbl: 'Answer Rate', cls: `stat-${rateClass}` },
    ...ivrCards,
    { val: formatWait(m.avgWaitMissed), lbl: 'Avg Wait (Missed)', cls: '' },
  ];

  return '<div class="stat-grid">'
    + cards.map(c => `<div class="stat ${c.cls}"><div class="stat-val">${c.val}</div><div class="stat-lbl">${c.lbl}</div></div>`).join('')
    + '</div>';
}

// ── Summary List ──────────────────────────────────────────────────────────────

function renderSummaryList(journeys: CallJourney[], config: LogicConfig): string {
  const m         = calcMetrics(journeys);
  const total     = m.total;
  const avgAll    = total > 0 ? Math.round(journeys.reduce((s,j) => s + j.wait_secs, 0) / total) : 0;

  // One line per configured IVR option — fully generic: whatever group→label the site
  // mapped, count the calls that passed through that group and show it with its label.
  const ivrLines = (config.ivr_options || [])
    .filter(o => o.group && o.label)
    .map(o => {
      const g = o.group.trim().toLowerCase();
      const count = journeys.filter(j => j.steps.some(s => s.group.trim().toLowerCase() === g)).length;
      return `<strong>${o.label}:</strong> ${count} (${pct(count, total)})`;
    });

  const items: (string | null)[] = [
    `<strong>Total Incoming Calls:</strong> ${total}`,
    `<strong>Answered Calls:</strong> ${m.answered} (${pct(m.answered, total)})`,
    `<strong>Missed Calls:</strong> ${m.missed} (${pct(m.missed, total)})`,
    ...ivrLines,
    `<strong>Average Wait Time (all calls):</strong> ${formatWait(avgAll)}`,
    `<strong>Average Wait Before Missed Call:</strong> ${formatWait(m.avgWaitMissed)}`,
  ].filter(Boolean);

  return `<div class="card">
    <div class="card-title">Call Summary</div>
    <ul style="padding-left:18px;line-height:2;margin:0;">${items.map(i => `<li style="font-size:14px;">${i}</li>`).join('')}</ul>
  </div>`;
}

// ── IVR Options (driven entirely by the report config's ivr_options) ──────────
// One row per configured IVR option: how many calls passed through that option's
// group. Add/rename options in the report config and the report follows.
function renderIvrBreakdown(journeys: CallJourney[], config: LogicConfig): string {
  const opts = (config.ivr_options || []).filter(o => o.group && o.label);
  if (!opts.length) return '';
  const total = journeys.length;
  const rows = opts.map(o => {
    const g = o.group.toLowerCase();
    const count = journeys.filter(j => j.steps.some(s => s.group.toLowerCase().includes(g))).length;
    return `<tr>
      <td>${o.label}</td>
      <td class="num">${count}</td>
      <td class="num">${pct(count, total)}</td>
    </tr>`;
  }).join('');
  return `<div class="card">
    <div class="card-title">IVR Options</div>
    <table class="tbl">
      <thead><tr><th>Option</th><th class="num">Calls</th><th class="num">% of Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Daily Breakdown ───────────────────────────────────────────────────────────

function renderDailyBreakdown(journeys: CallJourney[], weekStart: Date): string {
  const byDay = groupByDay(journeys);
  const rows = Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const dj  = byDay.get(iso) || [];
    const ans     = dj.filter(j => j.status === 'Answered').length;
    const mis     = dj.filter(j => j.status === 'Missed' || j.status === 'Abandoned').length;
    const ovf     = dj.filter(j => j.overflowed || j.is_overflow_voicemail).length;
    const tot     = dj.length;
    const avgW    = tot > 0 ? Math.round(dj.reduce((s,j) => s + j.wait_secs, 0) / tot) : 0;
    const misJrns = dj.filter(j => j.status === 'Missed' || j.status === 'Abandoned');
    const avgMis  = misJrns.length > 0 ? Math.round(misJrns.reduce((s,j) => s + j.wait_secs, 0) / misJrns.length) : 0;
    const rate    = rateColour(tot > 0 ? Math.round(ans / tot * 100) : 100);
    return `<tr>
      <td>${DAY_NAMES_FULL[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}</td>
      <td class="num">${tot || '—'}</td>
      <td class="num good">${ans || '—'}</td>
      <td class="num bad">${mis || '—'}</td>
      <td class="num ${rate}">${tot ? pct(ans, tot) : '—'}</td>
      <td class="num">${ovf || '—'}</td>
      <td class="num">${tot ? formatWait(avgW) : '—'}</td>
      <td class="num">${misJrns.length ? formatWait(avgMis) : '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">Daily Breakdown</div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Day</th><th class="num">Total</th><th class="num">Answered</th>
      <th class="num">Missed</th><th class="num">Answer %</th>
      <th class="num">Overflow</th><th class="num">Avg Wait</th><th class="num">Avg Wait (Missed)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ── Call Volume Analysis (hourly for this week) ───────────────────────────────

// Hour-bucket range shown across every hour-based chart, derived from the site's CONFIGURED
// business hours (so all charts start/end on the same business-hours boundary — e.g. 08:00–18:00
// for an 08:00–19:00 site — instead of a hard-coded 07:00 or whatever hours happen to have data).
// Hour buckets to show, taken STRICTLY from the site's configured business hours (per-day or a
// single start/end). No hard-coded hours — a site that opens 06:00 or 09:00 renders its own range.
// Returns null when the site has no usable business-hours config (caller then falls back to data).
function configuredHours(config: LogicConfig): number[] | null {
  const bh: any = config.business_hours;
  if (!bh || typeof bh !== 'object') return null;
  const opens: number[] = [], closes: number[] = [];
  const pushOpen  = (s: any) => { const h = parseInt(String(s).split(':')[0], 10); if (!isNaN(h)) opens.push(h); };
  // A close at HH:00 means the last in-hours call lands in bucket HH-1; HH:30 lands in bucket HH.
  const pushClose = (s: any) => { const [ch, cm] = String(s).split(':').map(Number); if (!isNaN(ch)) closes.push(cm > 0 ? ch : ch - 1); };
  if ('start' in bh && 'end' in bh) {
    pushOpen(bh.start); pushClose(bh.end);
  } else {
    for (const day of Object.values(bh)) {
      const d: any = day;
      if (!d || d.closed || !d.open || !d.close) continue;
      pushOpen(d.open); pushClose(d.close);
    }
  }
  if (!opens.length || !closes.length) return null;
  const start = Math.min(...opens), end = Math.max(Math.max(...closes), start);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

// Last-resort fallback: the actual hour span present in the data (UK local). Still never a literal.
function dataHours(journeys: CallJourney[]): number[] {
  const present = new Set<number>();
  for (const j of journeys) {
    const d = new Date(j.datetime);
    const ukOff = (d.getUTCMonth() + 1 >= 4 && d.getUTCMonth() + 1 <= 10) ? 60 : 0;
    present.add(new Date(d.getTime() + ukOff * 60000).getUTCHours());
  }
  if (!present.size) return [];
  const start = Math.min(...present), end = Math.max(...present);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

// The hour range every hour-based chart uses: the site's configured business hours, or the data span.
function chartHours(config: LogicConfig, journeys: CallJourney[]): number[] {
  return configuredHours(config) ?? dataHours(journeys);
}

function renderCallVolumeAnalysis(journeys: CallJourney[], config: LogicConfig): string {
  const byHour = new Map<number, { total: number; answered: number; missed: number }>();
  for (const j of journeys) {
    const d = new Date(j.datetime);
    const month = d.getUTCMonth() + 1;
    const ukOff = (month >= 4 && month <= 10) ? 60 : 0;
    const h = new Date(d.getTime() + ukOff * 60000).getUTCHours();
    if (!byHour.has(h)) byHour.set(h, { total: 0, answered: 0, missed: 0 });
    const slot = byHour.get(h)!;
    slot.total++;
    if (j.status === 'Answered') slot.answered++;
    if (j.status === 'Missed' || j.status === 'Abandoned') slot.missed++;
  }

  const hours = chartHours(config, journeys);
  const maxTotal = Math.max(...hours.map(h => byHour.get(h)?.total || 0), 1);

  const rows = hours.map(h => {
    const slot = byHour.get(h) || { total: 0, answered: 0, missed: 0 };
    const barW = Math.round((slot.total / maxTotal) * 120);
    return `<tr>
      <td style="font-size:15px;white-space:nowrap;">${String(h).padStart(2,'0')}:00</td>
      <td class="num">${slot.total || '—'}</td>
      <td class="num good">${slot.answered || '—'}</td>
      <td class="num bad">${slot.missed || '—'}</td>
      <td><div style="width:${barW}px;height:10px;background:var(--accent);border-radius:2px;"></div></td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">Call Volume by Hour</div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Hour</th><th class="num">Total</th><th class="num">Answered</th><th class="num">Missed</th><th>Volume</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ── Call Flow Breakdown ───────────────────────────────────────────────────────

function renderCallFlowBreakdown(journeys: CallJourney[], config: LogicConfig): string {
  if (!config.call_flow?.length) return '';
  const rows = config.call_flow.map(cf => {
    const reached   = journeys.filter(j => j.steps.some(s => s.group === cf.group));
    const answeredH = reached.filter(j => j.steps.some(s => s.group === cf.group && s.outcome.toLowerCase() === 'answered'));
    const overNext  = reached.filter(j => {
      const idx = j.steps.findIndex(s => s.group === cf.group);
      return idx >= 0 && idx < j.steps.length - 1 && j.steps[idx].outcome.toLowerCase() !== 'answered';
    });
    const label = cf.label || cf.group.replace('Hunt Group ', '');
    const rate  = rateColour(reached.length > 0 ? Math.round(answeredH.length / reached.length * 100) : 100);
    return `<tr>
      <td>${label}</td>
      <td class="num">${reached.length}</td>
      <td class="num good">${answeredH.length}</td>
      <td class="num">${overNext.length}</td>
      <td class="num ${rate}">${reached.length ? pct(answeredH.length, reached.length) : '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">Call Flow Breakdown</div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Group</th><th class="num">Calls Reached</th><th class="num">Answered Here</th><th class="num">Passed On</th><th class="num">% Answered</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ── All Calls Log ─────────────────────────────────────────────────────────────

function outcomeLabel(j: CallJourney): string {
  if (j.is_emergency)    return 'Emergency';
  if (j.is_ivr_voicemail) return 'Chose Voicemail';
  if (j.is_overflow_voicemail) return 'Daytime Overflow (Voicemail)';
  return j.status;
}

function renderAllCalls(journeys: CallJourney[], config: LogicConfig, title = 'All Calls'): string {
  const tableId = 'all-calls-' + Math.random().toString(36).slice(2, 7);
  const rows = journeys.map(j => {
    const dt    = new Date(j.datetime);
    const time  = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' })
                + ' ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    const route   = formatRoute(j, config);
    const outcome = outcomeLabel(j);
    return `<tr>
      <td style="white-space:nowrap;font-size:15px;">${time}</td>
      <td style="font-family:monospace;font-size:15px;">${j.number || '—'}</td>
      <td style="font-size:15px;font-family:monospace;">${j.ddi || '—'}</td>
      <td style="font-size:15px;">${outcome}</td>
      <td class="num" style="font-size:15px;">${j.wait}</td>
      <td style="font-size:14px;color:#6b7280;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${route}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-header">
      <div class="card-title" style="margin-bottom:0;">${title} (${journeys.length})</div>
      <button onclick="downloadCsv('${tableId}')" class="btn-secondary" style="font-size:15px;padding:4px 10px;">Download CSV</button>
    </div>
    <div style="max-height:400px;overflow-y:auto;">
      <table class="tbl" id="${tableId}">
        <thead><tr><th>Date/Time</th><th>Number</th><th>DDI</th><th>Outcome</th><th class="num">Wait</th><th>Journey</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── 8-Week Rolling Summary ────────────────────────────────────────────────────

interface WeekBucket { label: string; total: number; answered: number; missed: number; }

function renderRollingSummary(weekBuckets: WeekBucket[]): string {
  const totalCalls  = weekBuckets.reduce((s, w) => s + w.total, 0);
  const workingDays = weekBuckets.length * 5;
  const inHrsMissed = weekBuckets.reduce((s, w) => s + w.missed, 0);
  const avgPerDay   = workingDays > 0 ? (totalCalls / workingDays).toFixed(1) : '0';
  const avgMissed   = workingDays > 0 ? (inHrsMissed / workingDays).toFixed(1) : '0';

  const max      = Math.max(...weekBuckets.map(w => w.total), 1);
  const chartH   = 90;
  const labelH   = 16;
  const colW     = Math.max(24, Math.min(40, Math.floor(700 / weekBuckets.length)));
  const svgW     = colW * weekBuckets.length;
  const svgTotal = chartH + labelH + 4;
  const step     = Math.ceil(weekBuckets.length / 14); // show at most ~14 labels
  const svgBars  = weekBuckets.map((w, i) => {
    const h    = w.total > 0 ? Math.max(2, Math.round((w.total / max) * chartH)) : 0;
    const x    = i * colW + 2;
    const bw   = colW - 4;
    const y    = chartH - h;
    return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="#7c3aed" rx="2" opacity="${w.total === 0 ? 0.15 : 0.85}">
      <title>${w.label}: ${w.total} calls</title></rect>`;
  }).join('');
  const svgLabels = weekBuckets.map((w, i) => {
    if (i % step !== 0) return '';
    const x = i * colW + colW / 2;
    return `<text x="${x}" y="${svgTotal - 2}" font-size="9" fill="#9ca3af" text-anchor="middle" font-family="system-ui,sans-serif">${w.label}</text>`;
  }).join('');
  const bars = `<div style="overflow:hidden;width:100%;"><svg width="${svgW}" height="${svgTotal}" style="display:block;max-width:100%;">${svgBars}${svgLabels}</svg></div>`;

  const tblRows = weekBuckets.map(w => {
    const rate = w.total > 0 ? Math.round(w.answered / w.total * 100) : 0;
    return `<tr>
      <td>${w.label}</td>
      <td class="num">${w.total}</td>
      <td class="num good">${w.answered}</td>
      <td class="num bad">${w.missed}</td>
      <td class="num ${rateColour(rate)}">${w.total ? pct(w.answered, w.total) : '—'}</td>
    </tr>`;
  }).join('');

  const wkCount = weekBuckets.length;
  return `<div class="card">
    <div class="card-title">${wkCount}-Week Rolling Summary</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div class="stat"><div class="stat-val">${totalCalls}</div><div class="stat-lbl">Total (${wkCount} weeks)</div></div>
      <div class="stat"><div class="stat-val">${avgPerDay}</div><div class="stat-lbl">Avg Calls / Working Day</div></div>
      <div class="stat stat-bad"><div class="stat-val">${avgMissed}</div><div class="stat-lbl">Avg Missed / Working Day</div></div>
    </div>
    <div class="bars">${bars}</div>
    <table class="tbl" style="margin-top:16px;">
      <thead><tr><th>Week</th><th class="num">Total</th><th class="num">Answered</th><th class="num">Missed</th><th class="num">Rate</th></tr></thead>
      <tbody>${tblRows}</tbody>
    </table>
  </div>`;
}

// ── Peak Concurrent Demand ────────────────────────────────────────────────────
// For each day × hour slot: what's the average peak calls-in-a-single-minute?
// Tells you: "On Monday 9am, you sometimes have 4 calls arriving simultaneously"

function renderPeakConcurrency(allJourneys: CallJourney[], weeks: number, config: LogicConfig): string {
  if (allJourneys.length === 0 || weeks === 0) return '';

  const hours = chartHours(config, allJourneys);

  // Build: Map<"dow|hour|weekIso|minute", count>
  const minuteMap = new Map<string, number>();
  for (const j of allJourneys) {
    const d     = new Date(j.datetime);
    const month = d.getUTCMonth() + 1;
    const ukOff = (month >= 4 && month <= 10) ? 60 : 0;
    const ukD   = new Date(d.getTime() + ukOff * 60000);
    const dow   = ukD.getUTCDay();
    const hour  = ukD.getUTCHours();
    const min   = ukD.getUTCMinutes();
    // weekIso = ISO week label to track individual weeks
    const weekKey = `${ukD.getUTCFullYear()}-W${Math.ceil((ukD.getUTCDate() + new Date(ukD.getUTCFullYear(), ukD.getUTCMonth(), 1).getDay()) / 7)}`;
    if (!hours.includes(hour)) continue;
    const key = `${dow}|${hour}|${weekKey}|${min}`;
    minuteMap.set(key, (minuteMap.get(key) || 0) + 1);
  }

  // For each (dow, hour, week), find peak minute count
  const peakMap = new Map<string, number[]>(); // "dow|hour" → [peak per week]
  for (const [key, count] of minuteMap) {
    const [dow, hour, weekKey] = key.split('|');
    const slotKey   = `${dow}|${hour}`;
    const weekSlot  = `${dow}|${hour}|${weekKey}`;
    if (!peakMap.has(slotKey)) peakMap.set(slotKey, []);
    // Track max per week
    const existing = minuteMap.get(weekSlot) ?? 0;
    const arr = peakMap.get(slotKey)!;
    // We want the max minute count per (dow, hour, week)
    // Reconstruct: find all minute counts for this (dow, hour, week)
    // Simple: just push the count, then per week take the max
  }

  // Rebuild properly: per (dow, hour, week), find the max minute-bucket count
  const weekSlotMax = new Map<string, number>(); // "dow|hour|week" → max count
  for (const [key, count] of minuteMap) {
    const parts   = key.split('|');
    const slotKey = `${parts[0]}|${parts[1]}|${parts[2]}`;
    weekSlotMax.set(slotKey, Math.max(weekSlotMax.get(slotKey) || 0, count));
  }

  // Average the weekly peaks per (dow, hour)
  const avgPeak = new Map<string, { sum: number; weeks: Set<string> }>();
  for (const [key, maxCount] of weekSlotMax) {
    const parts   = key.split('|');
    const slotKey = `${parts[0]}|${parts[1]}`;
    const weekId  = parts[2];
    if (!avgPeak.has(slotKey)) avgPeak.set(slotKey, { sum: 0, weeks: new Set() });
    const slot = avgPeak.get(slotKey)!;
    slot.sum += maxCount;
    slot.weeks.add(weekId);
  }

  const activeDows = [1,2,3,4,5].filter(dow => hours.some(h => avgPeak.has(`${dow}|${h}`)));
  if (activeDows.length === 0) return '';

  const allVals = [...avgPeak.values()].map(v => v.sum / v.weeks.size);
  const maxVal  = Math.max(...allVals, 1);

  const hdrs = hours.map(h => `<th style="padding:5px 8px;background:#f0f4ff;color:var(--accent);text-align:center;border:1px solid #ddd;font-size:14px;">${String(h).padStart(2,'0')}:00</th>`).join('');

  const rows = activeDows.map(dow => {
    const cells = hours.map(h => {
      const slot = avgPeak.get(`${dow}|${h}`);
      const avg  = slot ? slot.sum / slot.weeks.size : 0;
      const disp = avg >= 1 ? avg.toFixed(1) : avg > 0 ? avg.toFixed(1) : '';
      const intensity = avg / maxVal;
      const r   = Math.round(6   + (255-6)   * (1 - intensity));
      const g   = Math.round(182 + (255-182) * (1 - intensity));
      const b   = Math.round(212 + (255-212) * (1 - intensity));
      const txt = intensity > 0.5 ? '#fff' : '#374151';
      const style = avg > 0 ? `background:rgb(${r},${g},${b});color:${txt};` : 'background:#fff;color:#ccc;';
      return `<td style="padding:5px 8px;border:1px solid #ddd;text-align:center;${style}" title="${DAY_NAMES_FULL[dow]} ${h}:00 — avg peak ${disp} calls/min">${disp}</td>`;
    }).join('');
    return `<tr><td style="padding:5px 10px;border:1px solid #ddd;font-weight:600;background:#f9fafb;white-space:nowrap;font-size:15px;">${DAY_NAMES[dow]}</td>${cells}</tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">Peak Concurrent Demand — avg busiest minute per hour (${weeks} weeks)</div>
    <p style="font-size:15px;color:var(--muted);margin-bottom:12px;">Shows the average number of calls arriving in the busiest single minute within each hour. A value of 3 means you typically need 3 people available in that slot.</p>
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;font-size:15px;">
        <thead><tr>
          <th style="padding:5px 10px;background:#f0f4ff;color:var(--accent);text-align:left;border:1px solid #ddd;font-size:14px;"></th>
          ${hdrs}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Missed Calls by Hour (All Time) ──────────────────────────────────────────
// Red heatmap — missed calls per hour × day, raw counts + totals row/col

function redCell(count: number, max: number): string {
  if (count === 0) return 'background:#fff;color:#ccc;';
  const intensity = Math.min(count / max, 1);
  // White → red (#e74c3c)
  const r = 255;
  const g = Math.round(255 - intensity * (255 - 76));
  const b = Math.round(255 - intensity * (255 - 60));
  const text = intensity > 0.55 ? '#fff' : '#c0392b';
  return `background:rgb(${r},${g},${b});color:${text};font-weight:bold;`;
}

function renderMissedHeatmap(allJourneys: CallJourney[], config: LogicConfig): string {
  // Filter to missed calls only; optionally exclude short calls (IVR hangups)
  const minWait = config.min_wait_seconds ?? 0;
  const missed  = allJourneys.filter(j =>
    (j.status === 'Missed' || j.status === 'Abandoned') && j.wait_secs >= minWait
  );

  // Build grid: dow (1=Mon..6=Sat) × hour
  const grid = new Map<string, number>();
  const hours = chartHours(config, allJourneys);   // site's business hours, so columns are consistent
  for (const j of missed) {
    const d     = new Date(j.datetime);
    const month = d.getUTCMonth() + 1;
    const ukOff = (month >= 4 && month <= 10) ? 60 : 0;
    const ukD   = new Date(d.getTime() + ukOff * 60000);
    const dow   = ukD.getUTCDay();
    const hour  = ukD.getUTCHours();
    if (!hours.includes(hour)) continue;
    const key = `${dow}|${hour}`;
    grid.set(key, (grid.get(key) || 0) + 1);
  }

  if (grid.size === 0) return '';
  const dows     = [1,2,3,4,5,6].filter(dow => hours.some(h => grid.has(`${dow}|${h}`)));
  const allVals  = [...grid.values()];
  const maxVal   = Math.max(...allVals, 1);

  const hdrs = hours.map(h => `<th style="padding:6px 8px;background:#f8f8f8;color:#c0392b;text-align:center;border:1px solid #ddd;font-size:15px;">${String(h).padStart(2,'0')}:00</th>`).join('');
  const totalsRow: number[] = hours.map(h => dows.reduce((s, dow) => s + (grid.get(`${dow}|${h}`) || 0), 0));
  const grandTotal = totalsRow.reduce((s, v) => s + v, 0);

  const rows = dows.map(dow => {
    const rowTotal = hours.reduce((s, h) => s + (grid.get(`${dow}|${h}`) || 0), 0);
    const cells = hours.map(h => {
      const count = grid.get(`${dow}|${h}`) || 0;
      return `<td style="padding:5px 8px;border:1px solid #ddd;text-align:center;${redCell(count, maxVal)}">${count || ''}</td>`;
    }).join('');
    return `<tr>
      <td style="padding:5px 10px;border:1px solid #ddd;font-weight:600;background:#f8f8f8;white-space:nowrap;">${DAY_NAMES[dow]}</td>
      ${cells}
      <td style="padding:5px 10px;border:1px solid #ddd;text-align:center;font-weight:700;color:#c0392b;background:#fff5f5;">${rowTotal || ''}</td>
    </tr>`;
  }).join('');

  const totalCells = totalsRow.map((t, i) => `<td style="padding:5px 8px;border:1px solid #ddd;text-align:center;font-weight:700;color:#c0392b;background:#fff5f5;">${t || ''}</td>`).join('');

  // Find earliest year in data
  const earliest = allJourneys.length > 0
    ? new Date(Math.min(...allJourneys.map(j => new Date(j.datetime).getTime()))).getFullYear()
    : new Date().getFullYear();

  const note = minWait > 0
    ? `Note: all-time data from ${earliest} onwards. Calls under ${minWait} seconds are excluded — these are typically callers who heard the IVR greeting and hung up before a phone could realistically ring.`
    : `Note: all-time data from ${earliest} onwards.`;

  return `<div class="card">
    <div class="card-title">Missed Calls by Hour (All Time)</div>
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;font-size:15px;">
        <thead>
          <tr>
            <th style="padding:6px 10px;background:#f8f8f8;color:#c0392b;text-align:left;border:1px solid #ddd;">Hour</th>
            ${hdrs}
            <th style="padding:6px 8px;background:#f8f8f8;color:#c0392b;text-align:center;border:1px solid #ddd;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr>
            <td style="padding:5px 10px;border:1px solid #ddd;font-weight:700;color:#c0392b;background:#fff5f5;">Total</td>
            ${totalCells}
            <td style="padding:5px 10px;border:1px solid #ddd;font-weight:700;color:#c0392b;background:#fff5f5;">${grandTotal}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p style="font-size:14px;color:#999;margin-top:10px;font-style:italic;">${note}</p>
  </div>`;
}

// ── Calls by Day of Week (rolling) ───────────────────────────────────────────

function renderCallsByDow(allJourneys: CallJourney[], weeks: number): string {
  const counts = new Array(7).fill(0);
  for (const j of allJourneys) {
    const d     = new Date(j.datetime);
    const ukOff = (d.getUTCMonth() + 1 >= 4 && d.getUTCMonth() + 1 <= 10) ? 60 : 0;
    counts[new Date(d.getTime() + ukOff * 60000).getUTCDay()]++;
  }
  const max  = Math.max(...counts, 1);
  const days = [1,2,3,4,5,6,0]; // Mon–Sun
  const rows = days.map(dow => {
    const count = counts[dow];
    const barW  = max > 0 ? Math.round((count / max) * 200) : 0;
    return `<tr>
      <td style="font-weight:600;font-size:15px;width:40px;white-space:nowrap;">${DAY_NAMES[dow]}</td>
      <td style="padding-right:8px;"><div style="height:14px;width:${barW}px;background:var(--accent);border-radius:2px;display:inline-block;vertical-align:middle;opacity:0.85;"></div></td>
      <td class="num" style="font-size:15px;font-variant-numeric:tabular-nums;">${count}</td>
    </tr>`;
  }).join('');
  return `<div class="card">
    <div class="card-title">Calls by Day of Week (${weeks} weeks)</div>
    <table class="tbl" style="max-width:350px;"><tbody>${rows}</tbody></table>
  </div>`;
}

// ── Calls by Hour of Day (rolling) ────────────────────────────────────────────

function renderCallsByHour(allJourneys: CallJourney[], weeks: number, config: LogicConfig): string {
  const counts = new Array(24).fill(0);
  for (const j of allJourneys) {
    const d     = new Date(j.datetime);
    const ukOff = (d.getUTCMonth() + 1 >= 4 && d.getUTCMonth() + 1 <= 10) ? 60 : 0;
    counts[new Date(d.getTime() + ukOff * 60000).getUTCHours()]++;
  }
  const max  = Math.max(...counts, 1);
  const hrs    = chartHours(config, allJourneys);
  const startH = hrs[0];
  const endH   = hrs[hrs.length - 1];

  const rows = Array.from({ length: 24 }, (_, h) => {
    const count  = counts[h];
    const avg    = weeks > 0 ? (count / weeks).toFixed(1) : '0.0';
    const inHrs  = h >= startH && h <= endH;
    const barW   = max > 0 ? Math.round((count / max) * 200) : 0;
    if (count === 0 && !inHrs) return '';
    return `<tr style="${!inHrs ? 'opacity:0.4;' : ''}">
      <td style="font-size:15px;white-space:nowrap;width:55px;">${String(h).padStart(2,'0')}:00</td>
      <td style="padding-right:8px;"><div style="height:14px;width:${barW}px;background:${inHrs ? 'var(--accent)' : '#d1d5db'};border-radius:2px;display:inline-block;vertical-align:middle;opacity:0.85;"></div></td>
      <td class="num" style="font-size:15px;">${count}</td>
      <td class="num" style="font-size:15px;color:var(--muted);">${avg}</td>
    </tr>`;
  }).filter(Boolean).join('');

  return `<div class="card">
    <div class="card-title">Calls by Hour of Day (${weeks} weeks)</div>
    <table class="tbl" style="max-width:450px;">
      <thead><tr><th>Hour</th><th>Volume</th><th class="num">Calls</th><th class="num">Avg/Week</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:14px;color:var(--muted);margin-top:10px;">Rolling charts are based on all available call data. Avg/week = total calls in that hour ÷ number of weeks. Greyed hours are outside configured business hours.</p>
  </div>`;
}

// ── Heatmap (calls per minute by hour × day, 8 weeks) ────────────────────────

function renderHeatmap(allJourneys: CallJourney[], weeks: number, config: LogicConfig): string {
  const hrs = chartHours(config, allJourneys);
  const grid = new Map<string, number>();
  for (const j of allJourneys) {
    const d     = new Date(j.datetime);
    const month = d.getUTCMonth() + 1;
    const ukOff = (month >= 4 && month <= 10) ? 60 : 0;
    const ukD   = new Date(d.getTime() + ukOff * 60000);
    const dow   = ukD.getUTCDay();
    const hour  = ukD.getUTCHours();
    if (dow === 0 || dow === 6 || !hrs.includes(hour)) continue;
    const key = `${dow}|${hour}`;
    grid.set(key, (grid.get(key) || 0) + 1);
  }
  const max = Math.max(...grid.values(), 1);
  const hourHdrs = hrs.map(h => `<th>${h}:00</th>`).join('');
  const dayRows  = [1,2,3,4,5].map(dow => {
    const cells = hrs.map((hour) => {
      const count = grid.get(`${dow}|${hour}`) || 0;
      const avg   = count > 0 ? (count / weeks).toFixed(1) : '';
      const style = heatmapColour(count, max);
      return `<td style="${style}" title="${DAY_NAMES_FULL[dow]} ${hour}:00 — avg ${avg} calls/wk">${avg}</td>`;
    }).join('');
    return `<tr><td class="row-label">${DAY_NAMES[dow]}</td>${cells}</tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">Call Volume Heatmap — average total calls in that hour on a typical week (${weeks} weeks)</div>
    <div class="heatmap"><table>
      <thead><tr><th></th>${hourHdrs}</tr></thead>
      <tbody>${dayRows}</tbody>
    </table></div>
    <p style="font-size:16px;color:var(--accent);font-weight:600;margin-top:12px;padding:10px 14px;background:#f0f9ff;border-left:3px solid var(--accent);border-radius:4px;">Each cell shows the average number of calls arriving in that one-hour slot on a typical week. Mon 09:00 = 19 means roughly 19 calls come in between 9am–10am on a typical Monday — about one every 3 minutes.</p>
  </div>`;
}

// ── Data pool banner — tells the reader exactly what data the report is built on ──
function renderDataRange(
  thisWeek: CallJourney[], rollingEight: CallJourney[],
  weekStart: Date, weekEnd: Date, rollingWeeks: number
): string {
  const pool  = rollingEight.length ? rollingEight : thisWeek;
  const times = pool.map(j => new Date(j.datetime).getTime());
  const min   = times.length ? new Date(Math.min(...times)) : weekStart;
  const max   = times.length ? new Date(Math.max(...times)) : weekEnd;
  return `<div class="card" style="background:#f0f4ff;border-color:#c7d2fe;">
    <div class="card-title" style="margin-bottom:8px;">Data Pool</div>
    <div style="font-size:16px;color:#3730a3;line-height:1.8;">
      <strong>This report (week):</strong> ${fmtDate(weekStart)} – ${fmtDate(weekEnd)}<br>
      <strong>Rolling charts below use all available data:</strong> ${fmtDate(min)} – ${fmtDate(max)}
      &nbsp;·&nbsp; ${rollingWeeks} week${rollingWeeks !== 1 ? 's' : ''} of data
    </div>
  </div>`;
}

// Exposed as composable report modules (reports/modules.ts) so they're tick-box selectable.
// (These are the weekly-specific / rolling blocks; the shared ones live in group-call-performance.)
export {
  renderSummaryList, renderMissedHeatmap, renderCallVolumeAnalysis, renderRollingSummary,
  renderCallsByDow, renderCallsByHour, renderHeatmap, renderPeakConcurrency,
};

// ── Main generator ────────────────────────────────────────────────────────────

export function generateWeeklyReport(params: {
  customerName:  string;
  siteName:      string;
  weekStart:     Date;
  weekEnd:       Date;
  thisWeek:      CallJourney[];
  rollingEight:  CallJourney[];
  weekBuckets:   WeekBucket[];
  config:        LogicConfig;
  weekNumber?:   number;
  rollingWeeks?: number;
}): string {
  const { customerName, siteName, weekStart, weekEnd, thisWeek, rollingEight, weekBuckets, config, weekNumber } = params;
  const rollingWeeks = params.rollingWeeks ?? weekBuckets.length;

  const weekNum  = weekNumber || Math.ceil((new Date(weekStart).getTime() - new Date(weekStart.getFullYear(), 0, 1).getTime()) / 604800000);
  const title    = `Weekly Call Stats — ${siteName}`;
  const period   = `${customerName} &nbsp;·&nbsp; Week ${weekNum} &nbsp;·&nbsp; ${fmtDateShort(weekStart)} – ${fmtDateShort(weekEnd)}`;

  const body = `
    ${renderDataRange(thisWeek, rollingEight, weekStart, weekEnd, rollingWeeks)}
    ${renderScorecard(thisWeek, config)}
    ${renderSummaryList(thisWeek, config)}
    ${renderDailyBreakdown(thisWeek, weekStart)}
    ${renderMissedHeatmap(rollingEight, config)}
    ${renderCallVolumeAnalysis(thisWeek, config)}
    ${renderCallFlowBreakdown(thisWeek, config)}
    ${renderRollingSummary(weekBuckets)}
    ${renderCallsByDow(rollingEight, rollingWeeks)}
    ${renderCallsByHour(rollingEight, rollingWeeks, config)}
    ${renderHeatmap(rollingEight, rollingWeeks, config)}
    ${renderPeakConcurrency(rollingEight, rollingWeeks, config)}
    ${renderAllCalls(thisWeek, config)}
  `;

  return reportHtml(title, period, body);
}
