import cron from 'node-cron';
import { pool } from '../db/pool';
import { config } from '../config';
import { getGraphTokenForTenant, graphConfigured } from './graph';

// ── Graph consent status per customer tenant ─────────────────────────────────────
// The IT report's Intune/Secure Score sections only work once the portal's multi-tenant
// Graph app has been ADMIN-CONSENTED inside each customer's tenant. This module probes
// every recorded tenant and caches the answer, so the Customers list can show exactly
// who is granted, who is partially granted, and who still needs the consent link clicked.
//
// Statuses:
//   ok      — token issued AND Intune device read succeeds (fully usable)
//   partial — token issued but Intune read is 401/403 (app consented, but the
//             DeviceManagementManagedDevices.Read.All grant is missing/stale)
//   none    — token request refused (app not consented in the tenant at all)
//   error   — network/other failure; treated as unknown, re-checked next run

export async function ensureGraphConsentTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS graph_consent_status (
      customer_id INTEGER PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'none',
      detail      TEXT DEFAULT '',
      checked_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// The one-time grant link a CUSTOMER global admin must open. v2 admin-consent endpoint
// with an EXPLICIT redirect_uri — the v1 endpoint bounces to the app's DEFAULT redirect
// URI, which on this app registration is learn.lumenmsp.co.uk (discovered 2026-08-03 when
// a consent landed on LITS Learn's login and scared everyone with its CSRF message).
// Requires https://<portal>/auth/callback to be REGISTERED as a redirect URI on the Graph
// app (Entra → App registrations → the app → Authentication → Web → add it).
export function graphConsentUrl(tenantId: string): string {
  const redirect = ((config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, '')) + '/auth/callback';
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/adminconsent`
    + `?client_id=${encodeURIComponent(config.GRAPH_CLIENT_ID || '')}`
    + `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`;
}

async function probeTenant(tenant: string): Promise<{ status: string; detail: string }> {
  let token: string;
  try {
    token = await getGraphTokenForTenant(tenant);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // AADSTS700016 (app not found in tenant) / 65001 (no consent) → the grant was never made.
    const noConsent = /700016|65001|consent|not found in the directory/i.test(msg);
    return { status: noConsent ? 'none' : 'error', detail: msg.slice(0, 300) };
  }
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=1&$select=id', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.ok) return { status: 'ok', detail: '' };
    if (res.status === 401 || res.status === 403) return { status: 'partial', detail: `Token issued but Intune read returned HTTP ${res.status} — the Intune permission isn't granted (re-run the consent link after adding it to the app registration).` };
    return { status: 'partial', detail: `Intune read returned HTTP ${res.status}.` };
  } catch (e: any) {
    return { status: 'error', detail: String(e?.message || e).slice(0, 300) };
  }
}

export async function refreshGraphConsentForTenant(tenantId: string): Promise<void> {
  const t = (tenantId || '').trim();
  if (!t || !graphConfigured()) return;
  const customers = (await pool.query(
    'SELECT id FROM customers WHERE deleted_at IS NULL AND lower(entra_tenant_id)=lower($1)', [t])).rows;
  if (!customers.length) return;
  const r = await probeTenant(t);
  for (const c of customers) {
    await pool.query(
      `INSERT INTO graph_consent_status (customer_id, tenant_id, status, detail, checked_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (customer_id) DO UPDATE SET tenant_id=$2, status=$3, detail=$4, checked_at=NOW()`,
      [c.id, t, r.status, r.detail]);
  }
}

export async function syncGraphConsent(): Promise<{ checked: number }> {
  if (!graphConfigured()) return { checked: 0 };
  await ensureGraphConsentTable().catch(() => {});
  const rows = (await pool.query(
    `SELECT id, entra_tenant_id FROM customers
      WHERE deleted_at IS NULL AND entra_tenant_id IS NOT NULL AND TRIM(entra_tenant_id) <> ''`)).rows;
  let checked = 0;
  for (const c of rows) {
    try {
      const r = await probeTenant(c.entra_tenant_id);
      await pool.query(
        `INSERT INTO graph_consent_status (customer_id, tenant_id, status, detail, checked_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (customer_id) DO UPDATE SET tenant_id=$2, status=$3, detail=$4, checked_at=NOW()`,
        [c.id, c.entra_tenant_id, r.status, r.detail]);
      checked++;
    } catch (e) { console.error('[graph-consent] check failed for customer', c.id, (e as Error).message); }
  }
  console.log(`[graph-consent] checked ${checked} tenant(s)`);
  return { checked };
}

let _started = false;
export function startGraphConsentCheck(): void {
  if (_started) return;
  _started = true;
  ensureGraphConsentTable().catch((e) => console.error('[graph-consent] ensure table failed:', e.message));
  cron.schedule('15 6 * * *', () => { syncGraphConsent().catch((e) => console.error('[graph-consent] sync failed:', e.message)); });
  setTimeout(() => { syncGraphConsent().catch((e) => console.error('[graph-consent] boot sync failed:', e.message)); }, 45 * 1000);
  console.log('✓ Graph consent checker scheduled (06:15 daily)');
}
