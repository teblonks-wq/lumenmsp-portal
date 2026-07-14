import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool, insightsPool } from '../db/pool';
import { sendMail } from '../lib/mailer';
import { buildJourneys, formatRoute, type CallEventRow } from '../lib/insights-journeys';
import { generateWeekly, generateDaily, generateSitePerformance, generateFromTemplate } from '../lib/insights/report-generator';
import { moduleList } from '../lib/insights/reports/modules';
import { clientFromCustomer } from '../lib/insights/tollring-client';

// Insights — reporting & call analytics, now a native section of the portal. Reads from the
// separate lumenmsp_insights DB via insightsPool. Customer identity lives in the portal; Insights
// rows reference it by lumenmsp_id (bridge already present on the Insights customers table).

const router = Router();

router.get('/insights', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  if (!insightsPool) {
    res.render('insights/dashboard', { user, connected: false, stats: null, customers: [], recentReports: [], error: null });
    return;
  }
  try {
    const [counts, custs, reps] = await Promise.all([
      insightsPool.query(
        `SELECT (SELECT COUNT(*) FROM call_events)::bigint AS call_events,
                (SELECT COUNT(*) FROM customers WHERE is_active = true)::int AS customers,
                (SELECT COUNT(*) FROM generated_reports)::int AS reports`
      ),
      insightsPool.query(
        `SELECT c.id, c.name, c.lumenmsp_id, COUNT(s.id)::int AS site_count
           FROM customers c LEFT JOIN sites s ON s.customer_id = c.id
          WHERE c.is_active = true GROUP BY c.id ORDER BY c.name`
      ),
      insightsPool.query(
        `SELECT gr.id, gr.status, gr.created_at, gr.generated_at, gr.report_start, gr.report_end,
                rc.config_label, rc.report_type, c.name AS customer_name
           FROM generated_reports gr
           JOIN report_configs rc ON rc.id = gr.config_id
           JOIN sites s ON s.id = rc.site_id
           JOIN customers c ON c.id = s.customer_id
          ORDER BY gr.generated_at DESC NULLS LAST, gr.created_at DESC LIMIT 12`
      ),
    ]);
    const unlinked = (await insightsPool.query('SELECT COUNT(*)::int n FROM customers WHERE is_active=true AND lumenmsp_id IS NULL')).rows[0].n;
    // Surface portal customers with Phones ticked that aren't yet set up in Insights, so they
    // appear here automatically (still need Tollring creds + a site to pull live call data).
    const linked = new Set(custs.rows.map((c: any) => c.lumenmsp_id).filter(Boolean).map(Number));
    const phonesRows = (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL AND COALESCE(is_placeholder,false)=false AND has_phones=true ORDER BY name").catch(() => ({ rows: [] as any[] }))).rows;
    const phonesUnlinked = phonesRows.filter((c: any) => !linked.has(Number(c.id)));
    res.render('insights/dashboard', {
      user, connected: true, error: null, notice: req.query.msg || null, qerr: req.query.err || null, unlinked,
      stats: counts.rows[0], customers: custs.rows, recentReports: reps.rows, phonesUnlinked,
    });
  } catch (e: any) {
    res.render('insights/dashboard', { user, connected: true, error: e.message, stats: null, customers: [], recentReports: [] });
  }
});

// Reports list — configs + generated reports (read-only; generation still runs in the Insights cron).
router.get('/insights/reports', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  if (!insightsPool) { res.render('insights/reports', { user, connected: false, configs: [], reports: [], customers: [], custFilter: 0, flash: null, error: null }); return; }
  const custFilter = parseInt(String(req.query.customer || ''), 10) || 0;
  const fc  = String(req.query.fc  || '');  // filter by customer name
  const frc = String(req.query.frc || '');  // filter by config label
  try {
    const configs = (await insightsPool.query(
      `SELECT rc.id, rc.config_label, rc.report_type, s.site_label, c.id AS customer_id, c.name AS customer_name
         FROM report_configs rc JOIN sites s ON s.id=rc.site_id JOIN customers c ON c.id=s.customer_id
        WHERE rc.is_active=true ORDER BY c.name, rc.config_label`
    )).rows;
    const params: any[] = [];
    const clauses: string[] = [];
    if (custFilter) { params.push(custFilter); clauses.push(`c.id=$${params.length}`); }
    if (fc)  { params.push(fc);  clauses.push(`c.name=$${params.length}`); }
    if (frc) { params.push(frc); clauses.push(`rc.config_label=$${params.length}`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const reports = (await insightsPool.query(
      `SELECT gr.id, gr.config_id, gr.report_start, gr.report_end, gr.status, gr.generated_at, gr.created_at,
              rc.config_label, rc.report_type, s.site_label, c.name AS customer_name
         FROM generated_reports gr JOIN report_configs rc ON rc.id=gr.config_id
         JOIN sites s ON s.id=rc.site_id JOIN customers c ON c.id=s.customer_id
        ${where} ORDER BY gr.generated_at DESC NULLS LAST, gr.created_at DESC LIMIT 100`, params
    )).rows;
    const customers = (await insightsPool.query('SELECT id, name FROM customers WHERE is_active=true ORDER BY name')).rows;
    res.render('insights/reports', { user, connected: true, configs, reports, customers, custFilter, flash: req.query.flash || null, error: req.query.error || null });
  } catch (e: any) {
    res.render('insights/reports', { user, connected: true, configs: [], reports: [], customers: [], custFilter: 0, flash: null, error: e.message });
  }
});

// View a generated report — serves the stored HTML. Relax CSP so the report's inline styles/charts render.
router.get('/insights/reports/:id', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.status(503).send('Insights database not connected.'); return; }
  const id = parseInt(String(req.params.id), 10);
  const r = (await insightsPool.query('SELECT html FROM generated_reports WHERE id=$1', [id])).rows[0];
  if (!r || !r.html) { res.status(404).render('error', { message: 'Report not generated.' }); return; }
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob: https:; img-src * data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:");
  res.send(r.html);
});

// Re-email a generated report to its configured recipients.
router.post('/insights/reports/:id/email', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/reports?error=Insights+DB+not+connected'); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = (await insightsPool.query(
      `SELECT gr.html, gr.report_start, gr.report_end, rc.config_label, rc.recipients
         FROM generated_reports gr JOIN report_configs rc ON rc.id=gr.config_id WHERE gr.id=$1`, [id]
    )).rows[0];
    if (!r || !r.html) { res.redirect('/insights/reports?error=Report+not+found+or+empty'); return; }
    // Normalise recipients EXACTLY like the scheduler's emailReport — the column can hold a
    // Postgres array literal, so strip {}" or addresses go out braced and bounce.
    const recipients: string[] = (Array.isArray(r.recipients) ? r.recipients : String(r.recipients || '').split(/[\n,;]+/))
      .map((s: string) => String(s).replace(/[{}"]/g, '').trim()).filter((s: string) => s.includes('@'));
    if (!recipients.length) { res.redirect('/insights/reports?error=No+recipients+configured+for+this+report'); return; }
    const fmt = (d: any) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    let sent = 0; const failed: string[] = [];
    for (const to of recipients) {
      try { await sendMail({ to, subject: `${r.config_label} — ${fmt(r.report_start)} to ${fmt(r.report_end)}`, html: r.html }); sent++; }
      catch (err: any) { failed.push(to); console.error(`[insights] report ${id} send to ${to} failed:`, err?.message || err); }
    }
    // Only mark 'sent' when something actually went out — and be honest in the flash.
    if (sent > 0) await insightsPool.query(`UPDATE generated_reports SET status='sent', updated_at=NOW() WHERE id=$1`, [id]);
    if (failed.length) {
      res.redirect('/insights/reports?error=' + encodeURIComponent(`Sent to ${sent}, FAILED for: ${failed.join(', ')}`));
    } else {
      res.redirect(`/insights/reports?flash=` + encodeURIComponent(`Report sent to ${sent} recipient${sent !== 1 ? 's' : ''}: ${recipients.join(', ')}`));
    }
  } catch (e: any) {
    res.redirect('/insights/reports?error=' + encodeURIComponent((e.message || 'Email failed').slice(0, 80)));
  }
});

