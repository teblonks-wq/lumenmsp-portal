import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { pool } from '../db/pool';
import { looksLikeBitlockerScan, ingestBitlockerScan } from '../lib/bitlocker';
import { getSetting, setSetting } from '../lib/settings';
import { logActivity } from '../lib/activity';
import { vaultConfigured, encryptSecret, decryptSecret } from '../lib/vault';
import { ingestCeResult } from '../lib/ce-ingest';
import { syncAssetFromAgent } from '../lib/agent-asset';
import { windowsOsName } from '../lib/os-name';
import { reapStaleCommands } from '../lib/agent-commands';
import { ingestServerFacts } from '../lib/server-facts';
import { ingestGpoInventory, ingestGpoDelete, ingestGpoUnlink, ingestGpoRestore } from '../lib/gpo';
import { htmlToPlain } from '../lib/whatsapp';
import { nextTicketNumber } from './tickets';
import { guessKind, supplyPercent, isIpv4, SUPPLY_LOW_PERCENT } from '../lib/network-discovery';
import { raiseAlert, resolveAlert } from '../lib/alerts';

// ── LumenMSP Agent API ──────────────────────────────────────────────────────────
// Server-to-server API for the Windows LumenMSP Agent (tray app + service on end-user
// machines). No session, no CSRF (unauthenticated requests are exempt from the CSRF
// guard, same as /api/leads). Two credentials:
//   • SITE KEY  (customers.agent_site_key)  — per-customer install secret, baked into the
//     MSI command line by the RMM. Only ever used once per machine, to enroll.
//   • DEVICE TOKEN (agent_devices.token_hash) — minted at enrollment, unique per machine,
//     sent as `Authorization: Bearer <token>` on every other call. Only the SHA-256 hash
//     is stored; revoking a device kills its token immediately.
//
// Chat rides on the helpdesk: the first message from a device opens a normal case
// (source='agent', inbox_tickets.agent_device_id set); staff reply from the case page
// with the "Agent" channel and the device picks replies up on its next poll (pull-based,
// so there is no send-failure path — an offline device simply reads the backlog later).

const router = Router();

// Master agent MSI store. Lives OUTSIDE dist/static so it survives deploys (the deploy
// tarball extracts over the top, never deletes) and can't be fetched without a valid key.
export const AGENT_MSI_DIR = path.join(__dirname, '../../agent-files');
export const AGENT_MSI_PATH = path.join(AGENT_MSI_DIR, 'LumenMSPAgent.msi');
export const AGENT_VERSION_PATH = path.join(AGENT_MSI_DIR, 'version.txt');
export function agentMsiInfo(): { size: number; mtime: Date } | null {
  try { const st = fs.statSync(AGENT_MSI_PATH); return { size: st.size, mtime: st.mtime }; } catch { return null; }
}

// The hosted build's version. build.ps1 writes version.txt next to the MSI when it
// publishes, so the file and its version can never drift apart — and there is nothing
// to type. The settings row stays as a fallback for a hand-uploaded MSI.
export function agentHostedSha256(): string | null {
  try {
    const v = fs.readFileSync(path.join(AGENT_MSI_DIR, 'sha256.txt'), 'utf8').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) return v;
  } catch { /* no checksum published */ }
  return null;
}

export function agentHostedVersion(): string | null {
  try {
    const v = fs.readFileSync(AGENT_VERSION_PATH, 'utf8').trim();
    if (/^\d+\.\d+\.\d+(\.\d+)?$/.test(v)) return v;
  } catch { /* fall through to the settings row */ }
  return null;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Strip NUL bytes. Postgres `text` cannot hold 0x00 and rejects the whole statement —
// and Windows registry values genuinely contain them (a null-terminated string read
// slightly too long). One embedded NUL in one publisher name was silently killing the
// entire software inventory for every device, every night.
const noNul = (v: string) => v.replace(/\u0000/g, '');
const s = (v: any, max = 300): string | null => { const t = noNul(String(v ?? '')).trim(); return t ? t.slice(0, max) : null; };

// Real client IP — the app sets trust proxy 1, so req.ip is already the nginx-forwarded address.
// Hardware facts the agent collects with WMI. These used to reach the Portal only through
// the Atera sync, which is why every device page showed two of everything. Parsed the same
// way on enrolment and on heartbeat so the machine describes itself from the first second.
function hardware(b: any) {
  const ram = Number(b?.ram_gb);
  const bootMs = Date.parse(String(b?.last_boot_at ?? ''));
  const macs = Array.isArray(b?.mac_addresses)
    ? (b.mac_addresses.map((x: any) => noNul(String(x)).trim()).filter(Boolean).slice(0, 8).join(', ') || null)
    : s(b?.mac_addresses, 200);
  return {
    manufacturer: s(b?.manufacturer, 120),
    model: s(b?.model, 160),
    cpu: s(b?.cpu, 200),
    ramGb: Number.isFinite(ram) && ram > 0 ? Math.round(ram * 10) / 10 : null,
    macAddresses: macs,
    domainOrWorkgroup: s(b?.domain_or_workgroup, 120),
    deviceType: s(b?.device_type, 40),
    lastBootAt: Number.isFinite(bootMs) ? new Date(bootMs) : null,
  };
}

function clientIp(req: Request): string {
  return String(req.ip || '').replace(/^::ffff:/, '');
}

// ── Keyed installer download ────────────────────────────────────────────────────
// ── Server agent console ────────────────────────────────────────────────────────
// The small web interface the server agent puts on the server's own desktop. It binds to
// localhost only, so everything below is reached from that machine, by an engineer who is
// already signed into it, over the device's own token.
//
// Two jobs: keep the list of subnets this customer actually has, and hold one domain
// credential. The credential itself lives in the customer's vault in the Portal — the
// same AES-256-GCM store as every other password, with the key held outside the database
// — because a secret on a domain controller's disk is a worse place for it than a secret
// in a vault we already protect and audit.

/** A six-digit PIN is not a security boundary — root on that server can read anything the
 *  console can. It is there to stop a passing colleague poking at it. So it is sent as a
 *  salted hash rather than in the clear: cheap, and it keeps the PIN itself off every
 *  server's disk. */
function pinHash(pin: string, salt: string): string {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

router.get('/agent/api/console', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  try {
    if (!d.customer_id) { res.status(409).json({ ok: false, error: 'This device is not linked to a customer yet.' }); return; }

    const cust = (await pool.query('SELECT id, name, agent_site_key FROM customers WHERE id=$1', [d.customer_id])).rows[0];
    const pin = (await getSetting('agent', 'console_pin')) || '486826';
    const salt = crypto.randomBytes(8).toString('hex');

    const nets = (await pool.query(
      `SELECT id, cidr, label, source, scan FROM customer_networks
        WHERE customer_id=$1 ORDER BY source, cidr`, [d.customer_id])).rows;

    // Username and state only. The console never receives a password back — it can set
    // one and it can replace one, but it cannot read one.
    const cred = (await pool.query(
      `SELECT id, username, validation_state, validated_at, (secret_encrypted IS NOT NULL) AS has_password
         FROM customer_credentials
        WHERE customer_id=$1 AND system_managed=true AND deleted_at IS NULL
        ORDER BY id LIMIT 1`, [d.customer_id])).rows[0] || null;

    res.json({
      ok: true,
      customer: cust?.name || '',
      hostname: d.hostname,
      pin_salt: salt,
      pin_hash: pinHash(String(pin), salt),
      networks: nets,
      // Hostnames we already manage for this customer, so the scan can say "we have this
      // one" instead of making someone cross-reference two lists by hand.
      managed: (await pool.query(
        `SELECT LOWER(hostname) AS h FROM agent_devices WHERE customer_id=$1 AND revoked=false AND hostname IS NOT NULL`,
        [d.customer_id])).rows.map((r: any) => r.h),
      credential: cred,
      vault_ready: vaultConfigured(),
      // The customer's own site key — used only to build the keyed MSI URL for the GPO
      // fallback. It is a per-customer install secret, not a password: it already appears
      // in the download links on /agents and /my, and the console is localhost-only on a
      // server the engineer is already signed into.
      site_key: cust?.agent_site_key || null,
    });
  } catch (e: any) {
    console.error('[console] bootstrap failed:', e.message);
    res.status(500).json({ ok: false, error: 'could not load' });
  }
});

// Subnets. The agent seeds what it can see from its own interfaces on first run; anything
// else is added by hand, because a server rarely sits on every network a customer has.
router.post('/agent/api/console/networks', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const b = req.body || {};
  try {
    if (!d.customer_id) { res.status(409).json({ ok: false, error: 'no customer' }); return; }

    if (b.remove) {
      await pool.query('DELETE FROM customer_networks WHERE id=$1 AND customer_id=$2',
        [parseInt(String(b.remove), 10), d.customer_id]);
      res.json({ ok: true });
      return;
    }

    const raw = Array.isArray(b.add) ? b.add : b.add ? [b.add] : [];
    const added: string[] = [];
    for (const one of raw) {
      const cidr = String(one).trim();
      // Validate here rather than trusting the console's own check — the console is a
      // client like any other, and a bad range is a scan of something that isn't ours.
      if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(cidr)) continue;
      const [ip, bits] = cidr.split('/');
      if (ip.split('.').some((o) => Number(o) > 255) || Number(bits) < 8 || Number(bits) > 32) continue;
      await pool.query(
        `INSERT INTO customer_networks (customer_id, cidr, label, source, device_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (customer_id, cidr) DO NOTHING`,
        [d.customer_id, cidr, s(b.label, 80), String(b.source) === 'detected' ? 'detected' : 'manual', d.id]);
      added.push(cidr);
    }
    res.json({ ok: true, added });
  } catch (e: any) {
    console.error('[console] networks failed:', e.message);
    res.status(500).json({ ok: false, error: 'could not save' });
  }
});

