import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { pool } from '../db/pool';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { getSetting } from '../lib/settings';
import { logActivity } from '../lib/activity';
import { AGENT_PKG_DIR, wakeAgent } from './agent-api';

// ── MeshCentral integration ─────────────────────────────────────────────────────
// Remote access. Two halves, and the direction of each matters:
//
//   • THE BRIDGE (mesh01 → here). A timer on the MeshCentral box asks us for the
//     customer list, creates a device group for anyone who hasn't got one, sends the
//     group id back, uploads that group's Windows agent, and reports every MeshCentral
//     node id with its hostname. We never dial MeshCentral — its control interface
//     stays unreachable from Azure, and the only credential crossing the wire is the
//     bridge secret. Authenticated by header, never a session.
//
//   • THE INSTALL (here → device). A device enrols, we see its customer has an agent
//     binary and the device hasn't got Mesh Agent, and we queue a mesh.install command.
//     The agent fetches the binary from /agent/api/package/:id on its own device token —
//     so nothing anonymous is used in normal running, even though the bridge's own
//     download from MeshCentral is unauthenticated.
//
// Node ids are matched to devices BY HOSTNAME, which is why every group the bridge
// creates has MeshCentral's Hostname Sync feature enabled.

const router = Router();

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * MeshCentral's API returns identifiers prefixed by type — "node//abc", "mesh//abc" —
 * but its own web UI's ?gotonode= expects the bare form, and silently lands you on a
 * dead desktop panel if you give it the prefixed one. Strip on the way in and again on
 * the way out, because a row stored before this existed shouldn't stay broken.
 */
const bareNodeId = (id: unknown) => String(id || '').replace(/^node\/\//, '');

/**
 * Node ids use a base64-ish alphabet that includes `$` and `@`. Both are legal in a
 * query string and MeshCentral's own UI emits them raw — percent-encoding them makes
 * the id fail to match, and you land on a desktop panel that never connects. So instead
 * of escaping, restrict to the known alphabet: nothing outside it can be an id, so
 * dropping the rest is both safe and sufficient.
 */
const nodeIdForUrl = (id: unknown) => bareNodeId(id).replace(/[^A-Za-z0-9$@_-]/g, '');

/** MeshCentral's public base URL, e.g. https://mesh.lumenmsp.co.uk (no trailing slash). */
export async function meshServerUrl(): Promise<string | null> {
  const v = ((await getSetting('mesh', 'server_url')) || '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(v) ? v : null;
}

// ── Bridge auth ─────────────────────────────────────────────────────────────────
// A shared secret in settings (mesh/bridge_secret), compared in constant time. This is
// a server-to-server credential: no session, no CSRF, same posture as the agent API.
async function requireBridge(req: Request, res: Response, next: NextFunction): Promise<void> {
  const given = String(req.headers['x-mesh-bridge-secret'] || '');
  const want = ((await getSetting('mesh', 'bridge_secret')) || '').trim();
  if (!want) { res.status(503).json({ ok: false, error: 'bridge secret not configured' }); return; }
  const a = Buffer.from(given), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: 'bad bridge secret' });
    return;
  }
  next();
}

// ── Bridge: what customers exist? ───────────────────────────────────────────────
// hasAgentBinary tells the bridge whether to bother downloading and uploading the
// agent, so a quiet cycle costs one query and nothing else.
router.get('/agent/api/mesh/customers', requireBridge, async (_req: Request, res: Response) => {
  try {
    // Active customers only. Without this we make a MeshCentral device group for every
    // lead and every website enquiry that ever landed in the CRM — and a new one each
    // time someone fills the form in.
    const r = await pool.query(
      `SELECT c.id, c.name, c.mesh_group_id,
              (c.mesh_agent_package_id IS NOT NULL) AS has_agent_binary
         FROM customers c
        WHERE c.deleted_at IS NULL
          AND COALESCE(c.mesh_enabled, true) = true
          AND c.status = 'active'
          AND COALESCE(c.is_placeholder, false) = false
        ORDER BY c.id`);
    res.json({
      ok: true,
      customers: r.rows.map((c: any) => ({
        id: c.id,
        name: c.name,
        meshGroupId: c.mesh_group_id || null,
        hasAgentBinary: c.has_agent_binary === true,
      })),
    });
  } catch (e: any) {
    console.error('[mesh] customer list failed:', e.message);
    res.status(500).json({ ok: false, error: 'customer list failed' });
  }
});