// Generate from the Reports page (standalone "Generate Report" panel + "Regenerate"
// buttons). Dispatches on the config's report_type, then emails recipients.
router.post('/insights/reports/generate', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/reports?error=Insights+DB+not+connected'); return; }
  const { config_id, date_from, date_to, week, report_date } = req.body as Record<string, string>;
  const configId = parseInt(String(config_id), 10);
  if (!configId) { res.redirect('/insights/reports?error=No+report+selected'); return; }
  try {
    const cfgRes = await insightsPool.query('SELECT report_type FROM report_configs WHERE id=$1', [configId]);
    if (!cfgRes.rows.length) { res.redirect('/insights/reports?error=Config+not+found'); return; }
    const rtype = cfgRes.rows[0].report_type;
    // Manual generation is REVIEW-ONLY — it never emails. The report lands in the list as
    // 'generated'; a human clicks Send when happy. Only the scheduler auto-sends.
    if (rtype === 'weekly_call_stats') {
      const start = new Date(week || date_from || report_date || new Date().toISOString().slice(0, 10));
      start.setUTCHours(0, 0, 0, 0);
      await generateWeekly(configId, start);
      res.redirect('/insights/reports?flash=' + encodeURIComponent('Report generated — review it below, then Send when happy'));
    } else if (rtype === 'site_performance') {
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(date_from || today);
      const to   = new Date(date_to || date_from || today);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) { res.redirect('/insights/reports?error=' + encodeURIComponent('Pick a valid date range.')); return; }
      if (to < from) { res.redirect('/insights/reports?error=' + encodeURIComponent('The end date is before the start date.')); return; }
      await generateSitePerformance(configId, from, to);
      res.redirect('/insights/reports?flash=' + encodeURIComponent('Site Performance report generated — review it below, then Send when happy'));
    } else {
      const d = date_from || report_date || new Date().toISOString().slice(0, 10);
      await generateDaily(configId, new Date(d));
      res.redirect('/insights/reports?flash=' + encodeURIComponent('Daily report generated — review it below, then Send when happy'));
    }
  } catch (e: any) {
    res.redirect('/insights/reports?error=' + encodeURIComponent((e.message || 'Generation failed').slice(0, 100)));
  }
});

// Number lookup — autocomplete (JSON). Searches the cached call_events for a customer.
router.get('/insights/number-search', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.json([]); return; }
  const cid = parseInt(String(req.query.customer || ''), 10) || 0;
  const raw = String(req.query.q || '').trim().replace(/[\s\-()]/g, '').replace(/^\+44/, '0');
  if (!cid || raw.length < 3) { res.json([]); return; }
  try {
    const r = await insightsPool.query(
      `SELECT number_normalised, COUNT(DISTINCT COALESCE(call_id, id::text))::int AS call_count, MAX(event_datetime) AS last_call
         FROM call_events
        WHERE customer_id=$1 AND (number_normalised ILIKE $2 OR number_raw ILIKE $2)
          AND number_normalised NOT IN ('', 'Anonymous', 'withheld', 'Withheld', 'WITHHELD')
        GROUP BY number_normalised ORDER BY call_count DESC LIMIT 12`,
      [cid, '%' + raw + '%']
    );
    res.json(r.rows);
  } catch { res.json([]); }
});

// Number lookup — the page. Pick a customer + number → call journeys (cached, last 28 days).
router.get('/insights/number', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const base: any = { user, connected: !!insightsPool, customers: [], cid: 0, number: '', journeys: [], stats: null, error: null, fromDate: '', toDate: '' };
  if (!insightsPool) { res.render('insights/number', base); return; }
  try {
    base.customers = (await insightsPool.query('SELECT id, name FROM customers WHERE is_active=true ORDER BY name')).rows;
  } catch (e: any) { base.error = e.message; res.render('insights/number', base); return; }

  const cid = parseInt(String(req.query.customer || ''), 10) || 0;
  const number = String(req.query.q || '').trim();
  base.cid = cid; base.number = number;
  if (!cid || number.length < 3) { res.render('insights/number', base); return; }

  const from = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  base.fromDate = from; base.toDate = to;
  try {
    const rows = (await insightsPool.query(
      `SELECT * FROM call_events
        WHERE customer_id=$1 AND number_normalised=$2 AND event_datetime >= $3 AND event_datetime <= $4
        ORDER BY event_datetime ASC`,
      [cid, number, from + ' 00:00:00', to + ' 23:59:59']
    )).rows as CallEventRow[];
    const journeys = buildJourneys(rows, { business_hours_only: false }).reverse().map((j) => ({ ...j, route: formatRoute(j) }));
    const total = journeys.length;
    const answered = journeys.filter((j) => j.status === 'Answered').length;
    const missed = journeys.filter((j) => j.status === 'Missed' || j.status === 'Abandoned').length;
    const avgWait = total ? Math.round(journeys.reduce((s, j) => s + j.wait_secs, 0) / total) : 0;
    base.journeys = journeys;
    base.stats = { total, answered, missed, ansRate: total ? Math.round(answered / total * 100) : 0, avgWait };
  } catch (e: any) { base.error = e.message; }
  res.render('insights/number', base);
});

