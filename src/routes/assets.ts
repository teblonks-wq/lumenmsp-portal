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
import { backfillAssetsFromAgents, findDuplicateAssets, preferredSurvivor, mergeAsset, unmergeAsset, ONLINE_WINDOW_SECS } from '../lib/agent-asset';
import { getBackupForComputer, getBackupHistoryForComputer, backupStateByComputer, classifyPlanStatus, planStatusLabel, planTypeLabel, fmtBytes } from '../lib/msp360';
import { meshStatus } from './mesh';

const router = Router();

// Adopting/creating asset rows for enrolled agents is normally done at enrolment and on
// every heartbeat. This is the belt-and-braces pass for anything that predates that, run
// at most once a minute so opening /assets never costs more than a couple of set-based
// statements.
let lastBackfillMs = 0;
async function backfillOnce(): Promise<void> {
  if (Date.now() - lastBackfillMs < 60_000) return;
  lastBackfillMs = Date.now();
  try { await backfillAssetsFromAgents(); } catch { /* never block the page */ }
}

function safeBack(raw: unknown, fallback: string): string {
  const s = String(raw || '');
  return /^\/(?!\/)/.test(s) ? s : fallback;
}

// ── Portal-wide asset list ──────────────────────────────────────────────────────
router.get('/assets', requireAuth, async (req: Request, res: Response) => {
  await backfillOnce();
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

  const where: string[] = ['a.customer_id IS NOT NULL', 'a.merged_into_id IS NULL AND a.archived_at IS NULL'];
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
    `SELECT a.*, c.name AS customer_name, c.agent_site_key, ac.full_name AS assigned_name,
            agd.id AS agent_device_id, agd.last_seen_at AS agent_last_seen, agd.agent_version AS agent_agent_version,
            agd.seen_secs AS agent_seen_secs, agd.mesh_node_id AS agent_mesh_node_id
     FROM customer_assets a
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_contacts ac ON ac.id = a.assigned_contact_id
     LEFT JOIN LATERAL (
       SELECT ag.id, ag.last_seen_at, ag.agent_version, ag.mesh_node_id,
              EXTRACT(EPOCH FROM (NOW() - ag.last_seen_at)) AS seen_secs FROM agent_devices ag
       WHERE ag.revoked = false AND ag.customer_id = a.customer_id
         AND (ag.id = a.agent_device_id
           OR (a.agent_device_id IS NULL
               AND ((a.serial_number IS NOT NULL AND ag.serial_number = a.serial_number)
                 OR (a.hostname IS NOT NULL AND LOWER(ag.hostname) = LOWER(a.hostname)))))
       ORDER BY ag.last_seen_at DESC NULLS LAST LIMIT 1
     ) agd ON true
     WHERE ${where.join(' AND ')}
     ORDER BY c.name, a.hostname`, params
  )).rows;

  const unmatchedCount = (await pool.query('SELECT COUNT(*)::int AS n FROM customer_assets WHERE customer_id IS NULL AND merged_into_id IS NULL AND archived_at IS NULL')).rows[0].n;
  // Cheap enough to run per page load, and it is the kind of mess that has to be visible
  // to get fixed - a silent duplicate is one somebody remotes onto the wrong copy of.
  const duplicateCount = (await findDuplicateAssets()).length;
  const types = (await pool.query("SELECT DISTINCT device_type FROM customer_assets WHERE device_type IS NOT NULL ORDER BY device_type")).rows.map((r: any) => r.device_type);
  const customers = (await pool.query('SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY name')).rows;

  // Backup badge per device — one grouped query over the MSP360 snapshot.
  const backupState = await backupStateByComputer();

  res.render('assets/list', {
    user: req.session.user!, rows, unmatchedCount, duplicateCount, types, customers, backupState,
    filters: { q, customer: custId, type, online: onlineOnly, nouser: noUser, agent: agentFilter, servers: serversOnly },
    // For the "agent required" copy button: the same keyed one-liner the Agents page hands out.
    baseUrl: req.protocol + '://' + req.get('host'),
    onlineWindowSecs: ONLINE_WINDOW_SECS,
    lastSynced: await lastAssetSyncAt(),
    remoteTemplate: await remoteUrlTemplate(),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── Devices Atera has that aren't matched to a portal customer yet ──────────────
router.get('/assets/unmatched', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const rows = (await pool.query("SELECT * FROM customer_assets WHERE customer_id IS NULL AND merged_into_id IS NULL AND archived_at IS NULL ORDER BY hostname")).rows;
  res.render('assets/unmatched', { user: req.session.user!, rows, notice: req.query.msg || null });
});

// ── Live status for the rows on screen ──────────────────────────────────────────
// Fast offline detection is no use on a page somebody is staring at, so the list polls
// this and updates the dots in place. Deliberately narrow: it answers only "is it on,
// and when did we last hear from it" for the ids already being shown, which keeps it
// cheap and means it cannot leak a device the viewer was not already looking at.
router.get('/assets/status.json', requireAuth, async (req: Request, res: Response) => {
  const ids = String(req.query.ids || '')
    .split(',').map((x) => parseInt(x, 10)).filter(Number.isInteger).slice(0, 500);
  if (!ids.length) { res.json({ ok: true, windowSecs: ONLINE_WINDOW_SECS, devices: [] }); return; }
  try {
    const rows = (await pool.query(
      `SELECT a.id,
              EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS seen_secs,
              ad.agent_version
         FROM customer_assets a
         LEFT JOIN agent_devices ad ON ad.id = a.agent_device_id AND ad.revoked = false
        WHERE a.id = ANY($1::int[]) AND a.merged_into_id IS NULL AND a.archived_at IS NULL`, [ids])).rows;
    res.json({
      ok: true,
      windowSecs: ONLINE_WINDOW_SECS,
      devices: rows.map((r: any) => ({
        id: r.id,
        seenSecs: r.seen_secs === null ? null : Number(r.seen_secs),
        // No agent of ours means no live link, so it is offline whatever else is true.
        online: r.seen_secs !== null && Number(r.seen_secs) < ONLINE_WINDOW_SECS,
        agentVersion: r.agent_version || null,
      })),
    });
  } catch (e: any) {
    console.error('[assets] status poll failed:', e.message);
    res.status(500).json({ ok: false });
  }
});

// ── Duplicate devices: find, merge, undo (admin) ────────────────────────────────
// One physical PC held as two rows - the Atera import and our agent's own record - which
// happened whenever the old exact-string match missed (a trailing space, a case change,
// or an FQDN on one side). The matching is fixed; this clears up what it already made.
router.get('/assets/duplicates', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const groups = await findDuplicateAssets();
  res.render('assets/duplicates', {
    user: req.session.user!,
    groups: groups.map((g) => ({ ...g, survivorId: preferredSurvivor(g.rows).id })),
    merged: (await pool.query(
      `SELECT a.id, a.hostname, a.merged_at, a.merged_into_id, k.hostname AS into_hostname, c.name AS customer_name
         FROM customer_assets a
         LEFT JOIN customer_assets k ON k.id = a.merged_into_id
         LEFT JOIN customers c ON c.id = a.customer_id
        WHERE a.merged_into_id IS NOT NULL ORDER BY a.merged_at DESC LIMIT 50`)).rows,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/assets/duplicates/merge', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const keepId = parseInt(String(req.body.keep_id), 10);
  const dropId = parseInt(String(req.body.drop_id), 10);
  if (!keepId || !dropId) { res.redirect('/assets/duplicates?err=' + encodeURIComponent('Pick which record to keep.')); return; }
  const r = await mergeAsset(keepId, dropId, req.session.user!.id);
  res.redirect('/assets/duplicates?' + (r.ok
    ? 'msg=' + encodeURIComponent('Merged. The second record is kept but hidden — undo it below if that was wrong.')
    : 'err=' + encodeURIComponent(r.error || 'Merge failed.')));
});

// Merge every group where the answer is not in doubt: exactly two rows, sharing a real
// serial number, one of which our agent reports. Anything less certain is left alone.
router.post('/assets/duplicates/merge-obvious', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const groups = await findDuplicateAssets();
  let ourMiss = 0, ateraDupe = 0, skipped = 0;
  for (const g of groups) {
    // A shared REAL serial is the strong identity, so both origins are safe to fold. What
    // differs is which copy survives, and preferredSurvivor already knows the rule.
    if (g.reason !== 'serial' || (g.origin !== 'portal-miss' && g.origin !== 'atera-dupe')) { skipped++; continue; }
    const keep = preferredSurvivor(g.rows);
    const drop = g.rows.find((r) => r.id !== keep.id)!;
    const r = await mergeAsset(keep.id, drop.id, req.session.user!.id);
    if (!r.ok) { skipped++; continue; }
    if (g.origin === 'portal-miss') ourMiss++; else ateraDupe++;
  }
  const done = ourMiss + ateraDupe;
  res.redirect('/assets/duplicates?msg=' + encodeURIComponent(
    `Merged ${done} device${done === 1 ? '' : 's'} held twice` +
    (done ? ` — ${ourMiss} where our own matching missed, ${ateraDupe} that were already duplicated in Atera before we imported them.` : '.') +
    (skipped ? ` ${skipped} left for you: they matched on host name only, or had more than two copies.` : '')));
});

router.post('/assets/duplicates/:id/undo', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const ok = await unmergeAsset(parseInt(String(req.params.id), 10), req.session.user!.id);
  res.redirect('/assets/duplicates?' + (ok
    ? 'msg=' + encodeURIComponent('Restored as its own record.')
    : 'err=' + encodeURIComponent('That record was not merged.')));
});

