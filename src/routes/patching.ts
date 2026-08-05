import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';

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