// The domain credential. One per customer, and the username is fixed once it exists —
// the agent finds this credential by account name, so renaming it would orphan it.
router.post('/agent/api/console/credential', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const b = req.body || {};
  const username = s(b.username, 200);
  const password = String(b.password ?? '');
  const state = ['valid', 'invalid', 'unchecked'].includes(String(b.validation_state)) ? String(b.validation_state) : 'unchecked';

  try {
    if (!d.customer_id) { res.status(409).json({ ok: false, error: 'no customer' }); return; }
    if (!vaultConfigured()) { res.status(503).json({ ok: false, error: 'The password vault is not configured on the Portal.' }); return; }

    const existing = (await pool.query(
      `SELECT id, username FROM customer_credentials
        WHERE customer_id=$1 AND system_managed=true AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [d.customer_id])).rows[0];

    if (existing) {
      if (username && username !== existing.username) {
        res.status(409).json({
          ok: false,
          error: `This customer already has a system credential for ${existing.username}. The account name cannot be changed — delete it in the Portal and add the new one.`,
        });
        return;
      }
      if (!password) { res.status(400).json({ ok: false, error: 'Enter the password.' }); return; }
      await pool.query(
        `UPDATE customer_credentials
            SET secret_encrypted=$1, validation_state=$2, validated_at=NOW(), updated_at=NOW()
          WHERE id=$3`, [encryptSecret(password), state, existing.id]);
      await logActivity(null, 'updated', 'credentials', existing.id,
        `Domain password for ${existing.username} updated from the server console on ${d.hostname}`);
      res.json({ ok: true, id: existing.id, username: existing.username });
      return;
    }

    if (!username || !password) { res.status(400).json({ ok: false, error: 'Both the account name and the password are needed.' }); return; }
    const ins = await pool.query(
      `INSERT INTO customer_credentials
         (customer_id, name, username, secret_encrypted, category, note,
          system_managed, validation_state, validated_at)
       VALUES ($1,'Domain account (server agent)',$2,$3,'Domain',
               'Added by the server agent console. Used to deploy the agent to machines on this network.',
               true,$4,NOW())
       RETURNING id`,
      [d.customer_id, username, encryptSecret(password), state]);
    await logActivity(null, 'created', 'credentials', ins.rows[0].id,
      `Domain credential for ${username} added from the server console on ${d.hostname}`);
    res.json({ ok: true, id: ins.rows[0].id, username });
  } catch (e: any) {
    console.error('[console] credential failed:', e.message);
    res.status(500).json({ ok: false, error: 'could not save' });
  }
});

// The one call that hands a stored password back. The server agent needs the domain
// credential in the clear to open a WinRM session to the machines it is installing on —
// there is no other way to authenticate as that account — so this returns the decrypted
// password, together with the customer's site key so the pushed MSI enrols to the right
// place.
//
// It is deliberately narrow:
//   • device token only, and only the calling device's OWN customer;
//   • only the single system-managed credential, and only when the Portal has already
//     confirmed it is valid — a deploy must never begin on a password we have not tested;
//   • every release is written to the activity log, because a domain-admin password
//     leaving the vault is exactly the event an audit needs to see.
// The password is used in memory on the server that asked, for the length of one run, and
// is never written to that server's disk.
router.get('/agent/api/console/deploy-config', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  try {
    if (!d.customer_id) { res.status(409).json({ ok: false, error: 'This device is not linked to a customer yet.' }); return; }
    if (!vaultConfigured()) { res.status(503).json({ ok: false, error: 'The password vault is not configured on the Portal.' }); return; }

    const cust = (await pool.query('SELECT agent_site_key FROM customers WHERE id=$1', [d.customer_id])).rows[0];
    const siteKey = cust?.agent_site_key || null;
    if (!siteKey) { res.status(409).json({ ok: false, error: 'This customer has no agent site key yet.' }); return; }

    const cred = (await pool.query(
      `SELECT id, username, secret_encrypted, validation_state
         FROM customer_credentials
        WHERE customer_id=$1 AND system_managed=true AND deleted_at IS NULL
        ORDER BY id LIMIT 1`, [d.customer_id])).rows[0];
    if (!cred || !cred.secret_encrypted) {
      res.status(409).json({ ok: false, error: 'No domain account is saved for this customer yet. Add one in the console first.' });
      return;
    }
    if (cred.validation_state !== 'valid') {
      res.status(409).json({ ok: false, error: 'The saved domain account has not been validated. Re-enter its password so it can be checked, then deploy.' });
      return;
    }

    let password: string;
    try { password = decryptSecret(cred.secret_encrypted); }
    catch { res.status(500).json({ ok: false, error: 'The stored credential could not be decrypted.' }); return; }

    await logActivity(null, 'agent_deploy_credential', 'credentials', cred.id,
      `Domain credential for ${cred.username} released to the server console on ${d.hostname} to deploy the agent`);

    res.json({ ok: true, username: cred.username, password, site_key: siteKey });
  } catch (e: any) {
    console.error('[console] deploy-config failed:', e.message);
    res.status(500).json({ ok: false, error: 'could not load' });
  }
});

// ── Linux agent ─────────────────────────────────────────────────────────────────
// Public, unauthenticated, and that is fine: the installer and the binary are the same
// files anybody could take off a machine that already runs them. The secret is the site
// key, which the person installing supplies — it is never in these URLs.
//
//   curl -fsSL https://portal/agent/linux/install.sh | sudo bash -s -- --site-key KEY
const LINUX_DIR = path.join(AGENT_MSI_DIR, 'linux');
const LINUX_RIDS = ['linux-x64', 'linux-arm64'];

router.get('/agent/linux/install.sh', (_req: Request, res: Response) => {
  const f = path.join(LINUX_DIR, 'install.sh');
  if (!fs.existsSync(f)) { res.status(404).type('text/plain').send('# No Linux agent has been published yet.\n'); return; }
  res.type('text/x-shellscript').sendFile(f);
});

router.get('/agent/linux/version.txt', (_req: Request, res: Response) => {
  const f = path.join(LINUX_DIR, 'version.txt');
  if (!fs.existsSync(f)) { res.status(404).type('text/plain').send(''); return; }
  res.type('text/plain').sendFile(f);
});

router.get('/agent/linux/:rid/:file', (req: Request, res: Response) => {
  const rid = String(req.params.rid);
  const file = String(req.params.file);
  // Allow-list both halves. Anything reaching a path segment straight from a URL onto the
  // filesystem is one ".." away from being a file server for the whole app.
  if (!LINUX_RIDS.includes(rid) || !['lumenmsp-agent', 'sha256.txt'].includes(file)) {
    res.status(404).send('Not found'); return;
  }
  const f = path.join(LINUX_DIR, rid, file);
  if (!fs.existsSync(f)) { res.status(404).send('Not published yet'); return; }
  res.download(f, file);
});

// ── macOS agent ─────────────────────────────────────────────────────────────────
// Identical shape to the Linux block — the installer is a shell script, the binary is
// the self-contained Posix agent built for osx-*, and the secret stays the site key.
//
//   curl -fsSL https://portal/agent/macos/install.sh | sudo bash -s -- --site-key KEY
const MACOS_DIR = path.join(AGENT_MSI_DIR, 'macos');
const MACOS_RIDS = ['osx-x64', 'osx-arm64'];

router.get('/agent/macos/install.sh', (_req: Request, res: Response) => {
  const f = path.join(MACOS_DIR, 'install.sh');
  if (!fs.existsSync(f)) { res.status(404).type('text/plain').send('# No macOS agent has been published yet.\n'); return; }
  res.type('text/x-shellscript').sendFile(f);
});

router.get('/agent/macos/version.txt', (_req: Request, res: Response) => {
  const f = path.join(MACOS_DIR, 'version.txt');
  if (!fs.existsSync(f)) { res.status(404).type('text/plain').send(''); return; }
  res.type('text/plain').sendFile(f);
});

router.get('/agent/macos/:rid/:file', (req: Request, res: Response) => {
  const rid = String(req.params.rid);
  const file = String(req.params.file);
  if (!MACOS_RIDS.includes(rid) || !['lumenmsp-agent', 'sha256.txt'].includes(file)) {
    res.status(404).send('Not found'); return;
  }
  const f = path.join(MACOS_DIR, rid, file);
  if (!fs.existsSync(f)) { res.status(404).send('Not published yet'); return; }
  res.download(f, file);
});

// GET /agent/download/LumenMSPAgent-<sitekey>.msi — public capability URL: the key in
// the filename both authorises the download AND enrolls the install (the MSI records
// its own launch path, and the service parses the key back out of the filename), so a
// plain double-click needs no SITEKEY property. Safe to hand to a customer's IT / RMM.
router.get('/agent/download/:file', async (req: Request, res: Response) => {
  const m = String(req.params.file || '').match(/^LumenMSPAgent-LMA-([0-9a-f]{8,64})\.msi$/i);
  if (!m) { res.status(404).send('Not found'); return; }
  const key = 'LMA-' + m[1].toLowerCase();
  try {
    const cust = await pool.query('SELECT id FROM customers WHERE agent_site_key=$1 AND deleted_at IS NULL LIMIT 1', [key]);
    if (!cust.rows.length) { res.status(404).send('Unknown installer'); return; }
    if (!agentMsiInfo()) { res.status(503).send('The agent installer has not been uploaded to the portal yet.'); return; }
    res.download(AGENT_MSI_PATH, `LumenMSPAgent-${key}.msi`);
  } catch {
    res.status(500).send('Download failed');
  }
});

// ── Device auth (Bearer device token) ──────────────────────────────────────────
async function requireDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token || token.length < 32) { res.status(401).json({ ok: false, error: 'missing device token' }); return; }
  try {
    const r = await pool.query('SELECT * FROM agent_devices WHERE token_hash=$1 AND revoked=false LIMIT 1', [sha256(token)]);
    if (!r.rows.length) { res.status(401).json({ ok: false, error: 'unknown or revoked device' }); return; }
    (req as any).agentDevice = r.rows[0];
    next();
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'auth failed' });
  }
}

// Which RMM installer this customer's machines should fetch, in priority order:
//   1. an explicit per-customer URL,
//   2. the URL TEMPLATE with {cid} swapped for this customer's Atera id,
//   3. the global fallback URL.
// The template matters because Atera's install URL carries a per-customer `cid` — one
// global URL would enrol every machine in the estate into a single Atera account. Since
// customers.atera_customer_id is already synced, step 2 needs no per-customer setup.
async function rmmConfig(customerId: number | null): Promise<{ url: string | null; args: string }> {
  let url: string | null = null;
  let ateraId: string | null = null;
  if (customerId) {
    const r = await pool.query('SELECT rmm_installer_url, atera_customer_id FROM customers WHERE id=$1', [customerId]);
    url = (r.rows[0]?.rmm_installer_url || '').trim() || null;
    ateraId = String(r.rows[0]?.atera_customer_id || '').trim() || null;
  }
  if (!url) {
    const tpl = ((await getSetting('agent', 'rmm_installer_template')) || '').trim();
    if (tpl && ateraId && tpl.includes('{cid}')) url = tpl.split('{cid}').join(encodeURIComponent(ateraId));
  }
  if (!url) url = ((await getSetting('agent', 'rmm_installer_url')) || '').trim() || null;
  const args = ((await getSetting('agent', 'rmm_install_args')) || '').trim() || '/qn /norestart';
  return { url, args };
}

// Config pushed down to every device on enroll + heartbeat. `agent_latest_version` is
// what drives self-update: agents compare it to their own build and upgrade themselves.
// Blank/unset = auto-update disabled (deliberate: no version, no push).
// Rollout stage for the CURRENT hosted build: -1 halted, 0 internal, 1 pilot, 2 everyone.
// A newly published version always starts at 0 — publishing must never be the same act as
// releasing to every customer machine. Detected by comparing the hosted version to the one
// the stage was last recorded against.
export async function rolloutState(): Promise<{ version: string | null; stage: number }> {
  const version = agentHostedVersion() || ((await getSetting('agent', 'latest_version')) || '').trim() || null;
  if (!version) return { version: null, stage: -1 };
  const stagedFor = ((await getSetting('agent', 'rollout_version')) || '').trim();
  if (stagedFor !== version) {
    await setSetting('agent', 'rollout_version', version);
    await setSetting('agent', 'rollout_stage', '0');
    return { version, stage: 0 };
  }
  const raw = parseInt(((await getSetting('agent', 'rollout_stage')) || '0').trim(), 10);
  return { version, stage: Number.isFinite(raw) ? raw : 0 };
}

async function deviceConfig(customerId: number | null, deviceRing = 2) {
  const rmm = await rmmConfig(customerId);
  const { version, stage } = await rolloutState();
  // Offer the build only once the rollout has reached this device's ring.
  const offered = version && stage >= 0 && deviceRing <= stage ? version : null;
  return {
    // 2 minutes, not 5. This is the backstop signal for "is it still there" - the
    // command long-poll is what actually keeps a live machine current - and it has to
    // beat comfortably inside ONLINE_WINDOW_SECS or a device whose command worker has
    // stopped would flap. Server-side, so changing it needs no agent build.
    heartbeat_seconds: 120,
    chat_poll_seconds: 20,
    rmm_installer_url: rmm.url,
    rmm_install_args: rmm.args,
    agent_latest_version: offered,
    agent_latest_sha256: offered ? agentHostedSha256() : null,
  };
}

// ── Enrollment ──────────────────────────────────────────────────────────────────
// POST /agent/api/enroll { site_key, hostname, serial_number?, os?, os_version?, agent_version? }
// Idempotent per machine: an existing row for the same customer + serial (or hostname when no
// serial) is re-used — a reinstall re-keys the device rather than creating a duplicate.
router.post('/agent/api/enroll', async (req: Request, res: Response) => {
  const b = req.body || {};
  const siteKey = s(b.site_key, 100);
  const hostname = s(b.hostname, 200);
  if (!siteKey || !hostname) { res.status(400).json({ ok: false, error: 'site_key and hostname are required' }); return; }

  const cust = await pool.query('SELECT id, name FROM customers WHERE agent_site_key=$1 AND deleted_at IS NULL LIMIT 1', [siteKey]);
  if (!cust.rows.length) { res.status(401).json({ ok: false, error: 'invalid site key' }); return; }
  const customerId = cust.rows[0].id;

  const serial = s(b.serial_number, 120);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const osVersion = s(b.os_version, 100);
  // Windows 11 reports itself as "Windows 10 Pro" - see lib/os-name.ts.
  const os = windowsOsName(s(b.os, 200), osVersion);
  const agentVersion = s(b.agent_version, 50);
  const hw = hardware(b);

  try {
    // Same machine re-enrolling? Match serial first (survives renames), then hostname.
    let existing = null as any;
    if (serial) {
      existing = (await pool.query('SELECT id FROM agent_devices WHERE customer_id=$1 AND serial_number=$2 LIMIT 1', [customerId, serial])).rows[0] || null;
    }
    if (!existing) {
      existing = (await pool.query('SELECT id FROM agent_devices WHERE customer_id=$1 AND LOWER(hostname)=LOWER($2) LIMIT 1', [customerId, hostname])).rows[0] || null;
    }
    let deviceId: number;
    if (existing) {
      deviceId = existing.id;
      await pool.query(
        `UPDATE agent_devices SET token_hash=$1, hostname=$2, serial_number=COALESCE($3, serial_number), os=COALESCE($4, os),
           os_version=COALESCE($5, os_version), agent_version=COALESCE($6, agent_version), revoked=false,
           public_ip=$7,
           manufacturer=COALESCE($9, manufacturer), model=COALESCE($10, model), cpu=COALESCE($11, cpu),
           ram_gb=COALESCE($12, ram_gb), mac_addresses=COALESCE($13, mac_addresses),
           domain_or_workgroup=COALESCE($14, domain_or_workgroup), device_type=COALESCE($15, device_type),
           last_boot_at=COALESCE($16, last_boot_at),
           enrolled_at=NOW(), last_seen_at=NOW(), updated_at=NOW() WHERE id=$8`,
        [tokenHash, hostname, serial, os, osVersion, agentVersion, clientIp(req), deviceId,
         hw.manufacturer, hw.model, hw.cpu, hw.ramGb, hw.macAddresses, hw.domainOrWorkgroup, hw.deviceType, hw.lastBootAt]
      );
    } else {
      const ins = await pool.query(
        `INSERT INTO agent_devices (customer_id, hostname, serial_number, os, os_version, agent_version, token_hash, public_ip,
           manufacturer, model, cpu, ram_gb, mac_addresses, domain_or_workgroup, device_type, last_boot_at, enrolled_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW()) RETURNING id`,
        [customerId, hostname, serial, os, osVersion, agentVersion, tokenHash, clientIp(req),
         hw.manufacturer, hw.model, hw.cpu, hw.ramGb, hw.macAddresses, hw.domainOrWorkgroup, hw.deviceType, hw.lastBootAt]
      );
      deviceId = ins.rows[0].id;
    }
    await logActivity(null, existing ? 'agent_reenrolled' : 'agent_enrolled', 'agent_devices', deviceId, `${hostname} enrolled for ${cust.rows[0].name}`);

    // Remote access rides along with enrollment — a device that arrives without
    // MeshCentral is a device somebody has to remember to visit later, and nobody does.
    // Dynamic import on purpose: mesh.ts imports AGENT_PKG_DIR and wakeAgent from here,
    // so a top-level import would be a cycle.
    try {
      const { queueMeshInstall } = await import('./mesh');
      await queueMeshInstall(deviceId, `${req.protocol}://${req.get('host')}`);
    } catch (e: any) { console.error('[mesh] enrol hook:', e.message); }

    // The Portal's own device record, written here rather than waiting for an Atera sync.
    // This is what makes a freshly enrolled machine appear on /assets - with a working
    // remote-control button - within seconds of the agent landing.
    await syncAssetFromAgent(deviceId);

    // Tell whoever is at a screen. NEW machines only: a machine coming back after a
    // rebuild re-enrols, and calling that "new device enrolled" would train people to
    // ignore the card on the day it actually matters. Fires AFTER syncAssetFromAgent so
    // that clicking through to /assets finds the machine already there.
    if (!existing) {
      const { toastDeviceEnrolled } = await import('../lib/staff-toast');
      toastDeviceEnrolled({ hostname, customerId, customerName: cust.rows[0].name });
    }

    // Bitdefender rides along too, for the same reason remote access does: a machine that
    // arrives unprotected is one somebody has to remember to go back to, and nobody does.
    // AFTER syncAssetFromAgent, because the catch-up looks the machine up through its
    // customer_assets row - running it first would find nothing and quietly do nothing.
    //
    // It is gated, not automatic: catchUpBitdefender only proceeds when the customer has
    // been ENABLED, which is a human mapping both a GravityZone company and an install
    // package. A customer nobody signed off never gets an install, because enabling them
    // is where someone takes responsibility for stripping the incumbent AV off their
    // machines.
    try {
      const { catchUpBitdefender } = await import('../lib/gravityzone-deploy');
      await catchUpBitdefender(deviceId);
    } catch (e: any) { console.error('[gz] enrol hook:', e.message); }

    res.status(existing ? 200 : 201).json({ ok: true, device_id: deviceId, device_token: token, customer: cust.rows[0].name, config: await deviceConfig(customerId, 2) });
  } catch (e: any) {
    console.error('[agent] enroll failed:', e.message);
    res.status(500).json({ ok: false, error: 'enrollment failed' });
  }
});