// ── Sync now (admin) ─────────────────────────────────────────────────────────────
router.post('/assets/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const r = await syncAssetsFromAtera(user.id);
  if (r.error) { res.redirect('/assets?err=' + encodeURIComponent(r.error)); return; }
  const msg = `Imported from Atera: ${r.imported} machine(s) without the LumenMSP Agent, ${r.linked} already covered by it (identifiers refreshed, inventory untouched)` +
    (r.unmatched ? ` — ${r.unmatched} not yet matched to a customer` : '');
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

// ── Archive a device (remove from the estate) ───────────────────────────────────
// For Atera imports of machines we will never manage. A hard DELETE is pointless: the
// nightly Atera sync's upsert would re-create it from Atera's own list. So we archive —
// the row is kept but hidden from every list, and because the sync's ON CONFLICT never
// clears archived_at, an archived row stays archived through every future sync. An agent
// that we DO put on later enrols fresh (adoption skips archived rows), so nothing is lost.
// Reversible from the archived list. Agent-owned devices are NOT archived here — revoke +
// delete them on the Agents page instead (this is the Atera/asset side).
async function archiveAssets(ids: number[], userId: number, reason: string): Promise<{ archived: number; skipped: number }> {
  let archived = 0, skipped = 0;
  for (const id of ids) {
    const a = (await pool.query('SELECT id, hostname, agent_device_id, archived_at FROM customer_assets WHERE id=$1', [id])).rows[0];
    if (!a || a.archived_at) { skipped++; continue; }
    if (a.agent_device_id) { skipped++; continue; }   // has a live agent — belongs on the Agents page
    await pool.query('UPDATE customer_assets SET archived_at=NOW(), archived_reason=$1, updated_at=NOW() WHERE id=$2', [reason.slice(0, 200) || null, id]);
    await logActivity(userId, 'asset_archived', 'customer_assets', id, `Device archived (${reason || 'no reason'}): ${a.hostname || 'asset ' + id}`);
    archived++;
  }
  return { archived, skipped };
}

router.post('/assets/:id/archive', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const reason = String((req.body || {}).reason || 'not managed');
  try {
    const r = await archiveAssets([id], req.session.user!.id, reason);
    if (!r.archived) { res.redirect(`/assets/${id}?err=` + encodeURIComponent('Could not archive — it may already be archived, or it has a live agent (revoke it on the Agents page instead).')); return; }
    res.redirect('/assets?msg=' + encodeURIComponent('Device archived — hidden from the estate and the Atera sync will not bring it back. Undo from the archived list.'));
  } catch (e: any) {
    res.redirect(`/assets/${id}?err=` + encodeURIComponent('Archive failed: ' + e.message));
  }
});

