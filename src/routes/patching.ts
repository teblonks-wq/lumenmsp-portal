import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';

// ── Patch management ────────────────────────────────────────────────────────────
// Reporting is live; enforcement is not. Nothing in this file installs an update or
// restarts a machine — it records what is missing, and what the rules WOULD be.
//
// Policies are a LIBRARY of named templates, not rows welded to a customer. Two ship as
// defaults ("Default Windows Desktop", "Default Windows Server"); anything unusual is a
// clone of one of those. That way a change to the default reaches everyone who inherits
// it, and the customer with the odd server has a policy with a name explaining why.
//
// A device resolves its policy in this order:
//   1. the device's own override      (agent_devices.patch_policy_id)
//   2. the customer's policy for its class (customers.patch_policy_{workstation,server}_id)
//   3. the built-in default for that class (patch_policies.is_default)
// Everything defaults to DISABLED, so the fallback at the end of that chain does nothing.

const router = Router();

const CLASSES = ['workstation', 'server'];
const REBOOT_MODES = ['never', 'prompt', 'if_idle'];
const INSTALL_SCOPES = ['security', 'all'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A machine is a server if we've been told so, else if Windows says so in its name. */
const classOf = (d: any) =>
  d.patch_class || (String(d.os || '').toLowerCase().includes('server') ? 'server' : 'workstation');

// ── Dashboard ───────────────────────────────────────────────────────────────────
router.get('/patching', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  const view = String(req.query.view || 'devices');

  const where: string[] = ['ad.revoked = false'];
  const params: any[] = [];
  if (customerId) { params.push(customerId); where.push(`ad.customer_id = $${params.length}`); }

  try {
    // Ages are computed in SQL: the app server runs Europe/London while Postgres stores
    // UTC, so doing this arithmetic in Node is an hour out for most of the year.
    const devices = (await pool.query(
      `SELECT ad.id, ad.hostname, ad.os, ad.customer_id, ad.patch_excluded, ad.patch_class,
              c.name AS customer_name,
              ad.patch_scan_at, ad.patch_pending, ad.patch_critical,
              ad.reboot_required, ad.patch_last_installed,
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

    // The same data cut by update — "what is this month's problem across the estate"
    // rather than "which box is behind".
    const updates = (await pool.query(
      `SELECT dp.title, dp.kb, dp.severity, dp.source,
              count(*)::int AS devices,
              MAX(EXTRACT(DAY FROM (NOW() - dp.first_seen)))::int AS oldest_days
         FROM device_patches dp
         JOIN agent_devices ad ON ad.id = dp.device_id AND ad.revoked = false
        ${customerId ? 'WHERE ad.customer_id = $1' : ''}
        GROUP BY dp.title, dp.kb, dp.severity, dp.source
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
      // "Clean" requires that we have actually looked, not merely that we found nothing.
      compliant: scanned.filter((d: any) => !d.patch_critical && !d.reboot_required).length,
    };

    res.render('patching', { user: req.session.user!, devices, updates, customers, customerId, view, summary, error: null });
  } catch (e: any) {
    console.error('[patching] dashboard failed:', e.message);
    res.render('patching', {
      user: req.session.user!, devices: [], updates: [], customers: [], customerId, view,
      summary: { devices: 0, scanned: 0, neverScanned: 0, pending: 0, critical: 0, needReboot: 0, compliant: 0 },
      error: e.message,
    });
  }
});

// ── Policy library ──────────────────────────────────────────────────────────────
router.get('/patching/policies', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const policies = (await pool.query(
      `SELECT p.*,
              (SELECT count(*) FROM customers c
                WHERE c.patch_policy_workstation_id = p.id OR c.patch_policy_server_id = p.id)::int AS customers,
              (SELECT count(*) FROM agent_devices ad WHERE ad.patch_policy_id = p.id)::int AS devices
         FROM patch_policies p
        ORDER BY p.is_default DESC, p.device_class DESC, p.name`)).rows;

    const customers = (await pool.query(
      `SELECT c.id, c.name,
              c.patch_policy_workstation_id AS ws_id, c.patch_policy_server_id AS srv_id,
              count(ad.id)::int AS devices
         FROM customers c
         JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked = false
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.name, c.patch_policy_workstation_id, c.patch_policy_server_id
        ORDER BY c.name`)).rows;

    res.render('patching-policies', {
      user: req.session.user!, policies, customers,
      msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    console.error('[patching] policy library failed:', e.message);
    res.render('patching-policies', {
      user: req.session.user!, policies: [], customers: [], msg: null, error: e.message,
    });
  }
});

// Clone — the intended way to make a new one. Starting from a working default beats
// starting from an empty form nobody remembers how to fill in.
router.post('/patching/policies/:id/clone', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const src = (await pool.query('SELECT * FROM patch_policies WHERE id=$1', [id])).rows[0];
    if (!src) { res.redirect('/patching/policies?msg=' + encodeURIComponent('Policy not found.')); return; }

    const name = String((req.body || {}).name || '').trim().slice(0, 120) || `${src.name} (copy)`;
    const ins = await pool.query(
      `INSERT INTO patch_policies
         (name, device_class, is_default, enabled, install_scope, window_days, window_start,
          window_minutes, reboot_mode, reboot_deferrals, reboot_deadline_hours,
          notify_minutes, notify_message, created_by)
       SELECT $1, device_class, false, enabled, install_scope, window_days, window_start,
              window_minutes, reboot_mode, reboot_deferrals, reboot_deadline_hours,
              notify_minutes, notify_message, $2
         FROM patch_policies WHERE id = $3
       RETURNING id`, [name, req.session.user!.id, id]);

    await logActivity(req.session.user!.id, 'patch_policy', null, null, `Cloned patch policy "${src.name}" as "${name}"`);
    res.redirect(`/patching/policies/${ins.rows[0].id}?msg=` + encodeURIComponent('Cloned — edit and save.'));
  } catch (e: any) {
    res.redirect('/patching/policies?msg=' + encodeURIComponent('Could not clone: ' + e.message));
  }
});

