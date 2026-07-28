import { pool } from '../db/pool';
import { Atera, pick } from './atera';
import { logActivity } from './activity';
import { getSetting, setSetting } from './settings';

// Asset Manager v1: one-way pull from Atera's device (agent) inventory into customer_assets.
// READ-ONLY by design — nothing here writes back to Atera. Field names vary across Atera API
// versions/plans, so everything is picked defensively (same approach as ateraCustomer/ateraContact
// in routes/atera.ts) and the full raw payload is kept in `raw` so nothing is lost if a field we
// didn't map turns out to matter later.

function ateraAgent(r: any) {
  const ramRaw = pick(r, ['TotalPhysicalMemoryInGB', 'TotalRAMInGB', 'RAMInGB', 'TotalMemoryGB', 'PhysicalMemory']);
  let ramGb: number | null = null;
  if (ramRaw) {
    const n = parseFloat(ramRaw.replace(/[^0-9.]/g, ''));
    if (!isNaN(n)) ramGb = n;
  }
  const online = r?.OnlineStatus === true || r?.Online === true || String(pick(r, ['OnlineStatus', 'Status'])).toLowerCase() === 'online';
  const disk = pick(r, ['DiskInfo', 'DriveDetails', 'StorageInfo']) || (Array.isArray(r?.Disks) ? r.Disks.map((d: any) => pick(d, ['DiskName', 'Name']) + (d?.TotalSpaceInGB ? ` (${d.TotalSpaceInGB}GB)` : '')).join(', ') : '');
  const ip = pick(r, ['IPAddresses', 'IpAddress', 'IPAddress']) || (Array.isArray(r?.IPAddresses) ? r.IPAddresses.join(', ') : '');
  return {
    ateraId: pick(r, ['AgentID', 'AgentId', 'id']),
    customerAteraId: pick(r, ['CustomerID', 'CustomerId', 'customerId']),
    hostname: pick(r, ['MachineName', 'AgentName', 'ComputerName', 'Name']),
    deviceType: pick(r, ['AgentType', 'DeviceType', 'MachineType']) || 'Device',
    os: pick(r, ['OSName', 'OS', 'OSType', 'OSPlatform']),
    osVersion: pick(r, ['OSVersion', 'OSBuild']),
    manufacturer: pick(r, ['Manufacturer', 'SystemManufacturer']),
    model: pick(r, ['Model', 'SystemModel', 'DeviceModel']),
    serialNumber: pick(r, ['SerialNumber', 'DeviceSerialNumber']),
    cpu: pick(r, ['Processor', 'CPUName', 'CPU']),
    ramGb,
    diskInfo: disk,
    ipAddresses: ip,
    macAddress: pick(r, ['MacAddress', 'MACAddress']),
    domainOrWorkgroup: pick(r, ['DomainName', 'Workgroup', 'Domain']),
    online,
    lastSeenAt: parseDate(pick(r, ['LastSeen', 'LastOnline', 'LastReported'])),
    lastRebootAt: parseDate(pick(r, ['LastRebootTime', 'LastReboot'])),
  };
}
function parseDate(s: string): Date | null { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }

export interface AssetSyncResult { synced: number; unmatched: number; error?: string }

// Pulls Atera's full device list and upserts into customer_assets, keyed on (source_system,
// external_id) so re-running is always safe. Agents whose CustomerID doesn't map to a portal
// customer (via customer_external_ids) are still stored (customerId=null) so nothing silently
// disappears — they show up as "Unmatched" on the Assets list for someone to reconcile.
export async function syncAssetsFromAtera(userId: number): Promise<AssetSyncResult> {
  const a = await Atera.load();
  if (!a.hasKey()) return { synced: 0, unmatched: 0, error: 'Atera API key not set — add it in Settings → Integrations.' };

  let agents: any[];
  try { agents = await a.getAgents(); }
  catch (e: any) { return { synced: 0, unmatched: 0, error: 'Atera pull failed: ' + e.message }; }

  const custByAtera = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows
    .forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));

  let synced = 0, unmatched = 0;
  for (const raw of agents) {
    const d = ateraAgent(raw);
    if (!d.ateraId) continue;
    const customerId = custByAtera.get(d.customerAteraId) || null;
    if (!customerId) unmatched++;
    await pool.query(
      `INSERT INTO customer_assets (customer_id, source_system, external_id, hostname, device_type, os, os_version,
         manufacturer, model, serial_number, cpu, ram_gb, disk_info, ip_addresses, mac_address, domain_or_workgroup,
         online_status, last_seen_at, last_reboot_at, raw, synced_at, updated_at)
       VALUES ($1,'atera',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())
       ON CONFLICT (source_system, external_id) DO UPDATE SET
         customer_id=$1, hostname=$3, device_type=$4, os=$5, os_version=$6, manufacturer=$7, model=$8,
         serial_number=$9, cpu=$10, ram_gb=$11, disk_info=$12, ip_addresses=$13, mac_address=$14,
         domain_or_workgroup=$15, online_status=$16, last_seen_at=$17, last_reboot_at=$18, raw=$19,
         synced_at=NOW(), updated_at=NOW()`,
      [customerId, d.ateraId, d.hostname || null, d.deviceType || null, d.os || null, d.osVersion || null,
       d.manufacturer || null, d.model || null, d.serialNumber || null, d.cpu || null, d.ramGb, d.diskInfo || null,
       d.ipAddresses || null, d.macAddress || null, d.domainOrWorkgroup || null, d.online, d.lastSeenAt, d.lastRebootAt,
       JSON.stringify(raw)]
    );
    synced++;
  }

  await setSetting('atera', 'assets_last_synced_at', new Date().toISOString());
  await logActivity(userId, 'created', 'customers', null, `Atera asset sync: ${synced} device(s) synced, ${unmatched} unmatched to a customer`);
  return { synced, unmatched };
}

export async function lastAssetSyncAt(): Promise<string | null> {
  return (await getSetting('atera', 'assets_last_synced_at')) || null;
}

// Deep-link template to Atera's own agent page (for the remote-control button) — a setting so
// it can be corrected without a redeploy once the exact URL format is confirmed against the
// live Atera account. {agentId} is replaced with the device's Atera AgentID.
const DEFAULT_REMOTE_TEMPLATE = 'https://app.atera.com/AgentDetails/{agentId}';
export async function remoteUrlTemplate(): Promise<string> {
  return (await getSetting('atera', 'remote_url_template')) || DEFAULT_REMOTE_TEMPLATE;
}
export async function saveRemoteUrlTemplate(tpl: string): Promise<void> {
  await setSetting('atera', 'remote_url_template', tpl.trim() || DEFAULT_REMOTE_TEMPLATE);
}
export function buildRemoteUrl(template: string, agentId: string): string {
  return template.replace('{agentId}', encodeURIComponent(agentId));
}
