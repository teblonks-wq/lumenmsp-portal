import { pool } from '../db/pool';
import { logActivity } from './activity';
import { windowsOsName } from './os-name';

// ── The Portal's own device record ──────────────────────────────────────────────
// Portal is master of the RMM record. The LumenMSP Agent is what reports a machine;
// Atera is only allowed to tell us a machine EXISTS.
//
// Before this, customer_assets was filled exclusively by the Atera sync, which had two
// consequences we kept paying for:
//   1. A machine could enrol our agent and still not appear on /assets at all, because
//      nobody had run an Atera sync since - "we added machines to Atera and the Portal
//      but they didn't sync, so the agent wasn't available".
//   2. Every field arrived twice: once from Atera's inventory and once from our own
//      agent, so the device page showed two of everything and they disagreed.
// Both go away by making enrolment itself create and maintain the asset row.

const ONLINE_WINDOW_SECS = 12 * 60;

// ── Matching a machine to the row we already hold ───────────────────────────────
// This is what decides whether deploying our agent to a machine Atera already told us
// about ADOPTS that row or creates a second one. It was exact-string on both fields,
// which meant a trailing space, a change of case, or Atera holding the FQDN where our
// agent reports the short name all produced a duplicate. Hence "when we deploy our agent
// to devices already in the list we get two devices - not on all" (Terry, 2026-08-12):
// it only bit the machines where one of those three things happened to be true.
//
// SQL-side equivalents of these live in ASSET_SERIAL_SQL / ASSET_HOST_SQL below; the two
// MUST stay in step, so they are defined next to each other.

/** Serials that are not serials. Whole production runs ship with these, so matching on
 *  one would merge unrelated machines together - far worse than a duplicate. */
const JUNK_SERIALS = new Set([
  '', 'TO BE FILLED BY O.E.M.', 'DEFAULT STRING', 'SYSTEM SERIAL NUMBER', 'NONE', 'N/A',
  'NOT SPECIFIED', 'NOT APPLICABLE', '0', '00000000', 'UNKNOWN', 'SERIAL NUMBER',
]);

export function normalSerial(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!t || t.length < 3 || JUNK_SERIALS.has(t)) return null;
  return t;
}

/** The short host name. Atera and our agent do not always agree on whether the domain is
 *  part of it, and "AL-07" and "al-07.acumen.local" are the same PC. */
export function shortHost(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim().toLowerCase().split('.')[0];
  return t || null;
}

// Postgres versions of the two above, for the set-based passes.
const ASSET_SERIAL_SQL = (col: string) => `NULLIF(UPPER(BTRIM(${col})), '')`;
const JUNK_SQL = `('','TO BE FILLED BY O.E.M.','DEFAULT STRING','SYSTEM SERIAL NUMBER','NONE','N/A','NOT SPECIFIED','NOT APPLICABLE','0','00000000','UNKNOWN','SERIAL NUMBER')`;
const SERIAL_USABLE = (col: string) => `(${ASSET_SERIAL_SQL(col)} IS NOT NULL AND LENGTH(BTRIM(${col})) >= 3 AND UPPER(BTRIM(${col})) NOT IN ${JUNK_SQL})`;
const HOST_SQL = (col: string) => `NULLIF(SPLIT_PART(LOWER(BTRIM(${col})), '.', 1), '')`;

/** agent_devices.disk_info is JSON from the agent; customer_assets.disk_info is the
 *  one-line human summary the device page and the asset list read. */
export function diskSummary(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const list = JSON.parse(json);
    if (!Array.isArray(list) || !list.length) return null;
    const parts = list.map((d: any) => {
      const drive = String(d?.drive ?? '?').replace(/\\+$/, '');
      const total = Number(d?.total_gb);
      const free = Number(d?.free_gb);
      const bits = [drive];
      if (Number.isFinite(total) && total > 0) bits.push(Math.round(total) + 'GB');
      if (Number.isFinite(free)) bits.push('(' + Math.round(free) + 'GB free)');
      return bits.join(' ');
    });
    return parts.join(', ').slice(0, 500) || null;
  } catch { return null; }
}

