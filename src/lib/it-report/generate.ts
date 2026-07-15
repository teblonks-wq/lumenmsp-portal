import { pool } from '../../db/pool';
import { REPORT_CSS } from '../insights/reports/report-styles';
import { getIntuneSummary, getSecureScoreSummary, type IntuneSummary, type SecureScoreSummary, type VulnerabilitySummary, type Unavailable } from './graph-it';
import { getHelpdeskStats, fmtResponse, type HelpdeskStats } from './helpdesk';
import { getDnsSecurity, type DnsResult } from './dns';
import { getDmarcMonthSummary, type DmarcMonthSummary } from '../dmarc/store';
import { aiWriteItReport } from '../ai-compose';

// ── Monthly "IT Operations & Security Snapshot" ──────────────────────────────────
// Client-facing report per customer. Auto-fills from Intune (devices/compliance),
// portal tickets (support activity), live DNS (email security) and Defender/Secure
// Score; manual fields cover the sections we can't yet reach by API (backup, firewall
// threat counts, deliverability). The Service Delivery Manager's notes + the metrics
// are handed to Claude to write the Executive Summary and Overall Status. Mirrors the
// existing Staybrook snapshot layout and tone.

export interface ItManual {
  backupBullets?: string;      // newline-separated bullets
  backupStatus?: string;
  patchBullets?: string;
  patchStatus?: string;
  firewallBlocked?: string;    // kept as string so blank = "not provided"
  endpointThreats?: string;
  threatBullets?: string;
  threatStatus?: string;
  deliverabilityPct?: string;
  // Vulnerability testing — external monthly scan (RoboShadow); no remote access, so entered manually.
  vulnProvider?: string;       // default "RoboShadow"
  vulnTarget?: string;         // external IP / host scanned
  vulnCriticalCves?: string;
  vulnCves?: string;
  vulnPorts?: string;
  vulnWebAlerts?: string;
  vulnRiskLevel?: string;      // e.g. "Low"
  vulnBullets?: string;
  vulnStatus?: string;         // e.g. "Secured"
}

export interface ItReportConfig {
  id: number; customer_id: number; recipients: string; primary_domain: string;
  sdm_notes: string; manual: ItManual; auto_send: boolean; is_active: boolean;
}

