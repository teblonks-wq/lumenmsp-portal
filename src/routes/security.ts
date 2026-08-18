import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { getSetting } from '../lib/settings';
import { logActivity } from '../lib/activity';
import {
  gzConfigured, gzConfig, saveGzConfig, testConnection, syncGravityZone, mapCompany,
  buildAssessment, inScopeCustomers, setCustomerScope, categoriseAv, licenceAudit, customerEnabled,
} from '../lib/gravityzone';
import {
  resolvePackage, createPackage, listPackages, mapPackage,
  queueDeploy, deployCustomer, rolloutFor, setExcluded,
  infectionsFor, policyExclusions, reconcile as deployReconcile,
} from '../lib/gravityzone-deploy';

const router = Router();

// ── Endpoint Security ───────────────────────────────────────────────────────────
// Lumen's managed antivirus, run from the Portal. AV ships free with the Managed IT
// package, so scope follows the CONTRACT (customers.is_itsm) — enable a customer once
// and every machine of theirs is picked up from then on.
//
// The estate view's whole trick is putting two sources side by side: what OUR agent
// says is protecting each machine today, and what GravityZone says about it. That
// join is what turns "we should roll out AV" into a worklist.

const STATES = ['protected', 'infected', 'outdated', 'todo', 'unknown'] as const;

router.get('/security', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  const state = STATES.includes(String(req.query.state) as any) ? String(req.query.state) : null;

  const rows = (await pool.query(
    `SELECT a.id AS asset_id, a.hostname, a.device_type, a.customer_id, c.name AS customer_name, c.is_itsm,
            d.security_json, d.id AS agent_device_id,
            EXTRACT(EPOCH FROM d.last_seen_at)::bigint AS agent_seen,
            se.gz_id, se.is_managed, se.infected, se.outdated, se.policy_name, se.modules_on,
            EXTRACT(EPOCH FROM se.last_seen_at)::bigint AS gz_seen
       FROM customer_assets a
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN agent_devices d ON d.id = a.agent_device_id AND NOT COALESCE(d.revoked, false)
       LEFT JOIN security_endpoints se ON se.asset_id = a.id
      WHERE a.merged_into_id IS NULL
        AND ($1::int IS NULL OR a.customer_id = $1)
      ORDER BY c.name NULLS LAST, a.hostname`,
    [customerId])).rows;

  const scope = await inScopeCustomers();
  const scopeById = new Map(scope.map((x) => [x.id, x]));

  const list = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);
  const devices = rows.map((r: any) => {
    let j: any = null;
    try { j = r.security_json ? JSON.parse(r.security_json) : null; } catch { j = null; }
    const products = j
      ? Array.from(new Set([...list(j.av), ...list(j.antispyware)].map((p: any) => String(p?.name || '').trim()).filter(Boolean)))
      : [];
    const cat = j ? categoriseAv(products as string[]).category : 'unknown';
    const st = r.gz_id
      ? (r.infected ? 'infected' : r.outdated ? 'outdated' : 'protected')
      : (j ? 'todo' : 'unknown');
    return {
      assetId: Number(r.asset_id), hostname: r.hostname || '?', deviceType: r.device_type,
      customerId: r.customer_id ? Number(r.customer_id) : null, customerName: r.customer_name,
      inScope: r.customer_id ? !!scopeById.get(Number(r.customer_id))?.inScope : false,
      currentAv: (products as string[]).join(', ') || null,
      migrationCategory: cat,
      gzId: r.gz_id || null, policyName: r.policy_name, modulesOn: r.modules_on,
      infected: !!r.infected, outdated: !!r.outdated,
      agentSeen: r.agent_seen ? Number(r.agent_seen) : null,
      gzSeen: r.gz_seen ? Number(r.gz_seen) : null,
      state: st,
    };
  });

  const shown = state ? devices.filter((d) => d.state === state) : devices;

  // Endpoints GravityZone knows about that we could not match to a device of ours.
  // A real gap worth showing: either the hostname differs or the machine is not in
  // our asset register at all.
  const unmatched = (await pool.query(
    `SELECT se.gz_id, se.name, se.os_name, se.policy_name, sc.name AS company_name,
            EXTRACT(EPOCH FROM se.last_seen_at)::bigint AS gz_seen
       FROM security_endpoints se
       LEFT JOIN security_companies sc ON sc.gz_id = se.gz_company_id
      WHERE se.asset_id IS NULL ORDER BY sc.name NULLS LAST, se.name LIMIT 200`)).rows;

  const seats = (await pool.query(
    `SELECT sc.name, sc.license_total, sc.license_used, c.name AS customer_name,
            (SELECT COUNT(*) FROM security_endpoints se WHERE se.gz_company_id = sc.gz_id) AS endpoints
       FROM security_companies sc LEFT JOIN customers c ON c.id = sc.customer_id
      ORDER BY sc.name`)).rows;

  res.render('security/estate', {
    user,
    configured: await gzConfigured(),
    lastSync: await getSetting('gravityzone', 'last_sync'),
    devices: shown, allCount: devices.length,
    stats: {
      protected: devices.filter((d) => d.state === 'protected').length,
      infected: devices.filter((d) => d.state === 'infected').length,
      outdated: devices.filter((d) => d.state === 'outdated').length,
      todo: devices.filter((d) => d.state === 'todo' && d.inScope).length,
      unknown: devices.filter((d) => d.state === 'unknown').length,
    },
    unmatched, seats, scope,
    customers: (await pool.query(
      `SELECT id, name FROM customers WHERE NOT is_placeholder AND status <> 'inactive' ORDER BY name`)).rows,
    customerId, state,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/security/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const back = String(req.body.back || '/security');
  try {
    const r = await syncGravityZone(req.session.user!.id);
    const bits = [`${r.endpoints} endpoint(s)`, `${r.companies} company/companies`, `${r.matchedDevices} matched to our devices`];
    if (r.ticketsRaised) bits.push(`${r.ticketsRaised} detection case(s) raised`);
    res.redirect(back + '?msg=' + encodeURIComponent('Synced: ' + bits.join(', ') + '.' +
      (r.warnings.length ? ' Warnings: ' + r.warnings.slice(0, 3).join(' | ') : '')));
  } catch (e: any) {
    res.redirect(back + '?err=' + encodeURIComponent(e.message));
  }
});

