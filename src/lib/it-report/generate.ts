import { pool } from '../../db/pool';
import { REPORT_CSS } from '../insights/reports/report-styles';
import { getIntuneSummary, getSecureScoreSummary, type IntuneSummary, type SecureScoreSummary, type VulnerabilitySummary, type Unavailable } from './graph-it';
import { getHelpdeskStats, fmtResponse, type HelpdeskStats } from './helpdesk';
import { getDnsSecurity, type DnsResult } from './dns';
import { getDmarcMonthSummary, getDomainHealth, type DmarcMonthSummary, type DomainHealth } from '../dmarc/store';
import { getBackupSummaryForCustomer, classifyPlanStatus, planStatusLabel, planTypeLabel, fmtBytes, type BackupSummary } from '../msp360';
import { getRmmPatchSummary, type RmmPatchSummary, type RmmUnavailable } from './rmm';
import { getAutoContent, type AutoContent } from './auto';
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
  excludedTickets?: string;    // newline-separated ticket numbers hidden from the report (internal noise)
  // FIGURE OVERRIDES. Every headline number in the report has a live source (Intune, the
  // RMM agents, the backup provider) and a key here. Blank or missing = use the live
  // figure, which is the normal state. A value typed on the settings page WINS — the
  // report then prints what Terry typed, and the settings page flags the figure as
  // overridden so it is never a surprise six months later. Keys are FIG_KEYS below.
  ovr?: Record<string, string>;
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
    ALTER TABLE it_report_runs ADD COLUMN IF NOT EXISTS cover_html TEXT;
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
  domainHealth: DomainHealth | null;   // LITS-DMARC deep check (score, SPF/DKIM/DMARC, platform DNS)
  backup: BackupSummary | null;        // MSP360 (and future providers) via backup_provider_links
  rmm: RmmPatchSummary | RmmUnavailable; // OUR agents: patch position + endpoint protection
  auto: AutoContent;                     // what the Portal can state for itself this period
}

export async function collectItReportData(customerId: number, tenant: string | null, domain: string, from: Date, to: Date, excludedTickets: string[] = [], periodLabel = 'the period'): Promise<ItReportData> {
  const [intune, secureScore, helpdesk, dns, dmarcMon, domainHealth, backup, rmm, auto] = await Promise.all([
    getIntuneSummary(tenant),
    getSecureScoreSummary(tenant),
    getHelpdeskStats(customerId, from, to, excludedTickets),
    domain ? getDnsSecurity(domain) : Promise.resolve(null),
    domain ? getDmarcMonthSummary(domain, from, to).catch(() => null) : Promise.resolve(null),
    domain ? getDomainHealth(domain).catch(() => null) : Promise.resolve(null),
    getBackupSummaryForCustomer(customerId).catch(() => null),
    getRmmPatchSummary(customerId).catch((e) => ({ available: false as const, note: 'patch data unavailable (' + String(e && e.message).slice(0, 60) + ')' })),
    getAutoContent(customerId, from, to, periodLabel),
  ]);
  // Vulnerability comes from the monthly external RoboShadow scan (entered manually — no remote
  // access to auto-pull). Defender TVM stays available as a future auto-source but isn't called here.
  const vulnerability: Unavailable = { available: false, note: 'Provided from the monthly external scan.' };
  return { intune, secureScore, vulnerability, helpdesk, dns, dmarcMon, domainHealth, backup, rmm, auto };
}

