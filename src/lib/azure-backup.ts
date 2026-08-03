import cron from 'node-cron';
import { pool } from '../db/pool';
import { config } from '../config';
import { ensureBackupTables } from './msp360';

// ── Azure Backup (Recovery Services vaults) — backup provider #3 ─────────────────
// Reads each customer tenant's Recovery Services vaults and their protected items
// (VMs, files, SQL…) via Azure Resource Manager, and feeds the SAME provider-agnostic
// backup tables as MSP360 — so vault health shows up on the customer panel, the asset
// pages and the monthly IT report with zero extra UI.
//
// Access model (differs from MSP360's credentials and Graph's admin consent):
//   The portal's Entra app (GRAPH_CLIENT_ID) must be given the "Reader" role (or the
//   tighter "Backup Reader") on each customer SUBSCRIPTION: customer's Azure portal →
//   Subscription → Access control (IAM) → Add role assignment → select the app.
//   Token = client-credentials against the CUSTOMER tenant, scope management.azure.com.
//
// Linking: automatic. Azure access is per-tenant and customers.entra_tenant_id already
// maps tenants to customers, so each vault self-links via backup_provider_links
// (provider 'azure', external_key = vault key). Unlinking in the UI still works.

const ARM = 'https://management.azure.com';

async function armToken(tenant: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GRAPH_CLIENT_ID, client_secret: config.GRAPH_CLIENT_SECRET,
      scope: 'https://management.azure.com/.default', grant_type: 'client_credentials',
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'ARM token error'), { status: res.status });
  return data.access_token;
}

async function armGetAll(token: string, url: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  while (next) {
    const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ARM ${res.status} for ${next.split('?')[0]}`);
    const data: any = await res.json();
    for (const v of (data.value || [])) out.push(v);
    next = data.nextLink || null;
    if (out.length > 2000) break; // safety cap
  }
  return out;
}

const ts = (v: any): Date | null => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? d : null; };

// One customer tenant → vaults → protected items. Returns rows ready for the shared tables.
async function collectTenant(tenant: string): Promise<{
  vaults: { key: string; items: number }[];
  rows: { vaultKey: string; item: string; plan: string; status: string; lastBackup: Date | null }[];
} | null> {
  let token: string;
  try { token = await armToken(tenant); }
  catch { return null; }   // app has no ARM access in this tenant (no RBAC granted) — normal, skip

  let subs: any[] = [];
  try { subs = await armGetAll(token, `${ARM}/subscriptions?api-version=2020-01-01`); }
  catch { return null; }
  if (!subs.length) return null; // token issued but no subscription visible → Reader role not assigned yet

  const vaults: { key: string; items: number }[] = [];
  const rows: { vaultKey: string; item: string; plan: string; status: string; lastBackup: Date | null }[] = [];
  for (const sub of subs) {
    const subId = String(sub.subscriptionId || '');
    let vlist: any[] = [];
    try {
      vlist = await armGetAll(token, `${ARM}/subscriptions/${subId}/providers/Microsoft.RecoveryServices/vaults?api-version=2023-04-01`);
    } catch { continue; }
    for (const v of vlist) {
      const vaultName = String(v.name || 'vault');
      // Vault key stays stable and human-readable; the short sub suffix disambiguates
      // same-named vaults across subscriptions.
      const key = `${vaultName} (Azure ${subId.slice(0, 8)})`;
      let items: any[] = [];
      try {
        items = await armGetAll(token, `${ARM}${v.id}/backupProtectedItems?api-version=2023-04-01`);
      } catch { /* vault without backup items or no permission — still record the vault */ }
      vaults.push({ key, items: items.length });
      for (const it of items) {
        const p = it.properties || {};
        rows.push({
          vaultKey: key,
          item: String(p.friendlyName || it.name || 'item'),
          plan: String(p.policyName || p.backupManagementType || 'Azure Backup'),
          status: String(p.lastBackupStatus || p.protectionState || ''),
          lastBackup: ts(p.lastBackupTime),
        });
      }
    }
  }
  return { vaults, rows };
}

export async function syncAzureBackup(): Promise<{ tenants: number; vaults: number; items: number }> {
  if (!config.GRAPH_CLIENT_ID || !config.GRAPH_CLIENT_SECRET) return { tenants: 0, vaults: 0, items: 0 };
  await ensureBackupTables().catch(() => {});
  const customers = (await pool.query(
    `SELECT id, name, entra_tenant_id FROM customers
      WHERE deleted_at IS NULL AND entra_tenant_id IS NOT NULL AND TRIM(entra_tenant_id) <> ''`)).rows;

  let tenants = 0, vaultCount = 0, itemCount = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM backup_companies WHERE provider='azure'");
    await client.query("DELETE FROM backup_plan_status WHERE provider='azure'");
    for (const c of customers) {
      const data = await collectTenant(c.entra_tenant_id).catch(() => null);
      if (!data || !data.vaults.length) continue;
      tenants++;
      for (const v of data.vaults) {
        await client.query(
          `INSERT INTO backup_companies (provider, external_key, users, storage_bytes, synced_at)
           VALUES ('azure', $1, $2, 0, NOW())
           ON CONFLICT (provider, external_key) DO UPDATE SET users=$2, synced_at=NOW()`,
          [v.key, v.items]);
        // Auto-link: Azure access is tenant-scoped and the tenant IS the customer.
        await client.query(
          `INSERT INTO backup_provider_links (customer_id, provider, external_key)
           VALUES ($1, 'azure', $2) ON CONFLICT (customer_id, provider, external_key) DO NOTHING`,
          [c.id, v.key]);
        vaultCount++;
      }
      for (const r of data.rows) {
        await client.query(
          `INSERT INTO backup_plan_status (provider, company, user_email, computer, plan_name, plan_type, status, error_message, last_start, next_start, data_copied, total_data, synced_at)
           VALUES ('azure',$1,'',$2,$3,'1',$4,'',$5,NULL,NULL,NULL,NOW())`,
          [r.vaultKey, r.item, r.plan, r.status, r.lastBackup]);
        await client.query(
          `INSERT INTO backup_history (day, provider, company, computer, plan_name, status, data_copied)
           VALUES (COALESCE($5::date, CURRENT_DATE), 'azure', $1, $2, $3, $4, NULL)
           ON CONFLICT (day, provider, company, computer, plan_name) DO UPDATE SET status=$4`,
          [r.vaultKey, r.item, r.plan, r.status, r.lastBackup]);
        itemCount++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (tenants) console.log(`[azure-backup] synced ${vaultCount} vault(s), ${itemCount} protected item(s) across ${tenants} tenant(s)`);
  return { tenants, vaults: vaultCount, items: itemCount };
}

let _started = false;
export function startAzureBackupSync(): void {
  if (_started) return;
  _started = true;
  cron.schedule('55 5 * * *', () => { syncAzureBackup().catch((e) => console.error('[azure-backup] sync failed:', e.message)); });
  setTimeout(() => { syncAzureBackup().catch((e) => console.error('[azure-backup] boot sync failed:', e.message)); }, 60 * 1000);
  console.log('✓ Azure Backup sync scheduled (05:55 daily)');
}
