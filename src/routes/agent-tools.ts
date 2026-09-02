import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { logActivity } from '../lib/activity';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { wakeAgent, AGENT_PKG_DIR, AGENT_XFER_DIR } from './agent-api';

// ── Remote tools (asset page → LumenMSP Agent) ──────────────────────────────────
// Admin-only, without exception: every kind here runs as SYSTEM on the customer's
// machine. The flow is queue → agent long-poll → result, so nothing blocks a request
// thread waiting on a remote PC.
//
//   POST /assets/:id/tools/run       queue a command, returns { command_id }
//   GET  /assets/:id/tools/result/:c poll for the result
//
// AD kinds are re-routed to the customer's designated AD agent (a DC or management
// server), because SYSTEM on a workstation has no rights to change directory accounts.

const router = Router();

// Every kind the UI may queue, with the audit wording used in the activity log.
const KINDS: Record<string, { label: string; ad?: boolean; destructive?: boolean }> = {
  'shell.powershell': { label: 'PowerShell command', destructive: true },
  'shell.cmd': { label: 'Command-line command', destructive: true },
  'shell.reset': { label: 'Reset the console session' },
  'agent.update': { label: 'Pushed an agent update', destructive: true },
  'software.list': { label: 'Listed installed software' },
  'inventory.software': { label: 'Refreshed the software inventory' },
  'software.uninstall': { label: 'Uninstalled software', destructive: true },
  'software.install': { label: 'Installed software', destructive: true },
  'winget.search': { label: 'Searched WinGet' },
  'winget.upgradable': { label: 'Listed WinGet updates' },
  'winget.install': { label: 'Installed a WinGet package', destructive: true },
  'winget.uninstall': { label: 'Uninstalled a WinGet package', destructive: true },
  'winget.upgrade': { label: 'Upgraded WinGet packages', destructive: true },
  'choco.search': { label: 'Searched Chocolatey' },
  'choco.outdated': { label: 'Listed Chocolatey updates' },
  'choco.install': { label: 'Installed a Chocolatey package', destructive: true },
  'choco.uninstall': { label: 'Uninstalled a Chocolatey package', destructive: true },
  'choco.upgrade': { label: 'Upgraded Chocolatey packages', destructive: true },
  'choco.bootstrap': { label: 'Installed Chocolatey itself', destructive: true },
  'files.search': { label: 'Searched the file system' },
  'files.delete': { label: 'Deleted a file or folder', destructive: true },
  'files.download': { label: 'Downloaded a file from the device' },
  'files.upload': { label: 'Uploaded a file to the device', destructive: true },
  'reg.list': { label: 'Browsed the registry' },
  'reg.set': { label: 'Changed a registry value', destructive: true },
  'reg.deleteValue': { label: 'Deleted a registry value', destructive: true },
  'reg.newKey': { label: 'Created a registry key', destructive: true },
  'reg.deleteKey': { label: 'Deleted a registry key', destructive: true },
  'reg.rename': { label: 'Renamed a registry key or value', destructive: true },
  'reg.find': { label: 'Searched the registry' },
  'reg.export': { label: 'Exported a registry key' },
  'reg.import': { label: 'Imported a .reg file', destructive: true },
  'reg.acl': { label: 'Viewed registry permissions' },
  'services.list': { label: 'Listed services' },
  'services.restart': { label: 'Restarted a service', destructive: true },
  'services.start': { label: 'Started a service', destructive: true },
  'services.stop': { label: 'Stopped a service', destructive: true },
  'files.list': { label: 'Browsed the file system' },
  'users.list': { label: 'Listed local users' },
  'users.disable': { label: 'Disabled a local user', destructive: true },
  'users.enable': { label: 'Enabled a local user', destructive: true },
  'users.resetpw': { label: 'Reset a local user password', destructive: true },
  'process.list': { label: 'Listed running processes' },
  'process.kill': { label: 'Ended a process', destructive: true },
  'events.list': { label: 'Read the event log' },
  'useractivity.list': { label: 'Read the sign-in history' },
  'patch.history': { label: 'Read the installed-update history' },
  'security.status': { label: 'Refreshed the security status' },
  'ad.users.list': { label: 'Listed AD users', ad: true },
  'ad.user.disable': { label: 'Disabled an AD account', ad: true, destructive: true },
  'ad.user.enable': { label: 'Enabled an AD account', ad: true, destructive: true },
  'ad.user.resetpw': { label: 'Reset an AD password', ad: true, destructive: true },
  'ad.user.setinfo': { label: "Changed an AD user's job details", ad: true, destructive: true },
};

