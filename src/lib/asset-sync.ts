import { pool } from '../db/pool';
import { Atera, pick } from './atera';
import { logActivity } from './activity';
import { getSetting, setSetting } from './settings';
import { backfillAssetsFromAgents, normalSerial, shortHost } from './agent-asset';

// Atera is an IMPORTER, not a source of truth. (Terry, 2026-08-12: "we only [use] Atera to
// import agents and advise the agent is required in the Portal, nothing else - Portal is to
// be the master of the RMM part now.")
//
// So this pull does exactly two things:
//   1. Tells us a machine EXISTS that we do not already have. Those rows land with no agent
//      bound, which is what the "agent required" flag on /assets reads.
//   2. Stamps Atera's own identifiers onto machines we DO already own, so the old deep-link
//      still works while Atera is being wound down.
// It is not allowed to write a single inventory field onto a device our agent reports. That
// rule is what removed the duplicate, disagreeing values from the device page.

function ateraAgent(r: any) {
  // Field names confirmed against a REAL payload via /assets/:id?debug=1 (2026-07-30):
  // RAM = Memory (MB, number) - disks = HardwareDisks [{Drive, Free, Used, Total} in MB] -
  // manufacturer/model/serial = Vendor / VendorBrandModel / VendorSerialNumber -
  // local IPs = IpAddresses (array) - MACs = MacAddresses (array). Old guessed names kept as fallbacks.
  const ramRaw = pick(r, ['TotalPhysicalMemoryInGB', 'TotalRAMInGB', 'RAMInGB', 'TotalMemoryGB', 'PhysicalMemory']);
  let ramGb: number | null = null;
  if (ramRaw) {
    const n = parseFloat(ramRaw.replace(/[^0-9.]/g, ''));
    if (!isNaN(n)) ramGb = n;
  }
  if (ramGb === null && typeof r?.Memory === 'number' && r.Memory > 0) ramGb = Math.round((r.Memory / 1024) * 10) / 10;
  const online = r?.OnlineStatus === true || r?.Online === true || String(pick(r, ['OnlineStatus', 'Status'])).toLowerCase() === 'online';
  const hwDisks = Array.isArray(r?.HardwareDisks)
    ? r.HardwareDisks.map((d: any) => [d?.Drive || '?', d?.Total ? Math.round(d.Total / 1024) + 'GB' : '', (d?.Free !== null && d?.Free !== undefined) ? '(' + Math.round(d.Free / 1024) + 'GB free)' : ''].filter(Boolean).join(' ')).join(', ')
    : '';
  const disk = hwDisks || pick(r, ['DiskInfo', 'DriveDetails', 'StorageInfo']) || (Array.isArray(r?.Disks) ? r.Disks.map((d: any) => pick(d, ['DiskName', 'Name']) + (d?.TotalSpaceInGB ? ` (${d.TotalSpaceInGB}GB)` : '')).join(', ') : '');
  const ip = (Array.isArray(r?.IpAddresses) ? r.IpAddresses.join(', ') : '') || (Array.isArray(r?.IPAddresses) ? r.IPAddresses.join(', ') : '') || pick(r, ['IpAddress', 'IPAddress']);
  return {
    ateraId: pick(r, ['AgentID', 'AgentId', 'id']),
    // GUID identifier Atera's newer web UI uses in its device URL (app.atera.com/new/rmm/device/{guid}/agent)
    // — distinct from the numeric AgentID above, which the OLDER AgentDetails/{id} page used.
    deviceGuid: pick(r, ['DeviceGuid', 'MachineGuid', 'Guid', 'GUID', 'DeviceGUID', 'AgentGuid']),
    customerAteraId: pick(r, ['CustomerID', 'CustomerId', 'customerId']),
    hostname: pick(r, ['MachineName', 'AgentName', 'ComputerName', 'Name']),
    deviceType: pick(r, ['AgentType', 'DeviceType', 'MachineType']) || 'Device',
    os: pick(r, ['OSName', 'OS', 'OSType', 'OSPlatform']),
    osVersion: pick(r, ['OSVersion', 'OSBuild']),
    manufacturer: pick(r, ['Vendor', 'Manufacturer', 'SystemManufacturer']),
    model: pick(r, ['VendorBrandModel', 'Model', 'SystemModel', 'DeviceModel']),
    serialNumber: pick(r, ['VendorSerialNumber', 'SerialNumber', 'DeviceSerialNumber']),
    cpu: pick(r, ['Processor', 'CPUName', 'CPU']),
    ramGb,
    diskInfo: disk,
    ipAddresses: ip,
    macAddress: (Array.isArray(r?.MacAddresses) ? r.MacAddresses.join(', ') : '') || pick(r, ['MacAddress', 'MACAddress']),
    domainOrWorkgroup: pick(r, ['DomainName', 'Workgroup', 'Domain']),
    online,
    // The IP Atera's cloud saw the agent report FROM (i.e. the site's WAN/public IP) — distinct
    // from ip_addresses above, which is the machine's own local NIC address(es).
    publicIp: pick(r, ['ReportedFromIP', 'ReportedFromIp', 'PublicIP', 'PublicIp']),
    agentVersion: pick(r, ['AgentVersion', 'Version']),
    lastLoginUser: pick(r, ['LastLoggedOnUser', 'LastLoginUser', 'CurrentLoggedUsers', 'CurrentLoggedOnUsers']),
    addedAt: parseDate(pick(r, ['CreatedOn', 'Created', 'DateAdded'])),
    lastSeenAt: parseDate(pick(r, ['LastSeen', 'LastOnline', 'LastReported', 'Modified'])),
    lastRebootAt: parseDate(pick(r, ['LastRebootTime', 'LastReboot'])),
  };
}
function parseDate(s: string): Date | null { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }

export interface AssetSyncResult {
  /** machines imported because we had no record of them (no agent) */
  imported: number;
  /** machines Atera also knows about that our own agent already owns - identifiers only */
  linked: number;
  synced: number;
  unmatched: number;
  error?: string;
}

// Pulls Atera's full device list and upserts into customer_assets, keyed on (source_system,
// external_id) so re-running is always safe. Agents whose CustomerID doesn't map to a portal
// customer (via customer_external_ids) are still stored (customerId=null) so nothing silently
// disappears — they show up as "Unmatched" on the Assets list for someone to reconcile.
// userId is nullable so the hourly scheduled import (lib/auto-sync.ts) can run with no
// person behind it - it only ever reaches logActivity, which already takes null.
export async function syncAssetsFromAtera(userId: number | null = null): Promise<AssetSyncResult> {
  const a = await Atera.load();
  if (!a.hasKey()) return { imported: 0, linked: 0, synced: 0, unmatched: 0, error: 'Atera API key not set - add it in Settings -> Integrations.' };

  let agents: any[];
  try { agents = await a.getAgents(); }
  catch (e: any) { return { imported: 0, linked: 0, synced: 0, unmatched: 0, error: 'Atera pull failed: ' + e.message }; }

  // Adopt anything our agents already cover before deciding what Atera is allowed to write.
  await backfillAssetsFromAgents();

  const custByAtera = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows
    .forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));

  // Every device the Portal already owns, keyed both ways, so an Atera record can be
  // recognised as "we have this machine" without a query per agent.
  // Keyed exactly the way agent-asset.ts matches, junk serials excluded - otherwise the
  // import happily recreates the second copy we just merged away.
  const ownedBySerial = new Map<string, number>();
  const ownedByHost = new Map<string, number>();
  (await pool.query(
    `SELECT id, customer_id, serial_number, hostname
       FROM customer_assets WHERE agent_device_id IS NOT NULL AND merged_into_id IS NULL`)).rows.forEach((r: any) => {
    const sn = normalSerial(r.serial_number);
    const hn = shortHost(r.hostname);
    if (sn) ownedBySerial.set(r.customer_id + '|' + sn, r.id);
    if (hn) ownedByHost.set(r.customer_id + '|' + hn, r.id);
  });

  let imported = 0, linked = 0, unmatched = 0;
  for (const raw of agents) {
    const d = ateraAgent(raw);
    if (!d.ateraId) continue;
    const customerId = custByAtera.get(d.customerAteraId) || null;
    if (!customerId) unmatched++;

    // Do we already own this machine?
    const dSerial = normalSerial(d.serialNumber);
    const dHost = shortHost(d.hostname);
    const owned = customerId
      ? (dSerial ? ownedBySerial.get(customerId + '|' + dSerial) : undefined)
        ?? (dHost ? ownedByHost.get(customerId + '|' + dHost) : undefined)
      : undefined;

    if (owned) {
      // Identifiers and the raw payload only. Not one inventory field - our agent is
      // standing on the machine and Atera is not.
      await pool.query(
        `UPDATE customer_assets
            SET atera_agent_id=$1, device_guid=COALESCE(device_guid, $2), raw=$3, synced_at=NOW(), updated_at=NOW()
          WHERE id=$4`,
        [d.ateraId, d.deviceGuid || null, JSON.stringify(raw), owned]);
      linked++;
      continue;
    }

    // A machine we do not have. Import it so it is visible and can be chased - this is the
    // "you still need to put our agent on this one" list.
    await pool.query(
      `INSERT INTO customer_assets (customer_id, source_system, external_id, atera_agent_id, data_source, device_guid, hostname, device_type, os, os_version,
         manufacturer, model, serial_number, cpu, ram_gb, disk_info, ip_addresses, mac_address, domain_or_workgroup,
         online_status, public_ip, agent_version, last_login_user, added_at, last_seen_at, last_reboot_at, raw, synced_at, updated_at)
       VALUES ($1,'atera',$2,$2,'atera',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW(),NOW())
       ON CONFLICT (source_system, external_id) DO UPDATE SET
         customer_id=$1, atera_agent_id=$2, device_guid=$3, hostname=$4, device_type=$5, os=$6, os_version=$7, manufacturer=$8, model=$9,
         serial_number=$10, cpu=$11, ram_gb=$12, disk_info=$13, ip_addresses=$14, mac_address=$15,
         domain_or_workgroup=$16, online_status=$17, public_ip=$18, agent_version=$19, last_login_user=$20,
         added_at=$21, last_seen_at=$22, last_reboot_at=$23, raw=$24,
         synced_at=NOW(), updated_at=NOW()
       WHERE customer_assets.agent_device_id IS NULL`,
      [customerId, d.ateraId, d.deviceGuid || null, d.hostname || null, d.deviceType || null, d.os || null, d.osVersion || null,
       d.manufacturer || null, d.model || null, d.serialNumber || null, d.cpu || null, d.ramGb, d.diskInfo || null,
       d.ipAddresses || null, d.macAddress || null, d.domainOrWorkgroup || null,
       // ALWAYS false. A machine with no LumenMSP Agent on it is offline as far as the
       // Portal is concerned - we have no live link to it, and showing Atera's green dot
       // implied we did. d.online is still kept in `raw` if it is ever wanted.
       false,
       d.publicIp || null, d.agentVersion || null, d.lastLoginUser || null, d.addedAt, d.lastSeenAt, d.lastRebootAt,
       JSON.stringify(raw)]
    );
    imported++;
  }

  // An Atera row whose machine has since had our agent put on it gets adopted here rather
  // than living on as a second, staler copy of the same PC.
  await backfillAssetsFromAgents();

  await setSetting('atera', 'assets_last_synced_at', new Date().toISOString());
  await logActivity(userId, 'created', 'customers', null,
    `Atera import: ${imported} device(s) without our agent, ${linked} already covered by the LumenMSP Agent, ${unmatched} unmatched to a customer`);
  return { imported, linked, synced: imported + linked, unmatched };
}

