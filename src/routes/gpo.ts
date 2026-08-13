import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { judgeGpos, gpoCorpus, estateCorpus, askGpo, preflightDeployment, lastDeployRun, explainInventoryOutcome, GpoRow } from '../lib/gpo';
import { ONLINE_WINDOW_SECS } from '../lib/agent-asset';

// -- Group Policy ---------------------------------------------------------------
// Read-only on purpose. GPMC already does the writing, and doing it from a browser is a
// way to break a customer's estate in one click. What GPMC is bad at is the two things
// here: every domain in one list, and "what does this policy actually DO" without
// reading three hundred rows of registry policy.
//
// Collection runs on the customer's nominated AD agent (Agents page -> tick "AD agent"),
// because Get-GPO only exists where the GPMC tools are installed.

const router = Router();

// Must match OUTPUT_LIMITS['gpo.inventory'] in routes/agent-api.ts - it is how the page
// tells "the domain is empty" apart from "the reply was cut off".
const GPO_OUTPUT_LIMIT = 4_000_000;

const SELECT_COLS = `id, gpo_id, name, status, description, domain, created_on, modified_on,
  link_count, linked_enabled, enforced, setting_count, applies_to, links, settings,
  report_error, collected_at`;

/** The customer's nominated AD agent, if it has one. */
async function adAgentFor(customerId: number): Promise<any | null> {
  const r = await pool.query(
    `SELECT id, hostname, last_seen_at,
            EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS seen_secs
       FROM agent_devices
      WHERE customer_id=$1 AND is_ad_agent=true AND revoked=false
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [customerId]);
  return r.rows[0] || null;
}

/** Is a collection already on its way for this customer? */
async function pendingFor(customerId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM agent_commands ac
       JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ad.customer_id=$1 AND ac.kind='gpo.inventory'
        AND ac.status IN ('queued','running') LIMIT 1`, [customerId]);
  return r.rows.length > 0;
}

// -- Where Group Policy lives ---------------------------------------------------
// There is deliberately no estate-wide policy list. A domain's Group Policy belongs to
// its domain controller, so these routes only resolve a customer to that machine and send
// you to its page. Every existing link into /gpo keeps working.

/** The asset page for a customer's nominated AD agent, if there is one. */
async function adAgentAssetId(customerId: number): Promise<number | null> {
  const r = await pool.query(
    `SELECT (SELECT ca.id FROM customer_assets ca
              WHERE ca.agent_device_id = ad.id AND ca.merged_into_id IS NULL LIMIT 1) AS asset_id
       FROM agent_devices ad
      WHERE ad.customer_id=$1 AND ad.is_ad_agent=true AND ad.revoked=false
      ORDER BY ad.last_seen_at DESC NULLS LAST LIMIT 1`, [customerId]);
  return r.rows[0]?.asset_id || null;
}

router.get('/gpo', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  try {
    if (customerId) {
      const assetId = await adAgentAssetId(customerId);
      if (assetId) { res.redirect(`/assets/${assetId}#gpo`); return; }
      const c = (await pool.query('SELECT name FROM customers WHERE id=$1', [customerId])).rows[0];
      res.redirect('/assets?servers=1&msg=' + encodeURIComponent(
        `${c?.name || 'That customer'} has no AD agent yet. Open their domain controller, then tick "AD agent" for it on the Agents page - Group Policy appears on that machine.`));
      return;
    }
    res.redirect('/assets?servers=1&msg=' + encodeURIComponent(
      'Group Policy lives on the machine that holds it. Open a customer\'s domain controller and use its Group Policy tab.'));
  } catch (e: any) {
    console.error('[gpo] resolve failed:', e.message);
    res.redirect('/assets');
  }
});