/** A PowerShell single-quoted literal. Doubling the quote is the ONLY escape inside '...',
 *  and nothing else is interpreted there — no expansion, no backtick escapes. Values reach
 *  a domain controller, so this is the boundary that matters. */
function psq(v: string): string {
  return "'" + String(v == null ? '' : v).replace(/'/g, "''") + "'";
}

/// The agent row for an asset — matched on customer + serial, hostname as fallback.
async function deviceForAsset(assetId: number): Promise<any | null> {
  const a = (await pool.query('SELECT id, customer_id, hostname, serial_number FROM customer_assets WHERE id=$1', [assetId])).rows[0];
  if (!a) return null;
  const r = await pool.query(
    `SELECT * FROM agent_devices
      WHERE revoked=false AND customer_id=$1
        AND (($2::text IS NOT NULL AND serial_number=$2) OR ($3::text IS NOT NULL AND LOWER(hostname)=LOWER($3)))
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
    [a.customer_id, a.serial_number || null, a.hostname || null]);
  return r.rows[0] || null;
}

/// The customer's nominated AD agent (a DC / management server running the agent).
async function adAgentFor(customerId: number): Promise<any | null> {
  const r = await pool.query(
    `SELECT * FROM agent_devices WHERE customer_id=$1 AND is_ad_agent=true AND revoked=false
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [customerId]);
  return r.rows[0] || null;
}

/// Passwords are generated here (never typed by the admin, never reused) and shown once.
function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const sym = '!@#$%^&*-_=+';
  const all = upper + lower + digit + sym;
  const pick = (set: string) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(sym)];
  while (chars.length < 16) chars.push(pick(all));
  // Fisher-Yates with a CSPRNG so the guaranteed-class characters aren't always up front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