// A full plain-text digest of EVERY collected + manual metric, so Claude forms a complete picture
// (devices, patching, backup, email security, threat protection, Secure Score, vulnerability,
// support activity) and can assess the whole estate — not just the notes.
function metricsBrief(d: ItReportData, m: ItManual): string {
  const L: string[] = [];
  if (d.intune.available) L.push(`Devices (Intune): ${d.intune.total} managed, ${d.intune.compliant} compliant (${d.intune.compliancePct}%), ${d.intune.nonCompliant} non-compliant, ${d.intune.encrypted} encrypted.`);
  else L.push(`Devices (Intune): not available (${d.intune.note}).`);
  const patch: string[] = [];
  if (d.rmm.available) {
    const r = d.rmm;
    patch.push(`security patch compliance ${figN(m, 'patch_pct', r.compliancePct)}% across ${figN(m, 'patch_total', r.total)} device(s) carrying the LumenMSP Agent`);
    patch.push(`${figN(m, 'patch_critical', r.criticalOutstanding)} critical/important update(s) outstanding, ${figN(m, 'patch_reboot', r.rebootPending)} device(s) awaiting a restart`);
    if (r.notReporting) patch.push(`${r.notReporting} device(s) have not reported a patch scan in the last week`);
    patch.push(`endpoint protection on ${r.avProtected}/${r.total} device(s)${r.avProducts.length ? ` (${fig(m, 'patch_av', r.avProducts.join(', '))})` : ''}, ${r.avCurrentCount} with current definitions`);
  } else patch.push(`agent patch data not available (${d.rmm.note})`);
  bulletsFromText(m.patchBullets).forEach((b) => patch.push(b));
  L.push(`Patch/endpoint (measured by our RMM agents, NOT the same figure as Intune device compliance): ${patch.join('; ')}${m.patchStatus ? ` (status: ${m.patchStatus})` : ''}.`);
  if (d.backup) {
    const b = d.backup;
    const failing = b.plans.filter((pl) => classifyPlanStatus(pl.status) === 'failed').map((pl) => `${pl.computer} (${pl.planName} — ${planStatusLabel(pl.status)})`);
    L.push(`Backup (${b.providers.join(', ')}): ${fmtBytes(b.totalStorageBytes)} protected across ${b.companies.join(', ')}; ${b.plans.length} backup plans — ${b.okPlans} healthy, ${b.failedPlans} failing${b.otherPlans ? `, ${b.otherPlans} other` : ''}${failing.length ? `; failing: ${failing.slice(0, 5).join(', ')}` : ''}.`);
  }
  const backup = bulletsFromText(m.backupBullets);
  if (backup.length || m.backupStatus) L.push(`Backup notes: ${backup.join('; ') || 'configured'}${m.backupStatus ? ` (status: ${m.backupStatus})` : ''}.`);
  const delivPct = (m.deliverabilityPct || '').trim() || ((d.dmarcMon && d.dmarcMon.volume) ? `${d.dmarcMon.alignedPct}% (from DMARC authentication)` : '');
  if (d.dns) L.push(`Email security: ${d.dns.rows.filter((r) => r.ok).length}/${d.dns.rows.length} DNS controls present for ${d.dns.domain}${delivPct ? `; deliverability ${delivPct}` : ''}.`);
  if (d.domainHealth) {
    const dh = d.domainHealth;
    const issues = [...(dh.check?.spf?.issues || []), ...(dh.check?.dmarc?.issues || [])];
    L.push(`Domain Health (LITS-DMARC deep check): score ${dh.score}/100 for ${dh.domain}; DMARC policy ${dh.policy ? `p=${dh.policy}` : 'not published'} (agreed target p=${dh.targetPolicy}); SPF ${dh.check?.spf?.found ? 'published' : 'MISSING'}, DKIM ${dh.check?.dkim?.found ? `signing (${(dh.check?.dkim?.selectors || []).join(', ')})` : 'not signing'}${issues.length ? `; open issues: ${issues.slice(0, 4).join(' ')}` : '; no open issues'}.`);
  }
  if (d.dmarcMon && d.dmarcMon.volume) {
    const dm = d.dmarcMon;
    L.push(`DMARC monitoring (LITS-DMARC): ${dm.volume} emails observed sent as ${dm.domain} this period; ${dm.alignedPct}% properly authenticated, ${dm.failed} failed authentication across ${dm.sources} sending IPs; policy ${dm.policy ? `p=${dm.policy}` : 'not yet published'}${(dm.quarantined + dm.rejected) ? `; ${dm.quarantined + dm.rejected} spoofed/unauthenticated messages actioned by the policy (${dm.rejected} rejected, ${dm.quarantined} quarantined)` : ''}${dm.topSources.length ? `; sending services seen: ${dm.topSources.map((sx) => `${sx.name} ${sx.volume} @ ${sx.alignedPct}%${sx.known ? '' : ' UNRECOGNISED'}`).join(', ')}` : ''}${dm.unknownFailingSources.length ? `; unrecognised failing sources: ${dm.unknownFailingSources.join(', ')}` : ''}.`);
  }
  if (d.domainHealth?.check?.registry?.expires) {
    const reg = d.domainHealth.check.registry;
    L.push(`Domain registration: registrar ${reg.registrar || 'unknown'}, renews ${reg.expires}${d.domainHealth.check.dnsManager ? `, DNS managed at ${d.domainHealth.check.dnsManager}` : ''}.`);
  }
  const threat = [m.firewallBlocked && `${m.firewallBlocked} firewall threats blocked`, m.endpointThreats && `${m.endpointThreats} endpoint threats removed`, ...bulletsFromText(m.threatBullets)].filter(Boolean);
  if (threat.length || m.threatStatus) L.push(`Threat protection: ${threat.join('; ') || 'monitored'}${m.threatStatus ? ` (status: ${m.threatStatus})` : ''}.`);
  if (d.secureScore.available) L.push(`Secure Score: ${d.secureScore.pct}% (${d.secureScore.currentScore}/${d.secureScore.maxScore})${d.secureScore.industryAvgPct != null ? `, industry average ${d.secureScore.industryAvgPct}%` : ''}.`);
  const vparts = [m.vulnCriticalCves && `${m.vulnCriticalCves} critical CVEs`, m.vulnCves && `${m.vulnCves} CVEs`, m.vulnPorts && `${m.vulnPorts} open ports`, m.vulnWebAlerts && `${m.vulnWebAlerts} web alerts`, m.vulnRiskLevel && `risk ${m.vulnRiskLevel}`].filter(Boolean);
  if (vparts.length) L.push(`Vulnerability scan (${(m.vulnProvider || 'RoboShadow')}${m.vulnTarget ? `, ${m.vulnTarget}` : ''}): ${vparts.join(', ')}.`);
  const h = d.helpdesk;
  L.push(`Support (working-hours timers): ${h.totalCases} total cases logged, ${h.resolved} resolved, ${h.closed} closed, ${h.open} still open; average first response ${fmtResponse(h.avgResponseMins)}${h.avgResolutionMins != null ? `, average resolution ${fmtResponse(h.avgResolutionMins)}` : ''}.`);
  if (h.byCategory.length) L.push(`Support case mix: ${h.byCategory.map((c) => `${c.category} ×${c.count}`).join(', ')}.`);
  if (h.notable.length) L.push(`Cases worked this period (newest first): ${h.notable.map((n) => `${n.subject} [${n.status}]`).join('; ')}.`);
  return L.join('\n');
}

// ── Figure overrides ───────────────────────────────────────────────────
// One place that knows every editable figure: its key, the label the settings page shows,
// and where the live value comes from (liveFigures below). Adding a figure means adding a
// row here and reading it through fig()/figN() in the section — nothing else.
export const FIG_KEYS = [
  // Device Management & Compliance (Intune)
  { key: 'dev_total',     label: 'Devices enrolled in Intune',        group: 'Devices (Intune)' },
  { key: 'dev_compliant', label: 'Devices compliant',                 group: 'Devices (Intune)' },
  { key: 'dev_pct',       label: 'Device compliance %',               group: 'Devices (Intune)' },
  { key: 'dev_encrypted', label: 'Devices with disk encryption',      group: 'Devices (Intune)' },
  // Patch Management & Endpoint Protection (our RMM agents)
  { key: 'patch_total',    label: 'Devices under patch management',   group: 'Patching & endpoint (RMM)' },
  { key: 'patch_pct',      label: 'Security patch compliance %',      group: 'Patching & endpoint (RMM)' },
  { key: 'patch_critical', label: 'Critical updates outstanding',     group: 'Patching & endpoint (RMM)' },
  { key: 'patch_reboot',   label: 'Devices awaiting a restart',       group: 'Patching & endpoint (RMM)' },
  { key: 'patch_av',       label: 'Endpoint protection product(s)',   group: 'Patching & endpoint (RMM)' },
  { key: 'patch_avpct',    label: 'Endpoints protected %',            group: 'Patching & endpoint (RMM)' },
  // Security Threat Protection
  { key: 'threat_endpoint', label: 'Endpoint threats detected/removed', group: 'Threat protection' },
  { key: 'threat_firewall', label: 'Firewall threats blocked',          group: 'Threat protection' },
  // Backup & Recovery Readiness
  { key: 'bk_protected', label: 'Total protected data',               group: 'Backup & recovery' },
  { key: 'bk_plans',     label: 'Backup plans monitored',             group: 'Backup & recovery' },
  { key: 'bk_failed',    label: 'Plans needing attention',            group: 'Backup & recovery' },
] as const;
export type FigKey = typeof FIG_KEYS[number]['key'];