// ── Bridge: here is the group I made for that customer ──────────────────────────
router.post('/agent/api/mesh/group', requireBridge, async (req: Request, res: Response) => {
  const b = req.body || {};
  const customerId = parseInt(String(b.customerId), 10);
  const groupId = String(b.meshGroupId || '').trim().slice(0, 200);
  const groupName = String(b.meshGroupName || '').trim().slice(0, 200) || null;
  if (!customerId || !groupId) { res.status(400).json({ ok: false, error: 'customerId and meshGroupId are required' }); return; }
  try {
    const r = await pool.query(
      'UPDATE customers SET mesh_group_id=$1, mesh_group_name=$2, updated_at=NOW() WHERE id=$3 RETURNING name',
      [groupId, groupName, customerId]);
    if (!r.rows.length) { res.status(404).json({ ok: false, error: 'unknown customer' }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[mesh] group link failed:', e.message);
    res.status(500).json({ ok: false, error: 'group link failed' });
  }
});

// ── Bridge: here is that group's Windows agent ──────────────────────────────────
// Stored as an ordinary agent_packages row so it rides the deployment machinery that
// already exists — the agent downloads it from /agent/api/package/:id on its device
// token, exactly like any other package.
const meshUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(AGENT_PKG_DIR, { recursive: true }); cb(null, AGENT_PKG_DIR); },
    filename: (req, _file, cb) => cb(null, `meshagent64-c${parseInt(String((req.body || {}).customerId), 10) || 0}-${Date.now()}.exe`),
  }),
  limits: { fileSize: 64 * 1024 * 1024, files: 1 },
});