/**
 * Create or refresh the customer_assets row for one agent device. Called on enrolment
 * (so the machine is on /assets within seconds of the agent landing) and on every
 * heartbeat (so the record stays live without anybody syncing anything).
 *
 * Binding order: an already-bound row, then the same customer's row with a matching
 * serial (survives a rename), then a matching hostname. That deliberately ADOPTS the
 * existing Atera-imported row rather than creating a second one, which is what turns
 * two half-right records into one.
 */
export async function syncAssetFromAgent(deviceId: number): Promise<number | null> {
  try {
    const d = (await pool.query(
      `SELECT id, customer_id, hostname, serial_number, os, os_version, agent_version,
              logged_in_user, local_ips, public_ip, disk_info, manufacturer, model, cpu,
              ram_gb, mac_addresses, domain_or_workgroup, device_type, last_boot_at,
              enrolled_at, last_seen_at
         FROM agent_devices WHERE id=$1 AND revoked=false`, [deviceId])).rows[0];
    if (!d || !d.customer_id) return null;

    const online = d.last_seen_at ? (Date.now() - new Date(d.last_seen_at).getTime()) < ONLINE_WINDOW_SECS * 1000 : false;
    const disk = diskSummary(d.disk_info);

    let row = (await pool.query(
      'SELECT id FROM customer_assets WHERE agent_device_id=$1 AND merged_into_id IS NULL ORDER BY id LIMIT 1',
      [deviceId])).rows[0] || null;

    // Serial first - it survives a rename - but only a serial that means something.
    const serial = normalSerial(d.serial_number);
    if (!row && serial) {
      row = (await pool.query(
        `SELECT id FROM customer_assets
          WHERE customer_id=$1 AND agent_device_id IS NULL AND merged_into_id IS NULL
            AND ${SERIAL_USABLE('serial_number')} AND UPPER(BTRIM(serial_number)) = $2
          ORDER BY id LIMIT 1`, [d.customer_id, serial])).rows[0] || null;
    }
    // Then the SHORT host name, so an FQDN on either side still matches.
    const host = shortHost(d.hostname);
    if (!row && host) {
      row = (await pool.query(
        `SELECT id FROM customer_assets
          WHERE customer_id=$1 AND agent_device_id IS NULL AND merged_into_id IS NULL
            AND ${HOST_SQL('hostname')} = $2
          ORDER BY id LIMIT 1`, [d.customer_id, host])).rows[0] || null;
    }

    // COALESCE on the way in: an older agent build that does not send (say) manufacturer
    // must not blank a value Atera seeded before we owned the row.
    const vals = [
      d.customer_id, d.hostname || null, d.serial_number || null, d.os || null, d.os_version || null,
      d.agent_version || null, d.logged_in_user || null, d.local_ips || null, d.public_ip || null,
      disk, d.manufacturer || null, d.model || null, d.cpu || null, d.ram_gb ?? null,
      d.mac_addresses || null, d.domain_or_workgroup || null, d.device_type || null,
      d.last_boot_at || null, d.last_seen_at || null, online, deviceId,
    ];

    if (row) {
      await pool.query(
        `UPDATE customer_assets SET
            customer_id=$1,
            hostname=COALESCE($2, hostname),
            serial_number=COALESCE($3, serial_number),
            os=COALESCE($4, os),
            os_version=COALESCE($5, os_version),
            agent_version=COALESCE($6, agent_version),
            last_login_user=COALESCE($7, last_login_user),
            ip_addresses=COALESCE($8, ip_addresses),
            public_ip=COALESCE($9, public_ip),
            disk_info=COALESCE($10, disk_info),
            manufacturer=COALESCE($11, manufacturer),
            model=COALESCE($12, model),
            cpu=COALESCE($13, cpu),
            ram_gb=COALESCE($14, ram_gb),
            mac_address=COALESCE($15, mac_address),
            domain_or_workgroup=COALESCE($16, domain_or_workgroup),
            device_type=COALESCE($17, device_type),
            last_reboot_at=COALESCE($18, last_reboot_at),
            last_seen_at=COALESCE($19, last_seen_at),
            online_status=$20,
            agent_device_id=$21,
            data_source='agent',
            synced_at=NOW(), updated_at=NOW()
          WHERE id=$22`, [...vals, row.id]);
      return row.id;
    }

    const ins = await pool.query(
      `INSERT INTO customer_assets
         (customer_id, hostname, serial_number, os, os_version, agent_version, last_login_user,
          ip_addresses, public_ip, disk_info, manufacturer, model, cpu, ram_gb, mac_address,
          domain_or_workgroup, device_type, last_reboot_at, last_seen_at, online_status,
          agent_device_id, source_system, external_id, data_source, added_at, synced_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17,'Workstation'),$18,$19,$20,
               $21,'lumen',$22,'agent',$23,NOW(),NOW())
       ON CONFLICT (source_system, external_id) DO UPDATE SET
         customer_id=EXCLUDED.customer_id, hostname=EXCLUDED.hostname, agent_device_id=EXCLUDED.agent_device_id,
         data_source='agent', synced_at=NOW(), updated_at=NOW()
       RETURNING id`,
      [...vals, 'dev:' + deviceId, d.enrolled_at || new Date()]);
    return ins.rows[0]?.id ?? null;
  } catch (e: any) {
    // The asset record is a mirror. Never fail an enrolment or a heartbeat over it.
    console.error('[asset] agent sync failed for device ' + deviceId + ':', e.message);
    return null;
  }
}