/** The typed override for a figure, trimmed — '' when there isn't one. */
function ovrRaw(m: ItManual, key: FigKey): string {
  return String((m.ovr || {})[key] ?? '').trim();
}
/** Text figure: the override if there is one, else the live value. */
function fig(m: ItManual, key: FigKey, live: string | number | null | undefined): string {
  const o = ovrRaw(m, key);
  return o || (live == null ? '' : String(live));
}
/** Numeric figure: the override only when it parses as a number, else the live value. */
function figN(m: ItManual, key: FigKey, live: number): number {
  const o = ovrRaw(m, key);
  if (!o) return live;
  const n = Number(o.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? live : n;
}
/** True when this figure is currently being overridden — used to mark the report source line. */
function isOvr(m: ItManual, ...keys: FigKey[]): boolean {
  return keys.some((k) => !!ovrRaw(m, k));
}

/**
 * The live figures exactly as the report would print them RIGHT NOW, with no overrides
 * applied — what the settings page shows in each box so Terry can see what would be
 * deployed before deciding to type over it. Deliberately cheap: Intune, the agents and the
 * backup provider only. No DNS, no Claude, no ticket maths.
 */
export async function liveFigures(customerId: number, tenant: string | null, from?: Date, to?: Date, periodLabel = 'the period'): Promise<{ figures: Record<string, string>; bullets: Record<string, string[]> }> {
  const [intune, backup, rmm, auto] = await Promise.all([
    getIntuneSummary(tenant).catch(() => ({ available: false as const, note: 'unavailable' })),
    getBackupSummaryForCustomer(customerId).catch(() => null),
    getRmmPatchSummary(customerId).catch(() => ({ available: false as const, note: 'unavailable' })),
    (from && to) ? getAutoContent(customerId, from, to, periodLabel).catch(() => null) : Promise.resolve(null),
  ]);
  const out: Record<string, string> = {};
  if (intune.available) {
    out.dev_total = String(intune.total);
    out.dev_compliant = String(intune.compliant);
    out.dev_pct = String(intune.compliancePct);
    out.dev_encrypted = String(intune.encrypted);
  }
  if (rmm.available) {
    out.patch_total = String(rmm.total);
    out.patch_pct = String(rmm.compliancePct);
    out.patch_critical = String(rmm.criticalOutstanding);
    out.patch_reboot = String(rmm.rebootPending);
    out.patch_av = rmm.avProducts.join(', ');
    out.patch_avpct = String(rmm.total ? Math.round((rmm.avProtected / rmm.total) * 100) : 0);
  }
  if (backup) {
    out.bk_protected = fmtBytes(backup.totalStorageBytes);
    out.bk_plans = String(backup.plans.length);
    out.bk_failed = String(backup.failedPlans);
  }
  // Firewall blocks are deliberately absent: nothing ingests them, so there is no live
  // value to show. The settings page says so rather than leaving an unexplained gap.
  if (auto) out.threat_endpoint = String(auto.endpointThreats);
  const bullets: Record<string, string[]> = auto
    ? { backupBullets: auto.backupBullets, patchBullets: auto.patchBullets, threatBullets: auto.threatBullets }
    : {};
  return { figures: out, bullets };
}

// ── HTML helpers ─────────────────────────────────────────────────────────────────
const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);

// ── Email-safe mini-charts ───────────────────────────────────────────────────
// Pure table/div CSS — no SVG, no JS — so they survive email clients (classic
// Outlook renders with Word: no flex, no border-radius; these degrade to square
// bars, which still read fine). Colour pair validated for colour-vision deficiency
// (cyan #0891b2 vs red #dc2626 — deutan dE 19.5, all checks pass); every bar also
// carries direct labels + counts so colour is never the only encoding.
const CHART_GOOD = '#0891b2';
const CHART_BAD = '#dc2626';

// Horizontal 0–100 meter (score gauges). Caller supplies the fill colour.
function meterBar(pct: number, color: string): string {
  const pv = Math.max(0, Math.min(100, pct));
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;"><tr>
    <td width="${pv}%" style="background:${color};height:12px;border-radius:6px 0 0 6px;font-size:0;line-height:0;">&nbsp;</td>
    <td style="background:#e5e7eb;height:12px;border-radius:0 6px 6px 0;font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;
}

// Two-segment split bar (good vs bad) with a 2px surface gap between segments and
// a labelled legend underneath — the split reads even without colour.
function splitBar(goodLabel: string, good: number, badLabel: string, bad: number): string {
  const total = good + bad;
  if (!total) return '';
  const gp = Math.round((good / total) * 1000) / 10;
  const chip = (c: string) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};margin-right:4px;"></span>`;
  const cells = bad
    ? `<td width="${Math.max(2, gp)}%" style="background:${CHART_GOOD};height:14px;border-radius:7px 0 0 7px;font-size:0;line-height:0;">&nbsp;</td>
       <td width="2" style="background:#ffffff;font-size:0;line-height:0;">&nbsp;</td>
       <td style="background:${CHART_BAD};height:14px;border-radius:0 7px 7px 0;font-size:0;line-height:0;">&nbsp;</td>`
    : `<td style="background:${CHART_GOOD};height:14px;border-radius:7px;font-size:0;line-height:0;">&nbsp;</td>`;
  return `<div style="margin-top:12px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${cells}</tr></table>
    <p style="margin:6px 0 0;font-size:13px;color:#475569;">${chip(CHART_GOOD)}${esc(goodLabel)}: <strong>${good}</strong> (${gp}%)${bad ? ` &nbsp;&nbsp;${chip(CHART_BAD)}${esc(badLabel)}: <strong>${bad}</strong>` : ''}</p>
  </div>`;
}