// ── Settings: the API key, the company mapping, and who is in scope ─────────────
// Both the GET and the Test-connection POST render this page, so the model is built once.
// It was duplicated before, and duplicated models are how the two copies drift until one
// of them quietly stops showing something the other does.
async function settingsModel(req: Request, extra: Record<string, any> = {}) {
  const cfg = await gzConfig();
  let syncWarnings: string[] = [];
  try { syncWarnings = JSON.parse((await getSetting('gravityzone', 'last_sync_warnings')) || '[]'); }
  catch { syncWarnings = []; }
  return {
    user: req.session.user!,
    configured: !!cfg,
    baseUrl: cfg?.base || 'https://cloudgz.gravityzone.bitdefender.com/api',
    // Never render the key back — only whether one is set and its last four, which is
    // enough to tell two keys apart without putting a credential on a screen.
    keyTail: cfg ? cfg.key.slice(-4) : null,
    lastSync: await getSetting('gravityzone', 'last_sync'),
    probes: null,
    companies: (await pool.query(
      `SELECT sc.*, c.name AS customer_name,
              (SELECT COUNT(*) FROM security_endpoints se WHERE se.gz_company_id = sc.gz_id) AS endpoints
         FROM security_companies sc LEFT JOIN customers c ON c.id = sc.customer_id ORDER BY sc.name`)).rows,
    customers: (await pool.query(
      `SELECT id, name FROM customers WHERE NOT is_placeholder AND status <> 'inactive' ORDER BY name`)).rows,
    scope: await inScopeCustomers(),
    // What each company is ACTUALLY licensed as, and what it costs. Read back rather than
    // assumed: the product chosen in Giacom decides the tier, and we do not.
    licences: await licenceAudit(),
    syncWarnings,
    notice: null, error: null,
    ...extra,
  };
}

router.get('/security/settings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  res.render('security/settings', await settingsModel(req, {
    notice: req.query.msg || null, error: req.query.err || null,
  }));
});

