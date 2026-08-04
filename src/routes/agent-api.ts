import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/pool';
import { getSetting, setSetting } from '../lib/settings';
import { logActivity } from '../lib/activity';
import { htmlToPlain } from '../lib/whatsapp';
import { nextTicketNumber } from './tickets';

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
const s = (v: any, max = 300): string | null => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };

// Real client IP — the app sets trust proxy 1, so req.ip is already the nginx-forwarded address.
function clientIp(req: Request): string {
  return String(req.ip || '').replace(/^::ffff:/, '');
}

// ── Keyed installer download ────────────────────────────────────────────────────
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

// Per-customer RMM installer URL, falling back to the global default (Settings on /agents).
async function rmmConfig(customerId: number | null): Promise<{ url: string | null; args: string }> {
  let url: string | null = null;
  if (customerId) {
    const r = await pool.query('SELECT rmm_installer_url FROM customers WHERE id=$1', [customerId]);
    url = (r.rows[0]?.rmm_installer_url || '').trim() || null;
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
    heartbeat_seconds: 300,
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
  const os = s(b.os, 200); const osVersion = s(b.os_version, 100); const agentVersion = s(b.agent_version, 50);

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
           public_ip=$7, enrolled_at=NOW(), last_seen_at=NOW(), updated_at=NOW() WHERE id=$8`,
        [tokenHash, hostname, serial, os, osVersion, agentVersion, clientIp(req), deviceId]
      );
    } else {
      const ins = await pool.query(
        `INSERT INTO agent_devices (customer_id, hostname, serial_number, os, os_version, agent_version, token_hash, public_ip, enrolled_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) RETURNING id`,
        [customerId, hostname, serial, os, osVersion, agentVersion, tokenHash, clientIp(req)]
      );
      deviceId = ins.rows[0].id;
    }
    await logActivity(null, existing ? 'agent_reenrolled' : 'agent_enrolled', 'agent_devices', deviceId, `${hostname} enrolled for ${cust.rows[0].name}`);
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
  try {
    await pool.query(
      `UPDATE agent_devices SET hostname=COALESCE($1, hostname), os=COALESCE($2, os), os_version=COALESCE($3, os_version),
         agent_version=COALESCE($4, agent_version), logged_in_user=$5, local_ips=$6, disk_info=$7,
         public_ip=$8, last_seen_at=NOW(), updated_at=NOW() WHERE id=$9`,
      [s(b.hostname, 200), s(b.os, 200), s(b.os_version, 100), s(b.agent_version, 50),
       s(b.logged_in_user, 200), localIps, diskInfo, clientIp(req), d.id]
    );
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
  const r = await pool.query(
    `UPDATE agent_commands SET status='running', started_at=NOW()
      WHERE id IN (SELECT id FROM agent_commands WHERE device_id=$1 AND status='queued'
                    ORDER BY id LIMIT 5)
      RETURNING id, kind, payload`, [deviceId]);
  return r.rows;
}

router.get('/agent/api/commands', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const waitSec = Math.min(30, Math.max(0, parseInt(String(req.query.wait || '0'), 10) || 0));
  try {
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

router.post('/agent/api/commands/:id/result', requireDevice, async (req: Request, res: Response) => {
  const d = (req as any).agentDevice;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};
  const exitCode = Number.isFinite(parseInt(String(b.exit_code), 10)) ? parseInt(String(b.exit_code), 10) : null;
  const output = String(b.output ?? '').slice(0, 400000);
  try {
    // payload=NULL on completion: a reset password must not sit in the database after use.
    const r = await pool.query(
      `UPDATE agent_commands SET status=$1, exit_code=$2, output=$3, finished_at=NOW(), payload=NULL
        WHERE id=$4 AND device_id=$5 RETURNING kind`,
      [exitCode === 0 ? 'done' : 'failed', exitCode, output, id, d.id]);
    if (!r.rows.length) { res.status(404).json({ ok: false, error: 'unknown command' }); return; }
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

export default router;
