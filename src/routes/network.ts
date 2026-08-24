import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { wakeAgent } from './agent-api';
import { encryptSecret, vaultConfigured } from '../lib/vault';
import {
  expandCidr, cidrSize, isIpv4, DEVICE_KINDS, KIND_LABELS, guessKind,
  supplyPercent, supplyNote, SUPPLY_LOW_PERCENT, NET_DISCO_MIN_AGENT, agentAtLeast,
} from '../lib/network-discovery';

const router = Router();

// ── Network discovery ───────────────────────────────────────────────────────────
// Everything on a customer's network that will never have our agent. Found by an agent
// (usually the server, because it is the machine that is always on and can see the whole
// subnet), monitored through it, and reached through it.
//
// The agent verbs this queues — net.scan and snmp.poll — landed in agent 1.0.29. An older
// agent collects the command and does not recognise it, so the version is checked BEFORE
// queueing and the operator is told plainly, rather than being left watching a spinner.
// Adding a device by hand still works regardless of the agent version.

const back = (raw: unknown, fallback: string): string => {
  const s = String(raw || '');
  return /^\/(?!\/)/.test(s) ? s : fallback;
};

/** Agents that could plausibly do the scanning — servers first, then anything online. */
async function scannerChoices(customerId: number | null) {
  if (!customerId) return [];
  return (await pool.query(
    `SELECT d.id, d.hostname, a.device_type,
            EXTRACT(EPOCH FROM (NOW() - d.last_seen_at)) AS seen_secs
       FROM agent_devices d
       LEFT JOIN customer_assets a ON a.agent_device_id = d.id
      WHERE d.revoked = false AND d.customer_id = $1
      ORDER BY (a.device_type ILIKE '%server%') DESC, d.last_seen_at DESC NULLS LAST`,
    [customerId])).rows;
}

router.get('/network', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const custId = parseInt(String(req.query.customer || ''), 10) || null;
  const kind = String(req.query.kind || '').trim();

  const customers = (await pool.query(
    `SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY name`)).rows;

  let ranges: any[] = [], devices: any[] = [], scanners: any[] = [];
  if (custId) {
    ranges = (await pool.query(
      `SELECT r.*, d.hostname AS scanner_hostname,
              EXTRACT(EPOCH FROM (NOW() - d.last_seen_at)) AS scanner_seen_secs
         FROM network_scan_ranges r
         LEFT JOIN agent_devices d ON d.id = r.agent_device_id
        WHERE r.customer_id = $1 ORDER BY r.cidr`, [custId])).rows;

    const params: any[] = [custId];
    let where = 'n.customer_id = $1 AND n.archived_at IS NULL';
    if (kind) { params.push(kind); where += ` AND n.kind = $${params.length}`; }

    devices = (await pool.query(
      `SELECT n.*,
              (SELECT COUNT(*)::int FROM network_device_alerts al
                WHERE al.network_device_id = n.id AND al.cleared_at IS NULL) AS open_alerts,
              (SELECT COUNT(*)::int FROM network_device_credentials cr
                WHERE cr.network_device_id = n.id) AS cred_count,
              (SELECT json_agg(json_build_object('name', s.name, 'colour', s.colour,
                                                 'level', s.level, 'max', s.max_capacity,
                                                 'percent', s.percent) ORDER BY s.name)
                 FROM network_printer_supplies s
                WHERE s.network_device_id = n.id
                  AND s.at = (SELECT MAX(s2.at) FROM network_printer_supplies s2
                               WHERE s2.network_device_id = n.id)) AS supplies
         FROM network_devices n
        WHERE ${where}
        ORDER BY n.kind, n.friendly_name NULLS LAST, n.ip`, params)).rows;

    scanners = await scannerChoices(custId);
  }

  res.render('network/index', {
    user: req.session.user!, customers, custId, kind, ranges, devices, scanners,
    kinds: DEVICE_KINDS, kindLabels: KIND_LABELS, lowPercent: SUPPLY_LOW_PERCENT,
    vaultOk: vaultConfigured(),
    msg: req.query.msg || null, error: req.query.err || null,
  });
});