// Reverse lookup — the pair to Number Lookup. Pick a customer + answering extension/user +
// a date & time range → every call that extension ANSWERED in the window. Caller numbers
// link straight back into Number Lookup for the full journey history of that number.
router.get('/insights/reverse', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const base: any = {
    user, connected: !!insightsPool, customers: [], cid: 0, ext: '',
    fromDate: weekAgo, toDate: today, fromTime: '00:00', toTime: '23:59',
    calls: [], stats: null, error: null, searched: false,
  };
  if (!insightsPool) { res.render('insights/reverse', base); return; }
  try {
    base.customers = (await insightsPool.query('SELECT id, name FROM customers WHERE is_active=true ORDER BY name')).rows;
  } catch (e: any) { base.error = e.message; res.render('insights/reverse', base); return; }

  const cid = parseInt(String(req.query.customer || ''), 10) || 0;
  const ext = String(req.query.ext || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) base.fromDate = String(req.query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')))   base.toDate   = String(req.query.to);
  if (/^\d{2}:\d{2}$/.test(String(req.query.from_time || '')))  base.fromTime = String(req.query.from_time);
  if (/^\d{2}:\d{2}$/.test(String(req.query.to_time || '')))    base.toTime   = String(req.query.to_time);
  base.cid = cid; base.ext = ext;
  if (!cid || !ext) { res.render('insights/reverse', base); return; }

  if (base.toDate < base.fromDate) { base.error = 'The end date is before the start date.'; res.render('insights/reverse', base); return; }
  const spanDays = Math.round((new Date(base.toDate).getTime() - new Date(base.fromDate).getTime()) / 86400000) + 1;
  if (spanDays > 92) { base.error = 'Date range is too wide — pick 92 days or fewer.'; res.render('insights/reverse', base); return; }

  try {
    // Pull EVERY event for the customer in the window (not just this extension's rows) so the
    // journey builder sees all legs of each call and attributes "answered by" correctly.
    const rows = (await insightsPool.query(
      `SELECT * FROM call_events
        WHERE customer_id=$1 AND event_datetime >= $2 AND event_datetime <= $3
        ORDER BY event_datetime ASC`,
      [cid, base.fromDate + ' 00:00:00', base.toDate + ' 23:59:59']
    )).rows as CallEventRow[];
    const journeys = buildJourneys(rows, { business_hours_only: false });
    // Match ignores any @domain suffix + case — the same normalisation answered_by itself uses.
    const normExt = (s: string) => String(s || '').replace(/@.*$/, '').trim().toLowerCase();
    const target = normExt(ext);
    const [fh, fm] = String(base.fromTime).split(':').map(Number);
    const [th, tm] = String(base.toTime).split(':').map(Number);
    const lo = fh * 60 + fm, hi = th * 60 + tm;
    // Time-of-day filter uses the journey's local wall-clock start — the same clock the table shows.
    const calls = journeys
      .filter((j) => j.status === 'Answered' && normExt(j.answered_by || '') === target)
      .filter((j) => { const d = new Date(j.datetime); const mins = d.getHours() * 60 + d.getMinutes(); return mins >= lo && mins <= hi; })
      .reverse()
      .map((j) => ({ ...j, route: formatRoute(j) }));
    const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const byDay = new Map<string, number>();
    for (const c of calls) { const k = dayKey(c.datetime); byDay.set(k, (byDay.get(k) || 0) + 1); }
    let busiestDay = ''; let busiestN = 0;
    for (const [d, n] of byDay) if (n > busiestN) { busiestDay = d; busiestN = n; }
    const uniqueCallers = new Set(calls.map((c) => c.number)).size;
    const avgWait = calls.length ? Math.round(calls.reduce((s, j) => s + j.wait_secs, 0) / calls.length) : 0;
    base.calls = calls;
    base.stats = { total: calls.length, uniqueCallers, avgWait, busiestDay, busiestN };
    base.searched = true;
  } catch (e: any) { base.error = e.message; }
  res.render('insights/reverse', base);
});

// Report config page — the editable visual builder + generate panel, exactly like the
// standalone /admin/report-configs/:id (the config IS the builder; there's no thin detail page).
router.get('/insights/report-config/:id', requireAuth, requireAdmin, async (req: Request, res: Response, next) => {
  // '/new' is a literal route defined further down — let it fall through (this
  // ':id' route is declared first, so guard against swallowing it).
  if (req.params.id === 'new') { next(); return; }
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const cfgRes = await insightsPool.query('SELECT rc.*, s.customer_id FROM report_configs rc JOIN sites s ON s.id = rc.site_id WHERE rc.id = $1', [id]);
    if (!cfgRes.rows.length) { res.status(404).render('error', { message: 'Report config not found.' }); return; }
    const cfg = cfgRes.rows[0];
    const data = await getConfigFormData(cfg.customer_id, cfg.site_id);
    const reports = (await insightsPool.query(
      'SELECT id, report_start, report_end, status, generated_at, created_at FROM generated_reports WHERE config_id=$1 ORDER BY generated_at DESC NULLS LAST, created_at DESC LIMIT 30', [id]
    )).rows;
    res.render('insights/report-config-form', {
      user: req.session.user!, config: cfg, customerId: cfg.customer_id, preselectSiteId: null,
      reports, error: req.query.error || req.query.err || null, notice: req.query.msg || null, ...data,
    });
  } catch (e: any) { res.status(500).render('error', { message: 'Insights error: ' + e.message }); }
});

// Site detail — site + its report configs.
router.get('/insights/site/:id', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.status(503).render('error', { message: 'Insights database not connected.' }); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const site = (await insightsPool.query(
      `SELECT s.*, c.id AS ins_customer_id, c.name AS customer_name, c.lumenmsp_id
         FROM sites s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1`, [id]
    )).rows[0];
    if (!site) { res.status(404).render('error', { message: 'Site not found.' }); return; }
    const configs = (await insightsPool.query(
      'SELECT id, config_label, report_type FROM report_configs WHERE site_id=$1 AND is_active=true ORDER BY config_label', [id]
    )).rows;
    const templates = (await insightsPool.query(
      'SELECT id, name FROM report_templates WHERE is_active=true ORDER BY is_system DESC, lower(name)')).rows;
    const siteReports = (await insightsPool.query(
      `SELECT sr.id, sr.recipients, sr.reporting_period, sr.send_day, sr.send_time, sr.is_active, t.name AS template_name
         FROM site_reports sr JOIN report_templates t ON t.id = sr.template_id
        WHERE sr.site_id = $1 ORDER BY sr.id`, [id])).rows;
    res.render('insights/site', { user: req.session.user!, site, configs, templates, siteReports, notice: req.query.msg || null, qerr: req.query.err || null });
  } catch (e: any) { res.status(500).render('error', { message: 'Insights error: ' + e.message }); }
});

// Auto-link Insights customers to portal customers by name (one-off bulk).
router.post('/insights/auto-link', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const STOP = new Set(['ltd', 'limited', 'plc', 'llp', 'inc', 'co', 'company', 'group', 'holdings', 'the', 'services', 'service', 'and']);
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = (s: string) => norm(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
  try {
    const portalCusts = (await pool.query('SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false')).rows as { id: number; name: string }[];
    const byNorm = new Map<string, number>();          // exact-normalised name → portal id
    const byToken = new Map<string, number[]>();        // distinctive word → portal ids containing it
    for (const c of portalCusts) {
      const n = norm(c.name); if (n && !byNorm.has(n)) byNorm.set(n, c.id);
      for (const tk of new Set(tokens(c.name))) { const a = byToken.get(tk) || []; a.push(c.id); byToken.set(tk, a); }
    }
    const ins = (await insightsPool.query('SELECT id, name FROM customers WHERE lumenmsp_id IS NULL')).rows as { id: number; name: string }[];
    let linked = 0;
    for (const ic of ins) {
      let pid = byNorm.get(norm(ic.name)) || 0;
      if (!pid) {
        // Match on the most distinctive (longest) word when it uniquely identifies one portal customer.
        const toks = tokens(ic.name).sort((a, b) => b.length - a.length);
        for (const tk of toks) { const hits = byToken.get(tk); if (hits && hits.length === 1) { pid = hits[0]; break; } }
      }
      if (pid) { await insightsPool.query('UPDATE customers SET lumenmsp_id=$1 WHERE id=$2', [pid, ic.id]); linked++; }
    }
    res.redirect('/insights?msg=' + encodeURIComponent(`Auto-linked ${linked} of ${ins.length} unlinked customer(s).`));
  } catch (e: any) {
    res.redirect('/insights?err=' + encodeURIComponent('Auto-link failed: ' + e.message));
  }
});

