import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { syncAssetsFromAtera, lastAssetSyncAt, remoteUrlTemplate, saveRemoteUrlTemplate, buildRemoteUrl } from '../lib/asset-sync';

const router = Router();

function safeBack(raw: unknown, fallback: string): string {
  const s = String(raw || '');
  return /^\/(?!\/)/.test(s) ? s : fallback;
}

// ── Portal-wide asset list ──────────────────────────────────────────────────────
router.get('/assets', requireAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const custId = parseInt(String(req.query.customer || ''), 10) || null;
  const type = String(req.query.type || '').trim();
  const onlineOnly = req.query.online === '1';
  const noUser = req.query.nouser === '1'; // "unallocated" - no last logged-in user known

  const where: string[] = ['a.customer_id IS NOT NULL'];
  const params: any[] = [];
  if (q) { params.push('%' + q + '%'); where.push(`(a.hostname ILIKE $${params.length} OR a.serial_number ILIKE $${params.length} OR a.model ILIKE $${params.length} OR a.last_login_user ILIKE $${params.length} OR ac.full_name ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }
  if (custId) { params.push(custId); where.push(`a.customer_id = $${params.length}`); }
  if (type) { params.push(type); where.push(`a.device_type = $${params.length}`); }
  if (onlineOnly) where.push('a.online_status = true');
  if (noUser) where.push("(a.assigned_contact_id IS NULL AND (a.last_login_user IS NULL OR a.last_login_user = ''))");

  const rows = (await pool.query(
    `SELECT a.*, c.name AS customer_name, ac.full_name AS assigned_name FROM customer_assets a
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_contacts ac ON ac.id = a.assigned_contact_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.name, a.hostname`, params
  )).rows;

  const unmatchedCount = (await pool.query('SELECT COUNT(*)::int AS n FROM customer_assets WHERE customer_id IS NULL')).rows[0].n;
  const types = (await pool.query("SELECT DISTINCT device_type FROM customer_assets WHERE device_type IS NOT NULL ORDER BY device_type")).rows.map((r: any) => r.device_type);
  const customers = (await pool.query('SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY name')).rows;

  res.render('assets/list', {
    user: req.session.user!, rows, unmatchedCount, types, customers,
    filters: { q, customer: custId, type, online: onlineOnly, nouser: noUser },
    lastSynced: await lastAssetSyncAt(),
    remoteTemplate: await remoteUrlTemplate(),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── Devices Atera has that aren't matched to a portal customer yet ──────────────
router.get('/assets/unmatched', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const rows = (await pool.query("SELECT * FROM customer_assets WHERE customer_id IS NULL ORDER BY hostname")).rows;
  res.render('assets/unmatched', { user: req.session.user!, rows, notice: req.query.msg || null });
});

// ── Sync now (admin) ─────────────────────────────────────────────────────────────
router.post('/assets/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const r = await syncAssetsFromAtera(user.id);
  if (r.error) { res.redirect('/assets?err=' + encodeURIComponent(r.error)); return; }
  const msg = `Synced ${r.synced} device(s) from Atera` + (r.unmatched ? ` — ${r.unmatched} not yet matched to a customer` : '');
  res.redirect('/assets?msg=' + encodeURIComponent(msg));
});

// ── Remote-access link template (admin) ─────────────────────────────────────────
router.post('/assets/remote-settings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  await saveRemoteUrlTemplate(String(req.body.template || ''));
  await logActivity(req.session.user!.id, 'updated', 'settings', null, 'Asset remote-access link template updated');
  res.redirect('/assets?msg=' + encodeURIComponent('Remote-access link updated'));
});

// ── Assign a device to a customer contact (Portal-side allocation) ──────────────
// This is OUR column (customer_assets.assigned_contact_id), not Atera data — staying editable
// while the Atera-synced fields are locked is deliberate, and the sync never touches it.
router.post('/assets/:id/assign', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const asset = (await pool.query('SELECT id, customer_id, hostname FROM customer_assets WHERE id=$1', [id])).rows[0];
  if (!asset) { res.status(404).render('error', { message: 'Device not found.' }); return; }
  const contactId = parseInt(String(req.body.contact_id || ''), 10) || null;
  if (contactId) {
    const ok = (await pool.query('SELECT id, full_name FROM customer_contacts WHERE id=$1 AND customer_id=$2', [contactId, asset.customer_id])).rows[0];
    if (!ok) { res.redirect(`/assets/${id}?err=` + encodeURIComponent('That contact does not belong to this device\'s customer.')); return; }
    await pool.query('UPDATE customer_assets SET assigned_contact_id=$1, updated_at=NOW() WHERE id=$2', [contactId, id]);
    await logActivity(req.session.user!.id, 'updated', 'customers', asset.customer_id, `Device ${asset.hostname || id} assigned to ${ok.full_name}`);
    res.redirect(`/assets/${id}?msg=` + encodeURIComponent(`Assigned to ${ok.full_name}`));
    return;
  }
  await pool.query('UPDATE customer_assets SET assigned_contact_id=NULL, updated_at=NOW() WHERE id=$1', [id]);
  await logActivity(req.session.user!.id, 'updated', 'customers', asset.customer_id, `Device ${asset.hostname || id} set to unallocated`);
  res.redirect(`/assets/${id}?msg=` + encodeURIComponent('Set to unallocated'));
});

// ── Device detail ────────────────────────────────────────────────────────────────
router.get('/assets/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const row = (await pool.query(
    `SELECT a.*, c.name AS customer_name, ac.full_name AS assigned_name
     FROM customer_assets a LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_contacts ac ON ac.id = a.assigned_contact_id WHERE a.id=$1`, [id]
  )).rows[0];
  if (!row) { res.status(404).render('error', { message: 'Device not found.' }); return; }
  // Contacts of this device's customer, for the "Assigned user" picker (Portal-side allocation).
  const contactOptions = row.customer_id
    ? (await pool.query('SELECT id, full_name FROM customer_contacts WHERE customer_id=$1 AND archived=false ORDER BY full_name', [row.customer_id])).rows
    : [];
  const tpl = await remoteUrlTemplate();
  // Admin-only raw-payload viewer (?debug=1) — lets us see Atera's exact field names for a real
  // device without guessing, since pick() field-name candidates won't always match every Atera
  // account/API version. Temporary diagnostic aid, not a general feature.
  const showDebug = req.session.user!.role === 'admin' && req.query.debug === '1';
  res.render('assets/detail', {
    user: req.session.user!, asset: row,
    remoteUrl: row.external_id ? buildRemoteUrl(tpl, { agentId: row.external_id, deviceGuid: row.device_guid }) : null,
    back: safeBack(req.query.back, '/assets'), contactOptions,
    rawJson: showDebug ? JSON.stringify(row.raw, null, 2) : null,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

export default router;
