import cron from 'node-cron';
import { pool } from '../db/pool';
import { getGroup } from './settings';
import { raiseAlert, resolveAlert } from './alerts';

// UniFi Site Manager API poller (https://api.ui.com, read-only X-API-Key). Backstop to the
// real-time Alarm Manager webhook: every few minutes we list devices and raise/clear alerts for
// any that are offline. API key lives in settings group 'unifi' key 'api_key'.
const BASES = ['https://api.ui.com/v1', 'https://api.ui.com/ea'];

async function apiGet(path: string, key: string): Promise<any | null> {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path, { headers: { 'X-API-Key': key, Accept: 'application/json' } });
      if (r.status === 404) continue;
      if (!r.ok) { console.warn(`[unifi] ${base}${path} → HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) { console.warn(`[unifi] ${base}${path} failed:`, (e as Error).message); }
  }
  return null;
}

// Flatten whatever device shape the API returns (flat list, or grouped under hosts/sites).
function flattenDevices(data: any): any[] {
  const out: any[] = [];
  const arr = Array.isArray(data) ? data : (data?.data || data?.devices || []);
  for (const x of (Array.isArray(arr) ? arr : [])) {
    if (Array.isArray(x?.devices)) out.push(...x.devices.map((d: any) => ({ ...d, hostName: x.hostName || x.name, hostId: x.id || x.hostId || d.hostId })));
    else out.push(x);
  }
  return out;
}
function isOffline(d: any): boolean {
  const s = String(d.status || d.state || '').toLowerCase();
  return s ? (s !== 'online' && s !== 'connected' && s !== 'ok') : false;
}
function devKey(d: any): string { return 'device:' + (d.mac || d.id || d.name || JSON.stringify(d).slice(0, 40)); }
// A gateway/console offline = the whole site is unavailable → critical (siren).
function isGateway(d: any): boolean {
  return /gateway|udm|ugw|uxg|usg|console|router|dream/i.test(String(d.type || d.model || d.productLine || d.name || ''));
}

export async function pollUnifi(): Promise<void> {
  const g = await getGroup('unifi').catch(() => ({} as Record<string, string>));
  const key = g.api_key;
  if (!key) return; // not configured
  const data = await apiGet('/devices', key);
  if (!data) { console.warn('[unifi] no device data from Site Manager API'); return; }
  const devices = flattenDevices(data);
  if (!devices.length) return;

  const offline = devices.filter(isOffline);
  const offlineKeys = new Set(offline.map(devKey));
  for (const d of offline) {
    const name = d.name || d.model || d.mac || 'device';
    const gw = isGateway(d);
    // Deep link to the site's UniFi console when we can build one, else the Site Manager dashboard.
    const siteUrl = d.consoleUrl || (d.hostId ? `https://unifi.ui.com/consoles/${d.hostId}` : 'https://unifi.ui.com');
    await raiseAlert({
      source: 'unifi', externalId: devKey(d), severity: gw ? 'critical' : 'warning',
      title: (gw ? 'Site unavailable — gateway offline: ' : 'UniFi device offline: ') + name,
      body: `${name}${d.hostName ? ' @ ' + d.hostName : ''}${d.mac ? ' (' + d.mac + ')' : ''} is offline.`,
      url: siteUrl,
      raw: d, autoTicket: false,   // operator decides whether to raise a ticket; alert auto-clears on recovery
    }).catch(() => {});
  }
  // Clear alerts for devices that have come back online.
  try {
    const open = await pool.query("SELECT external_id FROM alerts WHERE source='unifi' AND status='open' AND external_id LIKE 'device:%'");
    for (const row of open.rows) if (!offlineKeys.has(row.external_id)) await resolveAlert('unifi', row.external_id);
  } catch (e) { console.error('[unifi] resolve sweep failed:', (e as Error).message); }
}

export function startUnifiPoll(): void {
  cron.schedule('*/5 * * * *', () => { pollUnifi().catch((e) => console.error('[unifi]', e.message)); });
  console.log('✓ UniFi Site Manager poller started (5-min)');
}

// Parse an inbound UniFi Alarm Manager webhook payload into an alert. Shapes vary by trigger, so
// pull fields defensively. Returns null if it can't make sense of it.
export function parseUnifiWebhook(body: any): { externalId: string; severity: string; title: string; resolved: boolean } | null {
  if (!body || typeof body !== 'object') return null;
  const alarm = body.alarm || body.trigger || body;
  const title = String(alarm.name || alarm.title || body.subject || body.message || body.event || 'UniFi alert').slice(0, 200);
  const sevRaw = String(body.severity || alarm.severity || '').toLowerCase();
  const severity = /crit|high|urgent/.test(sevRaw) ? 'critical' : /info|low/.test(sevRaw) ? 'info' : 'warning';
  const resolved = /resolv|clear|recover|back online|restored/i.test(String(body.status || body.state || body.type || title));
  const externalId = String(body.id || body.alarmId || alarm.id || (title + ':' + (body.deviceMac || body.mac || ''))).slice(0, 200);
  return { externalId, severity, title, resolved };
}