// -- Collect --------------------------------------------------------------------
router.post('/gpo/refresh', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String((req.body || {}).customer_id || ''), 10);
  if (!customerId) { res.redirect('/assets?err=' + encodeURIComponent('Pick a customer first.')); return; }
  // Only ever an internal path: a redirect target from a form is attacker-shaped input.
  const asked = String((req.body || {}).back || '');
  const back = /^\/[A-Za-z0-9\/_?=&.#-]*$/.test(asked) && !asked.startsWith('//')
    ? asked.split('#')[0] : '/gpo?customer=' + customerId;
  try {
    const agent = await adAgentFor(customerId);
    if (!agent) {
      res.redirect(back + '&err=' + encodeURIComponent(
        'No AD agent set for this customer. Install the agent on a domain controller or management server, then tick "AD agent" for it on the Agents page.'));
      return;
    }
    if (await pendingFor(customerId)) {
      res.redirect(back + '&msg=' + encodeURIComponent('A collection is already queued for this customer.'));
      return;
    }
    const cmd = (await pool.query(
      `INSERT INTO agent_commands (device_id, kind, status, requested_by)
       VALUES ($1,'gpo.inventory','queued',$2) RETURNING id`,
      [agent.id, req.session.user!.id])).rows[0];
    await logActivity(req.session.user!.id, 'gpo_collect', 'customers', customerId,
      `Queued a Group Policy collection on ${agent.hostname}`);
    res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'cmd=' + cmd.id + '#gpo');
  } catch (e: any) {
    console.error('[gpo] refresh failed:', e.message);
    res.redirect(back + '&err=' + encodeURIComponent('Could not queue that: ' + e.message));
  }
});

// -- One policy -----------------------------------------------------------------
router.get('/gpo/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/gpo'); return; }
  try {
    const g = (await pool.query(
      `SELECT g.*, c.name AS customer_name,
              EXTRACT(EPOCH FROM (NOW() - g.collected_at))::int AS age_secs
         FROM customer_gpos g LEFT JOIN customers c ON c.id = g.customer_id
        WHERE g.id=$1`, [id])).rows[0];
    if (!g) { res.redirect('/gpo?err=' + encodeURIComponent('No such policy - it may have been removed from the domain.')); return; }

    res.render('gpo/detail', {
      user: req.session.user!, g,
      findings: judgeGpos([g as GpoRow]),
      links: Array.isArray(g.links) ? g.links : [],
      appliesTo: Array.isArray(g.applies_to) ? g.applies_to : [],
      settings: Array.isArray(g.settings) ? g.settings : [],
      msg: req.query.msg || null, error: req.query.err || null,
    });
  } catch (e: any) {
    console.error('[gpo] detail failed:', e.message);
    res.redirect('/gpo?err=' + encodeURIComponent('Could not open that policy: ' + e.message));
  }
});

// -- Ask Claude -----------------------------------------------------------------
// Two scopes, one engine. `id` reads a single policy in full; a customer reads every
// policy it has, which is what "do any of these conflict" needs. The corpus is the
// cached prefix either way, so asking a second question about the same policy is cheap.
router.post('/gpo/ask.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const question = String(b.question || '').trim().slice(0, 400);
  const id = parseInt(String(b.id || ''), 10) || null;
  const customerId = parseInt(String(b.customer_id || ''), 10) || null;
  if (!question) { res.status(400).json({ ok: false, error: 'Ask a question first.' }); return; }
  if (!id && !customerId) { res.status(400).json({ ok: false, error: 'Nothing to read - pick a policy or a customer.' }); return; }

  const started = Date.now();
  try {
    let corpus: string;
    let scope: string;
    if (id) {
      const g = (await pool.query(`SELECT ${SELECT_COLS} FROM customer_gpos WHERE id=$1`, [id])).rows[0];
      if (!g) { res.status(404).json({ ok: false, error: 'No such policy.' }); return; }
      corpus = gpoCorpus(g as GpoRow);
      scope = g.name;
    } else {
      const rows = (await pool.query(
        `SELECT ${SELECT_COLS} FROM customer_gpos WHERE customer_id=$1 ORDER BY name`, [customerId])).rows;
      if (!rows.length) { res.status(400).json({ ok: false, error: 'Nothing collected for that customer yet - press Collect first.' }); return; }
      corpus = estateCorpus(rows as GpoRow[]);
      scope = `${rows.length} policies`;
    }

    const r = await askGpo(corpus, question);
    await logActivity(req.session.user!.id, 'gpo_ask', id ? 'customer_gpos' : 'customers', id || customerId,
      `Asked Claude about Group Policy (${scope}): ${question}`);
    res.json({
      ok: true, headline: r.headline, answer: r.answer, risks: r.risks,
      cache: r.cache, scope,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    });
  } catch (e: any) {
    console.error('[gpo] ask failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'Ask failed.' });
  }
});

