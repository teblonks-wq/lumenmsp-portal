import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';

// ── Patch management (reporting) ────────────────────────────────────────────────
// What every machine is missing, and how long it has been missing it. Read-only for
// now: installation, maintenance windows and reboot policy are a separate change, and
// bundling them here would mean shipping a thing that can restart a customer's server
// before anyone has looked at the numbers it produces.
//
// "Age" is deliberately measured from first_seen rather than the update's release date:
// what we can defend is how long WE have known about it.

const router = Router();

router.get('/patching', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  const view = String(req.query.view || 'devices');

  const where: string[] = ['ad.revoked = false'];
  const params: any[] = [];
  if (customerId) { params.push(customerId); where.push(`ad.customer_id = $${params.length}`); }

  try {
    // Ages are computed in SQL. The app server runs Europe/London and Postgres stores
    // UTC — doing this arithmetic in Node is an hour out for eight months of the year.
    const devices = (await pool.query(
      `SELECT ad.id, ad.hostname, ad.os, ad.customer_id, c.name AS customer_name,
              ad.patch_scan_at, ad.patch_pending, ad.patch_critical,
              ad.reboot_required, ad.patch_last_installed,
              EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int  AS last_seen_secs,
              EXTRACT(EPOCH FROM (NOW() - ad.patch_scan_at))::int AS scan_age_secs,
              (SELECT MAX(EXTRACT(DAY FROM (NOW() - dp.first_seen)))::int
                 FROM device_patches dp
                WHERE dp.device_id = ad.id
                  AND LOWER(COALESCE(dp.severity,'')) IN ('critical','important')) AS oldest_critical_days
         FROM agent_devices ad
         LEFT JOIN customers c ON c.id = ad.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY ad.patch_critical DESC NULLS LAST, ad.patch_pending DESC NULLS LAST, ad.hostname`,
      params)).rows;

    // The same data cut by update instead of by machine — answers "what is this month's
    // problem across the estate" rather than "which box is behind".
    const updates = (await pool.query(
      `SELECT dp.title, dp.kb, dp.severity,
              count(*)::int AS devices,
              MAX(EXTRACT(DAY FROM (NOW() - dp.first_seen)))::int AS oldest_days
         FROM device_patches dp
         JOIN agent_devices ad ON ad.id = dp.device_id AND ad.revoked = false
        ${customerId ? 'WHERE ad.customer_id = $1' : ''}
        GROUP BY dp.title, dp.kb, dp.severity
        ORDER BY (LOWER(COALESCE(dp.severity,'')) IN ('critical','important')) DESC, count(*) DESC
        LIMIT 200`, customerId ? [customerId] : [])).rows;

    const customers = (await pool.query(
      `SELECT DISTINCT c.id, c.name FROM agent_devices ad
         JOIN customers c ON c.id = ad.customer_id
        WHERE ad.revoked = false ORDER BY c.name`)).rows;

    const scanned = devices.filter((d: any) => d.patch_scan_at);
    const summary = {
      devices: devices.length,
      scanned: scanned.length,
      neverScanned: devices.length - scanned.length,
      pending: devices.reduce((n: number, d: any) => n + (d.patch_pending || 0), 0),
      critical: devices.reduce((n: number, d: any) => n + (d.patch_critical || 0), 0),
      needReboot: devices.filter((d: any) => d.reboot_required).length,
      // A machine is only "compliant" if we have actually looked recently AND it is clean.
      compliant: scanned.filter((d: any) => !d.patch_critical && !d.reboot_required).length,
    };

    res.render('patching', {
      user: req.session.user!, devices, updates, customers, customerId, view, summary, error: null,
    });
  } catch (e: any) {
    console.error('[patching] page failed:', e.message);
    res.render('patching', {
      user: req.session.user!, devices: [], updates: [], customers: [],
      customerId, view, summary: { devices: 0, scanned: 0, neverScanned: 0, pending: 0, critical: 0, needReboot: 0, compliant: 0 },
      error: e.message,
    });
  }
});

// ── Policies ────────────────────────────────────────────────────────────────────
// Two policies per customer — workstations and servers — because they want opposite
// answers. A workstation can restart at 2am unattended; a domain controller cannot.
//
// EVERYTHING DEFAULTS TO DISABLED. Nothing here installs anything yet either: this is
// the definition layer, so policies can be set up and read back before the estate has
// any capability to act on them. Enforcement is a separate change, deliberately.

const CLASSES = ['workstation', 'server'];
const REBOOT_MODES = ['never', 'prompt', 'if_idle'];
const INSTALL_SCOPES = ['security', 'all'];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A customer's policies, creating the two defaults (off) the first time we look. */
async function policiesFor(customerId: number): Promise<any[]> {
  for (const cls of CLASSES) {
    await pool.query(
      `INSERT INTO patch_policies (customer_id, device_class) VALUES ($1,$2)
       ON CONFLICT (customer_id, device_class) DO NOTHING`, [customerId, cls]);
  }
  return (await pool.query(
    `SELECT * FROM patch_policies WHERE customer_id=$1 ORDER BY device_class DESC`, [customerId])).rows;
}