// Horizontal bar list for a category breakdown — single hue (magnitude, not identity;
// the row label carries identity), values labelled at the end of every row.
function hBars(items: { label: string; value: number }[]): string {
  if (!items.length) return '';
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px;">${items.map((i) => `<tr>
    <td style="padding:3px 10px 3px 0;font-size:13px;color:#475569;white-space:nowrap;width:1%;">${esc(i.label)}</td>
    <td style="padding:3px 0;"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
      <td width="${Math.max(3, Math.round((i.value / max) * 100))}%" style="background:${CHART_GOOD};height:12px;border-radius:6px;font-size:0;line-height:0;">&nbsp;</td>
      <td style="font-size:0;line-height:0;">&nbsp;</td>
    </tr></table></td>
    <td style="padding:3px 0 3px 8px;font-size:13px;font-weight:700;color:#0f172a;width:1%;">${i.value}</td>
  </tr>`).join('')}</table>`;
}

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
// A bullet box on the settings page works like every figure box: empty means "use what the
// Portal worked out", and anything typed REPLACES it outright. Not appends — replaces. The
// settings page shows the auto lines as the box's placeholder, so overtyping is editing
// something visible rather than guessing what you are adding to.
function bulletsOrAuto(typed: string | undefined, auto: string[]): string[] {
  const t = bulletsFromText(typed);
  return t.length ? t : auto;
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

// ── Binary status board (Overall IT Status) ──────────────────────────────────────
// Every report marker rolled up to one of three states, at a glance:
//   ok = green ✓  ·  attention = amber !  ·  pending = grey — (not yet monitored/consented)
type MarkerState = 'ok' | 'attention' | 'pending';
interface Marker { label: string; state: MarkerState; note: string; }

function reportMarkers(d: ItReportData, m: ItManual): Marker[] {
  const out: Marker[] = [];

  // Backup
  if (d.backup) {
    const failed = figN(m, 'bk_failed', d.backup.failedPlans);
    const plans = figN(m, 'bk_plans', d.backup.plans.length);
    out.push({ label: 'Backup & recovery', state: failed ? 'attention' : 'ok',
      note: failed ? `${failed} plan(s) need attention` : `${plans} plans healthy · ${fig(m, 'bk_protected', fmtBytes(d.backup.totalStorageBytes))}` });
  }
  else if (isOvr(m, 'bk_protected', 'bk_plans', 'bk_failed')) out.push({ label: 'Backup & recovery', state: figN(m, 'bk_failed', 0) ? 'attention' : 'ok', note: m.backupStatus || 'reported manually' });
  else out.push({ label: 'Backup & recovery', state: 'pending', note: 'no provider linked' });

  // Email security (Domain Health preferred, else live DNS)
  if (d.domainHealth && d.domainHealth.check) {
    const dh = d.domainHealth;
    const meetsTarget = !dh.check.dmarc?.issues?.some((i: string) => /below the agreed target/i.test(i));
    const dmarcConcern = !!(d.dmarcMon && d.dmarcMon.volume && d.dmarcMon.alignedPct < 90);
    out.push({ label: 'Email security', state: (dh.score >= 80 && meetsTarget && !dmarcConcern) ? 'ok' : 'attention',
      note: `Domain Health ${dh.score}/100${d.dmarcMon && d.dmarcMon.volume ? ` · ${d.dmarcMon.alignedPct}% authenticated` : ''}` });
  } else if (d.dns) {
    out.push({ label: 'Email security', state: d.dns.rows.every((r) => r.ok) ? 'ok' : 'attention', note: `${d.dns.rows.filter((r) => r.ok).length}/${d.dns.rows.length} DNS controls present` });
  } else out.push({ label: 'Email security', state: 'pending', note: 'no domain monitored' });

  // Device compliance (Intune only — the compliance-POLICY verdict, not patching)
  if (d.intune.available) {
    const pct = figN(m, 'dev_pct', d.intune.compliancePct), tot = figN(m, 'dev_total', d.intune.total);
    out.push({ label: 'Device compliance', state: pct >= 90 ? 'ok' : 'attention', note: `${pct}% of ${tot} devices compliant` });
  } else out.push({ label: 'Device compliance', state: 'pending', note: 'Intune access not yet granted' });

  // Patching & endpoint — its own marker off its own source (our agents), so it can read
  // Attention while Intune compliance reads OK, and vice versa. They are different things.
  if (d.rmm.available) {
    const pct = figN(m, 'patch_pct', d.rmm.compliancePct);
    const crit = figN(m, 'patch_critical', d.rmm.criticalOutstanding);
    const forced = (m.patchStatus || '').trim();
    const state: MarkerState = forced ? (/attention|review|risk|improv|poor|action/i.test(forced) ? 'attention' : 'ok')
      : (crit === 0 && pct >= 85) ? 'ok' : 'attention';
    out.push({ label: 'Patching & endpoint', state, note: `${pct}% patched · ${crit} critical outstanding` });
  }
  else if (m.patchStatus || (m.patchBullets || '').trim() || isOvr(m, 'patch_pct', 'patch_total')) out.push({ label: 'Patching & endpoint', state: /attention|review|risk|improv|medium|low|poor|action/i.test(m.patchStatus || '') ? 'attention' : 'ok', note: m.patchStatus || 'monitored' });
  else out.push({ label: 'Patching & endpoint', state: 'pending', note: 'no agent reporting for this customer' });

  // Threat protection (manual figures/status)
  if ((m.firewallBlocked || '').trim() || (m.endpointThreats || '').trim() || (m.threatStatus || '').trim() || (m.threatBullets || '').trim())
    out.push({ label: 'Threat protection', state: /attention|risk|incident/i.test(m.threatStatus || '') ? 'attention' : 'ok', note: m.threatStatus || 'monitored, no incidents' });
  else out.push({ label: 'Threat protection', state: 'pending', note: 'not reported this period' });

  // Cyber posture (Secure Score)
  if (d.secureScore.available) out.push({ label: 'Cyber posture (Secure Score)', state: d.secureScore.pct >= 70 ? 'ok' : 'attention', note: `${d.secureScore.pct}%` });
  else out.push({ label: 'Cyber posture (Secure Score)', state: 'pending', note: 'Graph access not yet granted' });

  // Vulnerability (external scan, manual)
  const hasVuln = [m.vulnCriticalCves, m.vulnCves, m.vulnRiskLevel, m.vulnStatus, m.vulnBullets].some((x) => (x || '').toString().trim());
  if (hasVuln) out.push({ label: 'Vulnerability testing', state: (Number(m.vulnCriticalCves) > 0 || /attention|high|critical/i.test(m.vulnRiskLevel || '')) ? 'attention' : 'ok', note: m.vulnStatus || (m.vulnRiskLevel ? `risk ${m.vulnRiskLevel}` : 'secured') });
  else out.push({ label: 'Vulnerability testing', state: 'pending', note: 'no scan this period' });

  // Support
  const h = d.helpdesk;
  out.push({ label: 'Support & service', state: 'ok', note: `${h.totalCases} case(s) · ${h.open} open, being progressed` });

  return out;
}

function overallMarkerState(d: ItReportData, m: ItManual): string {
  const ms = reportMarkers(d, m);
  if (ms.some((x) => x.state === 'attention')) return 'Attention';
  return 'Stable';
}

function statusBoard(d: ItReportData, m: ItManual): string {
  const dot = (st: MarkerState) => st === 'ok' ? '#16a34a' : st === 'attention' ? '#d97706' : '#94a3b8';
  const word = (st: MarkerState) => st === 'ok' ? 'OK' : st === 'attention' ? 'Needs attention' : 'Not monitored';
  const rows = reportMarkers(d, m).map((mk) => `<tr>
    <td style="padding:7px 10px;font-size:15px;font-weight:600;color:#0f172a;white-space:nowrap;">${esc(mk.label)}</td>
    <td style="padding:7px 10px;white-space:nowrap;">
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dot(mk.state)};margin-right:7px;vertical-align:middle;"></span>
      <span style="font-weight:700;color:${dot(mk.state)};font-size:14px;vertical-align:middle;">${word(mk.state)}</span>
    </td>
    <td style="padding:7px 10px;font-size:14px;color:#6b7280;">${esc(mk.note)}</td>
  </tr>`).join('');
  return `<div class="table-wrap"><table class="tbl" style="width:100%;"><tbody>${rows}</tbody></table></div>`;
}

// Where a section's numbers came from — and, when a figure has been typed over on the
// settings page, that it was. Said once, quietly, at the foot of the card: a customer
// reading a percentage is entitled to know what measured it.
function srcNote(text: string, overridden = false): string {
  return `<p style="margin:10px 0 0;font-size:13px;color:#94a3b8;">${esc(text)}${overridden ? ' Figures reviewed and confirmed by your service delivery manager.' : ''}</p>`;
}

// ── Section renderers ────────────────────────────────────────────────────────────
function sectionDevices(d: ItReportData, m: ItManual): string {
  // Device Management & Compliance is INTUNE ONLY. Backups (incl. Acronis M365 cloud
  // backup) belong in Backup & Recovery, never here — so when Intune isn't available this
  // is a straight "data pending" card, no backup fallback.
  if (!d.intune.available) {
    return card('Device Management & Compliance', pending(d.intune.note, 'Grant Microsoft Intune access for this organisation to populate device compliance.'), 'Data pending');
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
  // Every figure here can be typed over on the settings page; blank there = the live one.
  const total = figN(m, 'dev_total', s.total);
  const compliant = figN(m, 'dev_compliant', s.compliant);
  const pct = figN(m, 'dev_pct', s.compliancePct);
  const encrypted = figN(m, 'dev_encrypted', s.encrypted);
  const review = Math.max(0, isOvr(m, 'dev_total', 'dev_compliant') ? total - compliant : s.nonCompliant + s.unknown);
  const inner = `${ticks([
    `<strong>${total}</strong> device${total === 1 ? '' : 's'} enrolled in Microsoft Intune`,
    `${compliant} of ${total} compliant (${pct}%)`,
    encrypted ? `${encrypted} device${encrypted === 1 ? '' : 's'} with disk encryption enabled` : '',
    `Security baselines and policies enforced`,
    `Centralised visibility and compliance reporting enabled`,
  ])}${splitBar('Compliant', compliant, 'Needs review', review)}<div style="height:12px;"></div>${table}${srcNote('Microsoft Intune compliance policies. This is the policy verdict for each device — patching is reported separately below.', isOvr(m, 'dev_total', 'dev_compliant', 'dev_pct', 'dev_encrypted'))}`;
  const status = pct >= 90 ? 'Healthy' : 'Attention';
  return card('Device Management & Compliance', inner, status);
}

// Patch Management & Endpoint Protection stands on its OWN measurement — the agents on the
// endpoints — and is deliberately NOT Intune's device-compliance percentage. A device can
// satisfy every Intune compliance policy and still be three months behind on updates; a
// device can fail one policy for an unrelated reason and be perfectly patched. Reporting
// one number as the other is how a customer is told the wrong thing in good faith.
function sectionPatch(d: ItReportData, m: ItManual): string {
  const bl = bulletsOrAuto(m.patchBullets, d.auto.patchBullets);
  const overridden = isOvr(m, 'patch_total', 'patch_pct', 'patch_critical', 'patch_reboot', 'patch_av', 'patch_avpct');

  if (!d.rmm.available) {
    // No agents (or nothing scanned yet) — anything printed here has to have been typed.
    const lines = [...(overridden ? patchTicks(m, null) : []), ...bl];
    if (!lines.length) return card('Patch Management & Endpoint Protection', pending(`No patch data yet — ${d.rmm.note}.`, 'Deploy the LumenMSP Agent, or enter the figures in the report settings.'), 'Data pending');
    return card('Patch Management & Endpoint Protection', ticks(lines) + srcNote('Entered in the report settings.', true), m.patchStatus || 'Healthy');
  }

  const r = d.rmm;
  const total = figN(m, 'patch_total', r.total);
  const pct = figN(m, 'patch_pct', r.compliancePct);
  const crit = figN(m, 'patch_critical', r.criticalOutstanding);
  const bar = isOvr(m, 'patch_pct', 'patch_total')
    ? meterBar(pct, CHART_GOOD) + `<p style="margin:6px 0 0;font-size:13px;color:#475569;"><strong>${pct}%</strong> of ${total} device${total === 1 ? '' : 's'} up to date</p>`
    : (total ? splitBar('Up to date', r.compliant, 'Updates outstanding', Math.max(0, r.total - r.compliant)) : '');
  const scanned = r.lastScanAt ? `, last checked ${new Date(r.lastScanAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : '';
  const inner = ticks([...patchTicks(m, r), ...bl]) + bar
    + srcNote(`Measured on ${total} managed endpoint${total === 1 ? '' : 's'} by the LumenMSP Agent${scanned}. A device counts as patched when it has checked in within the last 7 days with no critical or important updates outstanding.`, overridden);
  const status = m.patchStatus || ((crit === 0 && pct >= 85) ? 'Healthy' : 'Active monitoring');
  return card('Patch Management & Endpoint Protection', inner, status);
}

/** The tick list for the patch card. `r` is null when there are no agents and every figure was typed. */
function patchTicks(m: ItManual, r: RmmPatchSummary | null): string[] {
  const total = figN(m, 'patch_total', r ? r.total : 0);
  const pct = figN(m, 'patch_pct', r ? r.compliancePct : 0);
  const crit = figN(m, 'patch_critical', r ? r.criticalOutstanding : 0);
  const reboot = figN(m, 'patch_reboot', r ? r.rebootPending : 0);
  const avPct = figN(m, 'patch_avpct', r && r.total ? Math.round((r.avProtected / r.total) * 100) : 0);
  const avName = fig(m, 'patch_av', r ? r.avProducts.join(', ') : '');
  const avCurrent = r ? r.avCurrentCount >= r.avProtected : true;
  const lines: string[] = [];
  lines.push(`Windows security patches <strong>${pct}%</strong> compliant${total ? ` across ${total} managed device${total === 1 ? '' : 's'}` : ''}`);
  lines.push(crit
    ? `${crit} critical update${crit === 1 ? '' : 's'} outstanding, scheduled into the next maintenance window`
    : `No critical or important updates outstanding`);
  if (reboot) lines.push(`${reboot} device${reboot === 1 ? '' : 's'} awaiting a restart to finish installing updates`);
  if (r && r.notReporting && !isOvr(m, 'patch_total', 'patch_pct')) lines.push(`${r.notReporting} device${r.notReporting === 1 ? '' : 's'} have not checked in this week and are being followed up`);
  lines.push(`Automatic update policies enforced and monitored`);
  lines.push(avPct >= 100 && avCurrent
    ? `Antivirus is updated and fully deployed${avName ? ` (${esc(avName)})` : ''}`
    : `Endpoint protection deployed on ${avPct}% of devices${avName ? ` (${esc(avName)})` : ''}${avCurrent ? '' : ', definitions being refreshed on the remainder'}`);
  return lines;
}

function sectionBackup(d: ItReportData, m: ItManual): string {
  const bl = bulletsOrAuto(m.backupBullets, d.auto.backupBullets);
  const b = d.backup;
  const bkOvr = isOvr(m, 'bk_protected', 'bk_plans', 'bk_failed');
  if (!b) {
    // No provider linked (or nothing synced yet) — bullets and/or typed figures carry it.
    if (!bl.length && !bkOvr) return card('Backup & Recovery Readiness', pending('Backup details not yet recorded.', 'Link a backup provider or add the configuration in the report settings.'), 'Data pending');
    const mGrid = bkOvr ? `<div class="stat-grid">
      <div class="stat"><div class="stat-val">${esc(fig(m, 'bk_protected', '—'))}</div><div class="stat-lbl">Total protected data</div></div>
      <div class="stat"><div class="stat-val">${esc(fig(m, 'bk_plans', '—'))}</div><div class="stat-lbl">Backup plans monitored</div></div>
      <div class="stat ${figN(m, 'bk_failed', 0) ? '' : 'stat-good'}"><div class="stat-val">${esc(fig(m, 'bk_failed', '0'))}</div><div class="stat-lbl">Plans needing attention</div></div>
    </div>` : '';
    return card('Backup & Recovery Readiness', mGrid + ticks(bl) + srcNote('Entered in the report settings.', true), m.backupStatus || 'Healthy');
  }
  const bkProtected = fig(m, 'bk_protected', fmtBytes(b.totalStorageBytes));
  const bkPlans = figN(m, 'bk_plans', b.plans.length);
  const bkFailed = figN(m, 'bk_failed', b.failedPlans);
  const bkOk = isOvr(m, 'bk_plans', 'bk_failed') ? Math.max(0, bkPlans - bkFailed) : b.okPlans;
  const grid = `<div class="stat-grid">
    <div class="stat"><div class="stat-val">${esc(bkProtected)}</div><div class="stat-lbl">Total protected data</div></div>
    <div class="stat"><div class="stat-val">${bkPlans}</div><div class="stat-lbl">Backup plans monitored</div></div>
    <div class="stat ${bkFailed ? '' : 'stat-good'}"><div class="stat-val">${bkFailed}</div><div class="stat-lbl">Plans needing attention</div></div>
  </div>`;
  const bar = (bkOk + bkFailed) ? splitBar('Healthy plans', bkOk, 'Failing', bkFailed) : '';
  const planRows = b.plans.slice(0, 20).map((pl) => {
    const cls = classifyPlanStatus(pl.status);
    const badge = cls === 'ok' ? '<span class="badge badge-answered">OK</span>'
      : cls === 'failed' ? `<span class="badge badge-missed">${esc(planStatusLabel(pl.status))}</span>`
      : `<span class="badge">${esc(planStatusLabel(pl.status))}</span>`;
    const when = pl.lastStart ? new Date(pl.lastStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
    const typ = planTypeLabel(pl.planType);
    return `<tr><td style="font-family:monospace;">${esc(pl.computer || '—')}</td><td>${esc(pl.planName)}${typ ? ` <span style="font-size:12px;color:#94a3b8;">(${esc(typ)})</span>` : ''}</td><td style="white-space:nowrap;">${when}</td><td>${badge}</td></tr>`;
  }).join('');
  const table = b.plans.length
    ? `<div class="table-wrap" style="margin-top:12px;"><table class="tbl"><thead><tr><th>Protected item</th><th>Backup plan</th><th>Last run</th><th>Status</th></tr></thead><tbody>${planRows}</tbody></table></div>`
    : '';
  const src = srcNote(`Monitored via ${b.providers.join(', ')}${b.syncedAt ? `, checked ${new Date(b.syncedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}.`, bkOvr);
  const extras = bl.length ? `<div style="margin-top:10px;">${ticks(bl)}</div>` : '';
  const status = m.backupStatus || (bkFailed ? 'Attention' : 'Healthy');
  return card('Backup & Recovery Readiness', grid + bar + table + extras + src, status);
}

// Deliverability: AUTO from DMARC authentication (Domain Health aggregate reports) when
// the domain is monitored and saw volume this period. A manually entered figure still
// wins (explicit override); otherwise the manual field can now stay empty.
// Email AUTHENTICATION rate — auto from Domain Health's DMARC aggregate reports (aligned ÷
// total messages this period). This is a real measured figure from the monitoring, not a
// manual entry: the manual deliverability box was retired now Domain Health supplies it.
function deliverabilityLine(d: ItReportData, _m: ItManual): string {
  if (d.dmarcMon && d.dmarcMon.volume) {
    const pct = d.dmarcMon.alignedPct;
    const col = pct >= 98 ? '#16a34a' : pct >= 90 ? '#d97706' : '#dc2626';
    return `<p style="margin:12px 0 0;font-size:16px;"><span style="color:${col};font-weight:800;">&#10004;</span> Email authentication running at <strong>${pct}%</strong>, measured from ${d.dmarcMon.volume} messages observed in DMARC reports this period.</p>`;
  }
  return '';
}

function sectionDns(d: ItReportData, m: ItManual): string {
  if (!d.dns && !d.domainHealth) return card('DNS & Email Security Status', pending('No primary domain set for this customer.', 'Add the domain in the report settings to enable live DNS checks.'), 'Data pending');

  // ── Rich path: LITS-DMARC Domain Health (same analysis as the Domain Health screen) ──
  if (d.domainHealth && d.domainHealth.check) {
    const dh = d.domainHealth;
    const c = dh.check;
    const scoreCol = dh.score >= 80 ? '#16a34a' : dh.score >= 60 ? '#d97706' : '#dc2626';
    const meetsTarget = !c.dmarc?.issues?.some((i: string) => /below the agreed target/i.test(i));
    const rows: { record: string; purpose: string; ok: boolean; detail: string }[] = [];
    for (const pr of (c.platform || []) as any[]) {
      rows.push({ record: pr.record, purpose: pr.record === 'MX' ? 'Mail routing' : pr.record === 'Autodiscover' ? 'Client configuration' : 'Device management', ok: !!pr.ok, detail: pr.detail || '' });
    }
    rows.push({
      record: 'SPF', purpose: 'Authorised senders', ok: !!c.spf?.found && !(c.spf?.issues || []).length,
      detail: c.spf?.found ? `published${c.spf?.allMechanism ? ` (${c.spf.allMechanism})` : ''}` : 'not found',
    });
    rows.push({
      record: 'DKIM', purpose: 'Message integrity', ok: !!c.dkim?.found,
      detail: c.dkim?.found ? `signing via ${(c.dkim?.selectors || []).join(', ')}` : 'not signing',
    });
    rows.push({
      record: 'DMARC', purpose: 'Policy & reporting', ok: !!c.dmarc?.found && meetsTarget,
      detail: c.dmarc?.found ? `p=${c.dmarc.policy || 'none'} (agreed target p=${dh.targetPolicy})` : 'not found',
    });
    const tableRows = rows.map((r) => `<tr>
      <td><strong>${esc(r.record)}</strong></td><td>${esc(r.purpose)}</td>
      <td>${r.ok ? '<span style="color:#16a34a;font-weight:800;">&#10004;</span>' : '<span style="color:#dc2626;font-weight:800;">&#10007;</span>'}</td>
      <td style="color:#6b7280;font-size:14px;">${esc(r.detail)}</td>
    </tr>`).join('');
    const issues: string[] = [...(c.spf?.issues || []), ...(c.dmarc?.issues || [])]
      .filter((i: string) => !/not being sent to our collector/i.test(i)); // internal ops detail, not client-facing
    const issuesHtml = issues.length
      ? `<div style="margin-top:12px;"><p style="margin:0 0 6px;font-weight:700;font-size:14px;color:#b45309;">Being addressed</p><ul style="margin:0;padding-left:18px;color:#92400e;font-size:14px;">${issues.slice(0, 5).map((i: string) => `<li style="margin:3px 0;">${esc(i)}</li>`).join('')}</ul></div>`
      : '';
    const grid = `<div class="stat-grid">
      <div class="stat"><div class="stat-val" style="color:${scoreCol};">${dh.score}/100</div><div class="stat-lbl">Domain Health score</div></div>
      <div class="stat"><div class="stat-val" style="font-size:26px;">${esc(dh.policy ? `p=${dh.policy}` : 'none')}</div><div class="stat-lbl">DMARC enforcement</div></div>
      ${c.mailProvider ? `<div class="stat"><div class="stat-val" style="font-size:22px;">${esc(c.mailProvider)}</div><div class="stat-lbl">Mail platform</div></div>` : ''}
    </div>`;
    const deliver = deliverabilityLine(d, m);
    const scoreMeter = meterBar(dh.score, scoreCol);
    // Domain registration facts (RDAP): registrar, expiry (with a renewal warning inside 60
    // days), and where the DNS is managed — the "who holds the keys" context clients ask about.
    const reg = c.registry || null;
    let regLine = '';
    if (reg && (reg.registrar || reg.expires)) {
      const bits: string[] = [];
      if (reg.registrar) bits.push(`Registrar: <strong>${esc(reg.registrar)}</strong>`);
      if (reg.expires) {
        const days = Math.floor((new Date(reg.expires + 'T00:00:00Z').getTime() - Date.now()) / 86400000);
        const warn = days >= 0 && days <= 60;
        bits.push(`renews ${esc(new Date(reg.expires + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}${warn ? ` <span style="color:#dc2626;font-weight:700;">(${days} days — renewal due)</span>` : ''}`);
      }
      if (c.dnsManager) bits.push(`DNS managed at ${esc(c.dnsManager)}`);
      regLine = `<p style="margin:0 0 12px;color:#6b7280;font-size:14px;">${bits.join(' &nbsp;·&nbsp; ')}</p>`;
    }
    const inner = `<p style="margin:0 0 6px;color:#6b7280;font-size:15px;">Domain: <strong>${esc(dh.domain)}</strong>${dh.checkedAt ? ` &nbsp;·&nbsp; checked ${new Date(dh.checkedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</p>${regLine}
      ${grid}
      ${scoreMeter}
      <div class="table-wrap" style="margin-top:12px;"><table class="tbl"><thead><tr><th>Record</th><th>Purpose</th><th>Status</th><th>Detail</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      ${issuesHtml}${deliver}${dmarcMonitorBlock(d)}`;
    const dmarcConcern = !!(d.dmarcMon && d.dmarcMon.volume && d.dmarcMon.alignedPct < 90);
    const status = (dh.score >= 80 && meetsTarget && !dmarcConcern) ? 'Healthy' : (dh.score >= 60 && !dmarcConcern) ? 'Active monitoring' : 'Attention';
    return card('DNS & Email Security Status', inner, status);
  }

  if (!d.dns) return card('DNS & Email Security Status', pending('No primary domain set for this customer.', 'Add the domain in the report settings to enable live DNS checks.'), 'Data pending');
  const rows = d.dns.rows.map((r) => `<tr>
      <td><strong>${esc(r.record)}</strong></td><td>${esc(r.purpose)}</td>
      <td>${r.ok ? '<span style="color:#16a34a;font-weight:800;">&#10004;</span>' : '<span style="color:#dc2626;font-weight:800;">&#10007;</span>'}</td>
      <td style="color:#6b7280;font-size:14px;">${esc(r.detail)}</td>
    </tr>`).join('');
  const deliver = deliverabilityLine(d, m);
  const inner = `<p style="margin:0 0 12px;color:#6b7280;font-size:15px;">Domain: <strong>${esc(d.dns.domain)}</strong></p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Record</th><th>Purpose</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>${deliver}${dmarcMonitorBlock(d)}`;
  const allOk = d.dns.rows.every((r) => r.ok);
  const dmarcConcern = !!(d.dmarcMon && d.dmarcMon.volume && d.dmarcMon.alignedPct < 90);
  return card('DNS & Email Security Status', inner, (allOk && !dmarcConcern) ? 'Healthy' : 'Attention');
}

// LITS-DMARC aggregate-report stats for the period — shared by both DNS-section paths.
function dmarcMonitorBlock(d: ItReportData): string {
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
      ${splitBar('Authenticated', dm.aligned, 'Failed authentication', dm.failed)}
      ${(dm.quarantined + dm.rejected) > 0 ? `<p style="margin:10px 0 0;font-size:15px;"><span style="color:#16a34a;font-weight:800;">&#128737;</span> <strong>${dm.quarantined + dm.rejected}</strong> message${(dm.quarantined + dm.rejected) === 1 ? '' : 's'} failing authentication ${dm.rejected ? `were blocked (${dm.rejected} rejected${dm.quarantined ? `, ${dm.quarantined} quarantined` : ''})` : 'were quarantined'} by your DMARC policy — spoofed mail that never reached inboxes.</p>` : ''}
      ${dm.topSources.length ? `<p style="margin:12px 0 6px;font-weight:700;font-size:15px;">Who sends email as ${esc(dm.domain)}</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Sending service</th><th>Emails</th><th>Authenticated</th></tr></thead><tbody>${dm.topSources.map((sx) => {
        const col = sx.alignedPct >= 98 ? '#16a34a' : sx.alignedPct >= 90 ? '#d97706' : '#dc2626';
        return `<tr><td>${esc(sx.name)}${sx.known ? '' : ' <span style="font-size:12px;color:#b45309;">(unrecognised)</span>'}</td><td>${sx.volume}</td><td style="color:${col};font-weight:700;">${sx.alignedPct}%</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
      ${dm.unknownFailingSources.length ? `<p style="margin:10px 0 0;font-size:14px;color:#b45309;">Unrecognised failing sources under review: ${esc(dm.unknownFailingSources.join(', '))}.</p>` : ''}
      ${dm.policy === 'none' ? `<p style="margin:10px 0 0;font-size:14px;color:#6b7280;">Policy is currently monitor-only (p=none); we are validating legitimate senders before moving to enforcement.</p>` : ''}
    </div>`;
  }
  return dmarcBlock;
}

// Endpoint threats are now MEASURED — every Bitdefender detection the GravityZone sync
// recorded for this customer in this period, with our own tools (MeshCentral filed as a
// PUP) excluded, because those are an exclusion to add and not an incident to report.
// Inbound firewall blocks have no source: nothing ingests a counter from the UniFi
// gateways, so that figure is typed or it is absent — it is never guessed.
function sectionThreat(d: ItReportData, m: ItManual): string {
  const lines: string[] = [];
  const fw = fig(m, 'threat_firewall', m.firewallBlocked || '');
  const ep = fig(m, 'threat_endpoint', d.rmm.available || d.auto.endpointThreats ? String(d.auto.endpointThreats) : (m.endpointThreats || ''));
  if (String(fw).trim()) lines.push(`${esc(fw)} inbound firewall threats blocked`);
  if (String(ep).trim() && Number(ep) > 0) lines.push(`${esc(ep)} endpoint threat${Number(ep) === 1 ? '' : 's'} detected and removed`);
  lines.push(...bulletsOrAuto(m.threatBullets, d.auto.threatBullets));
  if (d.vulnerability.available && d.vulnerability.exposureScore != null) lines.push(`Defender exposure score: ${d.vulnerability.exposureScore}`);
  if (!lines.length) return card('Security Threat Protection', pending('No threat metrics recorded for this period.', 'Deploy endpoint protection, or add the figures in the report settings.'), 'Data pending');
  const measured = d.auto.endpointThreats > 0 || d.rmm.available;
  const note = measured ? srcNote('Endpoint detections are counted from the Bitdefender GravityZone sync for this period. Detections of our own remote-support tooling are excluded.', isOvr(m, 'threat_endpoint', 'threat_firewall')) : '';
  return card('Security Threat Protection', ticks(lines) + note, m.threatStatus || (d.auto.endpointThreats && !d.auto.casesRaised ? 'Active monitoring' : 'Healthy'));
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
  // Case mix by category — pulled straight from the period's tickets.
  const mix = h.byCategory.length
    ? `<p style="margin:14px 0 2px;font-weight:700;font-size:15px;">Case mix</p>${hBars(h.byCategory.slice(0, 6).map((c) => ({ label: c.category, value: c.count })))}`
    : '';
  // What we actually worked on — the period's cases (subjects only, client-safe).
  const CLOSED_BADGE = '<span class="badge badge-answered">Resolved</span>';
  const OPEN_BADGE = '<span class="badge">In progress</span>';
  const work = h.notable.length
    ? `<p style="margin:14px 0 6px;font-weight:700;font-size:15px;">Work carried out this period</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Case</th><th>Subject</th><th>Outcome</th></tr></thead><tbody>${h.notable.map((n) => `<tr>
        <td style="font-family:monospace;white-space:nowrap;">${esc(n.ticketNumber)}</td>
        <td>${esc(n.subject)}</td>
        <td>${['resolved', 'closed'].includes(n.status.toLowerCase()) ? CLOSED_BADGE : OPEN_BADGE}</td>
      </tr>`).join('')}</tbody></table></div>${h.totalCases > h.notable.length ? `<p style="margin:6px 0 0;font-size:13px;color:#94a3b8;">Showing the ${h.notable.length} most recent of ${h.totalCases} cases.</p>` : ''}`
    : '';
  return card('Support & Service Activity', grid + ticks(lines) + mix + work, h.open ? 'Active monitoring' : 'Healthy');
}

// ── Assembly ─────────────────────────────────────────────────────────────────────
export interface GenerateOpts {
  customerId: number; customerName: string; tenant: string | null; domain: string;
  from: Date; to: Date; periodLabel: string;
  sdmNotes?: string; manual?: ItManual; useClaude?: boolean; preparedBy?: string;
}

// Email-safe COVERING email (tables + inline styles only — survives Outlook/Gmail, unlike the
// rich report which is sent as a PDF attachment). Branded header, the binary status board,
// the executive summary, and a line pointing to the attached PDF.
function reportCoverEmail(customerName: string, periodLabel: string, execSummary: string, data: ItReportData, manual: ItManual, preparedBy: string): string {
  const dot = (st: MarkerState) => st === 'ok' ? '#16a34a' : st === 'attention' ? '#d97706' : '#94a3b8';
  const word = (st: MarkerState) => st === 'ok' ? 'OK' : st === 'attention' ? 'Needs attention' : 'Not monitored';
  const rows = reportMarkers(data, manual).map((mk) => `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;font-weight:600;">${esc(mk.label)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-family:Segoe UI,Arial,sans-serif;font-size:14px;white-space:nowrap;color:${dot(mk.state)};font-weight:700;">&#9679; ${word(mk.state)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#64748b;">${esc(mk.note)}</td>
  </tr>`).join('');
  return `<div style="background:#f1f5f9;padding:24px 0;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr><td style="background:#0f172a;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Lumen IT Solutions</div>
      <div style="color:#cbd5e1;font-size:14px;margin-top:2px;">IT Operations &amp; Security Snapshot &nbsp;&middot;&nbsp; ${esc(periodLabel)}</div>
    </td></tr>
    <tr><td style="padding:24px 28px;">
      <p style="margin:0 0 14px;font-size:15px;color:#1f2937;line-height:1.6;">Hello,</p>
      <p style="margin:0 0 18px;font-size:15px;color:#1f2937;line-height:1.6;">Please find <strong>${esc(customerName)}</strong>'s IT Operations &amp; Security Snapshot for <strong>${esc(periodLabel)}</strong> attached as a PDF. A summary of the month is below.</p>
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b;">At a glance</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef2f7;border-radius:8px;border-collapse:separate;margin-bottom:20px;">${rows}</table>
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b;">Executive summary</p>
      <p style="margin:0 0 20px;font-size:15px;color:#1f2937;line-height:1.6;">${esc(execSummary).replace(/\n/g, '<br>')}</p>
      <p style="margin:0;font-size:15px;color:#1f2937;line-height:1.6;">The full report &mdash; devices, backup, email security, support activity and more &mdash; is in the attached PDF. If you have any questions, just reply to this email and we'll be glad to help.</p>
      <p style="margin:18px 0 0;font-size:15px;color:#1f2937;">Kind regards,<br><strong>${esc(preparedBy)}</strong></p>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#94a3b8;">Lumen IT Solutions &nbsp;&middot;&nbsp; Prepared by ${esc(preparedBy)}</div>
    </td></tr>
  </table>
</div>`;
}

export async function generateItReport(opts: GenerateOpts): Promise<{ html: string; coverHtml: string; subject: string; data: ItReportData }> {
  const manual = opts.manual || {};
  const data = await collectItReportData(opts.customerId, opts.tenant, opts.domain, opts.from, opts.to, bulletsFromText(manual.excludedTickets), opts.periodLabel);

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
    sectionDevices(data, manual),
    sectionPatch(data, manual),
    sectionBackup(data, manual),
    sectionDns(data, manual),
    sectionThreat(data, manual),
    sectionCyber(data),
    sectionVulnerability(data, manual),
    sectionSupport(data),
    // Overall IT Status = a binary status BOARD across every report marker (at-a-glance
    // OK / Attention / Pending), then a single forward-looking line from the narrative.
    card('Overall IT Status',
      statusBoard(data, manual)
      + (overallStatus ? `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#475569;">${esc(overallStatus).replace(/\n/g, '<br>')}</p>` : ''),
      overallMarkerState(data, manual)),
  ].join('\n');

  const subject = `IT Operations & Security Snapshot — ${opts.customerName} — ${opts.periodLabel}`;
  const html = itDocument(subject, header + body);
  const coverHtml = reportCoverEmail(opts.customerName, opts.periodLabel, execSummary, data, manual, opts.preparedBy || 'Lumen IT Solutions');
  return { html, coverHtml, subject, data };
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