// ── Report config + site management (writes to the Insights DB) ─────────────────

function parseRecipients(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(/[\n,;]+/).map((s) => s.replace(/[{}"]/g, '').trim()).filter((s) => s.includes('@'));
}

// Distinct group + extension names for a customer, read from the synced raw data
// (tollring_calls) UNION any legacy CSV-imported call_events rows. Fast + indexed.
export async function getGroupsAndExtensions(customerId: number): Promise<{ groups: string[]; extensions: string[] }> {
  if (!insightsPool) return { groups: [], extensions: [] };
  try {
    const [grpRes, extRes] = await Promise.all([
      insightsPool.query(
        `SELECT DISTINCT g FROM (
           SELECT group_no   AS g FROM tollring_calls WHERE customer_id = $1
           UNION SELECT group_name AS g FROM call_events WHERE customer_id = $1 AND source_file ILIKE 'ContactGroupDetail%'
         ) t WHERE g IS NOT NULL AND btrim(g) <> '' ORDER BY g`, [customerId]),
      insightsPool.query(
        `SELECT DISTINCT e FROM (
           SELECT extno AS e FROM tollring_calls WHERE customer_id = $1
           UNION SELECT group_name AS e FROM call_events WHERE customer_id = $1 AND source_file ILIKE 'ListCallsbyExtension%'
         ) t WHERE e IS NOT NULL AND btrim(e) <> '' ORDER BY e LIMIT 500`, [customerId]),
    ]);
    return { groups: grpRes.rows.map((r: any) => r.g), extensions: extRes.rows.map((r: any) => r.e) };
  } catch { return { groups: [], extensions: [] }; }
}

async function getConfigFormData(customerId: number | null, siteId?: number | null) {
  if (!insightsPool) return { customers: [], sites: [], knownGroups: [], knownExtensions: [] };
  const [custsRes, sitesRes] = await Promise.all([
    insightsPool.query('SELECT id, name FROM customers WHERE is_active = true ORDER BY name'),
    insightsPool.query('SELECT s.id, s.site_label, s.customer_id, c.name AS customer_name FROM sites s JOIN customers c ON c.id = s.customer_id WHERE s.is_active = true ORDER BY c.name, s.site_label'),
  ]);
  const resolvedCustId = customerId || (siteId ? sitesRes.rows.find((s: any) => s.id === siteId)?.customer_id : null);
  let knownGroups: string[] = [], knownExtensions: string[] = [];
  if (resolvedCustId) {
    const db = await getGroupsAndExtensions(resolvedCustId);
    knownGroups = db.groups; knownExtensions = db.extensions;
  }
  return { customers: custsRes.rows, sites: sitesRes.rows, knownGroups, knownExtensions };
}

// New report config form (optionally pre-scoped to a customer/site).
router.get('/insights/report-config/new', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const customerId = req.query.customer_id ? parseInt(String(req.query.customer_id), 10) : null;
  const preselectSiteId = req.query.site_id ? parseInt(String(req.query.site_id), 10) : null;
  const data = await getConfigFormData(customerId, null);
  res.render('insights/report-config-form', {
    user: req.session.user!, config: null, customerId, preselectSiteId, error: req.query.error || null, ...data,
  });
});

// Create report config.
router.post('/insights/report-config', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const { site_id, config_label, report_type, reporting_period, send_day, send_time, recipients } = req.body as Record<string, string>;
  if (!site_id || !config_label || !report_type) { res.redirect('/insights/report-config/new?error=Required+fields+missing'); return; }
  // Call logic lives on the SITE only (one logic per site, no duplication — Terry, 2026-07-14);
  // report configs no longer carry their own copy. Existing rows keep theirs as a read-only
  // fallback for sites not yet backfilled.
  try {
    const r = await insightsPool.query(
      `INSERT INTO report_configs (site_id, config_label, report_type, reporting_period, send_day, send_time, recipients)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [parseInt(site_id, 10), config_label.trim(), report_type, reporting_period || 'weekly',
       parseInt(send_day, 10) || 2, send_time || '09:00',
       parseRecipients(recipients).join(', ') || null]
    );
    res.redirect(`/insights/report-config/${r.rows[0].id}?msg=Report+config+created`);
  } catch (e: any) { res.redirect('/insights/report-config/new?error=' + encodeURIComponent('Failed to create config: ' + (e.message || '').slice(0, 80))); }
});

// Edit report config form.
router.get('/insights/report-config/:id/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const cfgRes = await insightsPool.query('SELECT rc.*, s.customer_id FROM report_configs rc JOIN sites s ON s.id = rc.site_id WHERE rc.id = $1', [id]);
  if (!cfgRes.rows.length) { res.status(404).render('error', { message: 'Config not found.' }); return; }
  const cfg = cfgRes.rows[0];
  const data = await getConfigFormData(cfg.customer_id, cfg.site_id);
  res.render('insights/report-config-form', {
    user: req.session.user!, config: cfg, customerId: cfg.customer_id, preselectSiteId: null, error: req.query.error || null, ...data,
  });
});

// Update report config.
router.post('/insights/report-config/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const { site_id, config_label, report_type, reporting_period, send_day, send_time, is_active, recipients } = req.body as Record<string, string>;
  // logic_config is deliberately NOT written here any more — the site's logic drives reports, and
  // the row's existing value stays untouched as the read-only fallback (see generateFromTemplate).
  try {
    await insightsPool.query(
      `UPDATE report_configs SET site_id=$1, config_label=$2, report_type=$3, reporting_period=$4,
       send_day=$5, send_time=$6, is_active=$7, recipients=$8 WHERE id=$9`,
      [parseInt(site_id, 10), config_label.trim(), report_type, reporting_period || 'weekly',
       parseInt(send_day, 10) || 2, send_time || '09:00', is_active !== 'false',
       parseRecipients(recipients).join(', ') || null, id]
    );
    res.redirect(`/insights/report-config/${id}?msg=Config+updated`);
  } catch (e: any) { res.redirect(`/insights/report-config/${id}/edit?error=` + encodeURIComponent('Failed to update: ' + (e.message || '').slice(0, 80))); }
});

// Delete a report schedule outright — the config AND its pool-migration mirror (site_reports),
// so nothing can ever fire it again. Generated report history is kept for reference.
router.post('/insights/report-config/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    await insightsPool.query('DELETE FROM site_reports WHERE source_config_id=$1', [id]).catch(() => {});
    await insightsPool.query('DELETE FROM report_configs WHERE id=$1', [id]);
    res.redirect('/insights?msg=' + encodeURIComponent('Report schedule deleted'));
  } catch (e: any) { res.redirect(`/insights/report-config/${id}?err=` + encodeURIComponent('Failed to delete: ' + (e.message || '').slice(0, 80))); }
});

// Generate a report on demand (weekly or daily), then email to recipients unless no_email.
router.post('/insights/report-config/:id/generate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const body = req.body as Record<string, any>;
  try {
    const cfgRes = await insightsPool.query('SELECT report_type FROM report_configs WHERE id = $1', [id]);
    if (!cfgRes.rows.length) { res.redirect(`/insights/report-config/${id}?err=Config+not+found`); return; }
    const reportType = cfgRes.rows[0].report_type;

    // Manual generation is REVIEW-ONLY — never emails. The report lands as 'generated';
    // a human clicks Send when happy. Only the scheduler auto-sends.
    if (reportType === 'weekly_call_stats') {
      const date = body.report_date ? new Date(body.report_date) : new Date();
      await generateWeekly(id, date);
      res.redirect(`/insights/report-config/${id}?msg=` + encodeURIComponent('Weekly report generated — review it below, then Send when happy'));
    } else if (reportType === 'site_performance') {
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(body.date_from || today);
      const to   = new Date(body.date_to || body.date_from || today);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) { res.redirect(`/insights/report-config/${id}?err=` + encodeURIComponent('Pick a valid date range.')); return; }
      if (to < from) { res.redirect(`/insights/report-config/${id}?err=` + encodeURIComponent('The end date is before the start date.')); return; }
      await generateSitePerformance(id, from, to);
      res.redirect(`/insights/report-config/${id}?msg=` + encodeURIComponent('Site Performance report generated — review it below, then Send when happy'));
    } else {
      const raw = body.report_dates ?? body['report_dates[]'];
      const dates: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [body.report_date || new Date().toISOString().slice(0, 10)];
      let generated = 0;
      for (const dateStr of dates) {
        await generateDaily(id, new Date(dateStr));
        generated++;
      }
      res.redirect(`/insights/report-config/${id}?msg=` + encodeURIComponent(`${generated} daily report(s) generated — review below, then Send when happy`));
    }
  } catch (e: any) {
    console.error(`[insights] manual generate failed for config ${id}:`, e.message || e);
    res.redirect(`/insights/report-config/${id}?err=` + encodeURIComponent((e.message || 'Generate failed').slice(0, 120)));
  }
});

// Add a site to an Insights customer.
router.post('/insights/customer/:id/sites', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const custId = parseInt(String(req.params.id), 10);
  const { site_label, icalls_site_code, ddi_number, business_hours } = req.body as Record<string, string>;
  if (!site_label) { res.redirect(`/insights?err=Site+label+required`); return; }
  let parsedHours: any = null;
  if (business_hours?.trim()) { try { parsedHours = JSON.parse(business_hours); } catch { /* null */ } }
  try {
    const r = await insightsPool.query(
      `INSERT INTO sites (customer_id, site_label, icalls_site_code, ddi_number, business_hours)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [custId, site_label.trim(), icalls_site_code?.trim() || null, ddi_number?.trim() || null, parsedHours ? JSON.stringify(parsedHours) : null]
    );
    res.redirect(`/insights/site/${r.rows[0].id}?msg=Site+added`);
  } catch (e: any) { res.redirect(`/insights?err=` + encodeURIComponent('Failed to add site: ' + (e.message || '').slice(0, 80))); }
});

// Update a site (label, ddi, site code, business hours, active).
router.post('/insights/site/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const { site_label, icalls_site_code, ddi_number, is_active, business_hours } = req.body as Record<string, string>;
  let parsedHours: any = null;
  if (business_hours?.trim()) { try { parsedHours = JSON.parse(business_hours); } catch { /* null */ } }
  try {
    await insightsPool.query(
      `UPDATE sites SET site_label=$1, icalls_site_code=$2, ddi_number=$3, is_active=$4, business_hours=$5 WHERE id=$6`,
      [site_label.trim(), icalls_site_code?.trim() || null, ddi_number?.trim() || null, is_active !== 'false', parsedHours ? JSON.stringify(parsedHours) : null, id]
    );
    res.redirect(`/insights/site/${id}?msg=Site+updated`);
  } catch (e: any) { res.redirect(`/insights/site/${id}?err=` + encodeURIComponent('Failed to update site: ' + (e.message || '').slice(0, 80))); }
});