// Bulk archive — Atera imports come in droves; tick them and clear them in one go.
router.post('/assets/archive-bulk', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const ids = String((req.body || {}).ids || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
  const reason = String((req.body || {}).reason || 'not managed');
  if (!ids.length) { res.redirect('/assets?err=' + encodeURIComponent('No devices selected.')); return; }
  try {
    const r = await archiveAssets(ids, req.session.user!.id, reason);
    res.redirect('/assets?msg=' + encodeURIComponent(`${r.archived} device(s) archived${r.skipped ? `, ${r.skipped} skipped (already archived or agent-owned)` : ''}.`));
  } catch (e: any) {
    res.redirect('/assets?err=' + encodeURIComponent('Bulk archive failed: ' + e.message));
  }
});

// Restore an archived device.
router.post('/assets/:id/unarchive', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    await pool.query('UPDATE customer_assets SET archived_at=NULL, archived_reason=NULL, updated_at=NOW() WHERE id=$1', [id]);
    await logActivity(req.session.user!.id, 'asset_unarchived', 'customer_assets', id, `Device restored from archive`);
    res.redirect('/assets/archived?msg=' + encodeURIComponent('Device restored — it is back in the estate.'));
  } catch (e: any) {
    res.redirect('/assets/archived?err=' + encodeURIComponent('Restore failed: ' + e.message));
  }
});

