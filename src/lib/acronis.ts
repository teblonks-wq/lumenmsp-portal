import cron from 'node-cron';
import { pool } from '../db/pool';
import { getSetting } from './settings';
import { ensureBackupTables } from './msp360';

// ── Acronis Cyber Protect Cloud — backup provider #4 ─────────────────────────────
// Live-verified against Lumen's partner tenant (eu-cloud, Aug 2026). Feeds the same
// provider-agnostic backup tables as MSP360/Azure, so Acronis data appears on the
// customer panel, asset pages and the monthly IT report automatically once a tenant
// is LINKED to a Portal customer (Acronis tenant names differ from Portal names —
// e.g. "Staybrook Capital Limited" — so linking is manual, same as MSP360).
//
// API (base = datacenter URL, e.g. https://eu-cloud.acronis.com):
//   POST /api/2/idp/token                (Basic client_id:secret, client_credentials)
//   GET  /api/2/clients/{client_id}      → our partner tenant id
//   GET  /api/2/tenants?parent_id=…      → customer tenants (kind 'customer')
//   GET  /api/2/tenants/{id}/usages      → per-tenant protected storage + workload counts
//   GET  /api/alert_manager/v1/alerts    → active alerts (partner-wide; empty = healthy)
//
// Workload rows are synthesised from the usage counters (mailboxes / SharePoint /
// Teams / workstations…) — Acronis C2C backups run continuously, so "plan status" is
// healthy unless the tenant has active alerts.
//
// Credentials: settings group 'acronis' (client_id / secret / datacenter), falling back
// to env ACRONIS_CLIENT_ID / ACRONIS_SECRET / ACRONIS_DC.

async function creds(): Promise<{ id: string; secret: string; base: string } | null> {
  const id = ((await getSetting('acronis', 'client_id').catch(() => '')) || process.env.ACRONIS_CLIENT_ID || '').trim();
  const secret = ((await getSetting('acronis', 'secret').catch(() => '')) || process.env.ACRONIS_SECRET || '').trim();
  const base = (((await getSetting('acronis', 'datacenter').catch(() => '')) || process.env.ACRONIS_DC || 'https://eu-cloud.acronis.com').trim()).replace(/\/+$/, '');
  return id && secret ? { id, secret, base } : null;
}

export async function acronisConfigured(): Promise<boolean> { return !!(await creds()); }

let _token: { value: string; base: string; at: number } | null = null;
async function token(): Promise<{ value: string; base: string; clientId: string }> {
  const c = await creds();
  if (!c) throw new Error('Acronis is not configured — set ACRONIS_CLIENT_ID / ACRONIS_SECRET in the server .env.');
  if (_token && _token.base === c.base && Date.now() - _token.at < 10 * 60 * 1000) {
    return { value: _token.value, base: c.base, clientId: c.id };
  }
  const res = await fetch(`${c.base}/api/2/idp/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Acronis login failed (HTTP ${res.status}) — check the API client credentials.`);
  const j: any = await res.json();
  if (!j.access_token) throw new Error('Acronis login returned no token.');
  _token = { value: j.access_token, base: c.base, at: Date.now() };
  return { value: j.access_token, base: c.base, clientId: c.id };
}