router.post('/assets/:id/tools/run', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const assetId = parseInt(String(req.params.id), 10);
  const kind = String((req.body || {}).kind || '');
  // Some tools are a FRIENDLY name for a script we build here; the agent sees shell.powershell.
  // Same pattern as Windows Updates on/off in Automation — no new agent capability, nothing
  // to roll out to 192 machines, and the script never comes off the browser.
  let wireKind = kind;
  const spec = KINDS[kind];
  if (!spec) { res.status(400).json({ ok: false, error: 'Unknown tool.' }); return; }

  try {
    const asset = (await pool.query('SELECT id, hostname, customer_id FROM customer_assets WHERE id=$1', [assetId])).rows[0];
    if (!asset) { res.status(404).json({ ok: false, error: 'Device not found.' }); return; }

    // Pick the machine that will actually run this.
    let device = await deviceForAsset(assetId);
    let routedTo: string | null = null;
    if (spec.ad) {
      const adAgent = asset.customer_id ? await adAgentFor(asset.customer_id) : null;
      if (!adAgent) {
        res.status(400).json({ ok: false, error: 'No AD agent set for this customer. Install the agent on a domain controller or management server, then tick "AD agent" for it on the Agents page.' });
        return;
      }
      device = adAgent;
      routedTo = adAgent.hostname;
    }
    if (!device) { res.status(400).json({ ok: false, error: 'No LumenMSP Agent is enrolled on this device.' }); return; }

    // Build the payload server-side; only the shell kinds accept free text.
    const b = req.body || {};
    const payload: Record<string, any> = {};
    let generated: string | null = null;
    if (kind === 'shell.powershell' || kind === 'shell.cmd') {
      // shell.reset carries no script - it just throws the session away.
      const script = String(b.script || '').trim();
      if (!script) { res.status(400).json({ ok: false, error: 'Type a command first.' }); return; }
      payload.script = script.slice(0, 8000);
      // SYSTEM by default; 'user' runs in the signed-in user's session instead.
      payload.run_as = String(b.run_as || '') === 'user' ? 'user' : 'system';
    }
    if (kind.startsWith('services.') && kind !== 'services.list') payload.name = String(b.name || '').slice(0, 200);
    if (kind === 'files.list') payload.path = String(b.path || '').slice(0, 500);
    if (kind.startsWith('users.') && kind !== 'users.list') payload.name = String(b.name || '').slice(0, 200);
    if (kind.startsWith('ad.user.')) payload.sam = String(b.sam || '').slice(0, 200);
    if (kind === 'ad.users.list') payload.q = String(b.q || '').slice(0, 100);
    if (kind === 'files.delete' || kind === 'files.download') payload.path = String(b.path || '').slice(0, 500);
    if (kind === 'files.upload') {
      payload.transfer_id = String(b.transfer_id || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
      payload.dest = String(b.dest || '').slice(0, 500);
      payload.expand = b.expand === '1' || b.expand === true ? '1' : '0';
    }
    if (kind === 'ad.user.setinfo') {
      const sam = String(b.sam || '').trim();
      if (!sam) { res.status(400).json({ ok: false, error: 'No account name given.' }); return; }
      // Only the fields actually typed are touched. A blank box means "leave it alone",
      // never "blank it out" — quietly clearing somebody's department because a box was
      // empty is exactly the kind of damage a bulk tool should not be able to do.
      const sets: string[] = [];
      const changed: string[] = [];
      const fields: Array<[string, string, string]> = [
        ['title', 'Title', String(b.title || '').trim()],
        ['department', 'Department', String(b.department || '').trim()],
        ['description', 'Description', String(b.description || '').trim()],
      ];
      for (const [key, adName, val] of fields) {
        if (!val) continue;
        sets.push(`-${adName} ${psq(val.slice(0, 200))}`);
        changed.push(`${key} to "${val.slice(0, 60)}"`);
      }
      if (!sets.length) { res.status(400).json({ ok: false, error: 'Nothing to change — fill in at least one field.' }); return; }
      payload.script = [
        'Import-Module ActiveDirectory -ErrorAction Stop',
        `Set-ADUser -Identity ${psq(sam)} ${sets.join(' ')} -ErrorAction Stop`,
        `$u = Get-ADUser -Identity ${psq(sam)} -Properties Title,Department,Description`,
        '"$($u.SamAccountName) updated. Title: $($u.Title); Department: $($u.Department); Description: $($u.Description)"',
      ].join('\r\n');
      payload.run_as = 'system';
      payload.setinfo_for = sam;
      payload.setinfo_changed = changed.join(', ');
      wireKind = 'shell.powershell';
    }
    if (kind === 'winget.search' || kind === 'choco.search') payload.q = String(b.q || '').slice(0, 120);
    if (kind.startsWith('choco.') && kind !== 'choco.search' && kind !== 'choco.bootstrap') {
      payload.id = String(b.id || '').slice(0, 200);
    }
    if (kind === 'winget.install' || kind === 'winget.uninstall' || kind === 'winget.upgrade') {
      payload.id = String(b.id || '').slice(0, 200);
    }
    if (kind === 'files.search') {
      payload.path = String(b.path || '').slice(0, 500);
      payload.pattern = String(b.pattern || '').slice(0, 120);
      payload.depth = String(b.depth || '4');
    }
    if (kind.startsWith('reg.')) {
      payload.key = String(b.key || '').slice(0, 500);
      if (b.name != null) payload.name = String(b.name).slice(0, 300);
      if (b.type != null) payload.type = String(b.type).slice(0, 20);
      if (b.data != null) payload.data = String(b.data).slice(0, 8000);
      if (b.to != null) payload.to = String(b.to).slice(0, 300);
      if (b.term != null) payload.term = String(b.term).slice(0, 200);
      if (b.keys != null) payload.keys = String(b.keys) === '0' ? '0' : '1';
      if (b.values != null) payload.values = String(b.values) === '0' ? '0' : '1';
      if (b.data_search != null) payload.data = String(b.data_search) === '0' ? '0' : '1';
      if (kind === 'reg.find') payload.data = String(b.data) === '0' ? '0' : '1';
      if (kind === 'reg.import') payload.transfer_id = String(b.transfer_id || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
    }
    if (kind === 'software.uninstall') {
      payload.name = String(b.name || '').slice(0, 300);
      payload.product_code = String(b.product_code || '').slice(0, 100);
      payload.uninstall_cmd = String(b.uninstall_cmd || '').slice(0, 1000);
    }
    if (kind === 'software.install') {
      // The URL is resolved HERE from the package id - never taken from the browser, so
      // nobody can point a device at an arbitrary installer via a crafted request.
      const pkgId = parseInt(String(b.package_id || ''), 10);
      if (pkgId) {
        const pkg = (await pool.query('SELECT id, name, url, file_name, install_args FROM agent_packages WHERE id=$1', [pkgId])).rows[0];
        if (!pkg) { res.status(400).json({ ok: false, error: 'Unknown package.' }); return; }
        payload.name = pkg.name;
        payload.args = pkg.install_args || '/qn /norestart';
        payload.url = pkg.url || `${req.protocol}://${req.get('host')}/agent/api/package/${pkg.id}`;
      } else {
        const url = String(b.url || '').trim();
        if (!/^https:\/\//i.test(url)) { res.status(400).json({ ok: false, error: 'Package URL must be https://' }); return; }
        payload.url = url.slice(0, 1000);
        payload.args = String(b.args || '/qn /norestart').slice(0, 200);
        payload.name = url.split('/').pop() || 'package';
      }
    }
    if (kind === 'process.kill') {
      const procId = parseInt(String(b.pid || ''), 10);
      if (!procId || procId < 1) { res.status(400).json({ ok: false, error: 'No process id given.' }); return; }
      payload.pid = String(procId);
      payload.name = String(b.name || '').slice(0, 200);
    }
    if (kind === 'events.list') {
      payload.log = ['System', 'Application', 'Security', 'Setup'].includes(String(b.log)) ? String(b.log) : 'System';
      const hours = parseInt(String(b.hours || '24'), 10) || 24;
      payload.hours = String(Math.min(Math.max(hours, 1), 720));
      const level = parseInt(String(b.level || '0'), 10);
      payload.level = String(level >= 1 && level <= 5 ? level : 0);
      payload.q = String(b.q || '').slice(0, 120);
    }
    if (kind === 'useractivity.list') {
      const days = parseInt(String(b.days || '7'), 10) || 7;
      payload.days = String(Math.min(Math.max(days, 1), 90));
    }
    if (kind === 'users.resetpw' || kind === 'ad.user.resetpw') {
      // Either generate one or take the admin's. A typed password is echoed back so the
      // UI can show it once alongside a generated one; like a generated one it is never
      // written to the activity log, and payload is NULLed the moment the command ends.
      const typed = String(b.password || '');
      if (typed) {
        if (typed.length < 8) { res.status(400).json({ ok: false, error: 'That password is too short — 8 characters minimum.' }); return; }
        if (typed.length > 127) { res.status(400).json({ ok: false, error: 'That password is too long.' }); return; }
        generated = typed;
      } else {
        generated = generatePassword();
      }
      payload.password = generated;
      payload.must_change = b.must_change === '1' || b.must_change === true ? '1' : '0';
    }

    const ins = await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, requested_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [device.id, wireKind, JSON.stringify(payload), req.session.user!.id]);
    const commandId = ins.rows[0].id;

    // Audit BEFORE the result comes back, and never record the generated password.
    const target = payload.name || payload.sam || payload.setinfo_for || payload.path || '';
    await logActivity(req.session.user!.id, 'agent_tool', 'customer_assets', assetId,
      `${spec.label} on ${device.hostname || 'device'}${target ? ' (' + target + ')' : ''}` +
      (kind === 'ad.user.setinfo' ? ' — set ' + payload.setinfo_changed : '') +
      (kind.startsWith('shell.') ? ` [as ${payload.run_as}]: ` + String(payload.script).slice(0, 200) : ''));

    wakeAgent(device.id);   // long-poll returns immediately instead of waiting out its timer
    res.json({ ok: true, command_id: commandId, routed_to: routedTo, password: generated });
  } catch (e: any) {
    console.error('[agent-tools] queue failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not queue that command.' });
  }
});