/**
 * Set-based catch-up for everything the per-device path missed: agents that enrolled
 * before this existed, and Atera rows that should be adopted by an agent we already have.
 * Three statements, milliseconds, safe to run repeatedly.
 */
export async function backfillAssetsFromAgents(): Promise<{ bound: number; created: number; refreshed: number; osCorrected: number }> {
  const out = { bound: 0, created: 0, refreshed: 0, osCorrected: 0 };
  try {
    // 1. Adopt the existing (Atera-imported) row for any machine we now have an agent on.
    const bound = await pool.query(
      `UPDATE customer_assets a
          SET agent_device_id = ad.id, data_source='agent', updated_at=NOW()
         FROM agent_devices ad
        WHERE a.agent_device_id IS NULL
          AND ad.revoked = false
          AND ad.customer_id IS NOT NULL
          AND a.merged_into_id IS NULL
          AND ad.customer_id = a.customer_id
          AND ( (${SERIAL_USABLE('a.serial_number')} AND ${SERIAL_USABLE('ad.serial_number')}
                 AND UPPER(BTRIM(ad.serial_number)) = UPPER(BTRIM(a.serial_number)))
             OR (${HOST_SQL('a.hostname')} IS NOT NULL AND ${HOST_SQL('ad.hostname')} = ${HOST_SQL('a.hostname')}) )
        RETURNING a.id`);
    out.bound = bound.rows.length;

    // 2. A machine running our agent that has no asset row at all gets one now, rather
    //    than waiting for somebody to remember to sync Atera.
    const created = await pool.query(
      `INSERT INTO customer_assets
         (customer_id, source_system, external_id, agent_device_id, data_source, hostname,
          serial_number, os, os_version, agent_version, last_login_user, ip_addresses, public_ip,
          device_type, manufacturer, model, cpu, ram_gb, mac_address, domain_or_workgroup,
          online_status, added_at, last_seen_at, last_reboot_at, synced_at, updated_at)
       SELECT ad.customer_id, 'lumen', 'dev:' || ad.id, ad.id, 'agent', ad.hostname,
              ad.serial_number, ad.os, ad.os_version, ad.agent_version, ad.logged_in_user,
              ad.local_ips, ad.public_ip, COALESCE(ad.device_type, 'Workstation'), ad.manufacturer,
              ad.model, ad.cpu, ad.ram_gb, ad.mac_addresses, ad.domain_or_workgroup,
              (ad.last_seen_at > NOW() - interval '12 minutes'), ad.enrolled_at, ad.last_seen_at,
              ad.last_boot_at, NOW(), NOW()
         FROM agent_devices ad
        WHERE ad.revoked = false AND ad.customer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM customer_assets a WHERE a.agent_device_id = ad.id AND a.merged_into_id IS NULL)
       ON CONFLICT (source_system, external_id) DO NOTHING
       RETURNING id`);
    out.created = created.rows.length;

    // 3. Keep the bound rows current. disk_info is left to the per-device path, which is
    //    the only place that has the agent's JSON to summarise.
    const refreshed = await pool.query(
      `UPDATE customer_assets a SET
          hostname = COALESCE(ad.hostname, a.hostname),
          serial_number = COALESCE(ad.serial_number, a.serial_number),
          os = COALESCE(ad.os, a.os),
          os_version = COALESCE(ad.os_version, a.os_version),
          agent_version = COALESCE(ad.agent_version, a.agent_version),
          last_login_user = COALESCE(ad.logged_in_user, a.last_login_user),
          ip_addresses = COALESCE(ad.local_ips, a.ip_addresses),
          public_ip = COALESCE(ad.public_ip, a.public_ip),
          manufacturer = COALESCE(ad.manufacturer, a.manufacturer),
          model = COALESCE(ad.model, a.model),
          cpu = COALESCE(ad.cpu, a.cpu),
          ram_gb = COALESCE(ad.ram_gb, a.ram_gb),
          mac_address = COALESCE(ad.mac_addresses, a.mac_address),
          domain_or_workgroup = COALESCE(ad.domain_or_workgroup, a.domain_or_workgroup),
          device_type = COALESCE(ad.device_type, a.device_type),
          last_reboot_at = COALESCE(ad.last_boot_at, a.last_reboot_at),
          last_seen_at = COALESCE(ad.last_seen_at, a.last_seen_at),
          online_status = (ad.last_seen_at > NOW() - interval '12 minutes'),
          data_source = 'agent', synced_at = NOW(), updated_at = NOW()
         FROM agent_devices ad
        WHERE a.agent_device_id = ad.id AND ad.revoked = false
        RETURNING a.id`);
    out.refreshed = refreshed.rows.length;

    // 3b. Repair Windows 11 machines stored as "Windows 10". The build number is the only
    //     thing that can tell them apart, and it is sitting right there in os_version.
    for (const t of ['agent_devices', 'customer_assets'] as const) {
      const rows = (await pool.query(
        `SELECT id, os, os_version FROM ${t} WHERE os ILIKE '%windows%10%' AND os NOT ILIKE '%server%'`)).rows;
      for (const r of rows) {
        const fixed = windowsOsName(r.os, r.os_version);
        if (fixed && fixed !== r.os) {
          await pool.query(`UPDATE ${t} SET os=$1, updated_at=NOW() WHERE id=$2`, [fixed, r.id]);
          out.osCorrected++;
        }
      }
    }

    // 4. Anything with no agent of ours is offline, full stop. We have no live link to it,
    //    so a green dot inherited from an old Atera sync is a lie that costs somebody a
    //    trip to a machine that is switched off.
    await pool.query(
      `UPDATE customer_assets SET online_status=false, updated_at=NOW()
        WHERE agent_device_id IS NULL AND online_status = true AND merged_into_id IS NULL`);
  } catch (e: any) {
    console.error('[asset] agent backfill failed:', e.message);
  }
  return out;
}