async function apiGet(path: string): Promise<any> {
  const t = await token();
  const res = await fetch(`${t.base}${path}`, { headers: { Authorization: `Bearer ${t.value}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Acronis ${path.split('?')[0]} failed (HTTP ${res.status})`);
  return res.json();
}

const usageOf = (items: any[], name: string): number => {
  const u = (items || []).find((x: any) => x.name === name);
  return u ? Number(u.usage ?? u.value ?? 0) || 0 : 0;
};

// Workload groups synthesised from the usage counters — label + count key + storage key.
const WORKLOADS: { label: string; count: string; storage?: string }[] = [
  { label: 'Microsoft 365 mailboxes', count: 'pw_base_m365_seats', storage: 'protected_mailbox_storage' },
  { label: 'SharePoint sites', count: 'pw_base_m365_sharepoint_sites', storage: 'protected_site_collection_storage' },
  { label: 'Microsoft Teams', count: 'pw_base_m365_teams', storage: 'protected_o365_teams_storage' },
  { label: 'OneDrive / File Sync seats', count: 'pu_base_fc_seats' },
  { label: 'Workstations', count: 'pw_base_workstations' },
  { label: 'Servers', count: 'pw_base_servers' },
  { label: 'Virtual machines', count: 'pw_base_vms' },
];

export async function syncAcronis(): Promise<{ tenants: number; workloads: number }> {
  if (!(await acronisConfigured())) return { tenants: 0, workloads: 0 };
  await ensureBackupTables().catch(() => {});

  const t = await token();
  const me: any = await apiGet(`/api/2/clients/${t.clientId}`);
  const rootId = me.tenant_id;

  // Customer tenants: direct children, plus one level under any folder/unit children.
  const kids: any = await apiGet(`/api/2/tenants?parent_id=${rootId}`);
  let tenants: any[] = (kids.items || []);
  for (const k of [...tenants]) {
    if (k.kind === 'folder' || k.kind === 'unit') {
      const sub: any = await apiGet(`/api/2/tenants?parent_id=${k.id}`).catch(() => ({ items: [] }));
      tenants = tenants.concat(sub.items || []);
    }
  }
  tenants = tenants.filter((x) => x.kind === 'customer' && x.enabled !== false);

  // Latest completed activity per tenant (partner-wide feed, newest first) — gives the
  // REAL last-run time and result for the workload rows (usages carry no timestamps).
  const lastRunByTenant = new Map<string, { at: Date | null; ok: boolean }>();
  try {
    const acts: any = await apiGet('/api/task_manager/v2/activities?limit=200&order=desc(completedAt)');
    for (const a of (acts.items || [])) {
      const tn = String(a.tenant?.name || '');
      if (!tn || lastRunByTenant.has(tn)) continue; // newest-first → first hit is the latest
      const at = a.completedAt ? new Date(a.completedAt) : null;
      lastRunByTenant.set(tn, { at: at && !isNaN(at.getTime()) ? at : null, ok: String(a.result?.code ?? a.result ?? 'ok') === 'ok' });
    }
  } catch { /* activities API unavailable — rows just show no last-run */ }

  // Active alerts (partner-wide). Any alert against a tenant marks its workloads unhealthy.
  const alertsByTenant = new Map<string, string>();
  try {
    const al: any = await apiGet('/api/alert_manager/v1/alerts?limit=200');
    for (const a of (al.items || [])) {
      const tid = a.tenant?.id || a.tenantID || a.tenant_id || '';
      if (tid) alertsByTenant.set(String(tid), String(a.type || a.category || 'alert'));
    }
  } catch { /* alerts API unavailable — treat as healthy */ }

  const client = await pool.connect();
  let workloadCount = 0;
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM backup_companies WHERE provider='acronis'");
    await client.query("DELETE FROM backup_plan_status WHERE provider='acronis'");
    for (const ten of tenants) {
      const usages: any = await apiGet(`/api/2/tenants/${ten.id}/usages`).catch(() => ({ items: [] }));
      const items = usages.items || [];
      const storage = usageOf(items, 'storage_total') || usageOf(items, 'pw_base_c2c_storage');
      const protectedCount = usageOf(items, 'total_protected_workloads');
      await client.query(
        `INSERT INTO backup_companies (provider, external_key, users, storage_bytes, synced_at)
         VALUES ('acronis', $1, $2, $3, NOW())
         ON CONFLICT (provider, external_key) DO UPDATE SET users=$2, storage_bytes=$3, synced_at=NOW()`,
        [String(ten.name || ten.id), protectedCount, storage]);

      const alert = alertsByTenant.get(String(ten.id)) || '';
      const run = lastRunByTenant.get(String(ten.name || '')) || null;
      for (const w of WORKLOADS) {
        const n = usageOf(items, w.count);
        if (!n) continue;
        const label = `${w.label} ×${n}`;
        const bytes = w.storage ? usageOf(items, w.storage) : null;
        const status = alert ? 'Failed' : (run && !run.ok ? 'Warning' : 'Completed');
        await client.query(
          `INSERT INTO backup_plan_status (provider, company, user_email, computer, plan_name, plan_type, status, error_message, last_start, next_start, data_copied, total_data, synced_at)
           VALUES ('acronis',$1,'',$2,'Acronis cloud backup','1',$3,$4,$5,NULL,$6,NULL,NOW())`,
          [String(ten.name || ten.id), label, status, alert ? `Active Acronis alert: ${alert}` : '', run ? run.at : null, bytes]);
        await client.query(
          `INSERT INTO backup_history (day, provider, company, computer, plan_name, status, data_copied)
           VALUES (COALESCE($5::date, CURRENT_DATE), 'acronis', $1, $2, 'Acronis cloud backup', $3, $4)
           ON CONFLICT (day, provider, company, computer, plan_name) DO UPDATE SET status=$3, data_copied=$4`,
          [String(ten.name || ten.id), label, status, bytes, run ? run.at : null]);
        workloadCount++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  console.log(`[acronis] synced ${tenants.length} tenant(s), ${workloadCount} workload group(s)`);
  return { tenants: tenants.length, workloads: workloadCount };
}

let _started = false;
export function startAcronisSync(): void {
  if (_started) return;
  _started = true;
  cron.schedule('5 6 * * *', () => { syncAcronis().catch((e) => console.error('[acronis] sync failed:', e.message)); });
  setTimeout(() => {
    acronisConfigured().then((ok) => { if (ok) syncAcronis().catch((e) => console.error('[acronis] boot sync failed:', e.message)); });
  }, 75 * 1000);
  console.log('✓ Acronis backup sync scheduled (06:05 daily)');
}
