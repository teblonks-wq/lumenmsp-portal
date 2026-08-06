import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { getSetting, setSetting } from '../lib/settings';
import { AGENT_MSI_DIR, AGENT_MSI_PATH, AGENT_VERSION_PATH, agentMsiInfo, agentHostedVersion, agentHostedSha256, rolloutState, wakeAgent } from './agent-api';
import { syncAssetsFromAtera, lastAssetSyncAt, remoteUrlTemplate, saveRemoteUrlTemplate, buildRemoteUrl } from '../lib/asset-sync';
import { getBackupForComputer, getBackupHistoryForComputer, backupStateByComputer, classifyPlanStatus, planStatusLabel, planTypeLabel, fmtBytes } from '../lib/msp360';
import { meshStatus } from './mesh';

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
  // Hero tile "servers". Substring match so it agrees with the tile's own count, which also
  // matches on the substring rather than one exact device_type value.
  const serversOnly = req.query.servers === '1';
  // Tri-state agent filter: '1' = has the LumenMSP Agent, '0' = without it (the machines
  // to target for a rollout), '' = either. Kept as a string so "without" is expressible.
  const agentFilter = String(req.query.agent || '').trim();

  const where: string[] = ['a.customer_id IS NOT NULL'];
  const params: any[] = [];
  if (q) { params.push('%' + q + '%'); where.push(`(a.hostname ILIKE $${params.length} OR a.serial_number ILIKE $${params.length} OR a.model ILIKE $${params.length} OR a.last_login_user ILIKE $${params.length} OR ac.full_name ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }
  if (custId) { params.push(custId); where.push(`a.customer_id = $${params.length}`); }
  if (type) { params.push(type); where.push(`a.device_type = $${params.length}`); }
  if (onlineOnly) where.push('a.online_status = true');
  if (noUser) where.push("(a.assigned_contact_id IS NULL AND (a.last_login_user IS NULL OR a.last_login_user = ''))");
  if (serversOnly) where.push("a.device_type ILIKE '%server%'");
  // agd is the LATERAL agent match below, so it can be filtered on here.
  if (agentFilter === '1') where.push('agd.id IS NOT NULL');
  else if (agentFilter === '0') where.push('agd.id IS NULL');

  const rows = (await pool.query(
    `SELECT a.*, c.name AS customer_name, ac.full_name AS assigned_name,
            agd.id AS agent_device_id, agd.last_seen_at AS agent_last_seen, agd.agent_version AS agent_agent_version,
            agd.seen_secs AS agent_seen_secs
     FROM customer_assets a
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_contacts ac ON ac.id = a.assigned_contact_id
     LEFT JOIN LATERAL (
       SELECT ag.id, ag.last_seen_at, ag.agent_version,
              EXTRACT(EPOCH FROM (NOW() - ag.last_seen_at)) AS seen_secs FROM agent_devices ag
       WHERE ag.revoked = false AND ag.customer_id = a.customer_id
         AND ((a.serial_number IS NOT NULL AND ag.serial_number = a.serial_number)
           OR (a.hostname IS NOT NULL AND LOWER(ag.hostname) = LOWER(a.hostname)))
       ORDER BY ag.last_seen_at DESC NULLS LAST LIMIT 1
     ) agd ON true
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
    filters: { q, customer: custId, type, online: onlineOnly, nouser: noUser, agent: agentFilter, servers: serversOnly },
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
  // LumenMSP Agent on this device? Matched by serial (preferred) or hostname.
  let agentInfo: any = null;
  try {
    agentInfo = (await pool.query(
      `SELECT id, last_seen_at, agent_version, logged_in_user, local_ips, public_ip, disk_info,
              EXTRACT(EPOCH FROM (NOW() - last_seen_at)) AS seen_secs FROM agent_devices
       WHERE revoked = false AND customer_id = $1
         AND (($2::text IS NOT NULL AND serial_number = $2)
           OR ($3::text IS NOT NULL AND LOWER(hostname) = LOWER($3)))
       ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
      [row.customer_id, row.serial_number || null, row.hostname || null]
    )).rows[0] || null;
  } catch { /* cosmetic — never block the device page */ }
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
    user: req.session.user!, asset: row, agentInfo,
    latestAgentVersion: agentHostedVersion() || (await getSetting('agent', 'latest_version')) || '',
    backupPlans, backupHistory,
    remoteUrl: row.external_id ? buildRemoteUrl(tpl, { agentId: row.external_id, deviceGuid: row.device_guid }) : null,
    back: safeBack(req.query.back, '/assets'), contactOptions,
    rawJson: showDebug ? JSON.stringify(row.raw, null, 2) : null,
    // Whether remote control is ready on this machine, and if not, which of the several
    // possible reasons it is — so the page can offer the install rather than a dead end.
    meshState: await meshStatus(row.id).catch(() => null),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── LumenMSP Agent — enrolled devices + site keys ───────────────────────────────
// The Windows agent (tray + service) enrolls with a per-customer SITE KEY and then
// heartbeats here. This page lists every enrolled device and (admin) manages the
// site keys, per-customer RMM installer URLs and the global defaults.
router.get('/agents', requireAuth, async (req: Request, res: Response) => {
  const rows = (await pool.query(
    `SELECT d.*, c.name AS customer_name,
            EXTRACT(EPOCH FROM (NOW() - d.last_seen_at)) AS seen_secs,
            a.id AS asset_id
     FROM agent_devices d
     LEFT JOIN customers c ON c.id = d.customer_id
     LEFT JOIN LATERAL (
       SELECT ca.id FROM customer_assets ca
       WHERE ca.customer_id = d.customer_id
         AND ((d.serial_number IS NOT NULL AND ca.serial_number = d.serial_number)
           OR (d.hostname IS NOT NULL AND LOWER(ca.hostname) = LOWER(d.hostname)))
       ORDER BY ca.id LIMIT 1
     ) a ON true
     ORDER BY c.name, d.hostname`)).rows;
  const isAdmin = req.session.user!.role === 'admin';
  // Every active customer gets a site key automatically — the download picker just works,
  // with no key admin to do first. Idempotent: only fills the blanks. md5(random()) is
  // per-row (volatile), so each customer gets its own key.
  try {
    await pool.query(
      `UPDATE customers SET agent_site_key = 'LMA-' || md5(random()::text || id::text || clock_timestamp()::text)
       WHERE agent_site_key IS NULL AND deleted_at IS NULL AND status = 'active'`);
  } catch { /* never block the page on backfill */ }
  const customers = (await pool.query(
    `SELECT c.id, c.name, c.agent_site_key, c.rmm_installer_url,
            (SELECT COUNT(*)::int FROM agent_devices d WHERE d.customer_id=c.id) AS device_count
     FROM customers c WHERE c.deleted_at IS NULL AND c.status='active' ORDER BY c.name`)).rows;
  const defaults = {
    url: isAdmin ? ((await getSetting('agent', 'rmm_installer_url')) || '') : '',
    args: isAdmin ? ((await getSetting('agent', 'rmm_install_args')) || '') : '',
    template: isAdmin ? ((await getSetting('agent', 'rmm_installer_template')) || '') : '',
  };
  const rollout = await rolloutState();
  const ringCounts = (await pool.query(
    `SELECT COALESCE(update_ring,2) AS ring, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE agent_version IS DISTINCT FROM $1)::int AS behind
       FROM agent_devices WHERE revoked=false GROUP BY 1`, [rollout.version])).rows;
  res.render('assets/agents', {
    user: req.session.user!, rows, customers, defaults, isAdmin,
    rollout, ringCounts, hostedSha: agentHostedSha256(),
    packages: isAdmin ? (await pool.query(
      'SELECT id, name, version, file_name, url, size_bytes, install_args FROM agent_packages ORDER BY name')).rows : [],
    msi: agentMsiInfo(), latestVersion: agentHostedVersion() || (await getSetting('agent', 'latest_version')) || '',
    baseUrl: req.protocol + '://' + req.get('host'),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Upload/replace the master agent MSI (admin). One file on disk; every customer
// download link serves it under a keyed filename (LumenMSPAgent-<sitekey>.msi).
const msiUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(AGENT_MSI_DIR, { recursive: true }); cb(null, AGENT_MSI_DIR); },
    filename: (_req, _file, cb) => cb(null, 'LumenMSPAgent.msi.uploading'),
  }),
  limits: { fileSize: 400 * 1024 * 1024, files: 1 },
});
router.post('/agents/installer', requireAuth, requireAdmin, msiUpload.single('msi'), async (req: Request, res: Response) => {
  const f = (req as any).file;
  if (!f) { res.redirect('/agents?err=' + encodeURIComponent('No file received.')); return; }
  try {
    // Sanity: MSIs are OLE compound files (magic D0 CF 11 E0).
    const fd = fs.openSync(f.path, 'r');
    const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.toString('hex') !== 'd0cf11e0') {
      fs.unlinkSync(f.path);
      res.redirect('/agents?err=' + encodeURIComponent('That does not look like an MSI file.')); return;
    }
    fs.renameSync(f.path, AGENT_MSI_PATH);
    // Version drives self-update: agents on an older build pull this one automatically.
    // Taken from the typed field, else sniffed out of the uploaded filename.
    const typed = String((req.body && req.body.version) || '').trim();
    const sniffed = (f.originalname || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    const version = typed || (sniffed ? sniffed[1] : '');
    // Write version.txt too, so a hand-upload and a build.ps1 publish leave the server in
    // exactly the same state (the file is what everything reads).
    if (version) {
      await setSetting('agent', 'latest_version', version);
      try { fs.writeFileSync(AGENT_VERSION_PATH, version); } catch { /* setting still covers us */ }
    }
    await logActivity(req.session.user!.id, 'agent_msi_uploaded', 'settings', null,
      `Agent MSI updated (${Math.round(f.size / 1048576)} MB)${version ? ', version ' + version : ', NO VERSION SET - auto-update stays off'}`);
    res.redirect('/agents?msg=' + encodeURIComponent(version
      ? `Agent installer updated to ${version} - existing agents will update themselves within 6 hours.`
      : 'Agent installer updated, but no version was set, so agents will NOT auto-update. Set the version to enable it.'));
  } catch (e: any) {
    res.redirect('/agents?err=' + encodeURIComponent('Upload failed: ' + (e.message || 'unknown error')));
  }
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
  const template = String(req.body.template || '').trim().slice(0, 500);
  if (url && !/^https:\/\//i.test(url)) { res.redirect('/agents?err=' + encodeURIComponent('RMM installer URL must be https://')); return; }
  if (template && !/^https:\/\//i.test(template)) { res.redirect('/agents?err=' + encodeURIComponent('RMM installer template must be https://')); return; }
  if (template && !template.includes('{cid}')) {
    res.redirect('/agents?err=' + encodeURIComponent('The template must contain {cid} - that is what gets swapped for each customer\'s Atera id. Without it, every machine would enrol into one Atera account.'));
    return;
  }
  await setSetting('agent', 'rmm_installer_url', url || null);
  await setSetting('agent', 'rmm_install_args', args || null);
  await setSetting('agent', 'rmm_installer_template', template || null);
  // How many customers the template can actually serve, so a half-done Atera match is visible.
  let covered = 0, total = 0;
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE atera_customer_id IS NOT NULL AND atera_customer_id <> '')::int AS covered
      FROM customers WHERE deleted_at IS NULL AND status='active'`);
    covered = r.rows[0].covered; total = r.rows[0].total;
  } catch { /* cosmetic */ }
  res.redirect('/agents?msg=' + encodeURIComponent(template
    ? `Agent defaults saved. The template covers ${covered} of ${total} active customers (the rest have no Atera customer id - set a per-customer URL for those).`
    : 'Agent defaults saved.'));
});