router.post('/agent/api/mesh/agent-binary', requireBridge, meshUpload.single('file'), async (req: Request, res: Response) => {
  const f = (req as any).file;
  const customerId = parseInt(String((req.body || {}).customerId), 10);
  if (!f) { res.status(400).json({ ok: false, error: 'no file' }); return; }
  const drop = () => { try { fs.unlinkSync(f.path); } catch { /* already gone */ } };

  try {
    if (!customerId) { drop(); res.status(400).json({ ok: false, error: 'customerId is required' }); return; }

    // We are about to run this as SYSTEM on customer machines, so "it arrived" is
    // nowhere near enough. Must be a real PE image, and a plausible size.
    const buf = fs.readFileSync(f.path);
    if (buf.length < 1_000_000 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
      drop();
      res.status(400).json({ ok: false, error: 'not a Windows executable' });
      return;
    }

    const cust = (await pool.query('SELECT id, name, mesh_agent_package_id FROM customers WHERE id=$1', [customerId])).rows[0];
    if (!cust) { drop(); res.status(404).json({ ok: false, error: 'unknown customer' }); return; }

    const name = `MeshCentral Agent — ${cust.name}`;
    const args = '-fullinstall';
    let packageId: number;

    if (cust.mesh_agent_package_id) {
      // Replace in place so the id stays stable and any queued command still resolves.
      const old = (await pool.query('SELECT file_name FROM agent_packages WHERE id=$1', [cust.mesh_agent_package_id])).rows[0];
      await pool.query(
        `UPDATE agent_packages SET name=$1, file_name=$2, size_bytes=$3, sha256=$4, install_args=$5, url=NULL WHERE id=$6`,
        [name, path.basename(f.path), buf.length, sha256(buf), args, cust.mesh_agent_package_id]);
      packageId = cust.mesh_agent_package_id;
      if (old?.file_name && old.file_name !== path.basename(f.path)) {
        try { fs.unlinkSync(path.join(AGENT_PKG_DIR, path.basename(old.file_name))); } catch { /* already gone */ }
      }
    } else {
      const ins = await pool.query(
        `INSERT INTO agent_packages (name, file_name, size_bytes, sha256, install_args)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, path.basename(f.path), buf.length, sha256(buf), args]);
      packageId = ins.rows[0].id;
      await pool.query('UPDATE customers SET mesh_agent_package_id=$1, updated_at=NOW() WHERE id=$2', [packageId, customerId]);
    }

    await logActivity(null, 'mesh_agent_binary', 'customers', customerId,
      `Remote-access agent published for ${cust.name} (${(buf.length / 1048576).toFixed(1)} MB)`);
    res.json({ ok: true, packageId });
  } catch (e: any) {
    drop();
    console.error('[mesh] agent binary failed:', e.message);
    res.status(500).json({ ok: false, error: 'agent binary not stored' });
  }
});

// ── Bridge: here is every device MeshCentral knows about ────────────────────────
// Hostname is the join key. Match within the customer that owns the device group, so
// two customers with a "RECEPTION" can never cross-contaminate.
router.post('/agent/api/mesh/devices', requireBridge, async (req: Request, res: Response) => {
  const list = (req.body || {}).devices;
  if (!Array.isArray(list)) { res.status(400).json({ ok: false, error: 'devices must be an array' }); return; }
  let matched = 0;
  try {
    for (const d of list.slice(0, 5000)) {
      const nodeId = bareNodeId(String(d?.nodeId || '').trim()).slice(0, 200);
      const groupId = String(d?.meshGroupId || '').trim().slice(0, 200);
      const hostname = String(d?.hostname || '').trim().slice(0, 200);
      if (!nodeId || !groupId || !hostname) continue;
      const r = await pool.query(
        `UPDATE agent_devices ad
            SET mesh_node_id=$1, mesh_installed=true, mesh_last_seen_at=NOW(), updated_at=NOW()
           FROM customers c
          WHERE ad.customer_id = c.id
            AND c.mesh_group_id = $2
            AND LOWER(ad.hostname) = LOWER($3)`,
        [nodeId, groupId, hostname]);
      matched += r.rowCount || 0;
    }
    res.json({ ok: true, received: list.length, matched });
  } catch (e: any) {
    console.error('[mesh] device sync failed:', e.message);
    res.status(500).json({ ok: false, error: 'device sync failed' });
  }
});

// ── Session recordings index ────────────────────────────────────────────────────
// The bridge reports what recordings exist on mesh01; the files themselves stay
// there. This is the index, not the archive — a list of who connected to what, when,
// and for how long, which is the bit anyone actually needs to search.
router.post('/agent/api/mesh/sessions', requireBridge, async (req: Request, res: Response) => {
  const list = (req.body || {}).sessions;
  if (!Array.isArray(list)) { res.status(400).json({ ok: false, error: 'sessions must be an array' }); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seen: string[] = [];

    for (const s of list.slice(0, 5000)) {
      const fileName = String(s?.fileName || '').trim().slice(0, 400);
      if (!fileName) continue;
      seen.push(fileName);

      await client.query(
        `INSERT INTO remote_sessions
           (file_name, engineer, device_name, mesh_node_id, mesh_group_id,
            started_at, ended_at, duration_seconds, size_bytes, file_present,
            customer_id, agent_device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,
                 (SELECT id FROM customers WHERE mesh_group_id = $5 AND deleted_at IS NULL LIMIT 1),
                 (SELECT id FROM agent_devices WHERE mesh_node_id = $4 AND revoked = false LIMIT 1))
         ON CONFLICT (file_name) DO UPDATE SET
           ended_at         = EXCLUDED.ended_at,
           duration_seconds = EXCLUDED.duration_seconds,
           size_bytes       = EXCLUDED.size_bytes,
           file_present     = true,
           customer_id      = COALESCE(remote_sessions.customer_id, EXCLUDED.customer_id),
           agent_device_id  = COALESCE(remote_sessions.agent_device_id, EXCLUDED.agent_device_id)`,
        [fileName,
         String(s.engineer || '').slice(0, 200) || null,
         String(s.deviceName || '').slice(0, 200) || null,
         String(s.meshNodeId || '').slice(0, 200) || null,
         String(s.meshGroupId || '').slice(0, 200) || null,
         s.startedAt ? new Date(s.startedAt) : null,
         s.endedAt ? new Date(s.endedAt) : null,
         Number.isFinite(Number(s.durationSeconds)) ? Number(s.durationSeconds) : null,
         Number.isFinite(Number(s.sizeBytes)) ? Number(s.sizeBytes) : null]);
    }

    // Anything we knew about that is no longer on disk has aged out of the retention
    // window. The ROW stays — it costs a few bytes and it is the audit trail; only the
    // recording itself is subject to the sixty days.
    await client.query(
      `UPDATE remote_sessions SET file_present = false
        WHERE file_present = true AND NOT (file_name = ANY($1::text[]))`, [seen]);

    await client.query('COMMIT');
    res.json({ ok: true, indexed: seen.length });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    console.error('[mesh] session index failed:', e.message);
    res.status(500).json({ ok: false, error: 'session index failed' });
  } finally { client.release(); }
});

// ── Remote Sessions panel ───────────────────────────────────────────────────────
router.get('/remote-sessions', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const engineer = String(req.query.engineer || '').trim();
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));

  const where: string[] = [`rs.started_at > NOW() - ($1 || ' days')::interval`];
  const params: any[] = [String(days)];

  if (q) { params.push('%' + q + '%'); where.push(`(rs.device_name ILIKE $${params.length} OR rs.engineer ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }
  if (engineer) { params.push(engineer); where.push(`rs.engineer = $${params.length}`); }
  if (customerId) { params.push(customerId); where.push(`rs.customer_id = $${params.length}`); }

  try {
    const rows = (await pool.query(
      `SELECT rs.*, c.name AS customer_name, a.id AS asset_id
         FROM remote_sessions rs
         LEFT JOIN customers c ON c.id = rs.customer_id
         LEFT JOIN LATERAL (
           SELECT ca.id FROM customer_assets ca
            WHERE ca.customer_id = rs.customer_id
              AND LOWER(ca.hostname) = LOWER(rs.device_name)
            LIMIT 1
         ) a ON true
        WHERE ${where.join(' AND ')}
        ORDER BY rs.started_at DESC
        LIMIT 500`, params)).rows;

    const [engineers, customers, totals] = await Promise.all([
      pool.query(`SELECT DISTINCT engineer FROM remote_sessions WHERE engineer IS NOT NULL ORDER BY engineer`),
      pool.query(`SELECT DISTINCT c.id, c.name FROM remote_sessions rs JOIN customers c ON c.id = rs.customer_id ORDER BY c.name`),
      pool.query(
        `SELECT count(*)::int AS sessions,
                COALESCE(sum(duration_seconds), 0)::int AS seconds,
                COALESCE(sum(size_bytes), 0)::bigint AS bytes
           FROM remote_sessions
          WHERE started_at > NOW() - ($1 || ' days')::interval`, [String(days)]),
    ]);

    res.render('remote-sessions', {
      user: req.session.user!, rows, q, engineer, customerId, days,
      engineers: engineers.rows.map((r: any) => r.engineer),
      customers: customers.rows,
      totals: totals.rows[0] || { sessions: 0, seconds: 0, bytes: 0 },
      meshUrl: await meshServerUrl(),
      error: null,
    });
  } catch (e: any) {
    console.error('[mesh] remote sessions page failed:', e.message);
    res.render('remote-sessions', {
      user: req.session.user!, rows: [], q, engineer, customerId, days,
      engineers: [], customers: [], totals: { sessions: 0, seconds: 0, bytes: 0 },
      meshUrl: null, error: e.message,
    });
  }
});

// ── Queue a remote-access install ───────────────────────────────────────────────
/**
 * Called from enrolment and from the Agents page. Safe to call repeatedly: it does
 * nothing when the device already has Mesh Agent, when its customer has no binary yet,
 * or when an install is already sitting in the queue.
 */
export async function queueMeshInstall(deviceId: number, baseUrl: string): Promise<'queued' | 'skipped'> {
  const d = (await pool.query(
    `SELECT ad.id, ad.mesh_installed, c.name AS customer, c.mesh_agent_package_id, COALESCE(c.mesh_enabled, true) AS enabled
       FROM agent_devices ad JOIN customers c ON c.id = ad.customer_id
      WHERE ad.id=$1 AND ad.revoked=false`, [deviceId])).rows[0];
  if (!d || !d.enabled || d.mesh_installed || !d.mesh_agent_package_id) return 'skipped';

  const pending = await pool.query(
    `SELECT 1 FROM agent_commands WHERE device_id=$1 AND kind='mesh.install' AND status IN ('queued','running') LIMIT 1`,
    [deviceId]);
  if (pending.rows.length) return 'skipped';

  // Resolve the URL here, never from anything the device sent — same rule as
  // software.install, so a device can't talk us into fetching an arbitrary installer.
  const payload = {
    name: `Remote access (${d.customer})`,
    url: `${baseUrl.replace(/\/+$/, '')}/agent/api/package/${d.mesh_agent_package_id}`,
    args: '-fullinstall',
  };
  await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, status) VALUES ($1,'mesh.install',$2,'queued')`,
    [deviceId, JSON.stringify(payload)]);
  wakeAgent(deviceId);
  return 'queued';
}

// Manual trigger from the Agents page, for a device that missed the automatic pass.
router.post('/agents/:id/mesh-install', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = await queueMeshInstall(id, `${req.protocol}://${req.get('host')}`);
    res.redirect('/agents?msg=' + encodeURIComponent(
      r === 'queued'
        ? 'Remote access install queued — it will run on this device shortly.'
        : 'Nothing to do: either it is already installed, or this customer has no remote-access agent yet.'));
  } catch {
    res.redirect('/agents?err=' + encodeURIComponent('Could not queue the remote-access install.'));
  }
});

