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
  resolvePackage, createPackage, listPackages, mapPackage, customerSummaries,
  queueDeploy, deployCustomer, rolloutFor, setExcluded,
  infectionsFor, infectedDevices, policyExclusions, reconcile as deployReconcile,
  REQUIRED_EXCLUSIONS,
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

// The landing page is a list of CUSTOMERS, not devices.
//
// Terry, 18 Aug: "we do not need an esytateview with big list of devices". He is right —
// 236 device rows spanning every customer is a list nobody reads. What you need to know
// here is which customers are done, which are mid-rollout, and which are blocked and on
// what. The devices live one click away, on that customer's own screen.
// Only ENROLLED customers. Terry, 18 Aug: "It almost needs to be that you only see the
// customers that are enrolled, and then there's add customer... I don't wanna see a list
// of customers that are not enabled, not mapped."
//
// He is right, and the old page proved it: Choose Leads sat in the list with a Deploy
// button that could never work, because Choose Leads has no Bitdefender. A screen that
// offers an action it will refuse is worse than a screen that does not mention it. So
// the list is the customers who ARE on Bitdefender, and everything else is behind
// "Add customer" — which is the mapping, which is the enablement.
router.get('/security', requireAuth, async (req: Request, res: Response) => {
  const all = await customerSummaries();
  const enrolled = all.filter((r) => r.enabled);

  const show = String(req.query.show || '');
  const rows = show === 'blocked' ? enrolled.filter((r) => r.blocker)
    : show === 'todo' ? enrolled.filter((r) => r.notDeployed > 0)
    : enrolled;

  // Totals count the ENROLLED estate only. They used to count everybody, which meant
  // "machines protected" quietly included customers who were not on the product.
  const t = (f: (r: typeof enrolled[number]) => number) => enrolled.reduce((n, r) => n + f(r), 0);

  res.render('security/index', {
    user: req.session.user!,
    configured: await gzConfigured(),
    lastSync: await getSetting('gravityzone', 'last_sync'),
    rows, enrolledCount: enrolled.length, show,
    add: await addModel(),
    totals: {
      enabled: enrolled.length,
      protectedCount: t((r) => r.protectedCount),
      installing: t((r) => r.installing),
      notDeployed: t((r) => r.notDeployed),
      failed: t((r) => r.failed),
      infected: t((r) => r.infected),
      blocked: enrolled.filter((r) => r.blocker).length,
    },
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

/**
 * What "Add customer" needs: the GravityZone companies, and our customers.
 *
 * Terry, 18 Aug: "that looks up the customers in Bet Defender. You select it, maps it to
 * ours, and then adds it to the list."
 *
 * Companies already claimed are still returned, marked with who has them. They used to be
 * filtered out entirely, and that is why "Lumen MSP is not even selectable from the list"
 * — it was already mapped, so it vanished, which reads as missing rather than as done.
 * The partner root is marked too: it is a real company, it is us, and packages cannot be
 * read from it, so saying that up front is cheaper than the error afterwards.
 */
async function addModel() {
  const companies = (await pool.query(
    `SELECT sc.gz_id, sc.name, sc.customer_id, c.name AS customer_name,
            COALESCE((sc.raw ->> '__ownCompany')::boolean, false) AS own_company
       FROM security_companies sc
       LEFT JOIN customers c ON c.id = sc.customer_id
      ORDER BY sc.name`)).rows.map((r: any) => ({
    gzId: String(r.gz_id), name: String(r.name),
    customerId: r.customer_id ? Number(r.customer_id) : null,
    customerName: r.customer_name || null,
    ownCompany: !!r.own_company,
  }));

  const customers = (await pool.query(
    `SELECT id, name FROM customers WHERE NOT is_placeholder AND status <> 'inactive' ORDER BY name`)).rows
    .map((r: any) => ({ id: Number(r.id), name: String(r.name) }));

  return { companies, customers, free: companies.filter((c) => !c.customerId).length };
}

// ── Which machine is infected ───────────────────────────────────────────────────
// Terry, 18 Aug: "it does say one is infected. Love to know which one that is because
// that's not clickable." Now it is, and it lands here.
router.get('/security/infections', requireAuth, async (req: Request, res: Response) => {
  const rows = await infectedDevices();
  res.render('security/infections', {
    user: req.session.user!,
    rows,
    real: rows.filter((r) => !r.ownTool).length,
    ours: rows.filter((r) => r.ownTool).length,
    requiredExclusions: REQUIRED_EXCLUSIONS,
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

/**
 * Map from the CUSTOMER's side: pick which company is theirs.
 *
 * The older route is keyed by company; this one is keyed by customer, because that is the
 * direction the mapping table works in. It also clears any company previously mapped to
 * this customer - one customer, one company. Without that, changing a mapping would leave
 * the old company still pointing at them and their endpoints split across two.
 */
router.post('/security/companies/map', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  const gzId = String(req.body.gz_id || '').trim();
  const back = String(req.body.back || '/security/mapping');
  if (!customerId) { res.redirect(back + '?err=' + encodeURIComponent('No customer given.')); return; }

  await pool.query(`UPDATE security_companies SET customer_id=NULL WHERE customer_id=$1`, [customerId]);
  if (gzId) {
    // Refuse to hand one company to two customers. Endpoints are attributed by company,
    // so a shared mapping would show one customer another customer's machines.
    const taken = (await pool.query(
      `SELECT customer_id FROM security_companies WHERE gz_id=$1`, [gzId])).rows[0];
    if (taken?.customer_id && Number(taken.customer_id) !== customerId) {
      res.redirect(back + '?err=' + encodeURIComponent('That company is already mapped to another customer.'));
      return;
    }
    await mapCompany(gzId, customerId);
  }
  // The package belonged to the OLD company; it cannot survive a company change.
  await pool.query(`DELETE FROM security_packages WHERE customer_id=$1 AND ($2 = '' OR gz_company_id <> $2)`,
    [customerId, gzId]);

  await logActivity(req.session.user!.id, 'gz_map', 'customers', customerId,
    gzId ? `Mapped to GravityZone company ${gzId}` : 'GravityZone company mapping cleared');
  res.redirect(back + '?msg=' + encodeURIComponent(gzId ? 'Company mapped.' : 'Company mapping cleared.'));
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


// ── Customers & packages: the ONE mapping surface ───────────────────────────────
// Terry, 18 Aug: "in admins intergrations we map packages and customers". So this is
// reached from Integrations and holds the whole of the configuration: which GravityZone
// company each customer is, which installation package they deploy, and whether Endpoint
// Security is on for them. Nothing else about this integration needs configuring.
router.get('/security/mapping', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const summaries = await customerSummaries();

  // Companies are read once; packages are read per COMPANY (not per customer) so two
  // customers in the same company cost one call, and a company that cannot be read does
  // not take the page down with it.
  const companies = (await pool.query(
    `SELECT sc.gz_id, sc.name, sc.customer_id FROM security_companies sc ORDER BY sc.name`)).rows;

  const pkgByCompany = new Map<string, string[]>();
  // A company whose packages cannot be read is a fact about THAT ROW, not about the page.
  // A red banner at the top says something is wrong without saying where, and this table
  // is long enough that "where" is most of the answer.
  const pkgError = new Map<string, string>();
  for (const c of companies) {
    if (!c.customer_id) continue;
    if (pkgByCompany.has(String(c.gz_id))) continue;
    try {
      const list = await listPackages(Number(c.customer_id));
      pkgByCompany.set(String(c.gz_id), list.map((p) => p.name));
    } catch (e: any) {
      pkgByCompany.set(String(c.gz_id), []);
      pkgError.set(String(c.gz_id), String(e.message || e));
    }
  }

  // MAPPED customers only. Terry, 18 Aug: "I only wanna see companies in the list,
  // customers and packages, now, that have a package. And then there needs to be an
  // add company."
  //
  // The old page listed every customer with machines too, which put 85 rows of "not
  // mapped, no package" in front of the handful that are actually configured — the same
  // big list he had removed from the estate view, wearing a different hat. What belongs
  // here is what IS configured, so a wrong mapping stands out. Adding is a deliberate act
  // with its own control, not a side effect of scrolling far enough.
  const rows = summaries.filter((r) => r.gzCompanyId);

  res.render('security/mapping', {
    user: req.session.user!,
    configured: await gzConfigured(),
    rows,
    unmappedCount: summaries.length - rows.length,
    companies,
    add: await addModel(),
    packagesByCompany: Object.fromEntries(pkgByCompany),
    packageErrors: Object.fromEntries(pkgError),
    notice: req.query.msg || null, error: req.query.err || null,
  });
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
    requiredExclusions: REQUIRED_EXCLUSIONS,
    counts: rows.reduce((m: Record<string, number>, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; }, {}),
    notice: req.query.msg || null, error: req.query.err || null,
  });
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
  const back = String(req.body.back || ('/security/customer/' + customerId));
  try {
    if (!name) {
      await pool.query(`DELETE FROM security_packages WHERE customer_id=$1`, [customerId]);
      res.redirect(back + '?msg=' + encodeURIComponent('Package mapping cleared.'));
      return;
    }
    if (name === '__create__') {
      const p = await createPackage(customerId, req.session.user!.id);
      res.redirect(back + '?msg=' + encodeURIComponent(
        `Created and mapped "${p.packageName}".` + (p.readyWindows ? '' : ' Bitdefender is still building it.')));
      return;
    }
    const p = await mapPackage(customerId, name, req.session.user!.id);
    res.redirect(back + '?msg=' + encodeURIComponent(
      `Deploying from "${p.packageName}".` + (p.readyWindows ? ' Installer ready.' : ' Bitdefender is still building it.')));
  } catch (e: any) {
    res.redirect(back + '?err=' + encodeURIComponent(e.message));
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
