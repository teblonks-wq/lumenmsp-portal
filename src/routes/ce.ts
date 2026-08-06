import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { CONTROLS } from '../lib/ce';
import { sweepStale, refreshAssessment } from '../lib/ce-ingest';
import { syncEol } from '../lib/eol-sync';
import { getSetting } from '../lib/settings';

// ── Cyber Essentials assessment ─────────────────────────────────────────────────
// An internal tool, not a certification body. It answers one question for an engineer:
// "if an assessor looked at this estate today, what would they pick on, and what do I
// have to do about it?" — so every finding comes with the action, and the report is a
// work list rather than a score card.
//
// Run it against one machine, one customer, or everything. The agent gathers evidence
// on each machine in the background; results appear as they land.

const router = Router();

const SCOPES = ['device', 'customer', 'all'];

// ── Dashboard ───────────────────────────────────────────────────────────────────
router.get('/ce', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  try {
    const customers = (await pool.query(
      `SELECT c.id, c.name, count(ad.id)::int AS devices
         FROM customers c
         JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked = false
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.name
        ORDER BY c.name`)).rows;

    // Latest completed assessment per machine — the estate as it stands, not as it was
    // during whichever run happened to be last.
    const params: any[] = [];
    let filter = '';
    if (customerId) { params.push(customerId); filter = `AND ad.customer_id = $${params.length}`; }

    const devices = (await pool.query(
      `SELECT ad.id, ad.hostname, ad.os, ad.customer_id, c.name AS customer_name,
              r.score, r.fail_count, r.warn_count, r.collected_at, r.assessment_id,
              EXTRACT(EPOCH FROM (NOW() - r.collected_at))::int AS age_secs
         FROM agent_devices ad
         LEFT JOIN customers c ON c.id = ad.customer_id
         LEFT JOIN LATERAL (
                SELECT dr.* FROM ce_device_results dr
                 WHERE dr.device_id = ad.id AND dr.status = 'complete'
                 ORDER BY dr.collected_at DESC LIMIT 1) r ON true
        WHERE ad.revoked = false ${filter}
        ORDER BY (r.score IS NULL), r.score ASC, ad.hostname`, params)).rows;

    // What is worth doing first, across everything assessed: the same failure on eight
    // machines is one job, not eight.
    const actions = (await pool.query(
      `WITH latest AS (
              SELECT DISTINCT ON (device_id) id, device_id, assessment_id
                FROM ce_device_results WHERE status='complete'
               ORDER BY device_id, collected_at DESC)
       SELECT f.title, f.control, f.action, f.status, f.remediation,
              count(*)::int AS devices,
              MIN(f.eol_date) AS eol_date
         FROM ce_findings f
         JOIN latest l ON l.device_id = f.device_id AND l.assessment_id = f.assessment_id
         JOIN agent_devices ad ON ad.id = f.device_id
        WHERE f.status IN ('fail','warn') ${customerId ? 'AND ad.customer_id = $1' : ''}
        GROUP BY f.title, f.control, f.action, f.status, f.remediation
        ORDER BY (f.status='fail') DESC, count(*) DESC
        LIMIT 25`, params)).rows;

    const runs = (await pool.query(
      `SELECT a.*, c.name AS customer_name, d.hostname
         FROM ce_assessments a
         LEFT JOIN customers c ON c.id = a.customer_id
         LEFT JOIN agent_devices d ON d.id = a.device_id
        ORDER BY a.started_at DESC LIMIT 12`)).rows;

    const assessed = devices.filter((d: any) => d.collected_at).length;
    const summary = {
      devices: devices.length,
      assessed,
      never: devices.length - assessed,
      failing: devices.filter((d: any) => Number(d.fail_count) > 0).length,
      avgScore: assessed ? Math.round(devices.filter((d: any) => d.score != null)
        .reduce((a: number, d: any) => a + Number(d.score), 0) / assessed) : null,
      eolItems: actions.filter((a: any) => a.eol_date).reduce((a: number, x: any) => a + Number(x.devices), 0),
    };

    res.render('ce', {
      user: req.session.user!, customers, devices, actions, runs, summary, customerId,
      controls: CONTROLS, msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    console.error('[ce] dashboard failed:', e.message);
    res.render('ce', {
      user: req.session.user!, customers: [], devices: [], actions: [], runs: [],
      summary: { devices: 0, assessed: 0, never: 0, failing: 0, avgScore: null, eolItems: 0 },
      customerId, controls: CONTROLS, msg: null, error: e.message,
    });
  }
});

// ── Run ─────────────────────────────────────────────────────────────────────────
// Queue the evidence-gathering command on every machine in scope. Commands sit in the
// queue for machines that are off, so a run against a whole customer completes over the
// following hours rather than failing at the first laptop in a bag.
router.post('/ce/run', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const scope = SCOPES.includes(String(req.body.scope)) ? String(req.body.scope) : 'device';
  const customerId = parseInt(String(req.body.customer_id || ''), 10) || null;
  const deviceId = parseInt(String(req.body.device_id || ''), 10) || null;

  try {
    const where: string[] = ['ad.revoked = false'];
    const params: any[] = [];
    if (scope === 'device') {
      if (!deviceId) { res.redirect('/ce?msg=' + encodeURIComponent('Pick a machine first.')); return; }
      params.push(deviceId); where.push(`ad.id = $${params.length}`);
    } else if (scope === 'customer') {
      if (!customerId) { res.redirect('/ce?msg=' + encodeURIComponent('Pick a customer first.')); return; }
      params.push(customerId); where.push(`ad.customer_id = $${params.length}`);
    }

    const targets = (await pool.query(
      `SELECT ad.id, ad.hostname FROM agent_devices ad WHERE ${where.join(' AND ')} ORDER BY ad.hostname`,
      params)).rows;

    if (!targets.length) {
      res.redirect('/ce?msg=' + encodeURIComponent('Nothing to assess — no machines are running the agent in that scope.'));
      return;
    }

    const label = scope === 'all' ? 'Whole estate'
      : scope === 'customer' ? (await pool.query('SELECT name FROM customers WHERE id=$1', [customerId])).rows[0]?.name || 'Customer'
      : targets[0].hostname;

    const a = (await pool.query(
      `INSERT INTO ce_assessments (scope, customer_id, device_id, label, status, devices_total, started_by)
       VALUES ($1,$2,$3,$4,'running',$5,$6) RETURNING id`,
      [scope, customerId, scope === 'device' ? deviceId : null, label, targets.length, req.session.user!.id])).rows[0];

    for (const t of targets) {
      const cmd = (await pool.query(
        `INSERT INTO agent_commands (device_id, kind, status, requested_by)
         VALUES ($1,'ce.assess','queued',$2) RETURNING id`, [t.id, req.session.user!.id])).rows[0];
      await pool.query(
        `INSERT INTO ce_device_results (assessment_id, device_id, command_id, status)
         VALUES ($1,$2,$3,'queued')
         ON CONFLICT (assessment_id, device_id) DO UPDATE SET command_id = EXCLUDED.command_id, status='queued'`,
        [a.id, t.id, cmd.id]);
    }

    await logActivity(req.session.user!.id, 'ce_assessment', null, null,
      `Started a Cyber Essentials assessment of ${label} (${targets.length} machine${targets.length === 1 ? '' : 's'})`);
    res.redirect(`/ce/run/${a.id}`);
  } catch (e: any) {
    console.error('[ce] run failed:', e.message);
    res.redirect('/ce?msg=' + encodeURIComponent('Could not start: ' + e.message));
  }
});