router.get('/assets/:id/tools/result/:commandId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const commandId = parseInt(String(req.params.commandId), 10);
  try {
    // Age is measured IN SQL on purpose. Comparing a database timestamp against the
    // Node process clock silently breaks whenever the two disagree on timezone: every
    // command then looks hours old and is expired the instant it is queued.
    const r = await pool.query(
      `SELECT id, kind, status, exit_code, output, finished_at,
              progress, progress_pct, progress_at,
              EXTRACT(EPOCH FROM (NOW() - requested_at)) AS age_secs,
              -- Silence, not elapsed time, is what says a device has gone away. A patch
              -- install can legitimately run for twenty minutes; what it does not do is
              -- go three minutes without saying anything.
              EXTRACT(EPOCH FROM (NOW() - COALESCE(progress_at, requested_at))) AS quiet_secs
         FROM agent_commands WHERE id=$1`, [commandId]);
    if (!r.rows.length) { res.status(404).json({ ok: false, error: 'Unknown command.' }); return; }
    const c = r.rows[0];
    // A device that went offline mid-command shouldn't leave the UI spinning forever.
    const quietSecs = Number(c.quiet_secs) || 0;
    if (['queued', 'running'].includes(c.status) && quietSecs > 180) {
      await pool.query("UPDATE agent_commands SET status='expired', payload=NULL WHERE id=$1 AND status IN ('queued','running')", [commandId]);
      res.json({ ok: true, status: 'expired', output: 'The device did not respond within 3 minutes. It may be offline or asleep.' });
      return;
    }
    res.json({
      ok: true, status: c.status, exit_code: c.exit_code, output: c.output || '',
      progress: c.progress || '', progress_pct: c.progress_pct == null ? null : Number(c.progress_pct),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'Could not read the result.' });
  }
});