router.post('/security/settings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const key = String(req.body.api_key || '').trim();
  const base = String(req.body.base_url || '').trim();
  // An empty key field means "leave it alone", not "delete it" — otherwise saving the
  // access URL would quietly disconnect the whole module.
  await saveGzConfig(key ? key : null, base || null);
  await logActivity(req.session.user!.id, 'gz_settings', 'settings', null,
    'GravityZone settings updated' + (key ? ' (new API key stored)' : ''));
  res.redirect('/security/settings?msg=' + encodeURIComponent(key ? 'Saved. Run Test connection to see what the key can reach.' : 'Saved.'));
});

router.post('/security/test', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  let probes: any = null; let error: string | null = null;
  try { probes = (await testConnection()).probes; }
  catch (e: any) { error = e.message; }
  res.render('security/settings', await settingsModel(req, { probes, error }));
});

router.post('/security/companies/:gzId/map', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const gzId = String(req.params.gzId);
  const customerId = parseInt(String(req.body.customer_id || ''), 10) || null;
  await mapCompany(gzId, customerId);
  await logActivity(req.session.user!.id, 'gz_map', 'security_companies', null,
    `GravityZone company ${gzId} mapped to customer ${customerId ?? '(cleared)'}`);
  res.redirect('/security/settings?msg=' + encodeURIComponent('Company mapping saved — its endpoints moved with it.'));
});

router.post('/security/scope/:customerId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  const v = String(req.body.in_scope || '');
  await setCustomerScope(customerId, v === 'on' ? true : v === 'off' ? false : null);
  const back = String(req.body.back || '/security/settings');
  res.redirect(back + '?msg=' + encodeURIComponent('Scope updated.'));
});

// ── The assessment ──────────────────────────────────────────────────────────────
router.get('/security/assessment/:customerId', requireAuth, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  const cust = (await pool.query(`SELECT id, name, is_itsm FROM customers WHERE id=$1`, [customerId])).rows[0];
  if (!cust) { res.redirect('/security?err=' + encodeURIComponent('No such customer.')); return; }

  let a = (await pool.query(
    `SELECT sa.*, u.display_name AS created_name, ua.display_name AS approved_name
       FROM security_assessments sa
       LEFT JOIN users u ON u.id = sa.created_by
       LEFT JOIN users ua ON ua.id = sa.approved_by
      WHERE sa.customer_id=$1 AND sa.status <> 'superseded'
      ORDER BY sa.id DESC LIMIT 1`, [customerId])).rows[0] || null;

  const items = a ? (await pool.query(
    `SELECT * FROM security_assessment_items WHERE assessment_id=$1 ORDER BY category, hostname`, [a.id])).rows : [];

  const history = (await pool.query(
    `SELECT sa.id, sa.status, sa.created_at, sa.approved_at, u.display_name AS approved_name,
            (SELECT COUNT(*) FROM security_assessment_items i WHERE i.assessment_id = sa.id) AS n
       FROM security_assessments sa LEFT JOIN users u ON u.id = sa.approved_by
      WHERE sa.customer_id=$1 ORDER BY sa.id DESC LIMIT 10`, [customerId])).rows;

  res.render('security/assessment', {
    user: req.session.user!, customer: cust, assessment: a, items, history,
    scope: (await inScopeCustomers()).find((x) => x.id === customerId) || null,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/security/assessment/:customerId/build', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  try {
    await buildAssessment(customerId, req.session.user!.id);
    res.redirect(`/security/assessment/${customerId}?msg=` + encodeURIComponent('Assessment built from the agent data we already hold.'));
  } catch (e: any) {
    res.redirect(`/security/assessment/${customerId}?err=` + encodeURIComponent(e.message));
  }
});

/**
 * Lumen signs off. "We are the ITSM — we do" (Terry): the customer never approves.
 * Unticked machines are held back, and the approval records who said yes and when —
 * it is the authority for anything the deploy pipeline later uninstalls.
 */