// "Update now" — queue a pushed update for one device, or for every device that is
// behind. The version and checksum travel in the command, so a push bypasses the ring
// gate: clicking the button is a deliberate act, unlike the unattended 6-hourly check.
async function queueUpdate(deviceId: number, version: string, sha: string, userId: number): Promise<void> {
  await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, requested_by) VALUES ($1,'agent.update',$2,$3)`,
    [deviceId, JSON.stringify({ version, sha256: sha }), userId]);
  wakeAgent(deviceId);
}

router.post('/agents/:id/update-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const version = agentHostedVersion();
  const sha = agentHostedSha256();
  if (!version || !sha) { res.redirect('/agents?err=' + encodeURIComponent('No published build with a checksum - run build.ps1 first.')); return; }
  const d = (await pool.query('SELECT hostname, agent_version FROM agent_devices WHERE id=$1 AND revoked=false', [id])).rows[0];
  if (!d) { res.redirect('/agents?err=' + encodeURIComponent('Device not found.')); return; }
  await queueUpdate(id, version, sha, req.session.user!.id);
  await logActivity(req.session.user!.id, 'agent_update_push', 'agent_devices', id, `Pushed ${version} to ${d.hostname}`);
  res.redirect('/agents?msg=' + encodeURIComponent(
    `Update to ${version} sent to ${d.hostname}. It downloads, verifies the checksum and restarts - give it a minute, then refresh.`));
});

router.post('/agents/update-all', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const version = agentHostedVersion();
  const sha = agentHostedSha256();
  if (!version || !sha) { res.redirect('/agents?err=' + encodeURIComponent('No published build with a checksum - run build.ps1 first.')); return; }
  // Only devices that can actually act on it: enrolled, not revoked, behind, and new
  // enough to have a command worker (pre-1.0.2 builds cannot self-update at all).
  const rows = (await pool.query(
    `SELECT id, hostname, agent_version FROM agent_devices
      WHERE revoked=false AND agent_version IS DISTINCT FROM $1
        AND string_to_array(regexp_replace(COALESCE(agent_version,'0.0.0'), '[^0-9.]', '', 'g'), '.')::int[] >= ARRAY[1,0,2]`,
    [version])).rows;
  for (const r of rows) await queueUpdate(r.id, version, sha, req.session.user!.id);
  await logActivity(req.session.user!.id, 'agent_update_push', null, null, `Pushed ${version} to ${rows.length} device(s)`);
  res.redirect('/agents?msg=' + encodeURIComponent(rows.length
    ? `Update to ${version} sent to ${rows.length} device(s). Offline machines pick it up when they reconnect.`
    : 'Every device that can self-update is already on this build.'));
});

// Move a device to a different customer — the fix for an agent installed from the
// wrong customer's download link. Its OPEN agent cases move with it (a case raised from
// this machine belongs to whoever owns the machine), and the requester is cleared because
// contacts are customer-scoped: leaving it would put another company's contact on the case.
router.post('/agents/:id/customer', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const customerId = parseInt(String(req.body.customer_id), 10);
  if (!customerId) { res.redirect('/agents?err=' + encodeURIComponent('Pick a customer.')); return; }
  const client = await pool.connect();
  try {
    const d = (await client.query('SELECT hostname, customer_id FROM agent_devices WHERE id=$1', [id])).rows[0];
    if (!d) { res.redirect('/agents?err=' + encodeURIComponent('Device not found.')); return; }
    const c = (await client.query('SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL', [customerId])).rows[0];
    if (!c) { res.redirect('/agents?err=' + encodeURIComponent('Unknown customer.')); return; }
    if (d.customer_id === customerId) { res.redirect('/agents?msg=' + encodeURIComponent('Already assigned to that customer.')); return; }

    await client.query('BEGIN');
    // is_ad_agent is per-customer, so it can't survive the move.
    await client.query('UPDATE agent_devices SET customer_id=$1, is_ad_agent=false, updated_at=NOW() WHERE id=$2', [customerId, id]);
    const moved = await client.query(
      `UPDATE inbox_tickets SET customer_id=$1, contact_id=NULL, updated_at=NOW()
        WHERE agent_device_id=$2 AND deleted_at IS NULL AND status NOT IN ('resolved','closed')
        RETURNING id`, [customerId, id]);
    await client.query('COMMIT');

    await logActivity(req.session.user!.id, 'agent_reassigned', 'agent_devices', id,
      `${d.hostname} moved to ${c.name}${moved.rows.length ? ` (${moved.rows.length} open case(s) moved too)` : ''}`);
    res.redirect('/agents?msg=' + encodeURIComponent(
      `${d.hostname} moved to ${c.name}.` +
      (moved.rows.length ? ` ${moved.rows.length} open case(s) moved with it — re-link the requester on each.` : '') +
      ' Already-closed cases stay with the previous customer.'));
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    console.error('[agents] reassign failed:', e.message);
    res.redirect('/agents?err=' + encodeURIComponent('Could not move that device.'));
  } finally {
    client.release();
  }
});

// Advance (or halt) the rollout of the hosted build. Publishing puts a build at stage 0
// (internal only); this is how it reaches pilot customers and then everyone.
router.post('/agents/rollout', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const to = parseInt(String(req.body.stage), 10);
  if (![-1, 0, 1, 2].includes(to)) { res.redirect('/agents?err=' + encodeURIComponent('Unknown rollout stage.')); return; }
  const { version } = await rolloutState();
  if (!version) { res.redirect('/agents?err=' + encodeURIComponent('No build is published yet.')); return; }
  await setSetting('agent', 'rollout_version', version);
  await setSetting('agent', 'rollout_stage', String(to));
  const label = to === -1 ? 'HALTED' : to === 0 ? 'internal only' : to === 1 ? 'internal + pilot' : 'everyone';
  await logActivity(req.session.user!.id, 'agent_rollout', 'settings', null, `Agent ${version} rollout: ${label}`);
  res.redirect('/agents?msg=' + encodeURIComponent(
    to === -1
      ? `Rollout halted — no device will take ${version} until you resume.`
      : `${version} is now rolling out to ${label}. Agents pick it up within 6 hours.`));
});

// Which ring a device updates in: 0 internal, 1 pilot, 2 everyone.
router.post('/agents/:id/ring', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const ring = parseInt(String(req.body.ring), 10);
  if (![0, 1, 2].includes(ring)) { res.redirect('/agents?err=' + encodeURIComponent('Unknown ring.')); return; }
  await pool.query('UPDATE agent_devices SET update_ring=$1, updated_at=NOW() WHERE id=$2', [ring, id]);
  res.redirect('/agents?msg=' + encodeURIComponent('Update ring saved.'));
});

// Revoke a device: its token dies instantly; a reinstall (with the site key) re-enrolls it.
router.post('/agents/:id/revoke', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE agent_devices SET revoked=true, updated_at=NOW() WHERE id=$1', [id]);
  await logActivity(req.session.user!.id, 'agent_revoked', 'agent_devices', id, 'Agent device revoked');
  res.redirect('/agents?msg=' + encodeURIComponent('Device revoked — its agent can no longer talk to the portal.'));
});

export default router;