// Serve a file the device sent up. Admin-only and one-shot-ish: the transfer folder is
// swept of anything older than a day.
router.get('/assets/:id/tools/file/:xfer', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.xfer || '').replace(/[^a-f0-9]/gi, '');
  if (id.length !== 32) { res.status(400).send('Bad id'); return; }
  try {
    const match = fs.readdirSync(AGENT_XFER_DIR).find((f) => f.startsWith(id + '__'));
    if (!match) { res.status(404).send('That file is no longer available.'); return; }
    res.download(path.join(AGENT_XFER_DIR, match), match.split('__').slice(1).join('__'));
  } catch { res.status(500).send('Download failed'); }
});

// Stage a file from the browser, ready to push to a device.
const xferIn = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(AGENT_XFER_DIR, { recursive: true }); cb(null, AGENT_XFER_DIR); },
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '__' +
      (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)),
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

router.post('/assets/:id/tools/stage', requireAuth, requireAdmin, xferIn.single('file'), (req: Request, res: Response) => {
  const f = (req as any).file;
  if (!f) { res.status(400).json({ ok: false, error: 'No file received.' }); return; }
  // Housekeeping: transfers are transient, so drop anything over a day old.
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(AGENT_XFER_DIR)) {
      const full = path.join(AGENT_XFER_DIR, name);
      if (fs.statSync(full).mtimeMs < cutoff) { try { fs.unlinkSync(full); } catch { /* ignore */ } }
    }
  } catch { /* housekeeping only */ }
  res.json({ ok: true, id: path.basename(f.filename).split('__')[0], name: (f.originalname || 'file') });
});