// ── Is remote access ready on this machine, and if not, why not ─────────────────
// The old answer was a red banner saying "not yet" and nothing you could do about it,
// which left an engineer with a machine in front of them and no way forward. This works
// out which of the several possible "not yet"s it actually is, so the page can either
// offer the install or explain what is missing.
export interface MeshStatus {
  deviceId: number | null;
  hostname: string | null;
  hasNode: boolean;        // MeshCentral knows this machine — remote control will work
  installed: boolean;      // we pushed the agent, but it may not have checked in yet
  enabled: boolean;        // remote access switched on for this customer
  hasPackage: boolean;     // this customer has an agent package built
  customer: string | null;
  pendingSince: Date | null;
  failed: { at: Date | null; output: string } | null;
}

export async function meshStatus(assetId: number): Promise<MeshStatus | null> {
  // Asset to agent device, matched the same way as everywhere else in the Portal:
  // serial first because it survives a rename, hostname second.
  const d = (await pool.query(
    `SELECT ad.id, ad.hostname, ad.mesh_node_id, ad.mesh_installed,
            COALESCE(c.mesh_enabled, true) AS enabled, c.mesh_agent_package_id, c.name AS customer
       FROM customer_assets a
       JOIN agent_devices ad
         ON ad.customer_id = a.customer_id
        AND ( (a.serial_number IS NOT NULL AND ad.serial_number = a.serial_number)
              OR LOWER(ad.hostname) = LOWER(a.hostname) )
       LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE a.id = $1 AND ad.revoked = false
      ORDER BY (ad.mesh_node_id IS NOT NULL) DESC, ad.last_seen_at DESC NULLS LAST
      LIMIT 1`, [assetId])).rows[0];

  if (!d) return null;   // no agent on this machine at all — nothing to install onto

  const pending = (await pool.query(
    `SELECT requested_at FROM agent_commands
      WHERE device_id=$1 AND kind='mesh.install' AND status IN ('queued','running')
      ORDER BY id DESC LIMIT 1`, [d.id])).rows[0];

  // Only worth surfacing a failure if nothing has succeeded since.
  const failed = pending ? null : (await pool.query(
    `SELECT finished_at, output FROM agent_commands
      WHERE device_id=$1 AND kind='mesh.install' AND status='failed'
        AND NOT EXISTS (SELECT 1 FROM agent_commands ok
                         WHERE ok.device_id=$1 AND ok.kind='mesh.install'
                           AND ok.status='done' AND ok.id > agent_commands.id)
      ORDER BY id DESC LIMIT 1`, [d.id])).rows[0];

  return {
    deviceId: d.id,
    hostname: d.hostname || null,
    hasNode: !!d.mesh_node_id,
    installed: !!d.mesh_installed,
    enabled: !!d.enabled,
    hasPackage: !!d.mesh_agent_package_id,
    customer: d.customer || null,
    pendingSince: pending ? pending.requested_at : null,
    failed: failed ? { at: failed.finished_at, output: String(failed.output || '').slice(-600) } : null,
  };
}