// ── Deploying the agent by Group Policy ─────────────────────────────────────────
// The Portal's one write into a customer's domain, and kept deliberately narrow: it
// creates a single GPO of its own carrying an Immediate Task that pulls the keyed MSI
// over HTTPS. No file share, no reboot, and it lands at the next policy refresh.
//
// Nothing is written without a plan first. The plan is the same script in dry-run, so
// what the page promises is what the domain controller itself worked out, not a guess.

const DEPLOY_GPO_NAME = 'LumenMSP - Agent Deployment';

async function deployContext(customerId: number, baseUrl: string) {
  const c = (await pool.query(
    'SELECT id, name, agent_site_key FROM customers WHERE id=$1 AND deleted_at IS NULL', [customerId])).rows[0];
  if (!c) return null;

  const agent = await adAgentFor(customerId);
  const gpos = (await pool.query(
    `SELECT COUNT(*)::int AS n, MAX(collected_at) AS at FROM customer_gpos WHERE customer_id=$1`,
    [customerId])).rows[0];
  const agents = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_devices WHERE customer_id=$1 AND revoked=false`, [customerId])).rows[0];
  const pending = (await pool.query(
    `SELECT 1 FROM agent_commands ac JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ad.customer_id=$1 AND ac.kind='gpo.deploy' AND ac.status IN ('queued','running') LIMIT 1`,
    [customerId])).rows.length > 0;

  const { agentMsiInfo } = await import('./agent-api');
  const msi = agentMsiInfo();

  return {
    customer: c,
    siteKey: c.agent_site_key || null,
    msiUrl: c.agent_site_key
      ? `${baseUrl.replace(/\/+$/, '')}/agent/download/LumenMSPAgent-${c.agent_site_key}.msi` : null,
    msi,
    adAgent: agent,
    adAgentLive: agent && agent.seen_secs != null && Number(agent.seen_secs) < ONLINE_WINDOW_SECS,
    gpoCount: Number(gpos.n) || 0,
    collectedAt: gpos.at || null,
    agentCount: Number(agents.n) || 0,
    pending,
    gpoName: DEPLOY_GPO_NAME,
    lastRun: await lastDeployRun(customerId),
  };
}

router.get('/gpo/deploy/:customerId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  if (!customerId) { res.redirect('/gpo'); return; }
  try {
    const ctx = await deployContext(customerId, `${req.protocol}://${req.get('host')}`);
    if (!ctx) { res.redirect('/gpo?err=' + encodeURIComponent('No such customer.')); return; }
    res.render('gpo/deploy', {
      user: req.session.user!, ...ctx,
      onlineWindowSecs: ONLINE_WINDOW_SECS,
      msg: req.query.msg || null, error: req.query.err || null,
    });
  } catch (e: any) {
    console.error('[gpo] deploy page failed:', e.message);
    res.redirect('/gpo?err=' + encodeURIComponent('Could not open the deployment page: ' + e.message));
  }
});

/** The pre-flight. Reads the customer's collected policies for anything that would make
 *  the deployment fail silently, which is the only way this kind of deployment fails. */