// Cached software list for a device — served from the database, so it works whether or
// not the machine is on. Uninstalling still needs it online; knowing what is installed
// does not.
router.get('/assets/:id/software', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const assetId = parseInt(String(req.params.id), 10);
  const q = String(req.query.q || '').trim();
  try {
    const device = await deviceForAsset(assetId);
    if (!device) { res.json({ ok: true, rows: [], collected_at: null, no_agent: true }); return; }
    const params: any[] = [device.id];
    let where = 'device_id = $1';
    if (q) { params.push('%' + q + '%'); where += ` AND (name ILIKE $${params.length} OR publisher ILIKE $${params.length})`; }
    // Join what is actually UPGRADABLE, from the same device_patches rows the estate-wide
    // software page uses. Matching on the normalised title rather than guessing a package
    // id from the display name matters: an Update button that runs `winget upgrade --name
    // "Adobe Acrobat"` on an ambiguous match is how the wrong product gets upgraded on
    // somebody's machine. If we do not hold a real update id, no button is offered.
    const rows = (await pool.query(
      `SELECT s.id, s.name, s.version, s.publisher, s.size_mb, s.install_date, s.product_code,
              s.uninstall_cmd, s.scope,
              up.update_id, up.source AS up_source, up.available_version,
              EXTRACT(EPOCH FROM (NOW() - s.collected_at)) AS age_secs
         FROM agent_software s
         LEFT JOIN LATERAL (
           SELECT p.update_id, p.source, p.available_version, p.title
             FROM device_patches p
            WHERE p.device_id = s.device_id
              AND p.source IN ('winget','choco')
              AND length(regexp_replace(lower(p.title), '[^a-z0-9]', '', 'g')) > 3
              AND regexp_replace(lower(s.name), '[^a-z0-9]', '', 'g')
                  LIKE regexp_replace(lower(p.title), '[^a-z0-9]', '', 'g') || '%'
            ORDER BY (p.source = 'winget') DESC, length(p.title) DESC
            LIMIT 1
         ) up ON true
        WHERE ${where.replace('device_id', 's.device_id').replace('name ILIKE', 's.name ILIKE').replace('publisher ILIKE', 's.publisher ILIKE')}
        ORDER BY s.name LIMIT 1000`, params)).rows;
    res.json({
      ok: true,
      rows: rows.map((r: any) => ({ ...r, removable: !!(r.product_code || (r.uninstall_cmd && /\/q|\/s/i.test(r.uninstall_cmd))) })),
      age_secs: rows.length ? Number(rows[0].age_secs) : null,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'Could not read the software list.' });
  }
});

// Deployable packages (an uploaded MSI, or a plain URL).
router.get('/agent-packages.json', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const rows = (await pool.query(
    'SELECT id, name, version, file_name, url, size_bytes, install_args FROM agent_packages ORDER BY name')).rows;
  res.json({ ok: true, rows });
});

const pkgUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(AGENT_PKG_DIR, { recursive: true }); cb(null, AGENT_PKG_DIR); },
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + (file.originalname || 'package.msi').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

router.post('/agent-packages', requireAuth, requireAdmin, pkgUpload.single('msi'), async (req: Request, res: Response) => {
  const f = (req as any).file;
  const name = String(req.body.name || '').trim() || (f?.originalname || 'Package');
  const url = String(req.body.url || '').trim();
  const args = String(req.body.args || '/qn /norestart').trim().slice(0, 200);
  // The Agents page posts this as a normal form and wants a redirect; the Install
  // software lightbox posts it with fetch() and wants the new package's id back so it can
  // deploy it straight away. Same endpoint, because they are the same operation.
  const wantsJson = String(req.query.json || '') === '1' || req.get('x-requested-with') === 'XMLHttpRequest';
  const fail = (m: string) => {
    if (wantsJson) res.status(400).json({ ok: false, error: m });
    else res.redirect('/agents?err=' + encodeURIComponent(m));
  };
  try {
    if (!f && !url) { fail('Upload an MSI or give a URL.'); return; }
    if (url && !/^https:\/\//i.test(url)) {
      if (f) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
      fail('Package URL must be https://'); return;
    }
    let sha: string | null = null;
    if (f) {
      // Same signature check as the agent installer: refuse anything that is not an MSI
      // before it can ever be pushed to a customer machine.
      const fd = fs.openSync(f.path, 'r');
      const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
      if (head.toString('hex') !== 'd0cf11e0') {
        try { fs.unlinkSync(f.path); } catch { /* ignore */ }
        fail('That file is not an MSI.'); return;
      }
      sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
    }
    const ins = await pool.query(
      `INSERT INTO agent_packages (name, version, file_name, url, size_bytes, sha256, install_args, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name.slice(0, 200), String(req.body.version || '').trim().slice(0, 50) || null,
       f ? path.basename(f.path) : null, url || null, f ? f.size : null, sha, args, req.session.user!.id]);
    await logActivity(req.session.user!.id, 'agent_package', null, null, `Added deployable package: ${name}`);
    if (wantsJson) { res.json({ ok: true, id: ins.rows[0].id, name: name.slice(0, 200) }); return; }
    res.redirect('/agents?msg=' + encodeURIComponent(`Package "${name}" is ready to deploy from any device's Tools tab.`));
  } catch (e: any) {
    console.error('[agent-packages] save failed:', e.message);
    fail('Could not save that package.');
  }
});

router.post('/agent-packages/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const p = (await pool.query('SELECT file_name, name FROM agent_packages WHERE id=$1', [id])).rows[0];
  if (p) {
    if (p.file_name) { try { fs.unlinkSync(path.join(AGENT_PKG_DIR, path.basename(p.file_name))); } catch { /* already gone */ } }
    await pool.query('DELETE FROM agent_packages WHERE id=$1', [id]);
    await logActivity(req.session.user!.id, 'agent_package', null, null, `Removed package: ${p.name}`);
  }
  res.redirect('/agents?msg=' + encodeURIComponent('Package removed.'));
});