// Install it from the machine's own page — which is where you are standing when you find
// out it is missing, rather than the Agents list.
router.post('/assets/:id/mesh-install', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const back = `/assets/${id}`;
  try {
    const st = await meshStatus(id);
    if (!st) { res.redirect(back + '?err=' + encodeURIComponent('This machine is not running the LumenMSP agent, so there is nothing to install onto yet.')); return; }
    if (!st.enabled) { res.redirect(back + '?err=' + encodeURIComponent(`Remote access is switched off for ${st.customer || 'this customer'}.`)); return; }
    if (!st.hasPackage) { res.redirect(back + '?err=' + encodeURIComponent(`${st.customer || 'This customer'} has no remote-access agent built yet — create it on the Agents page and it will install everywhere automatically.`)); return; }
    if (st.hasNode) { res.redirect(back + '?msg=' + encodeURIComponent('Remote access is already working on this machine.')); return; }
    if (st.pendingSince) { res.redirect(back + '?msg=' + encodeURIComponent('Already queued — it runs at the next check-in.')); return; }

    // mesh_installed is set when the install command succeeds, so a machine that was
    // installed but never appeared in MeshCentral needs the flag cleared to be retried.
    if (st.installed) {
      await pool.query('UPDATE agent_devices SET mesh_installed=false WHERE id=$1', [st.deviceId]);
    }

    const r = await queueMeshInstall(st.deviceId!, `${req.protocol}://${req.get('host')}`);
    await logActivity(req.session.user!.id, 'mesh_install', 'customer_assets', id,
      `Queued remote-access install on ${st.hostname}`);
    res.redirect(back + '?msg=' + encodeURIComponent(
      r === 'queued'
        ? 'Installing remote access. It runs at the next check-in — about a minute on a machine that is switched on — and this page will show when it lands.'
        : 'Could not queue it. Check the customer has a remote-access agent on the Agents page.'));
  } catch (e: any) {
    console.error('[mesh] asset install failed:', e.message);
    res.redirect(back + '?err=' + encodeURIComponent('Could not queue the remote-access install.'));
  }
});