// ── One run ─────────────────────────────────────────────────────────────────────
router.get('/ce/run/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    await sweepStale(id).catch(() => {});
    const a = (await pool.query(
      `SELECT a.*, c.name AS customer_name FROM ce_assessments a
         LEFT JOIN customers c ON c.id = a.customer_id WHERE a.id=$1`, [id])).rows[0];
    if (!a) { res.redirect('/ce?msg=' + encodeURIComponent('That assessment is gone.')); return; }

    const results = (await pool.query(
      `SELECT r.*, ad.hostname, ad.os, ad.customer_id, c.name AS customer_name
         FROM ce_device_results r
         JOIN agent_devices ad ON ad.id = r.device_id
         LEFT JOIN customers c ON c.id = ad.customer_id
        WHERE r.assessment_id=$1
        ORDER BY (r.status='complete') DESC, r.score ASC NULLS LAST, ad.hostname`, [id])).rows;

    // Grouped the way the work happens: one row per problem, listing the machines.
    const findings = (await pool.query(
      `SELECT f.control, f.rule, f.title, f.status, f.action, f.remediation, f.eol_date,
              count(*)::int AS devices,
              string_agg(ad.hostname, ', ' ORDER BY ad.hostname) AS hostnames,
              (array_agg(f.detail) FILTER (WHERE f.detail IS NOT NULL))[1] AS detail,
              (array_agg(f.evidence) FILTER (WHERE f.evidence IS NOT NULL))[1] AS evidence
         FROM ce_findings f
         JOIN agent_devices ad ON ad.id = f.device_id
        WHERE f.assessment_id=$1
        GROUP BY f.control, f.rule, f.title, f.status, f.action, f.remediation, f.eol_date
        ORDER BY CASE f.status WHEN 'fail' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, count(*) DESC, f.title`,
      [id])).rows;

    res.render('ce-run', {
      user: req.session.user!, a, results, findings, controls: CONTROLS,
      print: String(req.query.print || '') === '1', error: null,
    });
  } catch (e: any) {
    console.error('[ce] run view failed:', e.message);
    res.redirect('/ce?msg=' + encodeURIComponent('Could not open that run: ' + e.message));
  }
});