// ── Heartbeat + system info ─────────────────────────────────────────────────────
// POST /agent/api/heartbeat — every 5 min and on demand. Body mirrors the tray's System
// Info panel; public IP is what WE see (authoritative — no external what's-my-ip needed).
router.post('/agent/api/heartbeat', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const b = req.body || {};
  let localIps: string | null = null;
  if (Array.isArray(b.local_ips)) localIps = b.local_ips.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 16).join(', ') || null;
  let diskInfo: string | null = null;
  try { const j = JSON.stringify(b.disks ?? null); diskInfo = j && j !== 'null' ? j.slice(0, 4000) : null; } catch { diskInfo = null; }
  const hw = hardware(b);
  try {
    await pool.query(
      `UPDATE agent_devices SET hostname=COALESCE($1, hostname), os=COALESCE($2, os), os_version=COALESCE($3, os_version),
         agent_version=COALESCE($4, agent_version), logged_in_user=$5, local_ips=$6, disk_info=$7,
         public_ip=$8,
         manufacturer=COALESCE($10, manufacturer), model=COALESCE($11, model), cpu=COALESCE($12, cpu),
         ram_gb=COALESCE($13, ram_gb), mac_addresses=COALESCE($14, mac_addresses),
         domain_or_workgroup=COALESCE($15, domain_or_workgroup), device_type=COALESCE($16, device_type),
         last_boot_at=COALESCE($17, last_boot_at), serial_number=COALESCE($18, serial_number),
         last_seen_at=NOW(), updated_at=NOW() WHERE id=$9`,
      [s(b.hostname, 200), windowsOsName(s(b.os, 200), s(b.os_version, 100)), s(b.os_version, 100), s(b.agent_version, 50),
       s(b.logged_in_user, 200), localIps, diskInfo, clientIp(req), d.id,
       hw.manufacturer, hw.model, hw.cpu, hw.ramGb, hw.macAddresses, hw.domainOrWorkgroup, hw.deviceType, hw.lastBootAt,
       s(b.serial_number, 120)]
    );
    // Keep the Portal's device record live off the heartbeat, so /assets is current
    // without anybody syncing anything.
    await syncAssetFromAgent(d.id);

    // Clear out any command the agent was killed in the middle of BEFORE deciding whether
    // a remote-access install is still outstanding. Without this, one orphaned mesh.install
    // stuck in 'running' blocks every future attempt for the life of the device - which is
    // exactly how a machine sits on "Installing remote access..." for hours while switched on.
    await reapStaleCommands();

    // Catches devices that enrolled before their customer had a MeshCentral group, and
    // any machine where the install failed and was cleared. Cheap: returns immediately
    // unless there is genuinely something to queue.
    if (!d.mesh_installed) {
      try {
        const { queueMeshInstall } = await import('./mesh');
        await queueMeshInstall(d.id, `${req.protocol}://${req.get('host')}`);
      } catch { /* never let this break a heartbeat */ }
    }

    // Same idea, for Bitdefender: a machine that was off during its customer's rollout
    // catches itself up when it reappears. Guarded hard in catchUpBitdefender — held-back
    // machines are never touched, and it gives up after three failed attempts rather than
    // retrying at every heartbeat forever.
    try {
      const { catchUpBitdefender } = await import('../lib/gravityzone-deploy');
      await catchUpBitdefender(d.id);
    } catch { /* never let this break a heartbeat */ }

    // BitLocker, on the same principle but on a clock. A machine with no reading is due
    // immediately, so it converges on this very check-in; after that it re-reads on the
    // interval, because Windows rotates a protector once it has been used and a key that
    // is quietly out of date is worse than no key — somebody reads it out and it fails.
    try {
      const { maybeQueueBitlockerScan } = await import('../lib/bitlocker');
      await maybeQueueBitlockerScan(d.id);
    } catch { /* never let this break a heartbeat */ }

    res.json({ ok: true, public_ip: clientIp(req), config: await deviceConfig(d.customer_id, d.update_ring ?? 2) });
  } catch (e: any) {
    console.error('[agent] heartbeat failed:', e.message);
    res.status(500).json({ ok: false, error: 'heartbeat failed' });
  }
});