router.get('/patching/policies/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Policy not found.' }); return; }
  try {
    const policy = (await pool.query('SELECT * FROM patch_policies WHERE id=$1', [id])).rows[0];
    if (!policy) { res.status(404).render('error', { message: 'Policy not found.' }); return; }

    const usedBy = (await pool.query(
      `SELECT c.id, c.name, 'customer' AS kind FROM customers c
        WHERE c.patch_policy_workstation_id=$1 OR c.patch_policy_server_id=$1
        UNION ALL
       SELECT ad.id, ad.hostname, 'device' FROM agent_devices ad WHERE ad.patch_policy_id=$1`, [id])).rows;

    res.render('patching-policy', {
      user: req.session.user!, policy, usedBy, dayNames: DAY_NAMES, msg: req.query.msg || null,
    });
  } catch (e: any) {
    res.status(500).render('error', { message: 'Could not load the policy: ' + e.message });
  }
});

router.post('/patching/policies/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};

  const clean = (v: any, allowed: string[], fallback: string) => allowed.includes(String(v)) ? String(v) : fallback;
  const int = (v: any, min: number, max: number, fallback: number) => {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  // Ticked days arrive as a string when one is ticked and an array when several are.
  const raw = b.days;
  const days = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .map((d: any) => parseInt(String(d), 10))
    .filter((d: number) => d >= 0 && d <= 6)
    .sort()
    .join(',');

  try {
    await pool.query(
      `UPDATE patch_policies SET
         name = $1, device_class = $2, enabled = $3, install_scope = $4, window_days = $5,
         window_start = $6, window_minutes = $7, reboot_mode = $8, reboot_deferrals = $9,
         reboot_deadline_hours = $10, notify_minutes = $11, notify_message = $12,
         updated_by = $13, updated_at = NOW()
       WHERE id = $14`,
      [String(b.name || '').trim().slice(0, 120) || 'Untitled policy',
       clean(b.device_class, CLASSES, 'workstation'),
       b.enabled === '1',
       clean(b.install_scope, INSTALL_SCOPES, 'security'),
       days,
       /^\d{2}:\d{2}$/.test(String(b.window_start || '')) ? String(b.window_start) : '02:00',
       int(b.window_minutes, 30, 720, 180),
       clean(b.reboot_mode, REBOOT_MODES, 'never'),
       int(b.reboot_deferrals, 0, 10, 3),
       int(b.reboot_deadline_hours, 1, 720, 72),
       int(b.notify_minutes, 0, 240, 15),
       String(b.notify_message || '').slice(0, 500) || null,
       req.session.user!.id, id]);

    await logActivity(req.session.user!.id, 'patch_policy', null, null, `Updated patch policy ${id}`);
    res.redirect(`/patching/policies/${id}?msg=` + encodeURIComponent('Saved.'));
  } catch (e: any) {
    res.redirect(`/patching/policies/${id}?msg=` + encodeURIComponent('Could not save: ' + e.message));
  }
});