// ── Scan ranges ─────────────────────────────────────────────────────────────────
router.post('/network/ranges', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const custId = parseInt(String(b.customerId || ''), 10) || null;
  const agentId = parseInt(String(b.agentDeviceId || ''), 10) || null;
  const cidr = String(b.cidr || '').trim();
  const label = String(b.label || '').trim().slice(0, 80);
  const to = `/network?customer=${custId || ''}`;
  if (!custId || !agentId) { res.redirect(to + '&err=' + encodeURIComponent('Pick a customer and the agent that will do the scanning.')); return; }

  const size = cidrSize(cidr);
  if (!size) {
    res.redirect(to + '&err=' + encodeURIComponent(
      'That is not a range I can scan. Use CIDR like 192.168.70.0/24, and nothing larger than a /22 — '
      + 'a /16 is 65,000 addresses and a scan nobody ever finishes.'));
    return;
  }
  try {
    await pool.query(
      `INSERT INTO network_scan_ranges (customer_id, agent_device_id, cidr, label, created_by)
       VALUES ($1,$2,$3,$4,$5)`, [custId, agentId, cidr, label, req.session.user!.id]);
    await logActivity(req.session.user!.id, 'network_range_add', 'customers', custId, `Added scan range ${cidr}`);
    res.redirect(to + '&msg=' + encodeURIComponent(`Added ${cidr} — ${size} address(es) to scan.`));
  } catch (e: any) {
    res.redirect(to + '&err=' + encodeURIComponent('Could not add that range.'));
  }
});

router.post('/network/ranges/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = (await pool.query(`DELETE FROM network_scan_ranges WHERE id=$1 RETURNING customer_id, cidr`, [id])).rows[0];
  await logActivity(req.session.user!.id, 'network_range_delete', null, null, `Removed scan range ${r?.cidr || id}`);
  res.redirect(`/network?customer=${r?.customer_id || ''}&msg=` + encodeURIComponent('Range removed. Devices already found are kept.'));
});