// Re-queue the machines that never answered, without starting the run again.
router.post('/ce/run/:id/retry', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const stuck = (await pool.query(
      `SELECT device_id FROM ce_device_results WHERE assessment_id=$1 AND status IN ('offline','failed')`,
      [id])).rows;
    for (const s of stuck) {
      const cmd = (await pool.query(
        `INSERT INTO agent_commands (device_id, kind, status, requested_by)
         VALUES ($1,'ce.assess','queued',$2) RETURNING id`, [s.device_id, req.session.user!.id])).rows[0];
      await pool.query(
        `UPDATE ce_device_results SET command_id=$3, status='queued', error=NULL
          WHERE assessment_id=$1 AND device_id=$2`, [id, s.device_id, cmd.id]);
    }
    await refreshAssessment(id);
    res.redirect(`/ce/run/${id}`);
  } catch (e: any) {
    res.redirect(`/ce/run/${id}?msg=` + encodeURIComponent('Could not retry: ' + e.message));
  }
});

// ── One machine ─────────────────────────────────────────────────────────────────
router.get('/ce/device/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const device = (await pool.query(
      `SELECT ad.*, c.name AS customer_name FROM agent_devices ad
         LEFT JOIN customers c ON c.id = ad.customer_id WHERE ad.id=$1`, [id])).rows[0];
    if (!device) { res.redirect('/ce?msg=' + encodeURIComponent('No such machine.')); return; }

    const result = (await pool.query(
      `SELECT r.*, a.started_at, a.label FROM ce_device_results r
         JOIN ce_assessments a ON a.id = r.assessment_id
        WHERE r.device_id=$1 AND r.status='complete'
        ORDER BY r.collected_at DESC LIMIT 1`, [id])).rows[0] || null;

    const findings = result ? (await pool.query(
      `SELECT * FROM ce_findings WHERE assessment_id=$1 AND device_id=$2
        ORDER BY CASE status WHEN 'fail' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, control, title`,
      [result.assessment_id, id])).rows : [];

    const history = (await pool.query(
      `SELECT r.id, r.score, r.fail_count, r.warn_count, r.collected_at, r.assessment_id
         FROM ce_device_results r
        WHERE r.device_id=$1 AND r.status='complete'
        ORDER BY r.collected_at DESC LIMIT 10`, [id])).rows;

    res.render('ce-device', {
      user: req.session.user!, device, result, findings, history, controls: CONTROLS,
      msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    console.error('[ce] device view failed:', e.message);
    res.redirect('/ce?msg=' + encodeURIComponent('Could not open that machine: ' + e.message));
  }
});

