import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/pool';
import { getSetting } from '../lib/settings';
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
export function agentMsiInfo(): { size: number; mtime: Date } | null {
  try { const st = fs.statSync(AGENT_MSI_PATH); return { size: st.size, mtime: st.mtime }; } catch { return null; }
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
async function deviceConfig(customerId: number | null) {
  const rmm = await rmmConfig(customerId);
  const latest = ((await getSetting('agent', 'latest_version')) || '').trim() || null;
  return {
    heartbeat_seconds: 300,
    chat_poll_seconds: 20,
    rmm_installer_url: rmm.url,
    rmm_install_args: rmm.args,
    agent_latest_version: latest,
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
    res.status(existing ? 200 : 201).json({ ok: true, device_id: deviceId, device_token: token, customer: cust.rows[0].name, config: await deviceConfig(customerId) });
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
    res.json({ ok: true, public_ip: clientIp(req), config: await deviceConfig(d.customer_id) });
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
    await pool.query(
      `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, processing_status, is_unread, from_name, subject, body_text, received_at)
       VALUES ($1,'portal@lumenmsp.co.uk','inbound','agent','matched',true,$2,$3,$4,NOW())`,
      [t.id, fromName, 'Agent chat message', text]);
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