// Manual Tollring sync for one Insights customer.
router.post('/insights/customer/:id/sync-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const { syncCustomer } = await import('../lib/insights/tollring-sync');
    const result = await syncCustomer(id);
    res.redirect(`/insights?msg=` + encodeURIComponent(`Sync done: +${result.eventsAdded} events (${result.fetched} fetched, ${result.rawAdded} raw)`));
  } catch (e: any) { res.redirect(`/insights?err=` + encodeURIComponent('Sync failed: ' + (e.message || '').slice(0, 100))); }
});

// Save a customer's iCalls/Tollring credentials + internal flag. Redirects back to the portal
// customer page (Reports tab) when linked, else to /insights.
router.post('/insights/customer/:id/icalls-creds', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const { icalls_api_url, icalls_api_token, icalls_api_username, is_internal } = req.body as Record<string, string>;
  try {
    await insightsPool.query(
      `UPDATE customers SET icalls_api_url=$1, icalls_api_token=$2, icalls_api_username=$3, is_internal=$4 WHERE id=$5`,
      [icalls_api_url?.trim() || null, icalls_api_token?.trim() || null, icalls_api_username?.trim() || null, is_internal === 'true', id]
    );
    const link = (await insightsPool.query('SELECT lumenmsp_id FROM customers WHERE id=$1', [id])).rows[0];
    if (link?.lumenmsp_id) { res.redirect(`/customers/${link.lumenmsp_id}?msg=Call+credentials+saved#reports`); return; }
    res.redirect('/insights?msg=Credentials+saved');
  } catch (e: any) {
    const link = (await insightsPool.query('SELECT lumenmsp_id FROM customers WHERE id=$1', [id])).rows[0];
    const back = link?.lumenmsp_id ? `/customers/${link.lumenmsp_id}` : '/insights';
    res.redirect(`${back}?err=` + encodeURIComponent('Failed to save credentials: ' + (e.message || '').slice(0, 80)));
  }
});

// Test a customer's Tollring connection (JSON, used by the Test connection button).
router.get('/insights/customer/:id/api-test', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.json({ ok: false, message: 'Insights DB not connected' }); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const row = (await insightsPool.query('SELECT icalls_api_url, icalls_api_token, icalls_api_username FROM customers WHERE id=$1', [id])).rows[0];
    const client = clientFromCustomer(row || {});
    if (!client) { res.json({ ok: false, message: 'No API URL/token set — save credentials first' }); return; }
    const r = await client.pingVerbose();
    res.json({ ok: r.ok, message: r.detail });
  } catch (e: any) { res.json({ ok: false, message: (e.message || 'Test failed').slice(0, 160) }); }
});

// ── Customer 360 admin page (page-for-page port of the Insights customer admin) ───────────────