router.post('/gpo/deploy/:customerId/preflight.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  const started = Date.now();
  try {
    const rows = (await pool.query(
      `SELECT ${SELECT_COLS} FROM customer_gpos WHERE customer_id=$1 ORDER BY name`, [customerId])).rows;
    if (!rows.length) {
      res.status(400).json({ ok: false, error: 'No Group Policy collected for this customer yet - collect it first, or there is nothing to check against.' });
      return;
    }
    const r = await preflightDeployment(rows as GpoRow[]);
    await logActivity(req.session.user!.id, 'gpo_preflight', 'customers', customerId,
      `Pre-flighted the agent deployment against ${rows.length} policies: ${r.verdict}`);
    res.json({ ok: true, ...r, policies: rows.length,
      seconds: Math.round((Date.now() - started) / 100) / 10 });
  } catch (e: any) {
    console.error('[gpo] preflight failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'The check failed.' });
  }
});

/** Queue the deployment. `plan` runs the identical script in dry-run and writes nothing. */
async function queueDeploy(req: Request, res: Response, dryRun: boolean): Promise<void> {
  const customerId = parseInt(String(req.params.customerId), 10);
  const back = `/gpo/deploy/${customerId}`;
  try {
    const ctx = await deployContext(customerId, `${req.protocol}://${req.get('host')}`);
    if (!ctx) { res.redirect('/gpo?err=' + encodeURIComponent('No such customer.')); return; }
    if (!ctx.adAgent) {
      res.redirect(back + '?err=' + encodeURIComponent('No AD agent for this customer. Tick "AD agent" for a domain controller on the Agents page first.'));
      return;
    }
    if (!ctx.msiUrl) {
      res.redirect(back + '?err=' + encodeURIComponent('This customer has no agent site key, so there is no installer URL to deploy.'));
      return;
    }
    if (!ctx.msi) {
      res.redirect(back + '?err=' + encodeURIComponent('No agent MSI is published on the Portal yet - upload it on the Agents page.'));
      return;
    }
    if (ctx.pending) { res.redirect(back + '?msg=' + encodeURIComponent('One is already queued - wait for it to come back.')); return; }

    // Writing to a live domain gets typed confirmation. The plan does not: it writes
    // nothing, and putting a hurdle in front of the safe option only teaches people to
    // skip straight to the dangerous one.
    if (!dryRun) {
      const typed = String((req.body || {}).confirm || '').trim();
      if (typed.toLowerCase() !== String(ctx.customer.name).trim().toLowerCase()) {
        res.redirect(back + '?err=' + encodeURIComponent(`To create the policy, type the customer name exactly: ${ctx.customer.name}`));
        return;
      }
    }

    const target = String((req.body || {}).target || '').trim().slice(0, 400);
    await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by)
       VALUES ($1,'gpo.deploy',$2,'queued',$3)`,
      [ctx.adAgent.id, JSON.stringify({
        gpoName: ctx.gpoName, msiUrl: ctx.msiUrl, target, dryRun: dryRun ? 'true' : 'false',
      }), req.session.user!.id]);

    await logActivity(req.session.user!.id, dryRun ? 'gpo_deploy_plan' : 'gpo_deploy', 'customers', customerId,
      dryRun
        ? `Planned the agent deployment for ${ctx.customer.name} (dry run on ${ctx.adAgent.hostname})`
        : `CREATED the agent deployment policy "${ctx.gpoName}" for ${ctx.customer.name} on ${ctx.adAgent.hostname}`);

    res.redirect(back + '?msg=' + encodeURIComponent(
      dryRun
        ? `Working out what this would do on ${ctx.adAgent.hostname}. Nothing has been written. Reload in a moment.`
        : `Creating the deployment policy on ${ctx.adAgent.hostname}. Reload in a moment to see what it did.`));
  } catch (e: any) {
    console.error('[gpo] deploy queue failed:', e.message);
    res.redirect(back + '?err=' + encodeURIComponent('Could not queue that: ' + e.message));
  }
}

router.post('/gpo/deploy/:customerId/plan', requireAuth, requireAdmin, (req, res) => queueDeploy(req, res, true));
router.post('/gpo/deploy/:customerId/run', requireAuth, requireAdmin, (req, res) => queueDeploy(req, res, false));

export default router;