// Public IP echo — the tray's System Info panel shows the address the portal sees.
router.get('/agent/api/ip', requireDevice, (req: Request, res: Response) => {
  res.json({ ok: true, ip: clientIp(req) });
});

// ── Self-update feed ────────────────────────────────────────────────────────────
// The agent pulls its own next build here, authenticated with its DEVICE TOKEN — the
// site key is deleted from the machine after enrollment, so the public keyed URL isn't
// available by update time.
router.get('/agent/api/installer', requireDevice, (req: Request, res: Response) => {
  if (!agentMsiInfo()) { res.status(503).json({ ok: false, error: 'no installer uploaded' }); return; }
  res.download(AGENT_MSI_PATH, 'LumenMSPAgent.msi');
});

// ── Chat: device → helpdesk ─────────────────────────────────────────────────────
// The device's open agent case, or null. One live case per device keeps the thread in
// one place; a resolved/closed case stays closed — the next message opens a fresh one.
async function openAgentTicket(deviceId: number): Promise<any | null> {
  const r = await pool.query(
    `SELECT id, ticket_number, status FROM inbox_tickets
     WHERE agent_device_id=$1 AND deleted_at IS NULL AND status NOT IN ('resolved','closed')
     ORDER BY id DESC LIMIT 1`, [deviceId]);
  return r.rows[0] || null;
}