// The archived list.
router.get('/assets/archived', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const rows = (await pool.query(
    `SELECT a.*, c.name AS customer_name FROM customer_assets a
       LEFT JOIN customers c ON c.id=a.customer_id
      WHERE a.archived_at IS NOT NULL ORDER BY a.archived_at DESC LIMIT 500`)).rows;
  res.render('assets/archived', { user: req.session.user!, rows, msg: req.query.msg || null, error: req.query.err || null });
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
  // A merged-away record is not an error - it is the same machine under another id, so
  // send the reader to the copy that is being kept rather than showing a stale twin.
  if (row.merged_into_id) {
    res.redirect(`/assets/${row.merged_into_id}?msg=` + encodeURIComponent(
      `That was a duplicate record for this machine — merged into this one. Undo it on the duplicates page if that was wrong.`));
    return;
  }
  // LumenMSP Agent on this device? Matched by serial (preferred) or hostname.
  let agentInfo: any = null;
  try {
    agentInfo = (await pool.query(
      `SELECT id, last_seen_at, agent_version, logged_in_user, local_ips, public_ip, disk_info,
              EXTRACT(EPOCH FROM (NOW() - last_seen_at)) AS seen_secs FROM agent_devices
       WHERE revoked = false AND customer_id = $1
         AND (id = $4
           OR ($4::int IS NULL AND (($2::text IS NOT NULL AND serial_number = $2)
             OR ($3::text IS NOT NULL AND LOWER(hostname) = LOWER($3)))))
       ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
      [row.customer_id, row.serial_number || null, row.hostname || null, row.agent_device_id || null]
    )).rows[0] || null;
  } catch { /* cosmetic — never block the device page */ }
  // Contacts of this device's customer, for the "Assigned user" picker (Portal-side allocation).
  const contactOptions = row.customer_id
    ? (await pool.query('SELECT id, full_name FROM customer_contacts WHERE customer_id=$1 AND archived=false ORDER BY full_name', [row.customer_id])).rows
    : [];

  // Admin-only raw-payload viewer (?debug=1) — lets us see Atera's exact field names for a real
  // device without guessing, since pick() field-name candidates won't always match every Atera
  // account/API version. Temporary diagnostic aid, not a general feature.
  const showDebug = req.session.user!.role === 'admin' && req.query.debug === '1';
  const mesh = await meshStatus(row.id).catch(() => null);

  // ── Server health, on the machine's own page ──────────────────────────────────
  // The /servers section already collects and judges all of this; there is no reason a
  // server's own asset page should send you somewhere else to see it. Same facts, same
  // judgements - one query, and the tab only appears when there is something in it.
  let serverFacts: any = null;
  let serverAlerts: any[] = [];
  let serverRoles: string[] = [];
  if (row.agent_device_id) {
    try {
      const sf = (await pool.query(
        `SELECT *, EXTRACT(EPOCH FROM (NOW() - collected_at))::int AS age_secs
           FROM server_facts WHERE device_id=$1`, [row.agent_device_id])).rows[0] || null;
      if (sf) {
        serverFacts = sf;
        const { judge } = await import('../lib/server-facts');
        const { prettyRoles } = await import('./servers');
        serverAlerts = judge(sf.facts || null);
        serverRoles = prettyRoles(sf.roles || null, Number(sf.sql_instances || 0));
      }
    } catch (e: any) {
      console.error('[assets] server facts failed:', e.message);
    }
  }
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
  // ── Group Policy, on the machine that holds it ────────────────────────────────
  // Deliberately not an estate-wide list: a domain's policy belongs to its domain
  // controller, so it lives on that device's page and nowhere else.
  let gpo: any = null;
  if (row.agent_device_id) {
    // Group Policy shows up on any machine that actually holds Active Directory - the
    // nominated agent, or anything the server collector has identified as a domain
    // controller. Tying it to the nomination alone hid it on every other DC in the estate.
    const dev = (await pool.query(
      `SELECT ad.id, ad.customer_id, ad.is_ad_agent,
              (sf.server_role = 'domain controller') AS is_dc,
              (COALESCE(sf.roles,'') LIKE '%AD-Domain-Services%') AS has_ad_role
         FROM agent_devices ad
         LEFT JOIN server_facts sf ON sf.device_id = ad.id
        WHERE ad.id=$1`, [row.agent_device_id])).rows[0];
    if (dev && dev.customer_id && (dev.is_ad_agent || dev.is_dc || dev.has_ad_role)) {
      const { judgeGpos, explainInventoryOutcome, deleteVerdict, recentDeletions } = await import('../lib/gpo');
      const rows = (await pool.query(
        `SELECT * FROM customer_gpos WHERE customer_id=$1 ORDER BY name`, [dev.customer_id])).rows;
      const findings = judgeGpos(rows as any);
      // The pre-delete judgement, worked out per row so it can be a column and a filter
      // rather than something an engineer runs a PowerShell script to find out.
      for (const r of rows) r.verdict = deleteVerdict(r as any);
      const byGpo = new Map<string, any[]>();
      for (const f of findings) {
        const list = byGpo.get(f.gpoId) || [];
        list.push(f);
        byGpo.set(f.gpoId, list);
      }
      for (const r of rows) r.findings = byGpo.get(r.gpo_id) || [];

      const last = (await pool.query(
        `SELECT id, status, output, finished_at, length(output) AS output_len,
                -- Did anything actually get filed as a result of this run? Comparing the
                -- run to the newest row is the only honest test: a collection that failed
                -- while older rows were already present used to leave no trace at all.
                (finished_at > COALESCE(
                  (SELECT MAX(collected_at) FROM customer_gpos WHERE customer_id=$2), 'epoch'::timestamptz)
                  + INTERVAL '5 seconds') AS stale
           FROM agent_commands
          WHERE device_id=$1 AND kind='gpo.inventory' AND finished_at IS NOT NULL
          ORDER BY id DESC LIMIT 1`, [dev.id, dev.customer_id])).rows[0] || null;
      const pending = (await pool.query(
        `SELECT id FROM agent_commands WHERE device_id=$1 AND kind='gpo.inventory'
          AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`, [dev.id])).rows[0] || null;

      let problem: string | null = null;
      // Fire when the run stored nothing at all, OR when it finished without updating a
      // single row - which is what a failed collection looks like when yesterday's data
      // is still sitting there.
      if (last && (!rows.length || last.stale)) {
        if (last.status !== 'done') {
          const out = String(last.output || '');
          problem = /Get-GPO|GroupPolicy|not recognized|not recognised/i.test(out)
            ? 'This machine does not have the Group Policy tools. On a member server: Install-WindowsFeature GPMC.'
            : (out.trim().slice(-400) || 'The agent returned nothing at all.');
        } else {
          problem = explainInventoryOutcome(String(last.output || ''), rows.length && !last.stale ? rows.length : 0, 4_000_000).message;
          if (problem && rows.length) {
            problem = 'The policies below are from an earlier collection. ' + problem;
          }
        }
      }

      gpo = {
        deviceId: dev.id, customerId: dev.customer_id, assetId: row.id, rows,
        isAdAgent: !!dev.is_ad_agent,
        reviewed: rows.filter((r: any) => r.ai_verdict).length,
        broken: rows.filter((r: any) => r.ai_verdict === 'broken').length,
        watch: rows.filter((r: any) => r.ai_verdict === 'watch').length,
        collectedAt: rows.length ? rows[0].collected_at : null,
        findings: findings.length,
        bad: findings.filter((f: any) => f.level === 'bad').length,
        settings: rows.reduce((a: number, r: any) => a + Number(r.setting_count || 0), 0),
        unlinked: rows.filter((r: any) => Number(r.link_count) === 0).length,
        safeToDelete: rows.filter((r: any) => r.verdict && r.verdict.verdict === 'safe').length,
        deletions: await recentDeletions(dev.customer_id),
        pendingId: pending ? pending.id : null,
        lastAt: last ? last.finished_at : null,
        outputLen: last ? Number(last.output_len || 0) : 0,
        problem,
      };
    }
  }

  res.render('assets/detail', {
    user: req.session.user!, asset: row, agentInfo, gpo,
    trackCommandId: parseInt(String(req.query.cmd || ''), 10) || null,
    latestAgentVersion: agentHostedVersion() || (await getSetting('agent', 'latest_version')) || '',
    backupPlans, backupHistory,
    // Remote control means OUR remote control. It appears when MeshCentral actually has
    // this machine - not when Atera happens to know about it, which is what it used to key
    // on and is meaningless now Atera is on its way out.
    remoteUrl: mesh && mesh.hasNode ? `/assets/${id}/remote-mesh` : null,
    back: safeBack(req.query.back, '/assets'), contactOptions,
    rawJson: showDebug ? JSON.stringify(row.raw, null, 2) : null,
    // Whether remote control is ready on this machine, and if not, which of the several
    // possible reasons it is — so the page can offer the install rather than a dead end.
    meshState: mesh,
    onlineWindowSecs: ONLINE_WINDOW_SECS,
    serverFacts, serverAlerts, serverRoles,
    powerPending: (await pool.query(
      `SELECT 1 FROM agent_commands WHERE device_id=$1 AND kind LIKE 'power.%' AND status IN ('queued','running') LIMIT 1`,
      [row.agent_device_id || 0])).rows.length > 0,
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
  // Remote access lives or dies on the mesh bridge, and nothing on the Portal used to
  // show whether it was running. A bridge that had quietly stopped looked exactly like a
  // healthy one, while every machine enrolled since sat on "remote control not installed".
  const mesh = await import('./mesh');
  const meshBridge = isAdmin ? await mesh.meshBridgeHealth() : null;
  const meshReject = isAdmin ? await mesh.meshBridgeReject() : null;
  const meshContact = isAdmin ? await mesh.meshBridgeContact() : null;
  // Seconds since this process started, so the panel can tell "never" apart from
  // "not yet, we only just restarted".
  const meshWatchingSecs = Math.round((Date.now() - mesh.PORTAL_STARTED.getTime()) / 1000);
  const meshCycleSecs = mesh.BRIDGE_CYCLE_SECS;
  // Not just how many — WHICH machines. A count sends somebody digging through 138
  // devices; a name with a link is a fix that starts immediately (learned 13 Aug, when
  // "4 machines" had to be identified by hand during the bridge outage).
  const meshStrandedRows = isAdmin ? (await pool.query(
    `SELECT ad.id, ad.hostname, ad.last_seen_at, c.name AS customer_name,
            EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS seen_secs,
            (SELECT ca.id FROM customer_assets ca
              WHERE ca.agent_device_id = ad.id AND ca.merged_into_id IS NULL AND ca.archived_at IS NULL LIMIT 1) AS asset_id
       FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ad.revoked=false AND ad.mesh_node_id IS NULL AND ad.mesh_installed = true
      ORDER BY c.name NULLS LAST, ad.hostname`)).rows : [];
  const meshStranded = meshStrandedRows.length;
  const meshLoose = isAdmin ? (await pool.query(
    'SELECT node_id, group_id, hostname, seen_at FROM mesh_unmatched_nodes ORDER BY hostname LIMIT 50')).rows : [];
  const ringCounts = (await pool.query(
    `SELECT COALESCE(update_ring,2) AS ring, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE agent_version IS DISTINCT FROM $1)::int AS behind
       FROM agent_devices WHERE revoked=false GROUP BY 1`, [rollout.version])).rows;
  res.render('assets/agents', {
    user: req.session.user!, rows, customers, defaults, isAdmin,
    rollout, ringCounts, hostedSha: agentHostedSha256(),
    meshBridge, meshReject, meshContact, meshStranded, meshStrandedRows, meshLoose, meshWatchingSecs, meshCycleSecs,
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

// Delete a device FOREVER. Deliberately two-step: only a device that is already revoked
// can be deleted, so a live machine can never be nuked in one click. Hard rows go
// (commands, software, patches, CE results, server facts, remote-session index, GPO-run
// references); business records keep their history — the linked asset survives with the
// device link cleared and its status set honestly, tickets keep their case but lose the
// device pointer. Everything in one transaction; the activity log records the hostname.
router.post('/agents/:id/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const d = (await pool.query('SELECT id, hostname, revoked FROM agent_devices WHERE id=$1', [id])).rows[0];
    if (!d) { res.redirect('/agents?err=' + encodeURIComponent('No such device.')); return; }
    if (!d.revoked) {
      res.redirect('/agents?err=' + encodeURIComponent('Revoke it first — delete is only for revoked devices, so a live machine can never vanish in one click.'));
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agent_commands WHERE device_id=$1', [id]);
      await client.query('DELETE FROM agent_software WHERE device_id=$1', [id]);
      await client.query('DELETE FROM device_patches WHERE device_id=$1', [id]);
      await client.query('DELETE FROM ce_device_results WHERE device_id=$1', [id]);
      await client.query('DELETE FROM ce_findings WHERE device_id=$1', [id]);
      await client.query('DELETE FROM server_facts WHERE device_id=$1', [id]);
      await client.query('DELETE FROM remote_sessions WHERE device_id=$1', [id]);
      // History that references the device but belongs to something bigger: keep the row,
      // clear the pointer.
      await client.query('UPDATE ce_assessments SET device_id=NULL WHERE device_id=$1', [id]);
      await client.query('UPDATE customer_networks SET device_id=NULL WHERE device_id=$1', [id]);
      await client.query('UPDATE gpo_deletions SET device_id=NULL WHERE device_id=$1', [id]);
      await client.query('UPDATE inbox_tickets SET agent_device_id=NULL WHERE agent_device_id=$1', [id]);
      await client.query(
        `UPDATE customer_assets SET agent_device_id=NULL, online_status=false,
                data_source='agent required', updated_at=NOW() WHERE agent_device_id=$1`, [id]);
      await client.query('DELETE FROM agent_devices WHERE id=$1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await logActivity(req.session.user!.id, 'agent_deleted', 'agent_devices', id,
      `Device DELETED forever: ${d.hostname || 'device ' + id}`);
    res.redirect('/agents?msg=' + encodeURIComponent(`${d.hostname || 'Device'} deleted. Its asset record survives as "agent required"; reinstalling the agent re-adopts it.`));
  } catch (e: any) {
    console.error('[agents] delete failed:', e.message);
    res.redirect('/agents?err=' + encodeURIComponent('Could not delete: ' + e.message));
  }
});

export default router;