// Deleting a policy must not silently orphan whatever uses it — anything pointing at it
// falls back to the default for its class, which is the safe direction (defaults are off).
router.post('/patching/policies/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const p = (await pool.query('SELECT name, is_default FROM patch_policies WHERE id=$1', [id])).rows[0];
    if (!p) { res.redirect('/patching/policies'); return; }
    if (p.is_default) {
      res.redirect('/patching/policies?msg=' + encodeURIComponent('The built-in defaults cannot be deleted.'));
      return;
    }
    await pool.query('UPDATE customers SET patch_policy_workstation_id=NULL WHERE patch_policy_workstation_id=$1', [id]);
    await pool.query('UPDATE customers SET patch_policy_server_id=NULL WHERE patch_policy_server_id=$1', [id]);
    await pool.query('UPDATE agent_devices SET patch_policy_id=NULL WHERE patch_policy_id=$1', [id]);
    await pool.query('DELETE FROM patch_policies WHERE id=$1', [id]);
    await logActivity(req.session.user!.id, 'patch_policy', null, null, `Deleted patch policy "${p.name}"`);
    res.redirect('/patching/policies?msg=' + encodeURIComponent(`Deleted "${p.name}" — anything using it fell back to the default.`));
  } catch (e: any) {
    res.redirect('/patching/policies?msg=' + encodeURIComponent('Could not delete: ' + e.message));
  }
});

// ── Assignment ──────────────────────────────────────────────────────────────────
router.post('/patching/assign', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const customerId = parseInt(String(b.customer_id), 10);
  const idOrNull = (v: any) => { const n = parseInt(String(v), 10); return Number.isFinite(n) && n > 0 ? n : null; };
  try {
    await pool.query(
      'UPDATE customers SET patch_policy_workstation_id=$1, patch_policy_server_id=$2 WHERE id=$3',
      [idOrNull(b.ws_id), idOrNull(b.srv_id), customerId]);
    await logActivity(req.session.user!.id, 'patch_policy', 'customers', customerId, 'Assigned patch policies');
    res.redirect('/patching/policies?msg=' + encodeURIComponent('Assignment saved.'));
  } catch (e: any) {
    res.redirect('/patching/policies?msg=' + encodeURIComponent('Could not assign: ' + e.message));
  }
});

// ── One machine ─────────────────────────────────────────────────────────────────
router.get('/patching/device/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Device not found.' }); return; }
  try {
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

    // Which policy actually governs this machine, and why — shown on the page so nobody
    // has to reason about the fallback chain in their head.
    const cls = classOf(device);
    const resolved = (await pool.query(
      `SELECT p.*, 'device' AS source FROM patch_policies p WHERE p.id = $1
        UNION ALL
       SELECT p.*, 'customer' FROM patch_policies p
         JOIN customers c ON (c.patch_policy_workstation_id = p.id AND $2 = 'workstation')
                          OR (c.patch_policy_server_id = p.id AND $2 = 'server')
        WHERE c.id = $3 AND $1::int IS NULL
        UNION ALL
       SELECT p.*, 'default' FROM patch_policies p
        WHERE p.is_default AND p.device_class = $2 AND $1::int IS NULL
          AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = $3 AND
                ((c.patch_policy_workstation_id IS NOT NULL AND $2='workstation')
              OR (c.patch_policy_server_id IS NOT NULL AND $2='server')))
        LIMIT 1`, [device.patch_policy_id, cls, device.customer_id])).rows[0] || null;

    const policies = (await pool.query(
      'SELECT id, name, device_class, enabled FROM patch_policies ORDER BY is_default DESC, name')).rows;

    res.render('patching-device', {
      user: req.session.user!, device, patches, deviceClass: cls, resolved, policies,
      msg: req.query.msg || null,
    });
  } catch (e: any) {
    res.status(500).render('error', { message: 'Could not load the device: ' + e.message });
  }
});

router.post('/patching/device/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};
  const pid = parseInt(String(b.patch_policy_id), 10);
  try {
    await pool.query(
      `UPDATE agent_devices SET patch_policy_id = $1, patch_excluded = $2,
              patch_class = $3 WHERE id = $4`,
      [Number.isFinite(pid) && pid > 0 ? pid : null,
       b.patch_excluded === '1',
       CLASSES.includes(String(b.patch_class)) ? String(b.patch_class) : null,
       id]);
    res.redirect(`/patching/device/${id}?msg=` + encodeURIComponent('Saved.'));
  } catch (e: any) {
    res.redirect(`/patching/device/${id}?msg=` + encodeURIComponent('Could not save: ' + e.message));
  }
});

export default router;