// ── Schema (idempotent, portal DB) ───────────────────────────────────────────────
export async function ensureItReportTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS it_report_configs (
      id            SERIAL PRIMARY KEY,
      customer_id   INTEGER NOT NULL UNIQUE,
      recipients    TEXT DEFAULT '',
      primary_domain TEXT DEFAULT '',
      sdm_notes     TEXT DEFAULT '',
      manual        JSONB DEFAULT '{}'::jsonb,
      auto_send     BOOLEAN DEFAULT true,
      is_active     BOOLEAN DEFAULT false,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS it_report_runs (
      id            SERIAL PRIMARY KEY,
      customer_id   INTEGER NOT NULL,
      period_start  DATE NOT NULL,
      period_end    DATE NOT NULL,
      period_label  TEXT,
      sdm_notes     TEXT DEFAULT '',
      manual        JSONB DEFAULT '{}'::jsonb,
      subject       TEXT,
      html          TEXT,
      status        TEXT DEFAULT 'draft',
      error         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      sent_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_itrun_cust ON it_report_runs (customer_id, period_start DESC);
    CREATE TABLE IF NOT EXISTS it_report_notes (
      id           SERIAL PRIMARY KEY,
      customer_id  INTEGER NOT NULL,
      body         TEXT NOT NULL,
      author       TEXT DEFAULT '',
      category     TEXT DEFAULT 'observation',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_itnote_cust ON it_report_notes (customer_id, created_at DESC);
  `);
}

export interface ItNote { id: number; body: string; author: string; category: string; created_at: string; }

// Running SDM/observation notes for a customer within a period (e.g. "internet outage on 12th —
// considering a supplier review"). These are compiled into the report and handed to Claude.
export async function getItNotes(customerId: number, from: Date, to: Date): Promise<ItNote[]> {
  const r = await pool.query(
    'SELECT id, body, author, category, created_at FROM it_report_notes WHERE customer_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at',
    [customerId, from, to]
  );
  return r.rows as ItNote[];
}

// Notes to fold into a report: from the period start up to NOW (capped), not just the period end.
// This means notes added after month-end but before the report is generated/sent (the usual
// "wrap-up note before sending" and any testing done the following month) are still included,
// rather than silently dropping out because they fall past the calendar period.
export async function getReportNotes(customerId: number, from: Date, to: Date): Promise<ItNote[]> {
  const upperMs = Math.min(Date.now(), from.getTime() + 62 * 24 * 60 * 60 * 1000);
  const upper = new Date(Math.max(upperMs, to.getTime())); // at least the whole period, plus any wrap-up since
  return getItNotes(customerId, from, upper);
}

// Merge the period's running notes + the config's standing SDM commentary into one block for Claude.
export function compileSdmNotes(standing: string, notes: ItNote[]): string {
  const parts: string[] = [];
  if (standing && standing.trim()) parts.push(standing.trim());
  for (const n of notes) {
    const d = new Date(n.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    parts.push(`[${d}] ${n.body.trim()}`);
  }
  return parts.join('\n');
}

// The CUSTOMER RECORD drives the report domain (customer_domains, primary first) —
// the config's primary_domain field is only a fallback for customers with no domains
// recorded. (Decided 2026-07-08 after a typo in the free-text field checked the wrong domain.)
export async function reportDomain(customerId: number, fallback?: string | null): Promise<string> {
  const r = await pool.query(
    `SELECT LOWER(TRIM(domain)) AS domain FROM customer_domains
      WHERE customer_id=$1 AND COALESCE(TRIM(domain), '') <> ''
      ORDER BY is_primary DESC, id LIMIT 1`, [customerId]);
  return r.rows[0]?.domain || (fallback || '').trim().toLowerCase();
}

export async function getItConfig(customerId: number): Promise<ItReportConfig | null> {
  const r = await pool.query('SELECT * FROM it_report_configs WHERE customer_id=$1', [customerId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { ...row, manual: (row.manual && typeof row.manual === 'object') ? row.manual : {} } as ItReportConfig;
}

// ── Data collection ──────────────────────────────────────────────────────────────
export interface ItReportData {
  intune: IntuneSummary | Unavailable;
  secureScore: SecureScoreSummary | Unavailable;
  vulnerability: VulnerabilitySummary | Unavailable;
  helpdesk: HelpdeskStats;
  dns: DnsResult | null;
  dmarcMon: DmarcMonthSummary | null;  // LITS-DMARC — null unless the domain is monitored
}

export async function collectItReportData(customerId: number, tenant: string | null, domain: string, from: Date, to: Date): Promise<ItReportData> {
  const [intune, secureScore, helpdesk, dns, dmarcMon] = await Promise.all([
    getIntuneSummary(tenant),
    getSecureScoreSummary(tenant),
    getHelpdeskStats(customerId, from, to),
    domain ? getDnsSecurity(domain) : Promise.resolve(null),
    domain ? getDmarcMonthSummary(domain, from, to).catch(() => null) : Promise.resolve(null),
  ]);
  // Vulnerability comes from the monthly external RoboShadow scan (entered manually — no remote
  // access to auto-pull). Defender TVM stays available as a future auto-source but isn't called here.
  const vulnerability: Unavailable = { available: false, note: 'Provided from the monthly external scan.' };
  return { intune, secureScore, vulnerability, helpdesk, dns, dmarcMon };
}

// A full plain-text digest of EVERY collected + manual metric, so Claude forms a complete picture
// (devices, patching, backup, email security, threat protection, Secure Score, vulnerability,
// support activity) and can assess the whole estate — not just the notes.
function metricsBrief(d: ItReportData, m: ItManual): string {
  const L: string[] = [];
  if (d.intune.available) L.push(`Devices (Intune): ${d.intune.total} managed, ${d.intune.compliant} compliant (${d.intune.compliancePct}%), ${d.intune.nonCompliant} non-compliant, ${d.intune.encrypted} encrypted.`);
  else L.push(`Devices (Intune): not available (${d.intune.note}).`);
  const patch: string[] = [];
  if (d.intune.available) patch.push(`Windows patch compliance ${d.intune.compliancePct}%`);
  bulletsFromText(m.patchBullets).forEach((b) => patch.push(b));
  if (patch.length || m.patchStatus) L.push(`Patch/endpoint: ${patch.join('; ') || 'see status'}${m.patchStatus ? ` (status: ${m.patchStatus})` : ''}.`);
  const backup = bulletsFromText(m.backupBullets);
  if (backup.length || m.backupStatus) L.push(`Backup: ${backup.join('; ') || 'configured'}${m.backupStatus ? ` (status: ${m.backupStatus})` : ''}.`);
  if (d.dns) L.push(`Email security: ${d.dns.rows.filter((r) => r.ok).length}/${d.dns.rows.length} DNS controls present for ${d.dns.domain}${m.deliverabilityPct ? `; deliverability ${m.deliverabilityPct}` : ''}.`);
  if (d.dmarcMon && d.dmarcMon.volume) L.push(`DMARC monitoring (LITS-DMARC): ${d.dmarcMon.volume} emails observed sent as ${d.dmarcMon.domain} this period; ${d.dmarcMon.alignedPct}% properly authenticated, ${d.dmarcMon.failed} failed authentication across ${d.dmarcMon.sources} sending IPs; policy ${d.dmarcMon.policy ? `p=${d.dmarcMon.policy}` : 'not yet published'}${d.dmarcMon.unknownFailingSources.length ? `; unrecognised failing sources: ${d.dmarcMon.unknownFailingSources.join(', ')}` : ''}.`);
  const threat = [m.firewallBlocked && `${m.firewallBlocked} firewall threats blocked`, m.endpointThreats && `${m.endpointThreats} endpoint threats removed`, ...bulletsFromText(m.threatBullets)].filter(Boolean);
  if (threat.length || m.threatStatus) L.push(`Threat protection: ${threat.join('; ') || 'monitored'}${m.threatStatus ? ` (status: ${m.threatStatus})` : ''}.`);
  if (d.secureScore.available) L.push(`Secure Score: ${d.secureScore.pct}% (${d.secureScore.currentScore}/${d.secureScore.maxScore})${d.secureScore.industryAvgPct != null ? `, industry average ${d.secureScore.industryAvgPct}%` : ''}.`);
  const vparts = [m.vulnCriticalCves && `${m.vulnCriticalCves} critical CVEs`, m.vulnCves && `${m.vulnCves} CVEs`, m.vulnPorts && `${m.vulnPorts} open ports`, m.vulnWebAlerts && `${m.vulnWebAlerts} web alerts`, m.vulnRiskLevel && `risk ${m.vulnRiskLevel}`].filter(Boolean);
  if (vparts.length) L.push(`Vulnerability scan (${(m.vulnProvider || 'RoboShadow')}${m.vulnTarget ? `, ${m.vulnTarget}` : ''}): ${vparts.join(', ')}.`);
  const h = d.helpdesk;
  L.push(`Support (working-hours timers): ${h.totalCases} total cases logged, ${h.resolved} resolved, ${h.closed} closed, ${h.open} still open; average first response ${fmtResponse(h.avgResponseMins)}${h.avgResolutionMins != null ? `, average resolution ${fmtResponse(h.avgResolutionMins)}` : ''}.`);
  return L.join('\n');
}

// ── HTML helpers ─────────────────────────────────────────────────────────────────
const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);

function statusPill(label: string): string {
  const l = label.toLowerCase();
  const col = /health|stable|good|secure/.test(l) ? '#16a34a' : /attention|action|risk|review/.test(l) ? '#d97706' : '#0369a1';
  const bg = /health|stable|good|secure/.test(l) ? '#dcfce7' : /attention|action|risk|review/.test(l) ? '#fef3c7' : '#e0f2fe';
  return `<span style="display:inline-block;font-size:14px;font-weight:700;color:${col};background:${bg};padding:4px 12px;border-radius:20px;">Status: ${esc(label)}</span>`;
}
function ticks(lines: string[]): string {
  return `<ul style="list-style:none;margin:0;padding:0;">` + lines.filter(Boolean).map((t) =>
    `<li style="padding:5px 0 5px 28px;position:relative;font-size:16px;"><span style="position:absolute;left:0;color:#16a34a;font-weight:800;">&#10004;</span>${t}</li>`).join('') + `</ul>`;
}
function bulletsFromText(txt?: string): string[] {
  return String(txt || '').split('\n').map((s) => s.replace(/^[\s•\-*✔]+/, '').trim()).filter(Boolean);
}
function card(title: string, inner: string, status?: string): string {
  return `<div class="card"><div class="card-title" style="font-size:17px;color:#0f172a;">${esc(title)}</div>${inner}${status ? `<div style="margin-top:14px;">${statusPill(status)}</div>` : ''}</div>`;
}
function pending(note: string, manualHint = ''): string {
  return `<p style="margin:0;color:#6b7280;font-size:15px;">${esc(note)}${manualHint ? ' ' + esc(manualHint) : ''}</p>`;
}

// ── Section renderers ────────────────────────────────────────────────────────────
function sectionDevices(d: ItReportData): string {
  if (!d.intune.available) {
    return card('Device Management & Compliance', pending(d.intune.note, 'Enrol devices in Intune or add device details manually.'), 'Data pending');
  }
  const s = d.intune;
  const rows = s.devices.map((dev) => `<tr>
      <td style="font-family:monospace;">${esc(dev.name)}</td>
      <td>${esc(dev.assignedTo)}</td>
      <td>${esc(dev.os)}</td>
      <td>${dev.compliant ? '<span class="badge badge-answered">Compliant</span>' : '<span class="badge badge-missed">Review</span>'}</td>
    </tr>`).join('');
  const table = s.devices.length ? `<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Device</th><th>Assigned to</th><th>OS</th><th>Compliance</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '';
  const inner = `${ticks([
    `<strong>${s.total}</strong> device${s.total === 1 ? '' : 's'} enrolled in Microsoft Intune`,
    `${s.compliant} of ${s.total} compliant (${s.compliancePct}%)`,
    s.encrypted ? `${s.encrypted} device${s.encrypted === 1 ? '' : 's'} with disk encryption enabled` : '',
    `Security baselines and policies enforced`,
    `Centralised visibility and compliance reporting enabled`,
  ])}<div style="height:12px;"></div>${table}`;
  const status = s.compliancePct >= 90 ? 'Healthy' : 'Attention';
  return card('Device Management & Compliance', inner, status);
}

function sectionPatch(d: ItReportData, m: ItManual): string {
  const bl = bulletsFromText(m.patchBullets);
  const base = d.intune.available ? [
    `Windows security patches ${d.intune.compliancePct}% compliant`,
    `Automatic update policies enforced via Intune`,
  ] : [];
  const lines = [...base, ...bl];
  if (!lines.length) return card('Patch Management & Endpoint Protection', pending('No patch data yet — add notes or connect Intune.'), 'Data pending');
  return card('Patch Management & Endpoint Protection', ticks(lines), m.patchStatus || (d.intune.available && d.intune.compliancePct >= 90 ? 'Healthy' : 'Active monitoring'));
}

function sectionBackup(m: ItManual): string {
  const bl = bulletsFromText(m.backupBullets);
  if (!bl.length) return card('Backup & Recovery Readiness', pending('Backup details not yet recorded.', 'Add the backup configuration in the report settings.'), 'Data pending');
  return card('Backup & Recovery Readiness', ticks(bl), m.backupStatus || 'Healthy');
}

function sectionDns(d: ItReportData, m: ItManual): string {
  if (!d.dns) return card('DNS & Email Security Status', pending('No primary domain set for this customer.', 'Add the domain in the report settings to enable live DNS checks.'), 'Data pending');
  const rows = d.dns.rows.map((r) => `<tr>
      <td><strong>${esc(r.record)}</strong></td><td>${esc(r.purpose)}</td>
      <td>${r.ok ? '<span style="color:#16a34a;font-weight:800;">&#10004;</span>' : '<span style="color:#dc2626;font-weight:800;">&#10007;</span>'}</td>
      <td style="color:#6b7280;font-size:14px;">${esc(r.detail)}</td>
    </tr>`).join('');
  const deliver = m.deliverabilityPct ? `<p style="margin:12px 0 0;font-size:16px;"><span style="color:#16a34a;font-weight:800;">&#10004;</span> Email deliverability measured at ${esc(m.deliverabilityPct)} with a healthy domain reputation.</p>` : '';
  // LITS-DMARC: when the domain is monitored, add what the aggregate reports actually saw this period.
  let dmarcBlock = '';
  if (d.dmarcMon && d.dmarcMon.volume) {
    const dm = d.dmarcMon;
    const pctCol = dm.alignedPct >= 98 ? '#16a34a' : dm.alignedPct >= 90 ? '#d97706' : '#dc2626';
    dmarcBlock = `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #e5e7eb;">
      <p style="margin:0 0 8px;font-weight:700;font-size:15px;">DMARC monitoring (email spoofing protection)</p>
      <div class="stat-grid">
        <div class="stat"><div class="stat-val">${dm.volume}</div><div class="stat-lbl">Emails sent as your domain</div></div>
        <div class="stat"><div class="stat-val" style="color:${pctCol};">${dm.alignedPct}%</div><div class="stat-lbl">Properly authenticated</div></div>
        <div class="stat"><div class="stat-val">${dm.failed}</div><div class="stat-lbl">Failed authentication</div></div>
        <div class="stat"><div class="stat-val">${dm.sources}</div><div class="stat-lbl">Sending sources seen</div></div>
      </div>
      ${dm.unknownFailingSources.length ? `<p style="margin:10px 0 0;font-size:14px;color:#b45309;">Unrecognised failing sources under review: ${esc(dm.unknownFailingSources.join(', '))}.</p>` : ''}
      ${dm.policy === 'none' ? `<p style="margin:10px 0 0;font-size:14px;color:#6b7280;">Policy is currently monitor-only (p=none); we are validating legitimate senders before moving to enforcement.</p>` : ''}
    </div>`;
  }
  const inner = `<p style="margin:0 0 12px;color:#6b7280;font-size:15px;">Domain: <strong>${esc(d.dns.domain)}</strong></p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Record</th><th>Purpose</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>${deliver}${dmarcBlock}`;
  const allOk = d.dns.rows.every((r) => r.ok);
  const dmarcConcern = !!(d.dmarcMon && d.dmarcMon.volume && d.dmarcMon.alignedPct < 90);
  return card('DNS & Email Security Status', inner, (allOk && !dmarcConcern) ? 'Healthy' : 'Attention');
}

function sectionThreat(d: ItReportData, m: ItManual): string {
  const lines: string[] = [];
  if (m.firewallBlocked) lines.push(`${esc(m.firewallBlocked)} inbound firewall threats blocked`);
  if (m.endpointThreats) lines.push(`${esc(m.endpointThreats)} endpoint threat(s) detected and removed`);
  lines.push(...bulletsFromText(m.threatBullets));
  if (d.vulnerability.available && d.vulnerability.exposureScore != null) lines.push(`Defender exposure score: ${d.vulnerability.exposureScore}`);
  if (!lines.length) return card('Security Threat Protection', pending('No threat metrics recorded for this period.', 'Add firewall/endpoint figures in the report settings.'), 'Data pending');
  return card('Security Threat Protection', ticks(lines), m.threatStatus || 'Healthy');
}

function sectionCyber(d: ItReportData): string {
  if (!d.secureScore.available) return card('Cyber Security Posture (Secure Score)', pending(d.secureScore.note), 'Data pending');
  const s = d.secureScore;
  const grid = `<div class="stat-grid">
    <div class="stat"><div class="stat-val">${s.pct}%</div><div class="stat-lbl">Microsoft Secure Score</div></div>
    <div class="stat"><div class="stat-val">${s.currentScore}</div><div class="stat-lbl">Points (of ${s.maxScore})</div></div>
    ${s.industryAvgPct != null ? `<div class="stat"><div class="stat-val">${s.industryAvgPct}%</div><div class="stat-lbl">Industry average</div></div>` : ''}
  </div>`;
  const recs = s.topActions.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Recommended improvement</th></tr></thead><tbody>${s.topActions.map((a) => `<tr><td>${esc(a.name)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const status = s.pct >= 70 ? 'Healthy' : s.pct >= 50 ? 'Active monitoring' : 'Attention';
  return card('Cyber Security Posture (Secure Score)', grid + recs, status);
}

function sectionVulnerability(d: ItReportData, m: ItManual): string {
  // Primary source: the monthly external scan (RoboShadow), entered manually — no remote access.
  const hasManual = [m.vulnCriticalCves, m.vulnCves, m.vulnPorts, m.vulnWebAlerts, m.vulnRiskLevel, m.vulnBullets, m.vulnTarget].some((x) => (x || '').toString().trim());
  if (hasManual) {
    const provider = (m.vulnProvider || 'RoboShadow').trim();
    const tiles: string[] = [];
    const tile = (v: string | undefined, label: string, good = true) => { if ((v || '').trim() !== '') tiles.push(`<div class="stat ${good && /^0$/.test((v || '').trim()) ? 'stat-good' : ''}"><div class="stat-val">${esc(v)}</div><div class="stat-lbl">${label}</div></div>`); };
    tile(m.vulnCriticalCves, 'Critical CVEs');
    tile(m.vulnCves, 'CVEs');
    tile(m.vulnPorts, 'Open ports');
    tile(m.vulnWebAlerts, 'Web alerts');
    if ((m.vulnRiskLevel || '').trim()) tiles.push(`<div class="stat"><div class="stat-val" style="font-size:26px;">${esc(m.vulnRiskLevel)}</div><div class="stat-lbl">Risk level</div></div>`);
    const grid = tiles.length ? `<div class="stat-grid">${tiles.join('')}</div>` : '';
    const meta = `<p style="margin:0 0 12px;color:#6b7280;font-size:15px;">External scan by <strong>${esc(provider)}</strong>${(m.vulnTarget || '').trim() ? ` &nbsp;·&nbsp; Target: <strong>${esc(m.vulnTarget)}</strong>` : ''} &nbsp;·&nbsp; run monthly.</p>`;
    const bl = bulletsFromText(m.vulnBullets);
    return card('Vulnerability Testing', meta + grid + (bl.length ? ticks(bl) : ''), m.vulnStatus || 'Secured');
  }
  // Secondary: Defender TVM if it ever becomes available (needs consent — usually not, given no remote access).
  if (d.vulnerability.available) {
    const v = d.vulnerability;
    const grid = `<div class="stat-grid">
      ${v.exposureScore != null ? `<div class="stat"><div class="stat-val">${v.exposureScore}</div><div class="stat-lbl">Exposure score</div></div>` : ''}
      ${v.configScore != null ? `<div class="stat"><div class="stat-val">${v.configScore}</div><div class="stat-lbl">Config score</div></div>` : ''}
    </div>`;
    return card('Vulnerability Testing', grid, 'Active monitoring');
  }
  return card('Vulnerability Testing', pending('No vulnerability scan recorded for this period.', 'Add the monthly RoboShadow results in the report settings.'), 'Data pending');
}

function sectionSupport(d: ItReportData): string {
  const h = d.helpdesk;
  const grid = `<div class="stat-grid">
    <div class="stat"><div class="stat-val">${h.totalCases}</div><div class="stat-lbl">Total cases</div></div>
    <div class="stat stat-good"><div class="stat-val">${h.resolved}</div><div class="stat-lbl">Resolved</div></div>
    <div class="stat"><div class="stat-val">${h.closed}</div><div class="stat-lbl">Closed</div></div>
    <div class="stat"><div class="stat-val">${h.open}</div><div class="stat-lbl">Still open</div></div>
    <div class="stat"><div class="stat-val">${h.avgResponseMins != null ? fmtResponse(h.avgResponseMins) : 'n/a'}</div><div class="stat-lbl">Avg response</div></div>
    <div class="stat"><div class="stat-val">${h.avgResolutionMins != null ? fmtResponse(h.avgResolutionMins) : 'n/a'}</div><div class="stat-lbl">Avg resolution</div></div>
  </div>`;
  const lines = [
    `${h.totalCases} support case${h.totalCases === 1 ? '' : 's'} logged during the period`,
    h.avgResponseMins != null ? `Average response time: ${fmtResponse(h.avgResponseMins)} (working hours)` : '',
    h.avgResolutionMins != null ? `Average resolution time: ${fmtResponse(h.avgResolutionMins)} (working hours)` : '',
    `${h.resolved} resolved and ${h.closed} closed`,
    h.open ? `${h.open} case${h.open === 1 ? '' : 's'} remain open and are being progressed` : 'All cases for the period resolved or closed',
  ];
  return card('Support & Service Activity', grid + ticks(lines), h.open ? 'Active monitoring' : 'Healthy');
}

// ── Assembly ─────────────────────────────────────────────────────────────────────
export interface GenerateOpts {
  customerId: number; customerName: string; tenant: string | null; domain: string;
  from: Date; to: Date; periodLabel: string;
  sdmNotes?: string; manual?: ItManual; useClaude?: boolean; preparedBy?: string;
}

export async function generateItReport(opts: GenerateOpts): Promise<{ html: string; subject: string; data: ItReportData }> {
  const data = await collectItReportData(opts.customerId, opts.tenant, opts.domain, opts.from, opts.to);
  const manual = opts.manual || {};

  // Claude writes the narrative from the SDM notes + metrics, consolidating & polishing every note
  // (spelling, grammar, IT terminology) into the Executive Summary, Commentary and Overall Status.
  let execSummary = '';
  let commentary = '';
  let overallStatus = '';
  if (opts.useClaude !== false) {
    try {
      const n = await aiWriteItReport({ clientName: opts.customerName, period: opts.periodLabel, metricsBrief: metricsBrief(data, manual), sdmNotes: opts.sdmNotes });
      execSummary = n.executiveSummary; commentary = n.commentary; overallStatus = n.overallStatus;
    } catch { /* fall through to a templated summary */ }
  }
  // If Claude was unavailable but the SDM left notes, still surface them (unpolished) so nothing is lost.
  if (!commentary && opts.sdmNotes && opts.sdmNotes.trim()) commentary = opts.sdmNotes.trim();
  if (!execSummary) {
    const h = data.helpdesk;
    const dev = data.intune.available ? `${data.intune.total} managed device(s) remained protected and compliant. ` : '';
    execSummary = `During ${opts.periodLabel}, ${opts.customerName}'s IT environment remained secure and well maintained. ${dev}Support activity saw ${h.totalCases} case(s) logged with an average first response of ${fmtResponse(h.avgResponseMins)}; ${h.resolved} resolved, ${h.closed} closed and ${h.open} still in progress.`;
  }
  if (!overallStatus) overallStatus = 'Environment operating securely and efficiently; backup, patching and email security controls remain healthy. Open support items are in progress and under review.';

  const header = `<div class="report-header">
    <div class="report-header-top"><span class="report-logo">Lumen IT Solutions</span>
      <span class="report-title">IT Operations &amp; Security Snapshot</span></div>
    <div class="report-meta">Client: <strong style="color:#cbd5e1;">${esc(opts.customerName)}</strong> &nbsp;·&nbsp; Reporting period: ${esc(opts.periodLabel)} &nbsp;·&nbsp; Prepared by ${esc(opts.preparedBy || 'Lumen IT Solutions')}</div>
  </div>`;

  const commentaryCard = commentary
    ? card('Service Delivery Commentary', `<p style="margin:0;font-size:16px;line-height:1.6;">${esc(commentary).replace(/\n\n/g, '</p><p style="margin:12px 0 0;font-size:16px;line-height:1.6;">').replace(/\n/g, '<br>')}</p>`)
    : '';

  const body = [
    card('Executive Summary', `<p style="margin:0;font-size:16px;line-height:1.6;">${esc(execSummary).replace(/\n/g, '<br>')}</p>`),
    commentaryCard,
    sectionDevices(data),
    sectionPatch(data, manual),
    sectionBackup(manual),
    sectionDns(data, manual),
    sectionThreat(data, manual),
    sectionCyber(data),
    sectionVulnerability(data, manual),
    sectionSupport(data),
    card('Overall IT Status', `<p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${esc(overallStatus).replace(/\n/g, '<br>')}</p>` + ticks([
      'Environment operating securely and efficiently',
      'Backup, patching and email security controls reviewed',
      data.helpdesk.open ? 'Open support items are in progress and under review' : 'No outstanding support items',
    ]), 'Stable'),
  ].join('\n');

  const subject = `IT Operations & Security Snapshot — ${opts.customerName} — ${opts.periodLabel}`;
  const html = itDocument(subject, header + body);
  return { html, subject, data };
}

// Standalone HTML document reusing the report stylesheet + a print/Save-as-PDF toolbar.
function itDocument(title: string, inner: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${REPORT_CSS}
#report-toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:8px;padding:8px 20px;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.06);}
@media print{#report-toolbar{display:none !important;}}</style></head><body>
<div id="report-toolbar">
  <span style="font-weight:700;font-size:15px;color:#111;flex:1;">Lumen IT Solutions — IT Snapshot</span>
  <button onclick="window.print()" style="padding:6px 14px;background:#0ea5b7;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Save as PDF</button>
</div>
<div class="report-wrap">${inner}</div>
</body></html>`;
}