// ── Run-script library ──────────────────────────────────────────────────────────
// Saved scripts are shared across the estate: save once on any device page, run on all
// of them. Running one goes through the same audited shell kinds as the console, so the
// library adds no new execution surface - only convenience.
router.get('/agent-scripts.json', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = (await pool.query('SELECT id, name, shell, run_as, script FROM agent_scripts ORDER BY name')).rows;
    res.json({ ok: true, rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'Could not read the script library.' });
  }
});

router.post('/agent-scripts', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  const script = String(b.script || '').slice(0, 16000);
  const shell = String(b.shell) === 'cmd' ? 'cmd' : 'powershell';
  const runAs = String(b.run_as) === 'user' ? 'user' : 'system';
  const id = parseInt(String(b.id || ''), 10) || null;
  if (!name) { res.status(400).json({ ok: false, error: 'Give the script a name.' }); return; }
  if (!script.trim()) { res.status(400).json({ ok: false, error: 'There is no script to save.' }); return; }
  try {
    let row: any;
    if (id) {
      row = (await pool.query(
        `UPDATE agent_scripts SET name=$1, script=$2, shell=$3, run_as=$4, updated_at=NOW() WHERE id=$5
         RETURNING id, name, shell, run_as, script`, [name, script, shell, runAs, id])).rows[0];
      if (!row) { res.status(404).json({ ok: false, error: 'That script is gone.' }); return; }
      await logActivity(req.session.user!.id, 'agent_script', null, row.id, `Updated saved script: ${name}`);
    } else {
      row = (await pool.query(
        `INSERT INTO agent_scripts (name, script, shell, run_as, created_by) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, shell, run_as, script`, [name, script, shell, runAs, req.session.user!.id])).rows[0];
      await logActivity(req.session.user!.id, 'agent_script', null, row.id, `Saved a new script: ${name}`);
    }
    res.json({ ok: true, script: row });
  } catch (e: any) {
    console.error('[agent-scripts] save failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not save that script.' });
  }
});

router.post('/agent-scripts/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = (await pool.query('DELETE FROM agent_scripts WHERE id=$1 RETURNING name', [id])).rows[0];
    if (r) await logActivity(req.session.user!.id, 'agent_script', null, id, `Deleted saved script: ${r.name}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'Could not delete that script.' });
  }
});

// Mark/unmark a device as the customer's AD agent (the box that runs directory actions).
router.post('/agents/:id/ad-agent', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const on = String((req.body || {}).on || '') === '1';
  try {
    const d = (await pool.query('SELECT customer_id, hostname FROM agent_devices WHERE id=$1', [id])).rows[0];
    if (!d) { res.redirect('/agents?err=' + encodeURIComponent('Device not found.')); return; }
    // One AD agent per customer — promoting a new one stands the old one down.
    if (on && d.customer_id) await pool.query('UPDATE agent_devices SET is_ad_agent=false WHERE customer_id=$1', [d.customer_id]);
    await pool.query('UPDATE agent_devices SET is_ad_agent=$1, updated_at=NOW() WHERE id=$2', [on, id]);
    await logActivity(req.session.user!.id, 'agent_ad_agent', 'agent_devices', id,
      `${d.hostname} ${on ? 'set as' : 'removed as'} the AD agent`);
    res.redirect('/agents?msg=' + encodeURIComponent(on
      ? `${d.hostname} will now run AD actions for this customer.`
      : `${d.hostname} is no longer the AD agent.`));
  } catch (e: any) {
    res.redirect('/agents?err=' + encodeURIComponent('Could not update the AD agent.'));
  }
});

export default router;
