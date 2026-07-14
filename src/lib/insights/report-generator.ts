/**
 * Report Generator — Orchestrator (ported from Insights into the portal).
 *
 * Queries call_events (Insights DB via insightsPool), builds journeys, generates HTML,
 * stores in generated_reports. Called by the scheduler or manually from the Insights UI.
 */

import { insightsPool } from '../../db/pool';
import { sendMail } from '../mailer';
import { buildJourneys, LogicConfig, CallEventRow, CallJourney } from '../insights-journeys';
import { generateWeeklyReport } from './reports/weekly-call-stats';
import { generateDailyReport } from './reports/group-call-performance';
import { generateSitePerformanceReport } from './reports/site-performance';
import { buildReportContext, renderReportFromModules, ROLLING_MODULES } from './reports/modules';
import { clientFromCustomer, outcomeFromRecord } from './tollring-client';

// insightsPool is typed `Pool | null` — guard once and reuse a non-null handle.
function db() {
  if (!insightsPool) throw new Error('Insights database not connected (INSIGHTS_DATABASE_URL not set)');
  return insightsPool;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function fetchGroupRows(customerId: number, from: Date, to: Date): Promise<CallEventRow[]> {
  const res = await db().query(
    `SELECT id, customer_id AS site_id, event_datetime, group_name, outcome,
            number_raw, number_normalised, ddi, wait_seconds, source_file, call_id, extno, direction
     FROM call_events
     WHERE customer_id = $1
       AND event_datetime >= $2
       AND event_datetime <  $3
       AND (source_file ILIKE 'ContactGroupDetail%' OR source_file = 'tollring-sync')
     ORDER BY event_datetime DESC
     LIMIT 2000000`,
    [customerId, from, to]
  );
  return res.rows;
}

async function getCustomerAndSite(configId: number) {
  const res = await db().query(
    `SELECT rc.*, s.site_label, s.id AS site_id, s.business_hours AS site_business_hours,
            s.logic_config AS site_logic_config,
            c.id AS customer_id, c.name AS customer_name,
            c.icalls_api_url, c.icalls_api_token, c.icalls_api_username
     FROM report_configs rc
     JOIN sites s ON s.id = rc.site_id
     JOIN customers c ON c.id = s.customer_id
     WHERE rc.id = $1`,
    [configId]
  );
  return res.rows[0] || null;
}

// The call logic now lives on the SITE (one logic per site). We still fall back to the report's own
// logic_config for any site not yet backfilled, so nothing breaks during/after the lift.
function siteLogic(cfg: any): LogicConfig {
  const logic: LogicConfig = (cfg && (cfg.site_logic_config || cfg.logic_config)) || {};
  if (cfg && cfg.site_business_hours) logic.business_hours = cfg.site_business_hours;
  return logic;
}

// Idempotent (startup): the platform-level report POOL (templates) + per-site scheduled assignments.
//   report_templates — global library: a name + an ordered list of module ids (the "content").
//   site_reports      — a site's scheduled subscriptions to a template (recipients + cadence).
// Seeds the three current report types as system templates, and migrates existing report_configs'
// schedules into site_reports (once each, tracked by source_config_id). Additive — the live scheduler
// keeps running off report_configs until it's rewired onto site_reports in a later step.
export async function ensureReportPoolTables(): Promise<void> {
  try {
    await db().query(`
      CREATE TABLE IF NOT EXISTS report_templates (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        base_type  TEXT,                                  -- weekly_call_stats | group_call_performance | site_performance | custom
        modules    JSONB NOT NULL DEFAULT '[]'::jsonb,    -- ordered module ids
        is_system  BOOLEAN NOT NULL DEFAULT false,        -- seeded defaults (UI protects them)
        is_active  BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await db().query('CREATE UNIQUE INDEX IF NOT EXISTS idx_report_templates_name ON report_templates (lower(name))');
    await db().query(`
      CREATE TABLE IF NOT EXISTS site_reports (
        id               SERIAL PRIMARY KEY,
        site_id          INTEGER NOT NULL,
        template_id      INTEGER NOT NULL,
        recipients       TEXT,
        reporting_period TEXT,
        send_day         TEXT,
        send_time        TEXT,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        source_config_id INTEGER,                          -- provenance for the one-off backfill (dedupe)
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await db().query('CREATE UNIQUE INDEX IF NOT EXISTS idx_site_reports_src ON site_reports (source_config_id) WHERE source_config_id IS NOT NULL');

    const seeds: [string, string, string[]][] = [
      ['Weekly Call Stats', 'weekly_call_stats', LOCKED_TEMPLATE_MODULES.weekly_call_stats],
      ['Daily Group Performance', 'group_call_performance', LOCKED_TEMPLATE_MODULES.group_call_performance],
      ['Site Performance', 'site_performance', LOCKED_TEMPLATE_MODULES.site_performance],
    ];
    for (const [name, base, mods] of seeds) {
      await db().query(
        `INSERT INTO report_templates (name, base_type, modules, is_system)
         VALUES ($1, $2, $3::jsonb, true) ON CONFLICT (lower(name)) DO NOTHING`,
        [name, base, JSON.stringify(mods)]);
    }
    // Realign existing system rows to the locked sets (idempotent, 3 rows) — covers rows seeded
    // before the lock-down or hand-edited since.
    for (const [base, mods] of Object.entries(LOCKED_TEMPLATE_MODULES)) {
      await db().query(
        'UPDATE report_templates SET modules=$2::jsonb WHERE base_type=$1 AND is_system=true',
        [base, JSON.stringify(mods)]);
    }

    // Migrate existing schedules → site_reports (one row per report_config, matched to its system template).
    await db().query(`
      INSERT INTO site_reports (site_id, template_id, recipients, reporting_period, send_day, send_time, is_active, source_config_id)
      SELECT rc.site_id, t.id, rc.recipients::text, rc.reporting_period, rc.send_day, rc.send_time,
             COALESCE(rc.is_active, true), rc.id
        FROM report_configs rc
        JOIN report_templates t ON t.base_type = rc.report_type AND t.is_system = true
       WHERE NOT EXISTS (SELECT 1 FROM site_reports sr WHERE sr.source_config_id = rc.id)`);
  } catch (e: any) {
    console.error('ensureReportPoolTables failed:', e.message);
  }
}

// Idempotent (startup): add the site-level logic column and backfill each site from its most recent
// report's logic (each site has a single logic, so any report's is representative). Only fills NULLs.
export async function ensureSiteLogicColumn(): Promise<void> {
  try {
    await db().query('ALTER TABLE sites ADD COLUMN IF NOT EXISTS logic_config JSONB');
    await db().query(`
      UPDATE sites s SET logic_config = sub.lc
        FROM (
          SELECT DISTINCT ON (site_id) site_id, logic_config AS lc
            FROM report_configs
           WHERE logic_config IS NOT NULL
           ORDER BY site_id, updated_at DESC NULLS LAST, id DESC
        ) sub
       WHERE s.id = sub.site_id AND s.logic_config IS NULL`);
  } catch (e: any) {
    console.error('ensureSiteLogicColumn failed:', e.message);
  }
}

function normaliseNumber(raw: string): string {
  if (!raw) return '';
  const n = raw.replace(/\s+/g, '');
  if (n.startsWith('+44')) return '0' + n.slice(3);
  return n;
}

async function fetchFromTollring(cfg: any, from: Date, to: Date): Promise<CallEventRow[] | null> {
  const client = clientFromCustomer(cfg);
  if (!client) return null;
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').substring(0, 19);
  try {
    const records = await client.getCallsByDate({ startDate: fmt(from), endDate: fmt(to) });
    return records.map((r: any) => ({
      id:                r.RecordId,
      site_id:           0,
      event_datetime:    new Date(r.Call_date),
      group_name:        r.Group_no || '',
      outcome:           outcomeFromRecord(r),
      number_raw:        r.Number || '',
      number_normalised: normaliseNumber(r.Number || ''),
      ddi:               r.Port || null,
      wait_seconds:      r.Ring_time || 0,
      source_file:       'tollring-api',
      call_id:           r.CallId || null,
      extno:             r.Extno || null,
      direction:         r.Direction || null,
    }));
  } catch (err) {
    console.error('Tollring fetch error (falling back to DB):', err);
    return null;
  }
}

async function saveReport(configId: number, reportStart: Date, reportEnd: Date, html: string): Promise<void> {
  await db().query(
    `INSERT INTO generated_reports (config_id, report_start, report_end, html, status, generated_at, updated_at)
     VALUES ($1, $2, $3, $4, 'generated', NOW(), NOW())
     ON CONFLICT (config_id, report_start, report_end)
     DO UPDATE SET html = EXCLUDED.html, status = 'generated', generated_at = NOW(), updated_at = NOW()`,
    [configId, reportStart, reportEnd, html]
  );
}

/**
 * Email a stored report to the config's recipients and mark it 'sent'.
 * Returns how many recipients it was sent to (0 if none configured / not found).
 */
export async function emailReport(configId: number, reportStart: Date, reportEnd: Date): Promise<number> {
  // DEDUPE: if a report for this config + exact period has already been SENT, don't send again.
  // Guards against duplicate emails when more than one scheduler instance is live (e.g. the
  // standalone Insights app + the portal both running the scheduler against the same DB).
  const dup = await db().query(
    `SELECT 1 FROM generated_reports WHERE config_id=$1 AND report_start=$2 AND report_end=$3 AND status='sent' LIMIT 1`,
    [configId, reportStart, reportEnd]
  );
  if (dup.rowCount) { console.log(`[emailReport] config ${configId} already sent for this period — skipped`); return 0; }
  const res = await db().query(
    `SELECT gr.id, gr.html, rc.recipients, rc.config_label
       FROM generated_reports gr
       JOIN report_configs rc ON rc.id = gr.config_id
      WHERE gr.config_id = $1 AND gr.report_start = $2 AND gr.report_end = $3
      ORDER BY gr.generated_at DESC
      LIMIT 1`,
    [configId, reportStart, reportEnd]
  );
  const row = res.rows[0];
  if (!row || !row.html) return 0;

  const recipients: string[] = Array.isArray(row.recipients)
    ? row.recipients
    : String(row.recipients || '').split(/[\n,;]+/).map((s: string) => s.replace(/[{}"]/g, '').trim()).filter((s: string) => s.includes('@'));
  if (!recipients.length) return 0;

  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const startD  = new Date(reportStart);
  const endIncl = new Date(reportEnd.getTime() - 1);             // report_end is exclusive
  const oneDay  = (endIncl.getTime() - startD.getTime()) < 36 * 60 * 60 * 1000;
  const period  = oneDay ? fmt(startD) : `${fmt(startD)} – ${fmt(endIncl)}`;

  let sent = 0;
  for (const to of recipients) {
    try {
      await sendMail({ to, subject: `${row.config_label} — ${period}`, html: row.html });
      sent++;
    } catch (err: any) {
      console.error(`[emailReport] send to ${to} failed:`, err?.message || err);
    }
  }
  if (sent > 0) {
    await db().query(`UPDATE generated_reports SET status = 'sent', updated_at = NOW() WHERE id = $1`, [row.id]);
  }
  return sent;
}

// ── ONE RENDERER ──────────────────────────────────────────────────────────────
// All scheduled + UI generation goes through the template/modules pipeline (same output as the
// on-screen portal reports: Europe/London times, Answered-by column, every configured module).
// The legacy per-type renderers below the template lookup remain ONLY as a fallback for the
// impossible case that a system template row is missing. (Decided with Terry 2026-07-08 after a
// customer received a legacy-rendered email with UTC times: "one schedule, one portal, no confusion".)
// Locked module sets for the SYSTEM reports (Terry's lock-down, 2026-07-14): fixed catalogue,
// fixed modules — the Akixi/Tollring model. Enforced at render time (generateFromTemplate ignores
// whatever a system row holds) AND realigned in the DB at startup, so a hand-edited row can't
// drift. Weekly went 12 → 5; both heatmaps stay (customer favourites). Custom templates (is_system
// = false) are unaffected.
export const LOCKED_TEMPLATE_MODULES: Record<string, string[]> = {
  weekly_call_stats:      ['scorecard', 'daily_breakdown', 'heatmap', 'hourly_missed', 'rolling_summary'],
  group_call_performance: ['scorecard', 'call_flow', 'staff', 'outbound', 'missed_followup', 'all_calls'],
  site_performance:       ['scorecard', 'daily_breakdown', 'call_flow', 'staff'],
};

async function systemTemplateId(baseType: string): Promise<number | null> {
  const r = await db().query(
    `SELECT id FROM report_templates WHERE base_type=$1 AND is_active=true ORDER BY is_system DESC, id LIMIT 1`,
    [baseType]);
  return r.rows[0]?.id ?? null;
}

// ── Weekly generator ──────────────────────────────────────────────────────────

export async function generateWeekly(configId: number, weekStart: Date, weekEnd?: Date): Promise<{ reportStart: Date; reportEnd: Date }> {
  const cfg = await getCustomerAndSite(configId);
  if (!cfg) throw new Error(`Config ${configId} not found`);

  const logic: LogicConfig = siteLogic(cfg);
  // Snap to the Monday of the week containing the chosen date, then run Mon–Sun.
  const ws = new Date(weekStart);
  ws.setUTCHours(0, 0, 0, 0);
  const dow = ws.getUTCDay();                 // 0=Sun..6=Sat
  ws.setUTCDate(ws.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  weekStart = ws;
  weekEnd = new Date(ws);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);  // exclusive end (next Monday)

  // Unified path: render via the template pipeline (falls through to legacy only if no template).
  const weeklyTpl = await systemTemplateId('weekly_call_stats');
  if (weeklyTpl) {
    const { html } = await generateFromTemplate(weeklyTpl, cfg.site_id, weekStart, new Date(weekEnd.getTime() - 24 * 60 * 60 * 1000));
    await saveReport(configId, weekStart, weekEnd, html);
    console.log(`✓ Weekly report generated (template pipeline): config ${configId} week ${weekStart.toISOString().slice(0, 10)}`);
    return { reportStart: weekStart, reportEnd: weekEnd };
  }

  let groupRows = await fetchGroupRows(cfg.customer_id, weekStart, weekEnd);
  if (groupRows.length === 0) {
    groupRows = await fetchFromTollring(cfg, weekStart, weekEnd) ?? [];
  }
  const journeys = buildJourneys(groupRows, logic);

  // Rolling / all-time charts use ALL available data from the start of the year (not a fixed
  // 8-week window). The fetchGroupRows row cap is set high enough to hold a full year, so this is
  // not truncated. (The earlier "recent weeks = 0" bug was the cap dropping the newest rows; that's
  // handled by the raised cap + ORDER BY DESC in fetchGroupRows.)
  const rollingStart = new Date('2026-01-01T00:00:00Z');
  let rollingRows = await fetchGroupRows(cfg.customer_id, rollingStart, weekEnd);
  if (rollingRows.length === 0) {
    await new Promise((r) => setTimeout(r, 6000)); // rate limit
    rollingRows = await fetchFromTollring(cfg, rollingStart, weekEnd) ?? [];
  }
  const rollingJourneys = buildJourneys(rollingRows, logic);

  const firstJourneyDate = rollingJourneys.length > 0
    ? new Date(Math.min(...rollingJourneys.map((j) => new Date(j.datetime).getTime())))
    : rollingStart;
  const actualWeeks = Math.max(1, Math.ceil((weekEnd.getTime() - firstJourneyDate.getTime()) / (7 * 24 * 60 * 60 * 1000)));

  const weekBuckets = [];
  for (let w = actualWeeks - 1; w >= 0; w--) {
    const wkStart = new Date(weekStart);
    wkStart.setDate(wkStart.getDate() - w * 7);
    const we = new Date(wkStart);
    we.setDate(we.getDate() + 7);
    const label = `${wkStart.getDate()}/${wkStart.getMonth() + 1}`;
    const wj = rollingJourneys.filter((j) => {
      const dt = new Date(j.datetime);
      return dt >= wkStart && dt < we;
    });
    weekBuckets.push({
      label,
      total:    wj.length,
      answered: wj.filter((j) => j.status === 'Answered').length,
      missed:   wj.filter((j) => j.status === 'Missed' || j.status === 'Abandoned').length,
    });
  }

  const html = generateWeeklyReport({
    customerName: cfg.customer_name,
    siteName:     cfg.site_label,
    weekStart,
    weekEnd:      new Date(weekEnd.getTime() - 1),
    thisWeek:     journeys,
    rollingEight: rollingJourneys,
    weekBuckets,
    config:       logic,
    weekNumber:   undefined,
    rollingWeeks: actualWeeks,
  });

  await saveReport(configId, weekStart, weekEnd, html);
  console.log(`✓ Weekly report generated: config ${configId} for week ${weekStart.toISOString().slice(0, 10)}`);
  return { reportStart: weekStart, reportEnd: weekEnd };
}

// ── Daily generator ─────────────────────────────────────────────────────────

export async function generateDaily(configId: number, reportDate: Date): Promise<{ reportStart: Date; reportEnd: Date }> {
  const cfg = await getCustomerAndSite(configId);
  if (!cfg) throw new Error(`Config ${configId} not found`);

  const logic: LogicConfig = siteLogic(cfg);

  const dayStart = new Date(reportDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  // Unified path: render via the template pipeline (falls through to legacy only if no template).
  const dailyTpl = await systemTemplateId('group_call_performance');
  if (dailyTpl) {
    const { html } = await generateFromTemplate(dailyTpl, cfg.site_id, dayStart, dayStart);
    await saveReport(configId, dayStart, dayEnd, html);
    console.log(`Daily report generated (template pipeline): config ${configId} for ${reportDate.toISOString().slice(0, 10)}`);
    return { reportStart: dayStart, reportEnd: dayEnd };
  }

  let groupRows = await fetchGroupRows(cfg.customer_id, dayStart, dayEnd);
  if (groupRows.length === 0) {
    groupRows = await fetchFromTollring(cfg, dayStart, dayEnd) ?? [];
  }
  const extRows = groupRows;

  const journeys = buildJourneys(groupRows, logic);

  const html = generateDailyReport({
    customerName: cfg.customer_name,
    siteName:     cfg.site_label,
    reportDate,
    journeys,
    extRows,
    config:       logic,
  });

  await saveReport(configId, dayStart, dayEnd, html);
  console.log(`Daily report generated: config ${configId} for ${reportDate.toISOString().slice(0, 10)}`);
  return { reportStart: dayStart, reportEnd: dayEnd };
}

// ── Site Performance generator (arbitrary date range) ─────────────────────────
// Same data path as the daily report, but over [from, to] inclusive. Reuses the daily report's
// scorecard / call-flow / staff sections + a per-day trend. fetchGroupRows is capped high enough
// (2,000,000 rows) and ordered DESC so large ranges aren't truncated.
export async function generateSitePerformance(configId: number, from: Date, to: Date): Promise<{ reportStart: Date; reportEnd: Date }> {
  const cfg = await getCustomerAndSite(configId);
  if (!cfg) throw new Error(`Config ${configId} not found`);

  const logic: LogicConfig = siteLogic(cfg);

  const start = new Date(from); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() + 1); // exclusive end (whole last day)

  // Unified path: render via the template pipeline (falls through to legacy only if no template).
  const siteTpl = await systemTemplateId('site_performance');
  if (siteTpl) {
    const { html } = await generateFromTemplate(siteTpl, cfg.site_id, start, to);
    await saveReport(configId, start, end, html);
    console.log(`Site Performance report generated (template pipeline): config ${configId} ${start.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
    return { reportStart: start, reportEnd: end };
  }

  let groupRows = await fetchGroupRows(cfg.customer_id, start, end);
  if (groupRows.length === 0) {
    groupRows = await fetchFromTollring(cfg, start, end) ?? [];
  }
  const journeys = buildJourneys(groupRows, logic);

  const html = generateSitePerformanceReport({
    customerName: cfg.customer_name,
    siteName:     cfg.site_label,
    from:         start,
    to:           new Date(end.getTime() - 1), // last instant of the range, for the title
    journeys,
    extRows:      groupRows,
    config:       logic,
  });

  await saveReport(configId, start, end, html);
  console.log(`Site Performance report generated: config ${configId} ${start.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
  return { reportStart: start, reportEnd: end };
}

// ── Template (pool) generation ────────────────────────────────────────────────
// Render any pool template against a SITE over a date range, composed from modules and driven by the
// SITE's logic. Returns the HTML (used by ad-hoc "run"); the scheduler will persist via this later.
async function getSiteAndCustomer(siteId: number) {
  const res = await db().query(
    `SELECT s.id AS site_id, s.site_label, s.business_hours AS site_business_hours, s.logic_config AS site_logic_config,
            c.id AS customer_id, c.name AS customer_name,
            c.icalls_api_url, c.icalls_api_token, c.icalls_api_username
       FROM sites s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1`, [siteId]);
  return res.rows[0] || null;
}

export async function generateFromTemplate(templateId: number, siteId: number, from: Date, to: Date): Promise<{ html: string }> {
  const tpl = (await db().query('SELECT name, base_type, modules, is_system FROM report_templates WHERE id=$1', [templateId])).rows[0];
  if (!tpl) throw new Error('Report template not found.');
  const site = await getSiteAndCustomer(siteId);
  if (!site) throw new Error('Site not found.');

  const logic = siteLogic(site);
  const modules: string[] = (tpl.is_system && LOCKED_TEMPLATE_MODULES[tpl.base_type])
    ? LOCKED_TEMPLATE_MODULES[tpl.base_type]
    : (Array.isArray(tpl.modules)
      ? tpl.modules
      : (typeof tpl.modules === 'string' ? (JSON.parse(tpl.modules || '[]') as string[]) : []));

  const start = new Date(from); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() + 1); // exclusive end

  let rows = await fetchGroupRows(site.customer_id, start, end);
  if (rows.length === 0) rows = await fetchFromTollring(site, start, end) ?? [];
  const journeys = buildJourneys(rows, logic);

  // Rolling / all-time dataset — only fetched when the template actually uses a rolling module.
  let rollingJourneys: CallJourney[] = [];
  const weekBuckets: { label: string; total: number; answered: number; missed: number }[] = [];
  let rollingWeeks = 0;
  if (modules.some((m) => ROLLING_MODULES.includes(m))) {
    const rollingStart = new Date('2026-01-01T00:00:00Z');
    let rollingRows = await fetchGroupRows(site.customer_id, rollingStart, end);
    if (rollingRows.length === 0) rollingRows = await fetchFromTollring(site, rollingStart, end) ?? [];
    rollingJourneys = buildJourneys(rollingRows, logic);
    const weekStart = new Date(start); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)); // Monday of the report's week
    const firstJourneyDate = rollingJourneys.length
      ? new Date(Math.min(...rollingJourneys.map((j) => new Date(j.datetime).getTime())))
      : rollingStart;
    rollingWeeks = Math.max(1, Math.ceil((end.getTime() - firstJourneyDate.getTime()) / (7 * 24 * 60 * 60 * 1000)));
    for (let w = rollingWeeks - 1; w >= 0; w--) {
      const wkStart = new Date(weekStart); wkStart.setDate(wkStart.getDate() - w * 7);
      const we = new Date(wkStart); we.setDate(we.getDate() + 7);
      const wj = rollingJourneys.filter((j) => { const dt = new Date(j.datetime); return dt >= wkStart && dt < we; });
      weekBuckets.push({ label: `${wkStart.getDate()}/${wkStart.getMonth() + 1}`, total: wj.length, answered: wj.filter((j) => j.status === 'Answered').length, missed: wj.filter((j) => j.status === 'Missed' || j.status === 'Abandoned').length });
    }
  }

  const ctx = buildReportContext({
    customerName: site.customer_name, siteName: site.site_label,
    from: start, to: new Date(end.getTime() - 1),
    journeys, extRows: rows, config: logic,
    rollingJourneys, weekBuckets, rollingWeeks,
  });
  return { html: renderReportFromModules(tpl.name, modules, ctx) };
}