router.post('/agent/api/chat/message', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const text = String((req.body || {}).text || '').trim().slice(0, 8000);
  if (!text) { res.status(400).json({ ok: false, error: 'text is required' }); return; }
  const fromName = [d.logged_in_user, d.hostname].filter(Boolean).join(' @ ') || d.hostname || 'Agent user';
  try {
    let t = await openAgentTicket(d.id);
    if (!t) {
      // Link the requester when the device maps to an Atera asset with an assigned contact.
      let contactId: number | null = null;
      try {
        const m = await pool.query(
          `SELECT assigned_contact_id FROM customer_assets
           WHERE customer_id=$1 AND assigned_contact_id IS NOT NULL
             AND (($2::text IS NOT NULL AND serial_number=$2) OR LOWER(hostname)=LOWER($3)) LIMIT 1`,
          [d.customer_id, d.serial_number, d.hostname || '']);
        contactId = m.rows[0]?.assigned_contact_id || null;
      } catch { /* optional nicety */ }
      const tn = await nextTicketNumber();
      const ins = await pool.query(
        `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, agent_device_id, status, department, subject, description, activity_status, stage, last_customer_message_at, updated_at)
         VALUES ($1,'agent',$2,$3,$4,'new','support',$5,$6,'unread','awaiting_triage',NOW(),NOW()) RETURNING id, ticket_number`,
        [tn, d.customer_id, contactId, d.id, `Agent chat — ${d.hostname || 'device'}${d.logged_in_user ? ' (' + d.logged_in_user + ')' : ''}`, text.slice(0, 2000)]);
      t = { id: ins.rows[0].id, ticket_number: ins.rows[0].ticket_number, status: 'new' };
      await logActivity(null, 'created', 'tickets', t.id, `Agent chat case ${t.ticket_number} opened from ${d.hostname}`);
    }
    // from_email carries the hostname: it is this channel's "peer address", which is what
    // the Messages inbox threads on (same role as the number for WhatsApp).
    await pool.query(
      `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, processing_status, is_unread, from_name, from_email, subject, body_text, received_at)
       VALUES ($1,'portal@lumenmsp.co.uk','inbound','agent','matched',true,$2,$3,$4,$5,NOW())`,
      [t.id, fromName, d.hostname || ('device-' + d.id), 'Agent chat message', text]);
    // A user reply puts the ball back with us: an awaiting-customer case returns to the queue.
    await pool.query(
      `UPDATE inbox_tickets SET last_customer_message_at=NOW(), activity_status='unread',
         status = CASE WHEN status='awaiting_customer' THEN 'awaiting_engineer' ELSE status END,
         updated_at=NOW() WHERE id=$1`, [t.id]);
    res.status(201).json({ ok: true, ticket_id: t.id, ticket_number: t.ticket_number });
  } catch (e: any) {
    console.error('[agent] chat message failed:', e.message);
    res.status(500).json({ ok: false, error: 'message not saved' });
  }
});

// ── Chat: helpdesk → device (pull) ──────────────────────────────────────────────
// GET /agent/api/chat/updates?since=<note id> — staff public replies sent on the Agent
// channel, across ALL this device's agent cases (so a reply on a just-resolved case still
// reaches the user). Bodies are flattened to plain text for the tray.
router.get('/agent/api/chat/updates', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const since = parseInt(String(req.query.since || '0'), 10) || 0;
  try {
    const notes = await pool.query(
      `SELECT n.id, n.body, n.created_at, u.display_name AS author, t.ticket_number
       FROM inbox_notes n
       JOIN inbox_tickets t ON t.id=n.ticket_id
       LEFT JOIN users u ON u.id=n.user_id
       WHERE t.agent_device_id=$1 AND n.note_type='public_reply' AND n.channel='agent' AND n.id>$2
       ORDER BY n.id ASC LIMIT 50`, [d.id, since]);
    const t = await openAgentTicket(d.id);
    res.json({
      ok: true,
      open_ticket: t ? { id: t.id, number: t.ticket_number, status: t.status } : null,
      messages: notes.rows.map((n: any) => ({
        id: n.id,
        from: n.author || 'Lumen IT',
        text: htmlToPlain(n.body || ''),
        at: n.created_at,
        ticket: n.ticket_number,
      })),
    });
  } catch (e: any) {
    console.error('[agent] chat poll failed:', e.message);
    res.status(500).json({ ok: false, error: 'poll failed' });
  }
});

// ── Software inventory (cached, so it outlives the device being off) ───────────
export const AGENT_PKG_DIR = path.join(AGENT_MSI_DIR, 'packages');
export const AGENT_XFER_DIR = path.join(AGENT_MSI_DIR, 'transfer');

// A device sending a file up for an admin to download. Stored under a random id and
// named `<id>__<original>`; nothing here is guessable or publicly listed.
const xferUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(AGENT_XFER_DIR, { recursive: true }); cb(null, AGENT_XFER_DIR); },
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '__' +
      (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)),
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

router.post('/agent/api/file-upload', requireDevice, xferUpload.single('file'), (req: Request, res: Response) => {
  const f = (req as any).file;
  if (!f) { res.status(400).json({ ok: false, error: 'no file' }); return; }
  res.json({ ok: true, id: path.basename(f.filename).split('__')[0] });
});

// The agent collecting a file an admin uploaded for it.
router.get('/agent/api/transfer/:id', requireDevice, (req: Request, res: Response) => {
  const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
  if (id.length !== 32) { res.status(400).json({ ok: false, error: 'bad id' }); return; }
  try {
    const match = fs.readdirSync(AGENT_XFER_DIR).find((f) => f.startsWith(id + '__'));
    if (!match) { res.status(404).json({ ok: false, error: 'not found' }); return; }
    res.download(path.join(AGENT_XFER_DIR, match), match.split('__').slice(1).join('__'));
  } catch { res.status(500).json({ ok: false, error: 'transfer failed' }); }
});