// Render the full call-data admin page for one Insights customer.
router.get('/insights/customer/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const [custRes, sitesRes, usersRes, configsRes, dataStatsRes] = await Promise.all([
      insightsPool.query('SELECT * FROM customers WHERE id = $1', [id]),
      insightsPool.query('SELECT * FROM sites WHERE customer_id = $1 ORDER BY site_label', [id]),
      insightsPool.query('SELECT * FROM users WHERE customer_id = $1 ORDER BY email', [id]),
      insightsPool.query('SELECT rc.*, s.site_label FROM report_configs rc JOIN sites s ON s.id = rc.site_id WHERE s.customer_id = $1 ORDER BY rc.config_label', [id]),
      insightsPool.query(`SELECT COUNT(id)::int AS call_count, MIN(event_datetime) AS earliest, MAX(event_datetime) AS latest, MAX(created_at) AS last_import, COUNT(DISTINCT source_file)::int AS file_count FROM call_events WHERE customer_id = $1`, [id]),
    ]);
    if (!custRes.rows.length) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
    res.render('insights/customer', {
      user: req.session.user!, customer: custRes.rows[0], sites: sitesRes.rows, users: usersRes.rows,
      configs: configsRes.rows, dataStats: dataStatsRes.rows, flash: req.query.flash || null, error: req.query.error || null,
    });
  } catch (e: any) { res.status(500).render('error', { message: 'Failed to load customer: ' + (e.message || '') }); }
});

// Update customer details (name, status, type, iCalls credentials).
router.post('/insights/customer/:id/details', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const { name, is_active, is_internal, icalls_token, icalls_api_url, icalls_api_token, icalls_api_username } = req.body as Record<string, string>;
  try {
    await insightsPool.query(
      `UPDATE customers SET name=$1, is_active=$2, is_internal=$3, icalls_token=$4, icalls_api_url=$5, icalls_api_token=$6, icalls_api_username=$7 WHERE id=$8`,
      [name.trim(), is_active === 'true', is_internal === 'true', icalls_token?.trim() || null,
       icalls_api_url?.trim() || null, icalls_api_token?.trim() || null, icalls_api_username?.trim() || null, id]
    );
    res.redirect(`/insights/customer/${id}?flash=Customer+updated`);
  } catch (e: any) { res.redirect(`/insights/customer/${id}?error=` + encodeURIComponent('Failed to update: ' + (e.message || '').slice(0, 80))); }
});

// Send an Insights welcome email (best-effort). The standalone insights.lumenmsp.co.uk
// app is RETIRED (2026-07-07) — no customer login exists, so this no longer links to a
// sign-in page. Reports reach recipients by scheduled email; self-serve access for
// customers will come via the Portal's /my area when insights land there.
async function sendInsightsInvite(to: string, displayName: string, customerName: string): Promise<void> {
  const html = `<p>Hi ${displayName},</p>
    <p>You've been set up to receive <strong>Lumen MSP Insights</strong> call-analytics reports for <strong>${customerName}</strong>.</p>
    <p>Your reports will be delivered to this email address on their configured schedule — there's nothing you need to do.</p>
    <p>— Lumen IT Solutions</p>`;
  await sendMail({ to, subject: 'Your Lumen MSP Insights reports', html, signatureName: 'Lumen IT Solutions' });
}

// Add an Insights user to a customer (+ welcome email, non-blocking).
router.post('/insights/customer/:id/users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const { email, display_name, role } = req.body as Record<string, string>;
  const siteIdsRaw = (req.body as any)['site_ids[]'];
  const totalSites = parseInt((req.body as any)['total_sites'] || '0', 10);
  const checked = siteIdsRaw ? (Array.isArray(siteIdsRaw) ? siteIdsRaw : [siteIdsRaw]).map(Number).filter(Boolean) : [];
  const allowedSites = (checked.length === 0 || checked.length >= totalSites) ? null : checked;
  if (!email || !display_name) { res.redirect(`/insights/customer/${id}?error=Email+and+name+are+required`); return; }
  try {
    const cust = (await insightsPool.query('SELECT name, is_internal FROM customers WHERE id=$1', [id])).rows[0];
    const allowedRoles = cust?.is_internal ? ['viewer', 'admin', 'lumen_admin'] : ['viewer', 'admin'];
    const safeRole = allowedRoles.includes(role) ? role : 'viewer';
    await insightsPool.query(
      `INSERT INTO users (customer_id, email, display_name, role, is_active, allowed_site_ids) VALUES ($1,$2,$3,$4,true,$5)`,
      [id, email.toLowerCase().trim(), display_name.trim(), safeRole, allowedSites && allowedSites.length ? allowedSites : null]
    );
    sendInsightsInvite(email.toLowerCase().trim(), display_name.trim(), cust?.name || '').catch((err) => console.error('[insights] invite email failed:', err.message));
    res.redirect(`/insights/customer/${id}?flash=User+added+and+invite+sent`);
  } catch (e: any) {
    if (e.code === '23505') { res.redirect(`/insights/customer/${id}?error=Email+already+exists`); return; }
    res.redirect(`/insights/customer/${id}?error=` + encodeURIComponent('Failed to add user: ' + (e.message || '').slice(0, 60)));
  }
});

// Toggle an Insights user active/inactive.
router.post('/insights/user/:id/toggle', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const back = (req.body as any).return_to || '/insights';
  try {
    const u = (await insightsPool.query('UPDATE users SET is_active = NOT is_active WHERE id=$1 RETURNING customer_id', [id])).rows[0];
    res.redirect((u ? `/insights/customer/${u.customer_id}` : back) + '?flash=User+updated');
  } catch (e: any) { res.redirect(back + '?error=Failed+to+update+user'); }
});

// Resend an Insights user's invite.
router.post('/insights/user/:id/resend-invite', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  const back = (req.body as any).return_to || '/insights';
  try {
    const r = (await insightsPool.query('SELECT u.email, u.display_name, u.customer_id, c.name AS customer_name FROM users u JOIN customers c ON c.id=u.customer_id WHERE u.id=$1', [id])).rows[0];
    if (!r) { res.redirect(back + '?error=User+not+found'); return; }
    await sendInsightsInvite(r.email, r.display_name, r.customer_name);
    res.redirect(`/insights/customer/${r.customer_id}?flash=Invite+resent`);
  } catch (e: any) { res.redirect(back + '?error=' + encodeURIComponent('Failed to resend: ' + (e.message || '').slice(0, 60))); }
});

// Delete a site (blocked if it still has report configs).
router.post('/insights/site/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const s = (await insightsPool.query('SELECT customer_id FROM sites WHERE id=$1', [id])).rows[0];
    await insightsPool.query('DELETE FROM sites WHERE id=$1', [id]);
    res.redirect(`/insights/customer/${s?.customer_id || ''}?flash=Site+deleted`);
  } catch (e: any) {
    if (e.code === '23503') { res.redirect(`/insights/site/${id}?err=Cannot+delete+site+with+existing+report+configs`); return; }
    res.redirect(`/insights/site/${id}?err=Failed+to+delete+site`);
  }
});

