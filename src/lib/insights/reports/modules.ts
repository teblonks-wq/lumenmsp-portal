import { CallJourney, CallEventRow, LogicConfig, calcMetrics, formatRoute, isInHours } from '../../insights-journeys';
import { reportHtml, rateColour } from './report-styles';
import { computeOutbound, renderScorecard, renderCallFlowBreakdown, renderStaffPerformance } from './group-call-performance';
import {
  renderSummaryList, renderMissedHeatmap, renderCallVolumeAnalysis, renderRollingSummary,
  renderCallsByDow, renderCallsByHour, renderHeatmap, renderPeakConcurrency,
} from './weekly-call-stats';

export interface WeekBucket { label: string; total: number; answered: number; missed: number; }

// ── Report module registry ──────────────────────────────────────────────────────
// A report is now composed from named modules. Each module renders one content block from a shared
// ReportContext (call data + the SITE's logic). Templates in the pool are just an ordered list of
// module ids; this registry turns those ids into HTML. Site logic still lives on the site.

export interface ReportContext {
  customerName: string;
  siteName:     string;
  from:         Date;
  to:           Date;
  journeys:     CallJourney[];        // built from rows with the site's logic (business-hours filtered)
  extRows:      CallEventRow[];       // raw legs (for staff attribution / outbound)
  config:       LogicConfig;          // the site's logic
  outbound:     { byExt: Map<string, number>; total: number };
  rollingJourneys: CallJourney[];     // all-time/8-week journeys for the rolling modules
  weekBuckets:  WeekBucket[];         // per-week totals for the rolling summary
  rollingWeeks: number;
}

