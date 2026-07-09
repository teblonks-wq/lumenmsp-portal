import {
  CallJourney, CallEventRow, LogicConfig, ReportMetrics,
  calcMetrics, formatWait, pct, isInHours, formatRoute
} from '../../insights-journeys';
import { reportHtml, rateColour } from './report-styles';

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// ── Shared helpers ──────────────────────────────────────────────────────────
const normExt = (v?: string | null) => (v || '').replace(/@.*$/, '').trim().toLowerCase();

// Tollring's Direction is inbound vs outbound; outbound is the only value that
// starts with "o" (O / Out / Outbound), so this matches it without guessing format.
const isOutbound = (dir?: string | null) => /^o/i.test(String(dir || '').trim());

function groupNamesSet(config: LogicConfig): Set<string> {
  return new Set(
    [...(config.source_of_truth_group || []),
     ...((config.ivr_options || []).map(o => o.group)),
     ...((config.call_flow || []).map(cf => cf.group))]
      .filter(Boolean).map(normExt)
  );
}

// Outbound calls per extension (distinct CallId), business-hours scoped, group
// pilots excluded, restricted to configured staff when set. Returns per-ext counts
// (keyed by normalised extno) and the overall total for the scorecard.
export function computeOutbound(extRows: CallEventRow[], config: LogicConfig): { byExt: Map<string, number>; total: number } {
  const groups   = groupNamesSet(config);
  const bhOnly   = config.business_hours_only !== false;
  const staffSet = config.staff_extensions?.length ? new Set(config.staff_extensions.map(normExt)) : null;

  const callsByExt = new Map<string, Set<string>>();
  const totalCalls = new Set<string>();
  for (const r of extRows) {
    if (!isOutbound(r.direction)) continue;
    const ext = (r.extno || '').trim();
    if (!ext) continue;
    const key = normExt(ext);
    if (groups.has(key)) continue;
    if (staffSet && !staffSet.has(key)) continue;
    if (bhOnly && !isInHours(r.event_datetime, config.business_hours)) continue;
    const cid = r.call_id || ('leg-' + r.id);
    if (!callsByExt.has(key)) callsByExt.set(key, new Set());
    callsByExt.get(key)!.add(cid);
    totalCalls.add(cid);
  }
  const byExt = new Map<string, number>();
  for (const [k, set] of callsByExt) byExt.set(k, set.size);
  return { byExt, total: totalCalls.size };
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

export function renderScorecard(journeys: CallJourney[], config: LogicConfig, outboundTotal: number): string {
  const m = calcMetrics(journeys);
  const rateClass   = rateColour(m.answerRate);
  const ovLabel     = config.overflow_label ? `Overflow — ${config.overflow_label}` : 'Overflow';
  const voicemail   = journeys.filter(j => j.is_voicemail && !j.is_emergency).length;
  const emergency   = journeys.filter(j => j.is_emergency).length;

  const cards = [
    { val: m.total,      lbl: 'Total Calls',   cls: '' },
    { val: m.answered,   lbl: 'Answered',      cls: 'stat-good' },
    { val: m.missed,     lbl: 'Missed',        cls: m.missed > 0 ? 'stat-bad' : '' },
    { val: m.answerRate + '%', lbl: 'Answer Rate', cls: `stat-${rateClass}` },
    ...(config.overflow_label || m.overflowed > 0 ? [{ val: m.overflowed, lbl: ovLabel, cls: '' }] : []),
    ...(voicemail > 0 ? [{ val: voicemail, lbl: 'Voicemail', cls: '' }] : []),
    ...(emergency > 0 ? [{ val: emergency, lbl: 'Emergency', cls: 'stat-bad' }] : []),
    { val: outboundTotal, lbl: 'Outbound', cls: '' },
    { val: formatWait(m.avgWaitMissed), lbl: 'Avg Wait (Missed)', cls: '' },
  ];

  return '<div class="stat-grid">'
    + cards.map(c => `<div class="stat ${c.cls}"><div class="stat-val">${c.val}</div><div class="stat-lbl">${c.lbl}</div></div>`).join('')
    + '</div>';
}

// ── Call Flow Breakdown ───────────────────────────────────────────────────────

export function renderCallFlowBreakdown(journeys: CallJourney[], config: LogicConfig): string {
  if (!config.call_flow?.length) return '';
  const rows = config.call_flow.map(cf => {
    const reached   = journeys.filter(j => j.steps.some(s => s.group === cf.group));
    const answeredH = reached.filter(j => j.steps.some(s => s.group === cf.group && s.outcome.toLowerCase() === 'answered'));
    // "Passed On" = the JOURNEY left this group unanswered and went somewhere else. The previous
    // per-step version counted re-offers WITHIN the same group (retry legs) as passes, which
    // produced impossible numbers (e.g. 52/53 answered yet "36 passed on").
    const overNext  = reached.filter(j => {
      const answeredHere = j.steps.some(s => s.group === cf.group && s.outcome.toLowerCase() === 'answered');
      if (answeredHere) return false;
      const lastIdx = j.steps.map(s => s.group).lastIndexOf(cf.group);
      return j.steps.slice(lastIdx + 1).some(s => s.group !== cf.group);
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

// ── Staff Performance ─────────────────────────────────────────────────────────

interface StaffMember {
  extension: string;
  answered:  number;   // legs this extension picked up
  bounced:   number;   // legs that rang here but were not answered
  totalRing: number;   // sum of ring seconds across all their legs
  legs:      number;
}

export function renderStaffPerformance(extRows: CallEventRow[], config: LogicConfig, outboundByExt: Map<string, number>): string {
  const norm = normExt;

  // Group/queue names are NOT people. Tollring sometimes logs the hunt-group pilot
  // (e.g. LargeAnimalGroup11New) in the extno field; those must never appear as a
  // staff member. Build the set of every configured group name to exclude.
  const groupNames = groupNamesSet(config);
  const isGroup = (ext: string) => groupNames.has(norm(ext));

  // Only consider legs belonging to THIS report's groups (source-of-truth + IVR
  // options). extRows is every leg for the whole customer that day, so without this
  // every other site's extensions leak into the table.
  const allowed = new Set(
    [...(config.source_of_truth_group || []), ...((config.ivr_options || []).map(o => o.group))]
      .filter(Boolean).map(g => g.trim().toLowerCase())
  );
  let relevant = allowed.size
    ? extRows.filter(r => allowed.has((r.group_name || '').trim().toLowerCase()))
    : extRows;

  // Business-hours scope (same as the rest of the report): drop out-of-hours legs.
  if (config.business_hours_only !== false) {
    relevant = relevant.filter(r => isInHours(r.event_datetime, config.business_hours));
  }

  // Attribute by CALL, not by leg. Group every leg by its Tollring CallId (one ID
  // spans the whole call). Credit the ONE *person* who answered; a call answered only
  // at group/pilot level has no identifiable person, so nobody is credited or charged
  // a bounce for it (it's a group miss, not an individual's fault).
  const byCall = new Map<string, CallEventRow[]>();
  for (const row of relevant) {
    if (!(row.extno || '').trim()) continue;
    if (isGroup(row.extno || '')) continue;   // exclude group-pilot legs entirely
    const key = row.call_id || ('leg-' + row.id);
    if (!byCall.has(key)) byCall.set(key, []);
    byCall.get(key)!.push(row);
  }

  const staffMap = new Map<string, StaffMember>();
  const touch = (ext: string): StaffMember => {
    if (!staffMap.has(ext)) staffMap.set(ext, { extension: ext, answered: 0, bounced: 0, totalRing: 0, legs: 0 });
    return staffMap.get(ext)!;
  };

  for (const legs of byCall.values()) {
    // The person who answered (group legs already stripped out above).
    const answerLeg = legs.find(l => (l.outcome || '').toLowerCase() === 'answered');
    const answerExt = answerLeg ? (answerLeg.extno || '').trim() : '';
    const rangExts = new Set(legs.map(l => (l.extno || '').trim()).filter(Boolean));
    for (const ext of rangExts) {
      const s = touch(ext);
      s.legs++;
      if (ext === answerExt)      { s.answered++; s.totalRing += answerLeg!.wait_seconds || 0; }
      else if (answerExt)         { s.bounced++; }   // bounce only when a colleague took it
    }
  }

  // When a staff list is configured, every one of those people should appear — even
  // with zero inbound legs — so someone who only made outbound calls still shows.
  if (config.staff_extensions?.length) {
    for (const e of config.staff_extensions) { if (e && !isGroup(e)) touch(e.trim()); }
  }

  let staff = [...staffMap.values()]
    .filter(s => !isGroup(s.extension))   // belt-and-braces: no group rows
    .sort((a, b) => b.answered - a.answered || b.legs - a.legs);

  // Restrict to the staff extensions configured on the report (so other non-staff
  // extnos don't show). If none configured, show all individuals. Anyone excluded who
  // actually ANSWERED or made outbound calls is surfaced in a footnote — hiding them
  // silently made the staff table disagree with the scorecard (the LA.Spare lesson).
  let hiddenActive: StaffMember[] = [];
  if (config.staff_extensions?.length) {
    const staffSet = new Set(config.staff_extensions.map(norm));
    hiddenActive = staff.filter(s => !staffSet.has(norm(s.extension)) && (s.answered > 0 || (outboundByExt.get(norm(s.extension)) || 0) > 0));
    staff = staff.filter(s => staffSet.has(norm(s.extension)));
  }
  if (staff.length === 0 && hiddenActive.length === 0) return '';

  // Top 10 users only (already sorted by answered, then legs).
  const totalStaff = staff.length;
  staff = staff.slice(0, 10);

  const rows = staff.map(s => {
    const offered   = s.answered + s.bounced;
    const rate      = offered > 0 ? pct(s.answered, offered) : '—';
    const avgRing   = s.answered > 0 ? formatWait(Math.round(s.totalRing / s.answered)) : '—';
    const rateClass = offered > 0 ? rateColour(Math.round(s.answered / offered * 100)) : '';
    const outbound  = outboundByExt.get(norm(s.extension)) || 0;
    return `<tr>
      <td style="font-size:16px;font-family:monospace;">${s.extension.replace(/@.*$/, '')}</td>
      <td class="num good">${s.answered}</td>
      <td class="num">${offered}</td>
      <td class="num ${rateClass}">${rate}</td>
      <td class="num bad">${s.bounced}</td>
      <td class="num">${avgRing}</td>
      <td class="num">${outbound}</td>
    </tr>`;
  }).join('');

  const hiddenNote = hiddenActive.length
    ? `<p style="margin:10px 0 0;color:var(--muted);font-size:14px;">Also active but not in this site's staff list: ${hiddenActive
        .map(h => {
          const ob = outboundByExt.get(norm(h.extension)) || 0;
          return `<strong>${h.extension.replace(/@.*$/, '')}</strong> (${h.answered} answered${ob ? `, ${ob} outbound` : ''})`;
        }).join(', ')}. Add them to the site's staff list to include them in the table.</p>`
    : '';

  return `<div class="card">
    <div class="card-title">Staff Performance${totalStaff > 10 ? ' — top 10 users' : ''}</div>
    ${totalStaff > 10 ? `<p style="margin:0 0 10px;color:var(--muted);font-size:14px;">Showing the top 10 of ${totalStaff} users by calls answered.</p>` : ''}
    <div class="table-wrap"><table class="tbl">
      <thead><tr>
        <th>Extension</th><th class="num">Answered</th><th class="num">Offered</th>
        <th class="num">Answer Rate</th><th class="num">Bounced (rang, not answered)</th>
        <th class="num">Avg Ring Time</th><th class="num">Outbound</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${hiddenNote}
  </div>`;
}

// ── All Calls Log ─────────────────────────────────────────────────────────────

function outcomeLabel(j: CallJourney): string {
  if (j.is_emergency)          return 'Emergency';
  if (j.is_ivr_voicemail)      return 'Chose Voicemail';
  if (j.is_overflow_voicemail) return 'Daytime Overflow (Voicemail)';
  return j.status;
}

function renderAllCalls(journeys: CallJourney[], config: LogicConfig): string {
  const tableId = 'all-calls-' + Math.random().toString(36).slice(2, 7);
  const rows = journeys.map(j => {
    const dt      = new Date(j.datetime);
    const time    = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const route   = formatRoute(j, config);
    const outcome = outcomeLabel(j);
    return `<tr>
      <td style="white-space:nowrap;font-size:15px;">${time}</td>
      <td style="font-family:monospace;font-size:15px;">${j.number || '—'}</td>
      <td style="font-size:15px;">${outcome}</td>
      <td class="num" style="font-size:15px;">${j.wait}</td>
      <td style="font-size:14px;color:#6b7280;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${route}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-header">
      <div class="card-title" style="margin-bottom:0;">All Calls (${journeys.length})</div>
      <button onclick="downloadCsv('${tableId}')" class="btn-secondary" style="font-size:15px;padding:4px 10px;">Download CSV</button>
    </div>
    <div style="max-height:400px;overflow-y:auto;">
      <table class="tbl" id="${tableId}">
        <thead><tr><th>Time</th><th>Number</th><th>Outcome</th><th class="num">Wait</th><th>Journey</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Main generator ────────────────────────────────────────────────────────────

export function generateDailyReport(params: {
  customerName:  string;
  siteName:      string;
  reportDate:    Date;
  journeys:      CallJourney[];
  extRows:       CallEventRow[];
  config:        LogicConfig;
}): string {
  const { customerName, siteName, reportDate, journeys, extRows, config } = params;

  const title  = `Daily Call Performance — ${siteName}`;
  const period = `${customerName} &nbsp;·&nbsp; ${fmtDate(reportDate)}`;

  const outbound = computeOutbound(extRows, config);

  const body = `
    ${renderScorecard(journeys, config, outbound.total)}
    ${renderCallFlowBreakdown(journeys, config)}
    ${renderStaffPerformance(extRows, config, outbound.byExt)}
    ${renderAllCalls(journeys, config)}
  `;

  return reportHtml(title, period, body);
}