// ── End-of-life list ────────────────────────────────────────────────────────────
// Hand-maintained on purpose. Vendors publish these dates inconsistently, move them, and
// bury them in release notes; a list we own is one we can defend to an assessor.
router.get('/ce/eol', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = (await pool.query(
      `SELECT * FROM eol_products ORDER BY active DESC, source, category, name`)).rows;
    let lastSync: any = null;
    try { lastSync = JSON.parse((await getSetting('eol', 'last_sync')) || 'null'); } catch { /* never synced */ }
    res.render('ce-eol', {
      user: req.session.user!, rows, lastSync, msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    res.render('ce-eol', { user: req.session.user!, rows: [], lastSync: null, msg: null, error: e.message });
  }
});

// Pull the dates now rather than waiting for 04:20. Runs inline because it is a dozen
// small HTTP calls and the person pressing it wants to see the result.
router.post('/ce/eol/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await syncEol();
    await logActivity(req.session.user!.id, 'ce_eol', null, null, `Synced end-of-life dates (${r.rows} rows)`);
    let m = `Pulled ${r.rows} entries from ${r.products} products.`;
    if (r.supersededManual) m += ` ${r.supersededManual} of our hand-written rows are now covered by the feed and have been switched off.`;
    if (r.failed.length) m += ` No data came back for: ${r.failed.join(', ')}.`;
    res.redirect('/ce/eol?msg=' + encodeURIComponent(m));
  } catch (e: any) {
    res.redirect('/ce/eol?msg=' + encodeURIComponent('Sync failed: ' + e.message));
  }
});

router.post('/ce/eol', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const id = parseInt(String(b.id || ''), 10) || null;
  const t = (v: any, max = 300) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
  try {
    if (String(b.action_kind) === 'delete' && id) {
      await pool.query('DELETE FROM eol_products WHERE id=$1', [id]);
      res.redirect('/ce/eol?msg=' + encodeURIComponent('Removed.'));
      return;
    }
    const vals = [
      t(b.category, 20) || 'app', t(b.vendor, 100), t(b.name, 200) || 'Unnamed',
      t(b.match_type, 20) || 'contains', t(b.match_value, 300) || '', t(b.version_max, 50),
      t(b.eol_date, 10), t(b.severity, 10) || 'fail', t(b.action, 20) || 'upgrade',
      t(b.replacement, 200), t(b.guidance, 2000), t(b.ce_control, 20) || 'patch',
      b.active === undefined ? true : b.active === '1' || b.active === 'on' || b.active === 'true',
      b.overridden === '1' || b.overridden === 'on' || b.overridden === 'true',
    ];
    if (id) {
      // Editing an automatic row implicitly freezes it — otherwise the change is quietly
      // undone at 04:20 and whoever made it is left wondering.
      await pool.query(
        `UPDATE eol_products SET category=$1, vendor=$2, name=$3, match_type=$4, match_value=$5,
                version_max=$6, eol_date=$7::date, severity=$8, action=$9, replacement=$10,
                guidance=$11, ce_control=$12, active=$13, overridden=$14, updated_at=NOW()
          WHERE id=$15`, [...vals, id]);
    } else {
      await pool.query(
        `INSERT INTO eol_products (category, vendor, name, match_type, match_value, version_max,
                eol_date, severity, action, replacement, guidance, ce_control, active, overridden, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,'manual')`, vals);
    }
    await logActivity(req.session.user!.id, 'ce_eol', null, null,
      `${id ? 'Updated' : 'Added'} end-of-life entry "${vals[2]}"`);
    res.redirect('/ce/eol?msg=' + encodeURIComponent('Saved. It applies to the next assessment run.'));
  } catch (e: any) {
    res.redirect('/ce/eol?msg=' + encodeURIComponent('Could not save: ' + e.message));
  }
});

export default router;