export async function lastAssetSyncAt(): Promise<string | null> {
  return (await getSetting('atera', 'assets_last_synced_at')) || null;
}

// Deep-link template to Atera's own device page (for the remote-control button) — a setting so
// it can be corrected without a redeploy if Atera's URL format changes again. Confirmed live with
// Terry 2026-07-23: Atera's current web UI uses /new/rmm/device/{deviceGuid}/agent (a GUID, not
// the plain numeric AgentID the old AgentDetails/{id} page used). {agentId} is kept as a fallback
// placeholder for rows synced before device_guid was captured, or if Atera's URL changes again.
const DEFAULT_REMOTE_TEMPLATE = 'https://app.atera.com/new/rmm/device/{deviceGuid}/agent';
const FALLBACK_REMOTE_TEMPLATE = 'https://app.atera.com/AgentDetails/{agentId}';
export async function remoteUrlTemplate(): Promise<string> {
  return (await getSetting('atera', 'remote_url_template')) || DEFAULT_REMOTE_TEMPLATE;
}
export async function saveRemoteUrlTemplate(tpl: string): Promise<void> {
  await setSetting('atera', 'remote_url_template', tpl.trim() || DEFAULT_REMOTE_TEMPLATE);
}
// Builds the remote-control link for one device. Falls back to the old numeric-ID page when the
// template needs a device_guid we haven't synced yet (older row, not yet re-synced from Atera).
export function buildRemoteUrl(template: string, ids: { agentId?: string | null; deviceGuid?: string | null }): string {
  if (template.includes('{deviceGuid}') && !ids.deviceGuid) {
    return FALLBACK_REMOTE_TEMPLATE.replace('{agentId}', encodeURIComponent(ids.agentId || ''));
  }
  let url = template;
  if (ids.deviceGuid) url = url.replace('{deviceGuid}', encodeURIComponent(ids.deviceGuid));
  if (ids.agentId) url = url.replace('{agentId}', encodeURIComponent(ids.agentId));
  return url;
}