// ── Duplicate machines ──────────────────────────────────────────────────────────
// Two rows, one physical PC: the Atera import and our agent's own record, where the
// match above failed. The fixed matching stops NEW ones appearing; this finds and clears
// the ones already there.

export interface DuplicateGroup {
  key: string;
  reason: 'serial' | 'hostname';
  customerId: number | null;
  customerName: string | null;
  rows: {
    id: number; hostname: string | null; serialNumber: string | null; source: string | null;
    agentDeviceId: number | null; assignedContactId: number | null; lastSeenAt: Date | null;
    ateraAgentId: string | null; externalId: string | null; addedAt: Date | null;
  }[];
}

/** Same customer, same machine, more than one row. Grouped by whichever of the two
 *  identities they actually share, because that is what tells you how sure we are. */
export async function findDuplicateAssets(): Promise<DuplicateGroup[]> {
  const rows = (await pool.query(
    `SELECT a.id, a.customer_id, c.name AS customer_name, a.hostname, a.serial_number,
            a.source_system, a.agent_device_id, a.assigned_contact_id, a.last_seen_at,
            a.atera_agent_id, a.external_id, a.added_at,
            ${SERIAL_USABLE('a.serial_number')} AS serial_ok,
            UPPER(BTRIM(a.serial_number)) AS serial_key,
            ${HOST_SQL('a.hostname')} AS host_key
       FROM customer_assets a
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.merged_into_id IS NULL AND a.customer_id IS NOT NULL
      ORDER BY a.id`)).rows;

  const groups = new Map<string, DuplicateGroup>();
  const put = (key: string, reason: 'serial' | 'hostname', r: any) => {
    if (!groups.has(key)) {
      groups.set(key, { key, reason, customerId: r.customer_id, customerName: r.customer_name, rows: [] });
    }
    const g = groups.get(key)!;
    if (!g.rows.some((x) => x.id === r.id)) {
      g.rows.push({
        id: r.id, hostname: r.hostname, serialNumber: r.serial_number, source: r.source_system,
        agentDeviceId: r.agent_device_id, assignedContactId: r.assigned_contact_id,
        lastSeenAt: r.last_seen_at, ateraAgentId: r.atera_agent_id, externalId: r.external_id,
        addedAt: r.added_at,
      });
    }
  };

  // Serial is the stronger signal, so claim rows for it first and only fall back to the
  // host name for machines a serial could not group.
  const claimed = new Set<number>();
  const bySerial = new Map<string, any[]>();
  for (const r of rows) {
    if (!r.serial_ok || !r.serial_key) continue;
    const k = r.customer_id + '|S|' + r.serial_key;
    if (!bySerial.has(k)) bySerial.set(k, []);
    bySerial.get(k)!.push(r);
  }
  for (const [k, list] of bySerial) {
    if (list.length < 2) continue;
    for (const r of list) { put(k, 'serial', r); claimed.add(r.id); }
  }

  const byHost = new Map<string, any[]>();
  for (const r of rows) {
    if (claimed.has(r.id) || !r.host_key) continue;
    const k = r.customer_id + '|H|' + r.host_key;
    if (!byHost.has(k)) byHost.set(k, []);
    byHost.get(k)!.push(r);
  }
  for (const [k, list] of byHost) {
    if (list.length < 2) continue;
    for (const r of list) put(k, 'hostname', r);
  }

  return Array.from(groups.values()).sort((a, b) =>
    String(a.customerName || '').localeCompare(String(b.customerName || '')) ||
    String(a.rows[0]?.hostname || '').localeCompare(String(b.rows[0]?.hostname || '')));
}