router.post('/agent/api/inventory', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const list = (req.body || {}).software;
  if (!Array.isArray(list)) { res.status(400).json({ ok: false, error: 'software must be an array' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Replace wholesale: a partial merge would leave uninstalled software on the list
    // for ever, which is worse than briefly having none.
    await client.query('DELETE FROM agent_software WHERE device_id=$1', [d.id]);
    for (const a of list.slice(0, 2000)) {
      const name = s(a?.name, 300);
      if (!name) continue;
      await client.query(
        `INSERT INTO agent_software (device_id, name, version, publisher, size_mb, install_date, uninstall_cmd, product_code, scope)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.id, s(name, 300),
         s(a.version, 100),
         s(a.publisher, 200),
         a.size_mb != null && !isNaN(Number(a.size_mb)) ? Number(a.size_mb) : null,
         s(a.install_date, 20),
         s(a.uninstall_cmd, 1000),
         s(a.product_code, 100),
         s(a.scope, 20)]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, stored: list.length });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    console.error('[agent] inventory store failed:', e.message);
    res.status(500).json({ ok: false, error: 'inventory not stored' });
  } finally { client.release(); }
});

// ── Pending Windows Updates ─────────────────────────────────────────────────────
// Posted on the daily inventory pass. Rows are UPSERTED rather than replaced so that
// first_seen survives: "this machine has been missing a critical update for 40 days" is
// the number that matters, and a wholesale replace would reset it every night.
router.post('/agent/api/patches', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const p = (req.body || {}).patches;
  if (!p || typeof p !== 'object') { res.status(400).json({ ok: false, error: 'patches object required' }); return; }

  // PowerShell's ConvertTo-Json collapses a single-element array into an object, so a
  // machine with exactly one pending update arrives shaped differently from one with two.
  let updates: any[] = Array.isArray(p.updates) ? p.updates : (p.updates ? [p.updates] : []);
  updates = updates.filter((u) => u && String(u.update_id || '').trim());

  // Third-party updates arrive alongside the Windows ones and share the same table,
  // separated by `source` — one list is what anyone actually wants to look at.
  const rawApps = (req.body || {}).apps;
  const apps: any[] = (Array.isArray(rawApps) ? rawApps : (rawApps ? [rawApps] : []))
    .filter((a) => a && String(a.id || '').trim());

  const rebootRequired = p.reboot_required === true || p.reboot_required === 'True';
  const lastInstalled = s(p.last_installed, 20);
  const isUrgent = (sev: any) => ['critical', 'important'].includes(String(sev || '').toLowerCase());
  const critical = updates.filter((u) => isUrgent(u.severity)).length;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seen: string[] = [];

    for (const u of updates.slice(0, 500)) {
      const id = String(u.update_id).trim().slice(0, 100);
      seen.push(id);
      await client.query(
        `INSERT INTO device_patches
           (device_id, update_id, title, kb, severity, categories, size_mb, downloaded, source, first_seen, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'windows',NOW(),NOW())
         ON CONFLICT (device_id, update_id) DO UPDATE SET
           title = EXCLUDED.title, kb = EXCLUDED.kb, severity = EXCLUDED.severity,
           categories = EXCLUDED.categories, size_mb = EXCLUDED.size_mb,
           downloaded = EXCLUDED.downloaded, last_seen = NOW()`,
        [d.id, id,
         s(u.title, 500) || '',
         s(u.kb, 100),
         s(u.severity, 40),
         s(u.categories, 300),
         u.size_mb != null && !isNaN(Number(u.size_mb)) ? Number(u.size_mb) : null,
         u.downloaded === true]);
    }

    for (const a of apps.slice(0, 500)) {
      // Namespaced so a WinGet id can never collide with a Chocolatey one.
      const id = `${String(a.source || 'app')}:${String(a.id).trim()}`.slice(0, 100);
      seen.push(id);
      await client.query(
        `INSERT INTO device_patches
           (device_id, update_id, title, severity, source, current_version, available_version, first_seen, last_seen)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,NOW(),NOW())
         ON CONFLICT (device_id, update_id) DO UPDATE SET
           title = EXCLUDED.title, source = EXCLUDED.source,
           current_version = EXCLUDED.current_version,
           available_version = EXCLUDED.available_version, last_seen = NOW()`,
        [d.id, id, s(a.name, 300) || id, s(a.source, 20) || 'app',
         s(a.current, 60), s(a.available, 60)]);
    }

    // Anything not in this scan has been installed (or superseded) since the last one.
    await client.query(
      `DELETE FROM device_patches WHERE device_id = $1 AND NOT (update_id = ANY($2::text[]))`,
      [d.id, seen]);

    await client.query(
      `UPDATE agent_devices
          SET patch_scan_at = NOW(), reboot_required = $1, patch_pending = $2,
              patch_critical = $3, patch_last_installed = $4, updated_at = NOW()
        WHERE id = $5`,
      [rebootRequired, updates.length + apps.length, critical, lastInstalled, d.id]);

    await client.query('COMMIT');
    res.json({ ok: true, pending: updates.length, apps: apps.length, critical });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    console.error('[agent] patch store failed:', e.message);
    res.status(500).json({ ok: false, error: 'patches not stored' });
  } finally { client.release(); }
});

// ── Security status ─────────────────────────────────────────────────────────────
// Posted on the daily inventory pass (and on demand via the security.status command).
// Facts only - the agent reports what Windows said, and the Portal judges it, so the
// bar for "OK" can tighten without touching an agent on a customer machine.
router.post('/agent/api/security', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const sec = (req.body || {}).security;
  if (!sec || typeof sec !== 'object') { res.status(400).json({ ok: false, error: 'security object required' }); return; }
  try {
    const json = JSON.stringify(sec).slice(0, 20000);
    await pool.query(
      `UPDATE agent_devices SET security_json=$1, security_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [json, d.id]);
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[agent] security store failed:', e.message);
    res.status(500).json({ ok: false, error: 'security not stored' });
  }
});

// Package download for software deployment. Device-token auth: an uploaded MSI is not
// public, and the agent runs whatever this returns as SYSTEM.
router.get('/agent/api/package/:id', requireDevice, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const p = (await pool.query('SELECT file_name, name FROM agent_packages WHERE id=$1', [id])).rows[0];
    if (!p || !p.file_name) { res.status(404).json({ ok: false, error: 'unknown package' }); return; }
    const full = path.join(AGENT_PKG_DIR, path.basename(p.file_name));
    if (!fs.existsSync(full)) { res.status(404).json({ ok: false, error: 'package file missing' }); return; }
    res.download(full, path.basename(p.file_name));
  } catch {
    res.status(500).json({ ok: false, error: 'download failed' });
  }
});

// ── Remote-tool command queue ───────────────────────────────────────────────────
// The Tools tab queues rows; agents long-poll here. An in-process waiter map lets a
// queued command wake its device instantly instead of waiting out the poll interval
// (the portal runs as a single PM2 fork, so in-memory coordination is sound).
type Waiter = () => void;
const commandWaiters = new Map<number, Set<Waiter>>();

export function wakeAgent(deviceId: number): void {
  const set = commandWaiters.get(deviceId);
  if (!set) return;
  for (const w of Array.from(set)) { try { w(); } catch { /* ignore */ } }
  commandWaiters.delete(deviceId);
}

function waitForCommand(deviceId: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      commandWaiters.get(deviceId)?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (!commandWaiters.has(deviceId)) commandWaiters.set(deviceId, new Set());
    commandWaiters.get(deviceId)!.add(finish);
  });
}

async function takeQueued(deviceId: number): Promise<any[]> {
  // Claim atomically so a duplicate poll (retry, restart) can't run a command twice.
  // Remote access goes out FIRST regardless of when it was queued: getting a hands-free
  // way onto a machine matters more than any inventory job sitting in front of it, and
  // the agent runs what it is handed in order.
  const r = await pool.query(
    `UPDATE agent_commands SET status='running', started_at=NOW()
      WHERE id IN (SELECT id FROM agent_commands
                     WHERE device_id=$1 AND status='queued'
                       AND (run_after IS NULL OR run_after <= NOW())
                     ORDER BY (kind = 'mesh.install') DESC, id LIMIT 5)
      RETURNING id, kind, payload`, [deviceId]);
  return r.rows;
}

router.get('/agent/api/commands', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const waitSec = Math.min(30, Math.max(0, parseInt(String(req.query.wait || '0'), 10) || 0));
  try {
    // Housekeeping on the way past (throttled internally to once a minute).
    reapStaleCommands().catch(() => {});
    let rows = await takeQueued(d.id);
    if (!rows.length && waitSec > 0) {
      await waitForCommand(d.id, waitSec * 1000);
      rows = await takeQueued(d.id);
    }
    // Heartbeat-by-proxy: a polling agent is demonstrably alive.
    pool.query('UPDATE agent_devices SET last_seen_at=NOW() WHERE id=$1', [d.id]).catch(() => {});
    res.json({ ok: true, commands: rows.map((r: any) => ({ id: r.id, kind: r.kind, payload: r.payload || null })) });
  } catch (e: any) {
    console.error('[agent] command poll failed:', e.message);
    res.status(500).json({ ok: false, error: 'poll failed' });
  }
});

// Progress while a command is still running. The agent streams the tail of the output as
// it appears; a script that knows how far along it is says so with a [[progress:n]]
// marker, which the agent strips out and sends as a percentage. Nothing here changes the
// command's status — this is only so a ten-minute install stops looking like a hung window.
router.post('/agent/api/commands/:id/progress', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};
  const pctRaw = parseInt(String(b.pct), 10);
  const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : null;
  const text = noNul(String(b.text ?? '')).slice(-4000);
  try {
    await pool.query(
      `UPDATE agent_commands SET progress=$1, progress_pct=$2, progress_at=NOW()
        WHERE id=$3 AND device_id=$4 AND status IN ('queued','running')`,
      [text || null, pct, id, d.id]);
    res.json({ ok: true });
  } catch {
    // Progress is decoration. Never fail the command over it.
    res.json({ ok: true });
  }
});

// How much of a command's output we keep. Console output is chatty and worthless past a
// screenful; a structured inventory is worthless if it is cut off AT ALL, because the
// JSON stops parsing and the whole run is thrown away. Truncating one of those in the
// middle produced a collection that succeeded, stored nothing, and said nothing.
const OUTPUT_LIMIT_DEFAULT = 400_000;
const OUTPUT_LIMITS: Record<string, number> = {
  'gpo.inventory': 4_000_000,   // a large domain reports far more than 400k
  'server.facts': 2_000_000,
  'ce.assess': 2_000_000,
};