router.get('/patching/policies', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const rows = (await pool.query(
    `SELECT c.id, c.name,
            count(ad.id)::int AS devices,
            COALESCE(bool_or(pw.enabled), false) AS workstations_on,
            COALESCE(bool_or(ps.enabled), false) AS servers_on
       FROM customers c
       JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked = false
       LEFT JOIN patch_policies pw ON pw.customer_id = c.id AND pw.device_class = 'workstation'
       LEFT JOIN patch_policies ps ON ps.customer_id = c.id AND ps.device_class = 'server'
      WHERE c.deleted_at IS NULL
      GROUP BY c.id, c.name
      ORDER BY c.name`)).rows;

  res.render('patching-policies', { user: req.session.user!, rows, msg: req.query.msg || null });
});

router.get('/patching/policies/:customerId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  const cust = (await pool.query('SELECT id, name FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!cust) { res.status(404).render('error', { message: 'Customer not found.' }); return; }

  const policies = await policiesFor(customerId);
  const devices = (await pool.query(
    `SELECT id, hostname, os, patch_class, patch_excluded FROM agent_devices
      WHERE customer_id=$1 AND revoked=false ORDER BY hostname`, [customerId])).rows;

  res.render('patching-policy', {
    user: req.session.user!, customer: cust, policies, devices,
    dayNames: DAY_NAMES, msg: req.query.msg || null,
  });
});

router.post('/patching/policies/:customerId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.customerId), 10);
  const b = req.body || {};

  const clean = (v: any, allowed: string[], fallback: string) =>
    allowed.includes(String(v)) ? String(v) : fallback;
  const int = (v: any, min: number, max: number, fallback: number) => {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  try {
    for (const cls of CLASSES) {
      // Days arrive as either a single value or an array depending on how many are
      // ticked — normalise before it reaches the database.
      const raw = b[`${cls}_days`];
      const days = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
        .map((d: any) => parseInt(String(d), 10))
        .filter((d: number) => d >= 0 && d <= 6)
        .sort()
        .join(',');

      await pool.query(
        `UPDATE patch_policies SET
           enabled = $1, install_scope = $2, window_days = $3, window_start = $4,
           window_minutes = $5, reboot_mode = $6, reboot_deferrals = $7,
           reboot_deadline_hours = $8, notify_minutes = $9, notify_message = $10,
           updated_by = $11, updated_at = NOW()
         WHERE customer_id = $12 AND device_class = $13`,
        [b[`${cls}_enabled`] === '1',
         clean(b[`${cls}_scope`], INSTALL_SCOPES, 'security'),
         days,
         /^\d{2}:\d{2}$/.test(String(b[`${cls}_start`] || '')) ? String(b[`${cls}_start`]) : '02:00',
         int(b[`${cls}_minutes`], 30, 720, 180),
         clean(b[`${cls}_reboot`], REBOOT_MODES, 'never'),
         int(b[`${cls}_deferrals`], 0, 10, 3),
         int(b[`${cls}_deadline`], 1, 720, 72),
         int(b[`${cls}_notify`], 0, 240, 15),
         String(b[`${cls}_message`] || '').slice(0, 500) || null,
         req.session.user!.id, customerId, cls]);
    }

    // Per-device exceptions: the awkward machine every customer has.
    const excluded = new Set(
      (Array.isArray(b.excluded) ? b.excluded : b.excluded === undefined ? [] : [b.excluded])
        .map((v: any) => parseInt(String(v), 10)));
    const all = (await pool.query(
      'SELECT id FROM agent_devices WHERE customer_id=$1 AND revoked=false', [customerId])).rows;
    for (const d of all) {
      await pool.query('UPDATE agent_devices SET patch_excluded=$1 WHERE id=$2',
        [excluded.has(d.id), d.id]);
    }

    await logActivity(req.session.user!.id, 'patch_policy', 'customers', customerId,
      `Updated patching policy for customer ${customerId}`);
    res.redirect(`/patching/policies/${customerId}?msg=` + encodeURIComponent('Policy saved.'));
  } catch (e: any) {
    console.error('[patching] policy save failed:', e.message);
    res.redirect(`/patching/policies/${customerId}?msg=` + encodeURIComponent('Could not save: ' + e.message));
  }
});

// One machine's outstanding list.
router.get('/patching/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Device not found.' }); return; }

  const device = (await pool.query(
    `SELECT ad.*, c.name AS customer_name,
            EXTRACT(EPOCH FROM (NOW() - ad.patch_scan_at))::int AS scan_age_secs
       FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ad.id = $1 LIMIT 1`, [id])).rows[0];
  if (!device) { res.status(404).render('error', { message: 'Device not found.' }); return; }

  const patches = (await pool.query(
    `SELECT *, EXTRACT(DAY FROM (NOW() - first_seen))::int AS age_days
       FROM device_patches WHERE device_id = $1
      ORDER BY (LOWER(COALESCE(severity,'')) IN ('critical','important')) DESC, first_seen`, [id])).rows;

  res.render('patching-device', { user: req.session.user!, device, patches });
});

export default router;