/** Which row of a duplicate group to keep: the one our agent reports, because it is the
 *  one that stays current. Ties break on the older row, so the device's history and its
 *  id in any link somebody has already sent survive. */
export function preferredSurvivor<T extends { id: number; agentDeviceId: number | null }>(rows: T[]): T {
  const withAgent = rows.filter((r) => r.agentDeviceId != null);
  const pool_ = withAgent.length ? withAgent : rows;
  return pool_.slice().sort((a, b) => a.id - b.id)[0];
}

/**
 * Fold one asset row into another. Nothing is deleted: the loser keeps its row and gains
 * merged_into_id, so a wrong merge is one UPDATE away from being undone. Anything only
 * the loser knows - the Portal-side allocation, Atera's identifiers - moves across first.
 */
export async function mergeAsset(keepId: number, dropId: number, userId: number | null): Promise<{ ok: boolean; error?: string }> {
  if (keepId === dropId) return { ok: false, error: 'That is the same device.' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keep = (await client.query('SELECT * FROM customer_assets WHERE id=$1 FOR UPDATE', [keepId])).rows[0];
    const drop = (await client.query('SELECT * FROM customer_assets WHERE id=$1 FOR UPDATE', [dropId])).rows[0];
    if (!keep || !drop) { await client.query('ROLLBACK'); return { ok: false, error: 'One of those devices no longer exists.' }; }
    if (keep.customer_id !== drop.customer_id) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Those two devices belong to different customers - that is not a duplicate, it is a mis-filed machine. Move one to the right customer first.' };
    }
    if (drop.merged_into_id) { await client.query('ROLLBACK'); return { ok: false, error: 'That device has already been merged.' }; }

    // Carry over anything the survivor does not already have. COALESCE both ways round so
    // a merge can never blank a field that was populated.
    await client.query(
      `UPDATE customer_assets SET
         assigned_contact_id = COALESCE(assigned_contact_id, $2),
         atera_agent_id      = COALESCE(atera_agent_id, $3),
         device_guid         = COALESCE(device_guid, $4),
         agent_device_id     = COALESCE(agent_device_id, $5),
         serial_number       = COALESCE(serial_number, $6),
         manufacturer        = COALESCE(manufacturer, $7),
         model               = COALESCE(model, $8),
         cpu                 = COALESCE(cpu, $9),
         ram_gb              = COALESCE(ram_gb, $10),
         mac_address         = COALESCE(mac_address, $11),
         domain_or_workgroup = COALESCE(domain_or_workgroup, $12),
         added_at            = LEAST(COALESCE(added_at, $13), COALESCE($13, added_at)),
         raw                 = COALESCE(raw, $14),
         updated_at          = NOW()
       WHERE id=$1`,
      [keepId, drop.assigned_contact_id, drop.atera_agent_id, drop.device_guid, drop.agent_device_id,
       drop.serial_number, drop.manufacturer, drop.model, drop.cpu, drop.ram_gb, drop.mac_address,
       drop.domain_or_workgroup, drop.added_at, drop.raw]);

    await client.query(
      'UPDATE customer_assets SET merged_into_id=$1, merged_at=NOW(), updated_at=NOW() WHERE id=$2',
      [keepId, dropId]);

    await client.query('COMMIT');
    await logActivity(userId, 'updated', 'customers', keep.customer_id,
      `Device ${drop.hostname || dropId} merged into ${keep.hostname || keepId} (duplicate record)`);
    return { ok: true };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    console.error('[asset] merge failed:', e.message);
    return { ok: false, error: 'Could not merge those two records.' };
  } finally {
    client.release();
  }
}

/** Undo. The merged row simply comes back. */
export async function unmergeAsset(id: number, userId: number | null): Promise<boolean> {
  try {
    const r = await pool.query(
      'UPDATE customer_assets SET merged_into_id=NULL, merged_at=NULL, updated_at=NOW() WHERE id=$1 AND merged_into_id IS NOT NULL RETURNING hostname, customer_id',
      [id]);
    if (!r.rows.length) return false;
    await logActivity(userId, 'updated', 'customers', r.rows[0].customer_id,
      `Device ${r.rows[0].hostname || id} un-merged (restored as its own record)`);
    return true;
  } catch (e: any) {
    console.error('[asset] unmerge failed:', e.message);
    return false;
  }
}