router.post('/security/assessment/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const a = (await pool.query(`SELECT * FROM security_assessments WHERE id=$1`, [id])).rows[0];
  if (!a) { res.redirect('/security?err=' + encodeURIComponent('That assessment is gone.')); return; }

  const raw = req.body.include;
  const keep = new Set((Array.isArray(raw) ? raw : raw != null ? [raw] : []).map((v: any) => String(v)));
  await pool.query(`UPDATE security_assessment_items SET included = (id::text = ANY($1)) WHERE assessment_id=$2`,
    [Array.from(keep), id]);
  await pool.query(
    `UPDATE security_assessments SET status='approved', approved_by=$1, approved_at=NOW(), notes=$2 WHERE id=$3`,
    [user.id, String(req.body.notes || '').trim() || null, id]);

  const n = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM security_assessment_items WHERE assessment_id=$1 AND included`, [id])).rows[0].n;
  await logActivity(user.id, 'security_assessment_approved', 'security_assessments', id,
    `Endpoint Security rollout approved for customer ${a.customer_id}: ${n} machine(s) cleared to deploy`);
  res.redirect(`/security/assessment/${a.customer_id}?msg=` +
    encodeURIComponent(`Approved — ${n} machine(s) cleared for Bitdefender. New machines for this customer are picked up automatically from now on.`));
});

// ── One customer, one screen ────────────────────────────────────────────────────
// Terry, 18 Aug: "we simple need to enable the customer for Endpoint Security - then
// deploy to all devices - we need a screen where we can see the progress of install IE
// device offline, installing, installed version number etc - definitions updated, a tab
// for infections and exclusions and on the device the same."
//
// So: enable, deploy, watch. Everything else was scaffolding.
router.get('/security/customer/:id', requireAuth, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const cust = (await pool.query(`SELECT id, name, is_itsm FROM customers WHERE id=$1`, [customerId])).rows[0];
  if (!cust) { res.redirect('/security?err=' + encodeURIComponent('No such customer.')); return; }

  const tab = ['devices', 'infections', 'exclusions'].includes(String(req.query.tab)) ? String(req.query.tab) : 'devices';
  const rows = await rolloutFor(customerId);

  // Only fetch what the open tab needs. Exclusions cost one API call per policy, and
  // paying that on every page view of the devices tab would make the common case slow.
  let infections: any[] = [];
  let exclusions: any = { policies: [], warnings: [] };
  if (tab === 'infections') infections = await infectionsFor(customerId);
  if (tab === 'exclusions') { try { exclusions = await policyExclusions(); } catch (e: any) { exclusions = { policies: [], warnings: [e.message] }; } }

  const company = (await pool.query(
    `SELECT gz_id, name FROM security_companies WHERE customer_id=$1 ORDER BY gz_id LIMIT 1`, [customerId])).rows[0] || null;
  const pkg = (await pool.query(`SELECT * FROM security_packages WHERE customer_id=$1`, [customerId])).rows[0] || null;
  // Offered so the choice is Terry's. One API call, and only when a company is mapped —
  // there is nothing to list otherwise.
  let packages: any[] = [];
  if (company) { try { packages = await listPackages(customerId); } catch { packages = []; } }

  res.render('security/customer', {
    user: req.session.user!, customer: cust, tab, rows, infections, exclusions, company, pkg, packages,
    counts: rows.reduce((m: Record<string, number>, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; }, {}),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

/** Enable (or disable) Endpoint Security for a customer. */
router.post('/security/customer/:id/enable', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const on = String(req.body.on) === '1';
  await setCustomerScope(customerId, on ? true : false);
  await logActivity(req.session.user!.id, 'security_scope', 'customers', customerId,
    `Endpoint Security ${on ? 'enabled' : 'disabled'} for customer ${customerId}`);

  // Enabling is the moment to build the package, so "Deploy to all" is never the click
  // that discovers the package does not exist yet.
  // Enabling no longer CREATES a package — Terry builds those in GravityZone. It tries to
  // resolve one, and if it cannot, says so plainly rather than inventing one.
  let extra = '';
  if (on) {
    try { const p = await resolvePackage(customerId, req.session.user!.id);
          extra = p.readyWindows
            ? ` Using the "${p.packageName}" package.`
            : ` Using "${p.packageName}" — Bitdefender is still building the installer, give it a minute.`; }
    catch (e: any) { extra = ' ' + e.message; }
  }
  res.redirect(`/security/customer/${customerId}?msg=` +
    encodeURIComponent(`Endpoint Security ${on ? 'enabled' : 'disabled'}.${extra}`));
});

/** Deploy to every eligible machine. */
router.post('/security/customer/:id/deploy', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  try {
    // Gate BEFORE building anything. deployCustomer refuses too, but checking here means a
    // disabled customer never gets a package created in GravityZone as a side effect of a
    // click that was always going to be turned down.
    const gate = await customerEnabled(customerId);
    if (!gate.ok) {
      res.redirect(`/security/customer/${customerId}?err=` + encodeURIComponent(
        `Enable Endpoint Security for this customer first (${gate.reason}).`));
      return;
    }
    await resolvePackage(customerId, req.session.user!.id);   // and refresh the links first
    const r = await deployCustomer(customerId, req.session.user!.id);
    const skipped = r.skipped.length ? ` ${r.skipped.length} skipped: ` +
      r.skipped.slice(0, 4).map((s) => `${s.hostname} (${s.why})`).join(', ') : '';
    res.redirect(`/security/customer/${customerId}?msg=` +
      encodeURIComponent(`Queued ${r.queued} install(s).${skipped}`));
  } catch (e: any) {
    res.redirect(`/security/customer/${customerId}?err=` + encodeURIComponent(e.message));
  }
});

/** Which GravityZone package this customer deploys from. */
router.post('/security/customer/:id/package', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const name = String(req.body.package_name || '').trim();
  try {
    if (name === '__create__') {
      const p = await createPackage(customerId, req.session.user!.id);
      res.redirect(`/security/customer/${customerId}?msg=` + encodeURIComponent(
        `Created and mapped "${p.packageName}".` + (p.readyWindows ? '' : ' Bitdefender is still building it.')));
      return;
    }
    const p = await mapPackage(customerId, name, req.session.user!.id);
    res.redirect(`/security/customer/${customerId}?msg=` + encodeURIComponent(
      `Deploying from "${p.packageName}".` + (p.readyWindows ? ' Installer ready.' : ' Bitdefender is still building it.')));
  } catch (e: any) {
    res.redirect(`/security/customer/${customerId}?err=` + encodeURIComponent(e.message));
  }
});

/** Deploy to one machine. */
router.post('/security/device/:deviceId/deploy', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const deviceId = parseInt(String(req.params.deviceId), 10);
  const back = String(req.body.back || '/security');
  const dev = (await pool.query(`SELECT customer_id FROM agent_devices WHERE id=$1`, [deviceId])).rows[0];
  try {
    if (dev?.customer_id) {
      const gate = await customerEnabled(Number(dev.customer_id));
      if (!gate.ok) {
        res.redirect(back + '?err=' + encodeURIComponent(
          `Enable Endpoint Security for this customer first (${gate.reason}).`));
        return;
      }
      await resolvePackage(Number(dev.customer_id), req.session.user!.id);
    }
    const r = await queueDeploy(deviceId, req.session.user!.id);
    res.redirect(back + (r.ok ? '?msg=' + encodeURIComponent('Bitdefender install queued.')
                              : '?err=' + encodeURIComponent(r.error || 'Could not queue it.')));
  } catch (e: any) {
    res.redirect(back + '?err=' + encodeURIComponent(e.message));
  }
});

/** Hold one machine back, or release it. */
router.post('/security/device/:deviceId/exclude', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const deviceId = parseInt(String(req.params.deviceId), 10);
  const on = String(req.body.on) === '1';
  await setExcluded(deviceId, on, req.session.user!.id);
  res.redirect(String(req.body.back || '/security') + '?msg=' +
    encodeURIComponent(on ? 'Held back from the rollout.' : 'Back in the rollout.'));
});

/** Re-check what actually happened on the machines we are watching. */
router.post('/security/reconcile', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const back = String(req.body.back || '/security');
  const r = await deployReconcile();
  res.redirect(back + '?msg=' + encodeURIComponent(
    `Checked ${r.checked}: ${r.protectedCount} protected, ${r.installed} installed, ${r.failed} failed, ${r.stillWaiting} still waiting.`));
});

export default router;