// CSV import — REMOVED (2026-07-07). Ingestion is Tollring-API-only (hourly sync +
// per-customer Sync now). Removed both to simplify and because the CSV event_hash had
// no customer ID (cross-customer dedupe collision risk — a second company's identical
// row was silently dropped and stayed attributed to the first). Legacy CSV rows already
// in call_events are retained and still read by getGroupsAndExtensions/report queries.

// Live Tollring fallback — bounded + timed out — for when the DB has no cached groups yet (a
// freshly-onboarded customer). Returns null on any failure/timeout so the form still renders.
async function liveGroupsFromTollring(customerId: number): Promise<{ groups: string[]; extensions: string[] } | null> {
  if (!insightsPool) return null;
  try {
    const custRow = await insightsPool.query('SELECT icalls_api_url, icalls_api_token, icalls_api_username FROM customers WHERE id=$1', [customerId]);
    const client = clientFromCustomer(custRow.rows[0] || {});
    if (!client) return null;
    const now = new Date(), start = new Date(now.getTime() - 7 * 86400000);
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').substring(0, 19);
    const records = await Promise.race([
      client.getCallsByDate({ startDate: fmt(start), endDate: fmt(now) }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Tollring group fetch timed out')), 25000)),
    ]);
    const groupSet = new Set<string>(), extSet = new Set<string>();
    for (const r of records as any[]) {
      if (!r.Group_no) continue;
      const g = String(r.Group_no).toLowerCase();
      if (g.includes('group') || g.includes('hunt')) groupSet.add(r.Group_no); else extSet.add(r.Group_no);
    }
    return { groups: [...groupSet].sort(), extensions: [...extSet].sort() };
  } catch (e) { console.error('[insights] live Tollring group fetch failed:', (e as Error).message); return null; }
}

// JSON: known group/extension names for a customer (used by the config builder).
router.get('/insights/api/customer-groups', requireAuth, async (req: Request, res: Response) => {
  const customerId = req.query.customer_id ? parseInt(String(req.query.customer_id), 10) : 0;
  if (!customerId) { res.json({ groups: [], extensions: [] }); return; }
  let { groups, extensions } = await getGroupsAndExtensions(customerId);
  if (!groups.length && !extensions.length) {
    const live = await liveGroupsFromTollring(customerId);
    if (live) { groups = live.groups; extensions = live.extensions; }
  }
  res.json({ groups, extensions });
});

// ── Customers list + create (Insights admin) ───────────────────────────────────
router.get('/insights/customers', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  if (!insightsPool) { res.render('insights/customers', { user, customers: [], flash: null, error: 'Insights DB not connected' }); return; }
  try {
    const result = await insightsPool.query(
      `SELECT c.*,
              COUNT(DISTINCT s.id)::int AS site_count,
              COUNT(DISTINCT u.id)::int AS user_count
         FROM customers c
         LEFT JOIN sites s ON s.customer_id = c.id
         LEFT JOIN users u ON u.customer_id = c.id
        GROUP BY c.id ORDER BY c.name`
    );
    res.render('insights/customers', { user, customers: result.rows, flash: req.query.flash || null, error: req.query.error || null });
  } catch (e: any) {
    res.render('insights/customers', { user, customers: [], flash: null, error: e.message });
  }
});

router.post('/insights/customers', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/customers?error=Insights+DB+not+connected'); return; }
  const { name, slug } = req.body as Record<string, string>;
  if (!name || !slug) { res.redirect('/insights/customers?error=Name+and+slug+are+required'); return; }
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  try {
    await insightsPool.query('INSERT INTO customers (name, slug) VALUES ($1, $2)', [name.trim(), cleanSlug]);
    res.redirect('/insights/customers?flash=Customer+created');
  } catch (e: any) {
    if (e.code === '23505') { res.redirect('/insights/customers?error=Slug+already+exists'); return; }
    res.redirect('/insights/customers?error=Failed+to+create+customer');
  }
});

// ── Admin overview ──────────────────────────────────────────────────────────────
router.get('/insights/admin', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  if (!insightsPool) { res.render('insights/admin-index', { user, stats: { customers: 0, users: 0, sites: 0, reports: 0 }, recentReports: [], flash: null, error: 'Insights DB not connected' }); return; }
  try {
    const [counts, reps] = await Promise.all([
      insightsPool.query(
        `SELECT (SELECT COUNT(*) FROM customers WHERE is_active=true)::int AS customers,
                (SELECT COUNT(*) FROM users WHERE is_active=true)::int AS users,
                (SELECT COUNT(*) FROM sites WHERE is_active=true)::int AS sites,
                (SELECT COUNT(*) FROM generated_reports)::int AS reports`
      ),
      insightsPool.query(
        `SELECT gr.id, gr.status, gr.created_at, rc.config_label, rc.report_type, c.name AS customer_name
           FROM generated_reports gr
           JOIN report_configs rc ON rc.id = gr.config_id
           JOIN sites s ON s.id = rc.site_id
           JOIN customers c ON c.id = s.customer_id
          ORDER BY gr.created_at DESC LIMIT 12`
      ),
    ]);
    res.render('insights/admin-index', { user, stats: counts.rows[0], recentReports: reps.rows, flash: req.query.flash || null, error: req.query.error || null });
  } catch (e: any) {
    res.render('insights/admin-index', { user, stats: { customers: 0, users: 0, sites: 0, reports: 0 }, recentReports: [], flash: null, error: e.message });
  }
});

// ── Site call-flow logic editor (reuses the report builder in "site logic" mode) ──
router.get('/insights/site/:id/logic-edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights?err=' + encodeURIComponent('Insights DB not connected')); return; }
  const id = parseInt(String(req.params.id), 10);
  try {
    const site = (await insightsPool.query('SELECT s.*, c.name AS customer_name FROM sites s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1', [id])).rows[0];
    if (!site) { res.status(404).render('error', { message: 'Site not found.' }); return; }
    const data = await getConfigFormData(site.customer_id, id);
    const synthConfig = { id: null, site_id: id, config_label: site.site_label, report_type: 'group_call_performance', logic_config: site.logic_config || {}, recipients: [] };
    res.render('insights/report-config-form', {
      user: req.session.user!, config: synthConfig, customerId: site.customer_id, preselectSiteId: id,
      reports: [], error: req.query.error || null, notice: req.query.msg || null,
      siteLogicMode: true, siteId: id, siteLabel: site.site_label, ...data,
    });
  } catch (e: any) { res.status(500).render('error', { message: 'Insights error: ' + e.message }); }
});

router.post('/insights/site/:id/logic', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights'); return; }
  const id = parseInt(String(req.params.id), 10);
  const raw = String((req.body as any).logic_config || '').trim();
  let parsed: any = null;
  if (raw) { try { parsed = JSON.parse(raw); } catch { res.redirect('/insights/site/' + id + '/logic-edit?error=' + encodeURIComponent('Invalid logic — try again.')); return; } }
  await insightsPool.query('UPDATE sites SET logic_config = $1::jsonb WHERE id = $2', [parsed ? JSON.stringify(parsed) : null, id]).catch(() => {});
  res.redirect('/insights/site/' + id + '?msg=' + encodeURIComponent('Call-flow logic saved'));
});

