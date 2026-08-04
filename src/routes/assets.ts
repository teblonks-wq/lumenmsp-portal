import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { getSetting, setSetting } from '../lib/settings';
import { syncAssetsFromAtera, lastAssetSyncAt, remoteUrlTemplate, saveRemoteUrlTemplate, buildRemoteUrl } from '../lib/asset-sync';
import { getBackupForComputer, getBackupHistoryForComputer, backupStateByComputer, classifyPlanStatus, planStatusLabel, planTypeLabel, fmtBytes } from '../lib/msp360';

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

  // Backup badge per device — one grouped query over the MSP360 snapshot.
  const backupState = await backupStateByComputer();

  res.render('assets/list', {
    user: req.session.user!, rows, unmatchedCount, types, customers, backupState,
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
  // Backup panel: MSP360 plans matched to this device by machine name, plus the Portal's
  // own accrued daily history (the asset page is heading towards system-of-record status).
  const backupPlansRaw = await getBackupForComputer(row.hostname || '');
  const backupPlans = backupPlansRaw.map((pl) => ({
    provider: pl.provider === 'msp360' ? 'MSP360' : pl.provider,
    company: pl.company, planName: pl.planName,
    typeLabel: planTypeLabel(pl.planType),
    statusLabel: planStatusLabel(pl.status),
    cls: classifyPlanStatus(pl.status),
    lastStart: pl.lastStart, nextStart: pl.nextStart,
    dataCopiedH: pl.dataCopied != null ? fmtBytes(pl.dataCopied) : null,
    totalDataH: pl.totalData != null ? fmtBytes(pl.totalData) : null,
    errorMessage: pl.errorMessage || '',
  }));
  const backupHistory = (await getBackupHistoryForComputer(row.hostname || '', 14)).map((h) => ({
    ...h, statusLabel: planStatusLabel(h.status), cls: classifyPlanStatus(h.status),
    dataCopiedH: h.dataCopied != null ? fmtBytes(h.dataCopied) : null,
  }));
  res.render('assets/detail', {
    user: req.session.user!, asset: row, backupPlans, backupHistory,
    remoteUrl: row.external_id ? buildRemoteUrl(tpl, { agentId: row.external_id, deviceGuid: row.device_guid }) : null,
    back: safeBack(req.query.back, '/assets'), contactOptions,
    rawJson: showDebug ? JSON.stringify(row.raw, null, 2) : null,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── LumenMSP Agent — enrolled devices + site keys ───────────────────────────────
// The Windows agent (tray + service) enrolls with a per-customer SITE KEY and then
// heartbeats here. This page lists every enrolled device and (admin) manages the
// site keys, per-customer RMM installer URLs and the global defaults.
router.get('/agents', requireAuth, async (req: Request, res: Response) => {
  const rows = (await pool.query(
    `SELECT d.*, c.name AS customer_name FROM agent_devices d
     LEFT JOIN customers c ON c.id = d.customer_id
     ORDER BY c.name, d.hostname`)).rows;
  const isAdmin = req.session.user!.role === 'admin';
  let customers: any[] = [];
  let defaults: { url: string; args: string } = { url: '', args: '' };
  if (isAdmin) {
    customers = (await pool.query(
      `SELECT c.id, c.name, c.agent_site_key, c.rmm_installer_url,
              (SELECT COUNT(*)::int FROM agent_devices d WHERE d.customer_id=c.id) AS device_count
       FROM customers c WHERE c.deleted_at IS NULL AND c.status='active' ORDER BY c.name`)).rows;
    defaults = {
      url: (await getSetting('agent', 'rmm_installer_url')) || '',
      args: (await getSetting('agent', 'rmm_install_args')) || '',
    };
  }
  res.render('assets/agents', {
    user: req.session.user!, rows, customers, defaults, isAdmin,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Generate (or rotate) a customer's agent site key. Rotating does NOT break already-
// enrolled devices (they hold device tokens) — it only changes what NEW installs need.
router.post('/agents/sitekey/:customerId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.customerId), 10);
  const key = 'LMA-' + crypto.randomBytes(18).toString('hex');
  await pool.query('UPDATE customers SET agent_site_key=$1 WHERE id=$2', [key, cid]);
  await logActivity(req.session.user!.id, 'agent_sitekey', 'customers', cid, 'Agent site key generated/rotated');
  res.redirect('/agents?msg=' + encodeURIComponent('Site key generated. New installs for this customer must use the new key.'));
});
router.post('/agents/sitekey/:customerId/clear', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.customerId), 10);
  await pool.query('UPDATE customers SET agent_site_key=NULL WHERE id=$1', [cid]);
  await logActivity(req.session.user!.id, 'agent_sitekey', 'customers', cid, 'Agent site key cleared (enrollment disabled)');
  res.redirect('/agents?msg=' + encodeURIComponent('Site key cleared — new enrollments for this customer are disabled.'));
});

// Per-customer RMM installer URL override (blank = use the global default).
router.post('/agents/rmm-url/:customerId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.customerId), 10);
  const url = String(req.body.url || '').trim().slice(0, 500);
  if (url && !/^https:\/\//i.test(url)) { res.redirect('/agents?err=' + encodeURIComponent('RMM installer URL must be https://')); return; }
  await pool.query('UPDATE customers SET rmm_installer_url=$1 WHERE id=$2', [url || null, cid]);
  res.redirect('/agents?msg=' + encodeURIComponent('RMM installer URL saved.'));
});

// Global defaults: RMM installer URL + msiexec args handed to devices with no override.
router.post('/agents/settings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const url = String(req.body.url || '').trim().slice(0, 500);
  const args = String(req.body.args || '').trim().slice(0, 200);
  if (url && !/^https:\/\//i.test(url)) { res.redirect('/agents?err=' + encodeURIComponent('RMM installer URL must be https://')); return; }
  await setSetting('agent', 'rmm_installer_url', url || null);
  await setSetting('agent', 'rmm_install_args', args || null);
  res.redirect('/agents?msg=' + encodeURIComponent('Agent defaults saved.'));
});

// Revoke a device: its token dies instantly; a reinstall (with the site key) re-enrolls it.
router.post('/agents/:id/revoke', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE agent_devices SET revoked=true, updated_at=NOW() WHERE id=$1', [id]);
  await logActivity(req.session.user!.id, 'agent_revoked', 'agent_devices', id, 'Agent device revoked');
  res.redirect('/agents?msg=' + encodeURIComponent('Device revoked — its agent can no longer talk to the portal.'));
});

export default router;