export interface ReportModule {
  id:    string;
  name:  string;                       // shown in the template builder
  group: string;                       // builder grouping
  render: (ctx: ReportContext) => string;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtD(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtDateTime(x: string): string {
  return new Date(x).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const isOutbound = (dir?: string | null) => /^o/i.test(String(dir || '').trim());
const numOf = (s?: string | null) => String(s || '').replace(/\s+/g, '');

// ── Daily breakdown (per-day totals across the range) ─────────────────────────────
function renderDailyBreakdown(ctx: ReportContext): string {
  const byDay = new Map<string, CallJourney[]>();
  for (const j of ctx.journeys) {
    const key = new Date(j.datetime).toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(j);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return '';
  const rows = days.map((k) => {
    const m = calcMetrics(byDay.get(k)!);
    const rc = rateColour(m.answerRate);
    const label = new Date(k + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `<tr><td style="white-space:nowrap;">${label}</td><td class="num">${m.total}</td><td class="num good">${m.answered}</td><td class="num bad">${m.missed}</td><td class="num ${rc}">${m.answerRate}%</td></tr>`;
  }).join('');
  return `<div class="card"><div class="card-title">Daily Breakdown (${days.length} day${days.length === 1 ? '' : 's'})</div>
    <div class="table-wrap" style="max-height:520px;overflow-y:auto;"><table class="tbl">
      <thead><tr><th>Day</th><th class="num">Total</th><th class="num">Answered</th><th class="num">Missed</th><th class="num">Answer Rate</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}

// ── All calls log ─────────────────────────────────────────────────────────────
function renderAllCalls(ctx: ReportContext): string {
  const tableId = 'all-calls-' + Math.random().toString(36).slice(2, 7);
  const rows = ctx.journeys.map((j) => {
    const route = formatRoute(j, ctx.config);
    return `<tr>
      <td style="white-space:nowrap;font-size:15px;">${fmtDateTime(j.datetime)}</td>
      <td style="font-family:monospace;font-size:15px;">${j.number || '—'}</td>
      <td style="font-size:15px;">${j.status}</td>
      <td style="font-family:monospace;font-size:15px;">${j.status === 'Answered' ? (j.answered_by || '—') : '—'}</td>
      <td class="num" style="font-size:15px;">${j.wait}</td>
      <td style="font-size:14px;color:#6b7280;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${route}</td>
    </tr>`;
  }).join('');
  return `<div class="card">
    <div class="card-header"><div class="card-title" style="margin-bottom:0;">All Calls (${ctx.journeys.length})</div>
      <button onclick="downloadCsv('${tableId}')" class="btn-secondary" style="font-size:15px;padding:4px 10px;">Download CSV</button></div>
    <div style="max-height:420px;overflow-y:auto;"><table class="tbl" id="${tableId}">
      <thead><tr><th>Time</th><th>Number</th><th>Outcome</th><th>Answered by</th><th class="num">Wait</th><th>Journey</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}

// ── Voicemail ─────────────────────────────────────────────────────────────────
function renderVoicemail(ctx: ReportContext): string {
  // Voicemail is a hunt group. Detect from the RAW legs (not the group-filtered journeys), so a call
  // that rolled to the voicemail group is counted even if that group isn't in the report's flow config.
  const isVm = (r: CallEventRow) => /voice\s*mail/i.test((r.group_name || '') + ' ' + (r.extno || ''));
  const byCall = new Map<string, CallEventRow>();
  for (const r of ctx.extRows) {
    if (!isVm(r)) continue;
    const k = r.call_id || ('leg-' + r.id);
    const prev = byCall.get(k);
    // Keep the answered leg for the call if there is one (that's the voicemail actually taking it).
    if (!prev || ((r.outcome || '').toLowerCase() === 'answered' && (prev.outcome || '').toLowerCase() !== 'answered')) byCall.set(k, r);
  }
  const vms = [...byCall.values()].sort((a, b) => new Date(a.event_datetime).getTime() - new Date(b.event_datetime).getTime());
  const rows = vms.map((r) => `<tr>
      <td style="white-space:nowrap;font-size:15px;">${fmtDateTime(new Date(r.event_datetime).toISOString())}</td>
      <td style="font-family:monospace;font-size:15px;">${r.number_normalised || r.number_raw || '—'}</td>
      <td style="font-size:15px;color:#6b7280;">${(r.group_name || '').replace(/@.*$/, '')}</td></tr>`).join('');
  return `<div class="card"><div class="card-title">Voicemail (${vms.length})</div>
    ${vms.length ? `<div class="table-wrap" style="max-height:360px;overflow-y:auto;"><table class="tbl">
      <thead><tr><th>Time</th><th>Number</th><th>Group</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted" style="margin:0;">No calls rolled to voicemail in this period.</p>'}</div>`;
}

// ── Outbound activity (per extension) ─────────────────────────────────────────────
function renderOutbound(ctx: ReportContext): string {
  const all = [...ctx.outbound.byExt.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!all.length) return `<div class="card"><div class="card-title">Outbound Activity</div><p class="muted" style="margin:0;">No outbound calls in this period.</p></div>`;
  const total = all.length;
  const entries = all.slice(0, 10); // top 10 users only
  const rows = entries.map(([ext, n]) => `<tr><td style="font-family:monospace;font-size:16px;">${ext.replace(/@.*$/, '')}</td><td class="num">${n}</td></tr>`).join('');
  return `<div class="card"><div class="card-title">Outbound Activity${total > 10 ? ' — top 10 users' : ''} — ${ctx.outbound.total} call${ctx.outbound.total === 1 ? '' : 's'}</div>
    ${total > 10 ? `<p style="margin:0 0 10px;color:var(--muted);font-size:14px;">Showing the top 10 of ${total} users by outbound calls.</p>` : ''}
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Extension</th><th class="num">Outbound calls</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

// ── Answer-time SLA ───────────────────────────────────────────────────────────
function renderSla(ctx: ReportContext): string {
  const threshold = Number((ctx.config as any).sla_seconds) || 20;
  const answered = ctx.journeys.filter((j) => j.status === 'Answered');
  const within = answered.filter((j) => (j.wait_secs || 0) <= threshold).length;
  const pct = answered.length ? Math.round((within / answered.length) * 100) : 0;
  const cls = rateColour(pct);
  return `<div class="card"><div class="card-title">Answer-time SLA (within ${threshold}s)</div>
    <div class="stat-grid">
      <div class="stat stat-${cls}"><div class="stat-val">${pct}%</div><div class="stat-lbl">Answered within ${threshold}s</div></div>
      <div class="stat"><div class="stat-val">${within}</div><div class="stat-lbl">Within SLA</div></div>
      <div class="stat stat-bad"><div class="stat-val">${answered.length - within}</div><div class="stat-lbl">Breaches</div></div>
    </div></div>`;
}

// ── Missed-call follow-up (chase list) ────────────────────────────────────────────
// A real, chaseable external caller: has ≥7 digits (extensions/short codes are internal) and isn't
// an anonymous/withheld caller (nothing to call back).
function isExternalNumber(num?: string | null): boolean {
  const raw = String(num || '');
  if (/anon|withheld|unknown/i.test(raw)) return false;
  return raw.replace(/\D/g, '').length >= 7;
}

function renderMissedFollowup(ctx: ReportContext): string {
  const missed = ctx.journeys.filter((j) => (j.status === 'Missed' || j.status === 'Abandoned') && isExternalNumber(j.number));
  if (!missed.length) return `<div class="card"><div class="card-title">Missed-call Follow-up</div><p class="muted" style="margin:0;">No external missed calls — nothing to chase.</p></div>`;
  // Numbers we later connected with: answered inbound OR called back (outbound leg to that number).
  const reconnected = new Set<string>();
  for (const j of ctx.journeys) if (j.status === 'Answered' && j.number) reconnected.add(numOf(j.number));
  for (const r of ctx.extRows) if (isOutbound(r.direction)) reconnected.add(numOf(r.number_normalised || r.number_raw));
  // Only the ones STILL to chase — a missed call whose number we never reconnected with.
  const outstanding = missed.filter((j) => !reconnected.has(numOf(j.number)));
  if (!outstanding.length) return `<div class="card"><div class="card-title">Missed-call Follow-up</div><p class="muted" style="margin:0;">All ${missed.length} missed call${missed.length === 1 ? '' : 's'} were reconnected — nothing left to chase.</p></div>`;
  const rows = outstanding.map((j) => `<tr>
      <td style="white-space:nowrap;font-size:15px;">${fmtDateTime(j.datetime)}</td>
      <td style="font-family:monospace;font-size:15px;">${j.number || '—'}</td>
      <td class="num" style="font-size:15px;">${j.wait}</td></tr>`).join('');
  return `<div class="card"><div class="card-title">Missed-call Follow-up — ${outstanding.length} to chase (of ${missed.length} missed)</div>
    <div class="table-wrap" style="max-height:420px;overflow-y:auto;"><table class="tbl">
      <thead><tr><th>Time</th><th>Number</th><th class="num">Wait</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}

// ── Registry ──────────────────────────────────────────────────────────────────
export const MODULES: Record<string, ReportModule> = {
  scorecard:       { id: 'scorecard',       name: 'Scorecard',              group: 'Summary',  render: (c) => renderScorecard(c.journeys, c.config, c.outbound.total) },
  daily_breakdown: { id: 'daily_breakdown', name: 'Daily Breakdown',        group: 'Summary',  render: renderDailyBreakdown },
  call_flow:       { id: 'call_flow',       name: 'Call Flow Breakdown',    group: 'Groups',   render: (c) => renderCallFlowBreakdown(c.journeys, c.config) },
  staff:           { id: 'staff',           name: 'Staff Performance',      group: 'People',   render: (c) => renderStaffPerformance(c.extRows, c.config, c.outbound.byExt) },
  outbound:        { id: 'outbound',        name: 'Outbound Activity',      group: 'People',   render: renderOutbound },
  sla:             { id: 'sla',             name: 'Answer-time SLA',        group: 'Service',  render: renderSla },
  missed_followup: { id: 'missed_followup', name: 'Missed-call Follow-up',  group: 'Service',  render: renderMissedFollowup },
  voicemail:       { id: 'voicemail',       name: 'Voicemail',             group: 'Service',  render: renderVoicemail },
  all_calls:       { id: 'all_calls',       name: 'All Calls log',          group: 'Detail',   render: renderAllCalls },
  call_summary:    { id: 'call_summary',    name: 'Call Summary',           group: 'Summary',  render: (c) => renderSummaryList(c.journeys, c.config) },
  hourly_volume:   { id: 'hourly_volume',   name: 'Call Volume by Hour',    group: 'Volume',   render: (c) => renderCallVolumeAnalysis(c.journeys, c.config) },
  hourly_missed:   { id: 'hourly_missed',   name: 'Missed Calls by Hour (all-time)', group: 'Volume', render: (c) => renderMissedHeatmap(c.rollingJourneys, c.config) },
  rolling_summary: { id: 'rolling_summary', name: 'Rolling Weekly Summary',  group: 'Trend',    render: (c) => renderRollingSummary(c.weekBuckets) },
  callers_by_day:  { id: 'callers_by_day',  name: 'Calls by Day of Week',    group: 'Trend',    render: (c) => renderCallsByDow(c.rollingJourneys, c.rollingWeeks) },
  hourly_avg:      { id: 'hourly_avg',      name: 'Calls by Hour of Day',    group: 'Trend',    render: (c) => renderCallsByHour(c.rollingJourneys, c.rollingWeeks, c.config) },
  heatmap:         { id: 'heatmap',         name: 'Call Volume Heatmap',     group: 'Trend',    render: (c) => renderHeatmap(c.rollingJourneys, c.rollingWeeks, c.config) },
  peak_concurrency:{ id: 'peak_concurrency',name: 'Peak Concurrent Demand',  group: 'Trend',    render: (c) => renderPeakConcurrency(c.rollingJourneys, c.rollingWeeks, c.config) },
};

// All weekly/rolling blocks are now ported into the registry above — nothing pending.
export const PENDING_MODULES: string[] = [];

export function moduleList(): { id: string; name: string; group: string }[] {
  return Object.values(MODULES).map((m) => ({ id: m.id, name: m.name, group: m.group }));
}

// Compose a report from an ordered list of module ids. Unknown ids are skipped.
export function renderReportFromModules(templateName: string, moduleIds: string[], ctx: ReportContext): string {
  const title  = `${templateName} — ${ctx.siteName}`;
  const period = `${ctx.customerName} &nbsp;·&nbsp; ${fmtD(ctx.from)} – ${fmtD(ctx.to)}`;
  const body = moduleIds.map((id) => (MODULES[id] ? MODULES[id].render(ctx) : '')).filter(Boolean).join('\n');
  return reportHtml(title, period, body);
}

// Assemble the shared context from raw legs + the site's logic (journeys are built by the caller,
// which owns buildJourneys + the fetch). computeOutbound is done here so every module shares it.
export function buildReportContext(input: {
  customerName: string; siteName: string; from: Date; to: Date;
  journeys: CallJourney[]; extRows: CallEventRow[]; config: LogicConfig;
  rollingJourneys?: CallJourney[]; weekBuckets?: WeekBucket[]; rollingWeeks?: number;
}): ReportContext {
  // BUSINESS-HOURS GUARANTEE: journeys are already strictly filtered by buildJourneys, but the raw
  // legs feed staff / outbound / voicemail directly. Filter them HERE — the single choke point — so
  // no module (or the CSV built from a module's table) can ever include an out-of-hours call.
  const bh = input.config.business_hours || { start: '08:00', end: '18:30' };
  const extRows = (input.config.business_hours_only !== false)
    ? input.extRows.filter((r) => isInHours(r.event_datetime, bh))
    : input.extRows;
  return {
    ...input,
    extRows,
    rollingJourneys: input.rollingJourneys || [],
    weekBuckets: input.weekBuckets || [],
    rollingWeeks: input.rollingWeeks || 0,
    outbound: computeOutbound(extRows, input.config),
  };
}

// Which modules need the rolling / all-time dataset (so the generator only fetches it when needed).
export const ROLLING_MODULES = ['hourly_missed', 'rolling_summary', 'callers_by_day', 'hourly_avg', 'heatmap', 'peak_concurrency'];
