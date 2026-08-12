import { pool } from '../db/pool';

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

    let row = (await pool.query('SELECT id FROM customer_assets WHERE agent_device_id=$1 ORDER BY id LIMIT 1', [deviceId])).rows[0] || null;
    if (!row && d.serial_number) {
      row = (await pool.query(
        `SELECT id FROM customer_assets
          WHERE customer_id=$1 AND agent_device_id IS NULL AND serial_number=$2
          ORDER BY id LIMIT 1`, [d.customer_id, d.serial_number])).rows[0] || null;
    }
    if (!row && d.hostname) {
      row = (await pool.query(
        `SELECT id FROM customer_assets
          WHERE customer_id=$1 AND agent_device_id IS NULL AND LOWER(hostname)=LOWER($2)
          ORDER BY id LIMIT 1`, [d.customer_id, d.hostname])).rows[0] || null;
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
export async function backfillAssetsFromAgents(): Promise<{ bound: number; created: number; refreshed: number }> {
  const out = { bound: 0, created: 0, refreshed: 0 };
  try {
    // 1. Adopt the existing (Atera-imported) row for any machine we now have an agent on.
    const bound = await pool.query(
      `UPDATE customer_assets a
          SET agent_device_id = ad.id, data_source='agent', updated_at=NOW()
         FROM agent_devices ad
        WHERE a.agent_device_id IS NULL
          AND ad.revoked = false
          AND ad.customer_id IS NOT NULL
          AND ad.customer_id = a.customer_id
          AND ( (a.serial_number IS NOT NULL AND ad.serial_number = a.serial_number)
             OR (a.hostname IS NOT NULL AND ad.hostname IS NOT NULL AND LOWER(ad.hostname) = LOWER(a.hostname)) )
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
          AND NOT EXISTS (SELECT 1 FROM customer_assets a WHERE a.agent_device_id = ad.id)
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

    // 4. Anything with no agent of ours is offline, full stop. We have no live link to it,
    //    so a green dot inherited from an old Atera sync is a lie that costs somebody a
    //    trip to a machine that is switched off.
    await pool.query(
      `UPDATE customer_assets SET online_status=false, updated_at=NOW()
        WHERE agent_device_id IS NULL AND online_status = true`);
  } catch (e: any) {
    console.error('[asset] agent backfill failed:', e.message);
  }
  return out;
}