router.post('/agent/api/commands/:id/result', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};
  const exitCode = Number.isFinite(parseInt(String(b.exit_code), 10)) ? parseInt(String(b.exit_code), 10) : null;
  try {
    // The kind decides how much we keep, so it has to be read before the write.
    const known = await pool.query('SELECT kind FROM agent_commands WHERE id=$1 AND device_id=$2', [id, d.id]);
    if (!known.rows.length) { res.status(404).json({ ok: false, error: 'unknown command' }); return; }
    const kind = String(known.rows[0].kind || '');
    const output = String(b.output ?? '').slice(0, OUTPUT_LIMITS[kind] ?? OUTPUT_LIMIT_DEFAULT);

    // payload=NULL on completion: a reset password must not sit in the database after use.
    const r = await pool.query(
      `UPDATE agent_commands SET status=$1, exit_code=$2, output=$3, finished_at=NOW(), payload=NULL
        WHERE id=$4 AND device_id=$5 RETURNING kind`,
      [exitCode === 0 ? 'done' : 'failed', exitCode, output, id, d.id]);
    if (!r.rows.length) { res.status(404).json({ ok: false, error: 'unknown command' }); return; }
    // A Cyber Essentials run comes back as ordinary command output. Turn it into
    // findings here and now, but never let that failure reach the machine - the
    // agent is waiting on this response and has done its part correctly.
    if (r.rows[0].kind === 'ce.assess') {
      ingestCeResult(id).catch((err: any) => console.error('[ce] ingest failed:', err.message));
    }
    if (r.rows[0].kind === 'server.facts') {
      ingestServerFacts(id).catch((err: any) => console.error('[servers] ingest failed:', err.message));
    }
    // A BitLocker scan rides on shell.powershell so it could ship without an agent
    // rollout, so it is identified by a marker in its own output rather than by kind.
    // The output is REPLACED with a summary the moment it is ingested: recovery keys
    // must not sit in agent_commands.output in the clear, where the console history
    // would happily show them to anyone who can read a command log.
    if (r.rows[0].kind === 'shell.powershell' && looksLikeBitlockerScan(output)) {
      ingestBitlockerScan(d.id, output)
        .then(async (kept) => {
          await pool.query('UPDATE agent_commands SET output=$1 WHERE id=$2',
            [`BitLocker scan stored - ${kept} recovery key(s) kept. Output redacted.`, id]);
        })
        .catch(async (err: any) => {
          console.error('[bitlocker] ingest failed:', err.message);
          await pool.query('UPDATE agent_commands SET output=$1 WHERE id=$2',
            ['BitLocker scan could not be stored. Output redacted.', id]).catch(() => {});
        });
    }
    if (r.rows[0].kind === 'gpo.inventory') {
      ingestGpoInventory(id).catch((err: any) => console.error('[gpo] ingest failed:', err.message));
    }
    if (r.rows[0].kind === 'gpo.delete') {
      ingestGpoDelete(id).catch((err: any) => console.error('[gpo] delete ingest failed:', err.message));
    }
    if (r.rows[0].kind === 'gpo.unlink') {
      ingestGpoUnlink(id).catch((err: any) => console.error('[gpo] unlink ingest failed:', err.message));
    }
    if (r.rows[0].kind === 'gpo.restore') {
      ingestGpoRestore(id).catch((err: any) => console.error('[gpo] restore ingest failed:', err.message));
    }
    // The Mesh Agent is now on the machine. Record that here, where we actually learn it.
    // Until this existed, mesh_installed was only ever set by the bridge - so a machine
    // the bridge could not link looked "never installed" forever, and the heartbeat below
    // queued another install every two minutes, tearing the Mesh Agent down and putting it
    // back for the life of the device.
    if (r.rows[0].kind === 'mesh.install' && exitCode === 0) {
      await pool.query(
        'UPDATE agent_devices SET mesh_installed=true, mesh_installed_at=NOW(), updated_at=NOW() WHERE id=$1',
        [d.id]).catch((err: any) => console.error('[mesh] install flag failed:', err.message));
    }
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[agent] command result failed:', e.message);
    res.status(500).json({ ok: false, error: 'result not saved' });
  }
});