router.post('/insights/site/:id/logic/clear', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights'); return; }
  const id = parseInt(String(req.params.id), 10);
  await insightsPool.query('UPDATE sites SET logic_config = NULL WHERE id = $1', [id]).catch(() => {});
  res.redirect('/insights/site/' + id + '?msg=' + encodeURIComponent('Logic cleared — rebuild it from scratch'));
});

// ── Site scheduled reports (site_reports) ──────────────────────────────────────
router.post('/insights/site/:id/schedule', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights'); return; }
  const id = parseInt(String(req.params.id), 10);
  const b = req.body as any;
  const templateId = parseInt(String(b.template_id || ''), 10);
  if (!templateId) { res.redirect('/insights/site/' + id + '?err=' + encodeURIComponent('Pick a report.')); return; }
  try {
    await insightsPool.query(
      `INSERT INTO site_reports (site_id, template_id, recipients, reporting_period, send_day, send_time, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [id, templateId, String(b.recipients || '').trim() || null, b.reporting_period || 'weekly', b.send_day || null, b.send_time || '09:00']);
    res.redirect('/insights/site/' + id + '?msg=' + encodeURIComponent('Scheduled report added'));
  } catch (e: any) { res.redirect('/insights/site/' + id + '?err=' + encodeURIComponent((e.message || 'Failed').slice(0, 100))); }
});

router.post('/insights/site-report/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights'); return; }
  const srId = parseInt(String(req.params.id), 10);
  const sr = (await insightsPool.query('SELECT site_id FROM site_reports WHERE id=$1', [srId])).rows[0];
  await insightsPool.query('DELETE FROM site_reports WHERE id=$1', [srId]).catch(() => {});
  res.redirect('/insights/site/' + (sr ? sr.site_id : '') + '?msg=' + encodeURIComponent('Schedule removed'));
});

// ── Report pool (platform-level templates) ────────────────────────────────────
// Normalise submitted module ids to the registry's canonical order (checkboxes don't keep order).
function orderModules(selected: string[]): string[] {
  const set = new Set((Array.isArray(selected) ? selected : [selected]).filter(Boolean).map(String));
  return moduleList().map((m) => m.id).filter((id) => set.has(id));
}

router.get('/insights/templates', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.render('insights/templates', { user: req.session.user!, templates: [], modules: moduleList(), msg: null, err: 'Insights DB not connected' }); return; }
  const templates = (await insightsPool.query('SELECT id, name, base_type, modules, is_system, is_active FROM report_templates ORDER BY is_system DESC, lower(name)')).rows;
  res.render('insights/templates', { user: req.session.user!, templates, modules: moduleList(), msg: req.query.msg || null, err: req.query.err || null });
});

// Custom-template CREATION retired (Terry, 2026-07-14): the locked system catalogue + the coming
// Explore screen replace it. Existing custom templates keep working (edit/delete stay) until
// they're migrated, but no new ones can be made — templates were the module-sprawl generator.
router.get('/insights/templates/new', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.redirect('/insights/templates?err=' + encodeURIComponent('New templates are retired — the locked reports plus Explore (coming) cover it. Existing custom templates still work.'));
});

router.get('/insights/templates/:id/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/templates?err=Insights+DB+not+connected'); return; }
  const id = parseInt(String(req.params.id), 10);
  const tpl = (await insightsPool.query('SELECT * FROM report_templates WHERE id=$1', [id])).rows[0];
  if (!tpl) { res.status(404).render('error', { message: 'Template not found.' }); return; }
  if (tpl.is_system) { res.redirect('/insights/templates?err=' + encodeURIComponent('System reports are locked — their modules are fixed in code.')); return; }
  res.render('insights/template-form', { user: req.session.user!, tpl, modules: moduleList(), isNew: false });
});

router.post('/insights/templates', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  // Creation retired — see the GET /insights/templates/new comment.
  res.redirect('/insights/templates?err=' + encodeURIComponent('New templates are retired — the locked reports plus Explore (coming) cover it.'));
});

router.post('/insights/templates/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/templates?err=Insights+DB+not+connected'); return; }
  const id = parseInt(String(req.params.id), 10);
  const sys = (await insightsPool.query('SELECT is_system FROM report_templates WHERE id=$1', [id])).rows[0];
  if (sys?.is_system) { res.redirect('/insights/templates?err=' + encodeURIComponent('System reports are locked — their modules are fixed in code.')); return; }
  const name = String((req.body as any).name || '').trim();
  const mods = orderModules((req.body as any).modules);
  try {
    await insightsPool.query('UPDATE report_templates SET name=COALESCE(NULLIF($1,\'\'), name), modules=$2::jsonb WHERE id=$3', [name, JSON.stringify(mods), id]);
    res.redirect('/insights/templates?msg=' + encodeURIComponent('Template saved'));
  } catch (e: any) { res.redirect('/insights/templates?err=' + encodeURIComponent((e.message || 'Save failed').slice(0, 100))); }
});

router.post('/insights/templates/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/templates?err=Insights+DB+not+connected'); return; }
  const id = parseInt(String(req.params.id), 10);
  await insightsPool.query('DELETE FROM report_templates WHERE id=$1 AND is_system=false', [id]).catch(() => {});
  res.redirect('/insights/templates?msg=' + encodeURIComponent('Template deleted'));
});

// ── Ad-hoc run: pick customer → site → template → date range, render on the fly ────
router.get('/insights/run', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.render('insights/run', { user: req.session.user!, customers: [], sites: [], templates: [], err: 'Insights DB not connected' }); return; }
  const [customers, sites, templates] = await Promise.all([
    insightsPool.query('SELECT id, name FROM customers WHERE is_active=true ORDER BY name'),
    insightsPool.query('SELECT id, site_label, customer_id FROM sites ORDER BY site_label'),
    insightsPool.query('SELECT id, name, base_type FROM report_templates WHERE is_active=true ORDER BY is_system DESC, lower(name)'),
  ]);
  res.render('insights/run', { user: req.session.user!, customers: customers.rows, sites: sites.rows, templates: templates.rows, err: req.query.err || null });
});

router.post('/insights/run', requireAuth, async (req: Request, res: Response) => {
  if (!insightsPool) { res.redirect('/insights/run?err=Insights+DB+not+connected'); return; }
  const b = req.body as any;
  const siteId = parseInt(String(b.site_id || ''), 10);
  const templateId = parseInt(String(b.template_id || ''), 10);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(b.date_from || today);
  const to = new Date(b.date_to || b.date_from || today);
  if (!siteId || !templateId) { res.redirect('/insights/run?err=' + encodeURIComponent('Pick a site and a report.')); return; }
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) { res.redirect('/insights/run?err=' + encodeURIComponent('Pick a valid date range.')); return; }
  try {
    const { html } = await generateFromTemplate(templateId, siteId, from, to);
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob: https:; img-src * data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:");
    res.send(html);
  } catch (e: any) {
    res.redirect('/insights/run?err=' + encodeURIComponent((e.message || 'Run failed').slice(0, 120)));
  }
});

export default router;