router.post('/network/ranges/:id/scan', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = (await pool.query(
    `SELECT r.*, EXTRACT(EPOCH FROM (NOW() - d.last_seen_at)) AS seen, d.agent_version
       FROM network_scan_ranges r LEFT JOIN agent_devices d ON d.id = r.agent_device_id
      WHERE r.id=$1`, [id])).rows[0];
  const to = `/network?customer=${r?.customer_id || ''}`;
  if (!r) { res.redirect(to + '&err=' + encodeURIComponent('That range no longer exists.')); return; }
  if (!agentAtLeast(r.agent_version, NET_DISCO_MIN_AGENT)) {
    res.redirect(to + '&err=' + encodeURIComponent(
      `That agent is on ${r.agent_version || 'an unknown version'} and network scanning needs `
      + `${NET_DISCO_MIN_AGENT}. Update it from the Agents page first — queueing this now would `
      + `sit there doing nothing.`));
    return;
  }

  // Never stack scans. A second identical command cannot make the machine answer sooner
  // and an offline agent would collect a pile of them.
  const pending = (await pool.query(
    `SELECT id FROM agent_commands WHERE device_id=$1 AND kind='net.scan' AND status IN ('queued','running') LIMIT 1`,
    [r.agent_device_id])).rows[0];
  if (pending) { res.redirect(to + '&msg=' + encodeURIComponent('A scan is already queued on that agent.')); return; }

  await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by)
     VALUES ($1,'net.scan',$2,'queued',$3)`,
    [r.agent_device_id, JSON.stringify({ rangeId: r.id, cidr: r.cidr }), req.session.user!.id]);
  wakeAgent(r.agent_device_id);
  await pool.query(`UPDATE network_scan_ranges SET last_scan_at=NOW(), last_result='queued' WHERE id=$1`, [id]);
  await logActivity(req.session.user!.id, 'network_scan', null, null, `Queued a scan of ${r.cidr}`);

  const offline = r.seen == null || Number(r.seen) > 900;
  res.redirect(to + '&msg=' + encodeURIComponent(offline
    ? 'Scan queued. That agent is offline, so it runs when it next checks in.'
    : `Scanning ${r.cidr} now. A /24 takes about a minute; refresh to see what turns up.`));
});

// ── Devices ─────────────────────────────────────────────────────────────────────
router.post('/network/devices', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const custId = parseInt(String(b.customerId || ''), 10) || null;
  const ip = String(b.ip || '').trim();
  const to = `/network?customer=${custId || ''}`;
  if (!custId || !isIpv4(ip)) { res.redirect(to + '&err=' + encodeURIComponent('A customer and a valid IPv4 address are needed.')); return; }
  const name = String(b.friendlyName || '').trim().slice(0, 120);
  const kind = DEVICE_KINDS.includes(String(b.kind) as any) ? String(b.kind) : 'unknown';
  const agentId = parseInt(String(b.agentDeviceId || ''), 10) || null;
  try {
    await pool.query(
      `INSERT INTO network_devices (customer_id, agent_device_id, ip, friendly_name, kind, web_url, notes, last_seen_at)
       VALUES ($1,$2,$3,NULLIF($4,''),$5,NULLIF($6,''),NULLIF($7,''),NOW())
       ON CONFLICT (customer_id, ip) DO UPDATE
         SET friendly_name = COALESCE(NULLIF(EXCLUDED.friendly_name,''), network_devices.friendly_name),
             kind = EXCLUDED.kind, archived_at = NULL`,
      [custId, agentId, ip, name, kind, String(b.webUrl || '').trim(), String(b.notes || '').trim()]);
    await logActivity(req.session.user!.id, 'network_device_add', 'customers', custId, `Added ${name || ip}`);
    res.redirect(to + '&msg=' + encodeURIComponent(`${name || ip} added.`));
  } catch (e: any) {
    res.redirect(to + '&err=' + encodeURIComponent('Could not add that device.'));
  }
});

/** Turn monitoring on or off for a batch.
 *
 * Monitoring is the switch that decides whether the 30-minute sweep ever reads a device,
 * so doing it one page at a time for a site with fifteen printers is the difference between
 * a feature that gets used and one that does not. */
router.post('/network/devices/monitor', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const custId = parseInt(String(b.customerId || ''), 10) || null;
  const on = String(b.on || '') === '1';
  const to = `/network?customer=${custId || ''}${b.kind ? '&kind=' + encodeURIComponent(String(b.kind)) : ''}`;

  const raw = Array.isArray(b.ids) ? b.ids : (b.ids ? [b.ids] : []);
  const ids = raw.map((x: any) => parseInt(String(x), 10)).filter((n: number) => Number.isFinite(n) && n > 0);
  if (!ids.length) { res.redirect(to + '&err=' + encodeURIComponent('Nothing was ticked.')); return; }

  try {
    // Scoped to the customer on the form as well as by id. Ticking rows on one customer's
    // page must not be able to reach into another's, however the form is posted.
    const r = await pool.query(
      `UPDATE network_devices SET monitored=$1
        WHERE id = ANY($2::int[]) AND customer_id=$3 AND archived_at IS NULL
        RETURNING id`, [on, ids, custId]);
    await logActivity(req.session.user!.id, 'network_monitor', 'customers', custId,
      `${on ? 'Started' : 'Stopped'} monitoring ${r.rowCount} network device(s)`);

    // Say what a tick actually causes, because "monitored" on its own means nothing to
    // somebody who has not read the scheduler.
    res.redirect(to + '&msg=' + encodeURIComponent(on
      ? `${r.rowCount} device(s) now monitored — each one is read every 30 minutes, and low toner or a printer warning raises an alert on N3twrx.`
      : `${r.rowCount} device(s) no longer monitored. They stay on the list; nothing polls them.`));
  } catch (e: any) {
    console.error('[network] bulk monitor failed:', e.message);
    res.redirect(to + '&err=' + encodeURIComponent('Could not change those.'));
  }
});

router.get('/network/device/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const d = (await pool.query(
    `SELECT n.*, c.name AS customer_name, ag.hostname AS agent_hostname
       FROM network_devices n
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN agent_devices ag ON ag.id = n.agent_device_id
      WHERE n.id=$1`, [id])).rows[0];
  if (!d) { res.redirect('/network?err=' + encodeURIComponent('No such device.')); return; }

  const supplies = (await pool.query(
    `SELECT * FROM network_printer_supplies
      WHERE network_device_id=$1 AND at = (SELECT MAX(at) FROM network_printer_supplies WHERE network_device_id=$1)
      ORDER BY name`, [id])).rows
    .map((s: any) => ({ ...s, pct: supplyPercent(s.level, s.max_capacity), note: supplyNote(s.level, s.max_capacity) }));

  const alerts = (await pool.query(
    `SELECT * FROM network_device_alerts WHERE network_device_id=$1
      ORDER BY cleared_at NULLS FIRST, last_seen_at DESC LIMIT 50`, [id])).rows;

  const creds = (await pool.query(
    `SELECT id, kind, username, note, created_at FROM network_device_credentials
      WHERE network_device_id=$1 ORDER BY kind, username`, [id])).rows;

  const scanners = await scannerChoices(d.customer_id);

  res.render('network/device', {
    user: req.session.user!, d, supplies, alerts, creds, scanners,
    kinds: DEVICE_KINDS, kindLabels: KIND_LABELS, lowPercent: SUPPLY_LOW_PERCENT,
    vaultOk: vaultConfigured(),
    msg: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/network/device/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};
  const kind = DEVICE_KINDS.includes(String(b.kind) as any) ? String(b.kind) : 'unknown';
  try {
    await pool.query(
      `UPDATE network_devices
          SET friendly_name = NULLIF($1,''), notes = NULLIF($2,''), kind = $3,
              web_url = NULLIF($4,''), monitored = $5, agent_device_id = $6,
              snmp_version = NULLIF($7,'')
        WHERE id = $8`,
      [String(b.friendlyName || '').trim().slice(0, 120), String(b.notes || '').trim(),
       kind, String(b.webUrl || '').trim(), b.monitored === '1',
       parseInt(String(b.agentDeviceId || ''), 10) || null,
       String(b.snmpVersion || '').trim(), id]);
    // The community string is a secret like any other - encrypted, never stored plain.
    if (String(b.snmpCommunity || '').trim()) {
      await pool.query(`UPDATE network_devices SET snmp_community=$1 WHERE id=$2`,
        [encryptSecret(String(b.snmpCommunity).trim()), id]);
    }
    await logActivity(req.session.user!.id, 'network_device_edit', null, id, 'Updated a network device');
    res.redirect(`/network/device/${id}?msg=` + encodeURIComponent('Saved.'));
  } catch (e: any) {
    console.error('[network] save failed:', e.message);
    res.redirect(`/network/device/${id}?err=` + encodeURIComponent('Could not save that.'));
  }
});

router.post('/network/device/:id/credential', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body || {};
  const to = `/network/device/${id}`;
  if (!vaultConfigured()) {
    res.redirect(to + '?err=' + encodeURIComponent(
      'The credential vault has no key, so a password cannot be stored. Storing it in plain text '
      + 'would be worse than not storing it at all.'));
    return;
  }
  const secret = String(b.password || '');
  if (!secret) { res.redirect(to + '?err=' + encodeURIComponent('No password given.')); return; }
  try {
    await pool.query(
      `INSERT INTO network_device_credentials (network_device_id, kind, username, secret_enc, note, created_by)
       VALUES ($1,$2,$3,$4,NULLIF($5,''),$6)`,
      [id, String(b.kind || 'web'), String(b.username || '').trim(),
       encryptSecret(secret), String(b.note || '').trim(), req.session.user!.id]);
    await logActivity(req.session.user!.id, 'network_cred_add', null, id, 'Stored a device credential');
    res.redirect(to + '?msg=' + encodeURIComponent('Credential stored, encrypted.'));
  } catch (e: any) {
    console.error('[network] credential failed:', e.message);
    res.redirect(to + '?err=' + encodeURIComponent('Could not store that credential.'));
  }
});

router.post('/network/device/:id/credential/:cid/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query(`DELETE FROM network_device_credentials WHERE id=$1 AND network_device_id=$2`,
    [parseInt(String(req.params.cid), 10), id]);
  await logActivity(req.session.user!.id, 'network_cred_delete', null, id, 'Removed a device credential');
  res.redirect(`/network/device/${id}?msg=` + encodeURIComponent('Credential removed.'));
});

router.post('/network/device/:id/poll', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const d = (await pool.query(
    `SELECT n.*, ag.agent_version FROM network_devices n
       LEFT JOIN agent_devices ag ON ag.id = n.agent_device_id
      WHERE n.id=$1`, [id])).rows[0];
  const to = `/network/device/${id}`;
  if (!d?.agent_device_id) {
    res.redirect(to + '?err=' + encodeURIComponent('No agent is set to reach this device — pick one first.'));
    return;
  }
  if (!agentAtLeast(d.agent_version, NET_DISCO_MIN_AGENT)) {
    res.redirect(to + '?err=' + encodeURIComponent(
      `The agent that reaches this device is on ${d.agent_version || 'an unknown version'}, and SNMP `
      + `polling needs ${NET_DISCO_MIN_AGENT}. Update it from the Agents page first.`));
    return;
  }
  await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by)
     VALUES ($1,'snmp.poll',$2,'queued',$3)`,
    [d.agent_device_id, JSON.stringify({ networkDeviceId: id, ip: d.ip }), req.session.user!.id]);
  wakeAgent(d.agent_device_id);
  res.redirect(to + '?msg=' + encodeURIComponent(
    'Reading the device now. Refresh in a few seconds — supplies and warnings land as soon as it answers.'));
});

router.post('/network/device/:id/archive', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = (await pool.query(
    `UPDATE network_devices SET archived_at=NOW() WHERE id=$1 RETURNING customer_id`, [id])).rows[0];
  await logActivity(req.session.user!.id, 'network_device_archive', null, id, 'Archived a network device');
  res.redirect(`/network?customer=${r?.customer_id || ''}&msg=` + encodeURIComponent('Device archived — kept, not deleted.'));
});

export default router;