// ── Tool results ────────────────────────────────────────────────────────────────
// POST /agent/api/tools/result { tool, ok, detail } — audit trail for Release/Renew,
// Flush DNS and RMM reinstall runs, plus a case note when the device has an open chat.
router.post('/agent/api/tools/result', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const b = req.body || {};
  const tool = s(b.tool, 60) || 'unknown';
  const ok = b.ok === true || b.ok === 'true';
  const detail = s(b.detail, 1500) || '';
  try {
    await logActivity(null, 'agent_tool', 'agent_devices', d.id, `${d.hostname}: ${tool} ${ok ? 'succeeded' : 'FAILED'}${detail ? ' — ' + detail : ''}`);
    const t = await openAgentTicket(d.id);
    if (t) {
      await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,NULL,'system_log',$2)`,
        [t.id, `Agent tool on ${d.hostname}: ${tool} ${ok ? 'succeeded' : 'FAILED'}${detail ? ' — ' + detail : ''}`]);
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false });
  }
});

// ── Network discovery results ───────────────────────────────────────────────────
// Where net.scan and snmp.poll post what they found. NO SHIPPED AGENT SENDS THESE YET —
// this is the landing pad, written now so the agent is built against a fixed contract
// rather than a moving one, and so the Portal side is finished and testable today.
//
// Everything is scoped to the POSTING DEVICE'S customer. An agent can only tell us about
// the network it is standing on, and a compromised token must not be able to write rows
// against somebody else's estate.

/** net.scan → the devices an agent saw on a range. */
router.post('/agent/api/network/scan', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const b = req.body || {};
  if (!d.customer_id) { res.status(409).json({ ok: false, error: 'no customer' }); return; }

  const found = Array.isArray(b.devices) ? b.devices.slice(0, 2000) : [];
  const rangeId = parseInt(String(b.rangeId || ''), 10) || null;
  let stored = 0, skipped = 0;

  // Hostnames we already manage. A machine running our agent belongs on Assets, and putting
  // it here as well would mean two records for one device and two places to keep current.
  const managed = new Set<string>(
    (await pool.query(
      `SELECT LOWER(SPLIT_PART(hostname, '.', 1)) AS h FROM agent_devices
        WHERE customer_id=$1 AND revoked=false AND hostname IS NOT NULL`, [d.customer_id]))
      .rows.map((r: any) => r.h).filter(Boolean));

  try {
    for (const one of found) {
      const ip = String((one || {}).ip || '').trim();
      if (!isIpv4(ip)) continue;                       // a scanner that sends rubbish gets ignored, not trusted
      const ports = Array.isArray(one.openPorts) ? one.openPorts.map((p: any) => parseInt(String(p), 10)).filter(Boolean) : [];

      // THIS LIST IS FOR THE THINGS THAT WILL NEVER RUN AN AGENT. A computer found by the
      // sweep is not a network device, and letting PCs in here is how a page meant for
      // "3 printers and a switch" turns into a second, worse copy of the asset list.
      //
      // Two ways to spot one: we already manage it by name, or it answers on SMB/RDP with
      // nothing printer-shaped about it. The second test is deliberately conservative —
      // a print server answers on 445 AND 9100, and that IS worth having here.
      const shortName = String(one.hostname || '').split('.')[0].toLowerCase();
      const printerish = ports.includes(9100) || ports.includes(631) || ports.includes(515);
      const windowsish = ports.includes(445) || ports.includes(3389);
      if ((shortName && managed.has(shortName)) || (windowsish && !printerish)) { skipped++; continue; }

      const kind = guessKind(one.sysDescr, one.vendor, ports);

      // The guess only ever fills a blank. A kind a human set, and a friendly name a human
      // typed, survive every future scan — the heuristic is not allowed to argue with them.
      // archived_at is deliberately untouched: archiving is a decision, finding it again is
      // just an observation, and an observation should not overturn a decision.
      await pool.query(
        `INSERT INTO network_devices
           (customer_id, agent_device_id, ip, mac, hostname, vendor, sys_name, sys_descr, kind, monitored, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9 = 'printer',NOW())
         ON CONFLICT (customer_id, ip) DO UPDATE SET
           mac       = COALESCE(EXCLUDED.mac,       network_devices.mac),
           hostname  = COALESCE(EXCLUDED.hostname,  network_devices.hostname),
           vendor    = COALESCE(EXCLUDED.vendor,    network_devices.vendor),
           sys_name  = COALESCE(EXCLUDED.sys_name,  network_devices.sys_name),
           sys_descr = COALESCE(EXCLUDED.sys_descr, network_devices.sys_descr),
           kind      = CASE WHEN network_devices.kind = 'unknown' THEN EXCLUDED.kind ELSE network_devices.kind END,
           agent_device_id = COALESCE(network_devices.agent_device_id, EXCLUDED.agent_device_id),
           -- monitored is deliberately absent: a printer starts monitored, but if somebody
           -- has since turned it off, a re-scan must not turn it back on behind them.
           last_seen_at = NOW()`,
        [d.customer_id, d.id, ip, s(one.mac, 40), s(one.hostname, 120), s(one.vendor, 120),
         s(one.sysName, 160), s(one.sysDescr, 500), kind]);
      stored++;
    }

    if (rangeId) {
      // Say what was left out as well as what was kept. A count that quietly omits half of
      // what the scan saw reads as "that is everything", and it is not.
      await pool.query(
        `UPDATE network_scan_ranges SET last_scan_at=NOW(), last_result=$1
          WHERE id=$2 AND customer_id=$3`,
        [`${stored} found` + (skipped ? `, ${skipped} computer(s) left on Assets` : ''), rangeId, d.customer_id]);
    }
    res.json({ ok: true, stored, skipped });
  } catch (e: any) {
    console.error('[agent] network scan store failed:', e.message);
    res.status(500).json({ ok: false, error: 'scan not stored' });
  }
});

/** The community string for one device, handed over at the moment of use.
 *
 * NOT put in the snmp.poll payload. agent_commands rows are stored in clear and are shown
 * on the command history screens — a credential that lives there is a credential written
 * down, and it would stay written down for as long as the row does.
 *
 * Scoped to the agent that is actually assigned to reach the device, not merely to the
 * customer. A workstation token then cannot enumerate the community strings for every
 * network device on that site, and the assigned agent is the only one that can run the
 * poll anyway. */
router.get('/agent/api/network/device/:id/snmp', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const id = parseInt(String(req.params.id), 10);
  if (!id || !d.customer_id) { res.status(400).json({ ok: false, error: 'bad request' }); return; }
  try {
    const dev = (await pool.query(
      `SELECT snmp_community, snmp_version FROM network_devices
        WHERE id=$1 AND customer_id=$2 AND agent_device_id=$3`,
      [id, d.customer_id, d.id])).rows[0];
    if (!dev) { res.status(404).json({ ok: false, error: 'not a device you are set to reach' }); return; }

    // No stored string is not an error: "public" is the default on nearly every device
    // that has SNMP switched on, so the poll is worth trying.
    let community = 'public';
    if (dev.snmp_community) {
      try { community = decryptSecret(dev.snmp_community) || 'public'; }
      catch (e: any) { console.error('[agent] snmp community decrypt failed:', e.message); }
    }
    res.json({ ok: true, community, version: dev.snmp_version || null });
  } catch (e: any) {
    console.error('[agent] snmp credential lookup failed:', e.message);
    res.status(500).json({ ok: false, error: 'lookup failed' });
  }
});

/** snmp.poll → one device's supplies and warnings. */
router.post('/agent/api/network/poll', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const b = req.body || {};
  const id = parseInt(String(b.networkDeviceId || ''), 10);
  if (!id || !d.customer_id) { res.status(400).json({ ok: false, error: 'networkDeviceId required' }); return; }

  const client = await pool.connect();
  try {
    // Scope check first: the device has to belong to the customer this agent serves.
    const dev = (await client.query(
      `SELECT n.id, n.ip, n.friendly_name, n.monitored, c.name AS customer_name
         FROM network_devices n LEFT JOIN customers c ON c.id = n.customer_id
        WHERE n.id=$1 AND n.customer_id=$2`, [id, d.customer_id])).rows[0];
    if (!dev) { res.status(404).json({ ok: false, error: 'not your device' }); return; }

    const err = s(b.error, 400);
    const seenSupplies: { name: string; pct: number | null }[] = [];
    const seenAlerts: { desc: string; severity: string }[] = [];
    await client.query('BEGIN');

    await client.query(
      `UPDATE network_devices
          SET last_poll_at = NOW(),
              last_poll_error = $1,
              last_seen_at = CASE WHEN $1 IS NULL THEN NOW() ELSE last_seen_at END,
              sys_name  = COALESCE($2, sys_name),
              sys_descr = COALESCE($3, sys_descr)
        WHERE id = $4`,
      [err, s(b.sysName, 160), s(b.sysDescr, 500), id]);

    // A failed poll must not wipe the last good readings — "we could not reach it" is a
    // different fact from "it has no toner", and rewriting one as the other sends somebody
    // out with a cartridge that was not needed.
    if (!err) {
      const supplies = Array.isArray(b.supplies) ? b.supplies.slice(0, 40) : [];
      for (const sup of supplies) {   // seen[] is filled as we go, for the alerting below
        const level = sup.level == null ? null : parseInt(String(sup.level), 10);
        const max = sup.max == null && sup.maxCapacity == null ? null
          : parseInt(String(sup.max != null ? sup.max : sup.maxCapacity), 10);
        await client.query(
          `INSERT INTO network_printer_supplies (network_device_id, name, colour, level, max_capacity, percent)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, s(sup.name, 120) || 'Supply', s(sup.colour, 40),
           Number.isFinite(level as number) ? level : null,
           Number.isFinite(max as number) ? max : null,
           supplyPercent(level, max)]);           // null for the -1/-2/-3 sentinels, never 0
        seenSupplies.push({ name: s(sup.name, 120) || 'Supply', pct: supplyPercent(level, max) });
      }

      // Warnings are reconciled, not appended: what the device still reports stays open,
      // what it has stopped reporting is cleared. Otherwise a jam cleared five minutes
      // after it happened sits on the screen forever.
      const alerts = Array.isArray(b.alerts) ? b.alerts.slice(0, 60) : [];
      const live: string[] = [];
      for (const a of alerts) {
        const desc = s(a.description || a.desc, 300);
        if (!desc) continue;
        live.push(desc);
        const open = (await client.query(
          `SELECT id FROM network_device_alerts
            WHERE network_device_id=$1 AND description=$2 AND cleared_at IS NULL LIMIT 1`, [id, desc])).rows[0];
        if (open) {
          await client.query(`UPDATE network_device_alerts SET last_seen_at=NOW() WHERE id=$1`, [open.id]);
        } else {
          await client.query(
            `INSERT INTO network_device_alerts (network_device_id, code, severity, description)
             VALUES ($1,$2,$3,$4)`,
            [id, s(a.code, 60), s(a.severity, 20) || 'warning', desc]);
        }
        seenAlerts.push({ desc, severity: s(a.severity, 20) || 'warning' });
      }
      await client.query(
        `UPDATE network_device_alerts SET cleared_at=NOW()
          WHERE network_device_id=$1 AND cleared_at IS NULL AND NOT (description = ANY($2::text[]))`,
        [id, live]);
    }

    await client.query('COMMIT');

    // Alerting is deliberately AFTER the commit and wrapped in its own try: an email
    // server having a bad day must not roll back a perfectly good toner reading.
    if (!err && dev.monitored) {
      try { await netDeviceAlerts(dev, seenSupplies, seenAlerts); }
      catch (e: any) { console.error('[agent] network alerting failed:', e.message); }
    }
    res.json({ ok: true });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    console.error('[agent] network poll store failed:', e.message);
    res.status(500).json({ ok: false, error: 'poll not stored' });
  } finally { client.release(); }
});

/** Turn one poll into N3twrx alerts, and clear the ones that have fixed themselves.
 *
 * Only ever called for a MONITORED device. Something added by a scan and never ticked is
 * on the list to be known about, not to be shouted about.
 *
 * The two thresholds are NOT the same number on purpose. Raising at 20% and only clearing
 * again at 25% means a cartridge hovering on the line does not open and close an alert
 * every half hour — it goes on the board once and stays there until it is actually dealt
 * with. */
const SUPPLY_CLEAR_PERCENT = SUPPLY_LOW_PERCENT + 5;

async function netDeviceAlerts(
  dev: any,
  supplies: { name: string; pct: number | null }[],
  alerts: { desc: string; severity: string }[],
): Promise<void> {
  const label = dev.friendly_name || dev.ip;
  const where = [dev.customer_name, dev.ip].filter(Boolean).join(' · ');
  const url = `/network/device/${dev.id}`;

  for (const sup of supplies) {
    // A null percentage is the device saying it cannot measure this one. That is not an
    // empty cartridge and must never be alerted on.
    if (sup.pct == null) continue;
    const extId = `netdev:${dev.id}:supply:${sup.name}`;
    if (sup.pct <= SUPPLY_LOW_PERCENT) {
      await raiseAlert({
        source: 'printer', externalId: extId, severity: 'warning',
        title: `${label}: ${sup.name} at ${sup.pct}%`,
        body: `${where}\n${sup.name} is down to ${sup.pct}%. Low is ${SUPPLY_LOW_PERCENT}% or under.`,
        url, autoTicket: false,     // Terry's call whether it becomes a job
      });
    } else if (sup.pct >= SUPPLY_CLEAR_PERCENT) {
      await resolveAlert('printer', extId);   // refilled
    }
  }

  const live = new Set(alerts.map((a) => `netdev:${dev.id}:alert:${a.desc}`));
  for (const a of alerts) {
    await raiseAlert({
      source: 'printer', externalId: `netdev:${dev.id}:alert:${a.desc}`,
      severity: a.severity === 'critical' ? 'critical' : 'warning',
      title: `${label}: ${a.desc}`, body: where, url, autoTicket: false,
    });
  }

  // Anything this device was complaining about last time and is not complaining about now
  // has been dealt with. Clearing it here rather than waiting for a human keeps the board
  // trustworthy — a list full of jams that were cleared days ago is a list nobody reads.
  const open = (await pool.query(
    `SELECT external_id FROM alerts
      WHERE source='printer' AND status='open' AND external_id LIKE $1`,
    [`netdev:${dev.id}:alert:%`])).rows;
  for (const o of open) {
    if (!live.has(o.external_id)) await resolveAlert('printer', o.external_id);
  }
}

export default router;
