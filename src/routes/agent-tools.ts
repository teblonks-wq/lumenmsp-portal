import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { logActivity } from '../lib/activity';
import { wakeAgent } from './agent-api';

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
  'services.list': { label: 'Listed services' },
  'services.restart': { label: 'Restarted a service', destructive: true },
  'services.start': { label: 'Started a service', destructive: true },
  'services.stop': { label: 'Stopped a service', destructive: true },
  'files.list': { label: 'Browsed the file system' },
  'users.list': { label: 'Listed local users' },
  'users.disable': { label: 'Disabled a local user', destructive: true },
  'users.enable': { label: 'Enabled a local user', destructive: true },
  'users.resetpw': { label: 'Reset a local user password', destructive: true },
  'ad.users.list': { label: 'Listed AD users', ad: true },
  'ad.user.disable': { label: 'Disabled an AD account', ad: true, destructive: true },
  'ad.user.enable': { label: 'Enabled an AD account', ad: true, destructive: true },
  'ad.user.resetpw': { label: 'Reset an AD password', ad: true, destructive: true },
};

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
    }
    if (kind.startsWith('services.') && kind !== 'services.list') payload.name = String(b.name || '').slice(0, 200);
    if (kind === 'files.list') payload.path = String(b.path || '').slice(0, 500);
    if (kind.startsWith('users.') && kind !== 'users.list') payload.name = String(b.name || '').slice(0, 200);
    if (kind.startsWith('ad.user.')) payload.sam = String(b.sam || '').slice(0, 200);
    if (kind === 'ad.users.list') payload.q = String(b.q || '').slice(0, 100);
    if (kind === 'users.resetpw' || kind === 'ad.user.resetpw') {
      generated = generatePassword();
      payload.password = generated;
      payload.must_change = b.must_change === '1' || b.must_change === true ? '1' : '0';
    }

    const ins = await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, requested_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [device.id, kind, JSON.stringify(payload), req.session.user!.id]);
    const commandId = ins.rows[0].id;

    // Audit BEFORE the result comes back, and never record the generated password.
    const target = payload.name || payload.sam || payload.path || '';
    await logActivity(req.session.user!.id, 'agent_tool', 'customer_assets', assetId,
      `${spec.label} on ${device.hostname || 'device'}${target ? ' (' + target + ')' : ''}` +
      (kind.startsWith('shell.') ? ': ' + String(payload.script).slice(0, 200) : ''));

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
    const r = await pool.query(
      'SELECT id, kind, status, exit_code, output, requested_at, finished_at FROM agent_commands WHERE id=$1', [commandId]);
    if (!r.rows.length) { res.status(404).json({ ok: false, error: 'Unknown command.' }); return; }
    const c = r.rows[0];
    // A device that went offline mid-command shouldn't leave the UI spinning forever.
    const ageMs = Date.now() - new Date(c.requested_at).getTime();
    if (['queued', 'running'].includes(c.status) && ageMs > 3 * 60 * 1000) {
      await pool.query("UPDATE agent_commands SET status='expired', payload=NULL WHERE id=$1 AND status IN ('queued','running')", [commandId]);
      res.json({ ok: true, status: 'expired', output: 'The device did not respond within 3 minutes. It may be offline or asleep.' });
      return;
    }
    res.json({ ok: true, status: c.status, exit_code: c.exit_code, output: c.output || '' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'Could not read the result.' });
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