// ── Remote control ──────────────────────────────────────────────────────────────
// One link from an asset straight into that machine's desktop. viewmode=11 opens the
// desktop tab; hide=31 strips MeshCentral's own navigation, so it reads as part of the
// Portal rather than a second product. The engineer signs in to MeshCentral once and
// the session persists — in practice a login a week, not one per device.
router.get('/assets/:id/remote-mesh', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const back = `/assets/${id}`;
  try {
    const base = await meshServerUrl();
    if (!base) { res.redirect(back + '?err=' + encodeURIComponent('MeshCentral is not configured yet.')); return; }

    // The asset and its agent device are joined the same way everywhere else in the
    // Portal: serial first (survives renames), hostname second.
    const r = await pool.query(
      `SELECT ad.mesh_node_id, ad.hostname
         FROM customer_assets a
         JOIN agent_devices ad
           ON ad.customer_id = a.customer_id
          AND ( (a.serial_number IS NOT NULL AND ad.serial_number = a.serial_number)
                OR LOWER(ad.hostname) = LOWER(a.hostname) )
        WHERE a.id = $1 AND ad.revoked = false
        ORDER BY (ad.mesh_node_id IS NOT NULL) DESC, ad.last_seen_at DESC NULLS LAST
        LIMIT 1`, [id]);

    const nodeId = r.rows[0]?.mesh_node_id;
    if (!nodeId) {
      res.redirect(back + '?err=' + encodeURIComponent(
        'No remote-access session for this device yet. It appears once the MeshCentral agent has installed and checked in.'));
      return;
    }
    await logActivity(req.session.user!.id, 'remote_control', 'customer_assets', id,
      `Opened remote control for ${r.rows[0].hostname}`);
    res.redirect(`${base}/?gotonode=${nodeIdForUrl(nodeId)}&viewmode=11&hide=31`);
  } catch (e: any) {
    console.error('[mesh] remote control failed:', e.message);
    res.redirect(back + '?err=' + encodeURIComponent('Could not open remote control.'));
  }
});

export default router;
