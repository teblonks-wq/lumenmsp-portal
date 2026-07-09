import { CallEventRow, LogicConfig } from '../../insights-journeys';
import { reportHtml } from './report-styles';
import { computeOutbound, renderStaffPerformance } from './group-call-performance';

// "Site Performance" — a USERS report. Over an arbitrary date range it shows per-person
// (per-extension) answering only. IVR options / hunt-group routing live in the config so the
// journey logic can attribute *who* answered each call, but the aggregate call-volume scorecard
// and the group call-flow tallies are intentionally NOT shown — this report is about staff, not
// call totals.

function fmtD(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function generateSitePerformanceReport(params: {
  customerName: string;
  siteName:     string;
  from:         Date;   // inclusive range start (display)
  to:           Date;   // inclusive range end (display)
  journeys?:    unknown; // accepted but unused — this report doesn't show call-volume aggregates
  extRows:      CallEventRow[];
  config:       LogicConfig;
}): string {
  const { customerName, siteName, from, to, extRows, config } = params;

  const title  = `Site Performance — ${siteName}`;
  const period = `${customerName} &nbsp;·&nbsp; ${fmtD(from)} – ${fmtD(to)}`;

  // Outbound per extension feeds the staff table's Outbound column; we don't surface the total.
  const outbound = computeOutbound(extRows, config);

  const intro = `<p style="color:#6b7280;font-size:16px;margin:0 0 16px;">
    Per-person answering across the period (business hours only). Hunt-group / IVR routing is used
    to attribute who answered each call; group and call-volume totals are intentionally not shown.
  </p>`;

  const body = `
    ${intro}
    ${renderStaffPerformance(extRows, config, outbound.byExt)}
  `;

  return reportHtml(title, period, body);
}
