import cron from 'node-cron';
import { pool } from '../db/pool';
import { config } from '../config';
import { getGraphTokenForTenant, reportingApp } from './graph';

// ── Graph consent status per customer tenant ─────────────────────────────────────
// The IT report's Intune/Secure Score sections only work once the portal's multi-tenant
// Graph app has been ADMIN-CONSENTED inside each customer's tenant. This module probes
// every recorded tenant and caches the answer, so the Customers list can show exactly
// who is granted, who is partially granted, and who still needs the consent link clicked.
//
// Statuses (consent is judged by a baseline DIRECTORY read, not Intune — see probeTenant):
//   ok      — token issued AND directory read succeeds (app consented & working; detail
//             notes whether Intune is also available, which many tenants don't license)
//   partial — token issued but the directory read is 401/403 (genuine consent problem)
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
    + `?client_id=${encodeURIComponent(reportingApp().clientId || '')}`
    + `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`;
}

async function probeTenant(tenant: string): Promise<{ status: string; detail: string }> {
  // Whether the app is CONSENTED & working in a tenant is decided by a baseline directory
  // read (/users — the app holds User.Read.All), NOT by an Intune read. Intune is a separate
  // capability many tenants don't even license: reading /deviceManagement there 403s for
  // "no Intune", which is NOT a consent fault. Probing Intune was making licence-free tenants
  // (e.g. Staybrook) stick on "partial — re-grant" forever. A 401/403 retries once with a
  // fresh token first, to rule out a stale token cached mid consent-propagation.
  const check = async (forceRefresh: boolean): Promise<{ status: string; detail: string }> => {
    let token: string;
    try {
      token = await getGraphTokenForTenant(tenant, forceRefresh);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const noConsent = /700016|65001|consent|not found in the directory/i.test(msg);
      return { status: noConsent ? 'none' : 'error', detail: msg.slice(0, 300) };
    }
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/users?$top=1&$select=id', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (res.ok) {
        // Consented & working. Note (non-gating) whether Intune is actually available.
        let intune = '';
        try {
          const di = await fetch('https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=1&$select=id', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          });
          intune = di.ok ? 'Intune available' : `Intune not available (HTTP ${di.status} — likely unlicensed in this tenant)`;
        } catch { /* ignore */ }
        return { status: 'ok', detail: intune };
      }
      if (res.status === 401 || res.status === 403) return { status: 'partial', detail: `Directory read returned HTTP ${res.status} — consent not yet effective (propagation) or not granted.` };
      return { status: 'partial', detail: `Directory read returned HTTP ${res.status}.` };
    } catch (e: any) {
      return { status: 'error', detail: String(e?.message || e).slice(0, 300) };
    }
  };
  const first = await check(false);
  if (first.status === 'partial') return check(true); // bust a possibly-stale token, try once more
  return first;
}

// ── Per-permission tester ────────────────────────────────────────────────────────
// Probes every Graph permission the reporting/report features rely on, one endpoint each,
// with a single forced-fresh token, and reports pass/fail per permission. Powers the
// "Test Microsoft 365 access" button on the customer panel — so staff can see exactly which
// scopes are effective in a tenant, not just a single green/amber dot.
export interface PermTest { label: string; scope: string; ok: boolean; status: number | string; note: string; }

const PERM_PROBES: { label: string; scope: string; path: string }[] = [
  { label: 'Directory / users', scope: 'User.Read.All', path: '/v1.0/users?$top=1&$select=id' },
  { label: 'Organisation details', scope: 'Organization.Read.All', path: '/v1.0/organization?$select=id,displayName' },
  { label: 'Groups', scope: 'Group.Read.All', path: '/v1.0/groups?$top=1&$select=id' },
  { label: 'Intune devices', scope: 'DeviceManagementManagedDevices.Read.All', path: '/v1.0/deviceManagement/managedDevices?$top=1&$select=id' },
  { label: 'Secure Score', scope: 'SecurityEvents.Read.All', path: '/v1.0/security/secureScores?$top=1' },
  { label: 'Service health', scope: 'ServiceHealth.Read.All', path: '/v1.0/admin/serviceAnnouncement/issues?$top=1' },
];

export async function testGraphPermissions(tenant: string): Promise<{ tokenOk: boolean; tokenError: string; results: PermTest[] }> {
  let token = '';
  try {
    token = await getGraphTokenForTenant(tenant, true); // always a fresh token for a true test
  } catch (e: any) {
    return { tokenOk: false, tokenError: String(e?.message || e).slice(0, 300), results: [] };
  }
  const results: PermTest[] = [];
  for (const p of PERM_PROBES) {
    try {
      const res = await fetch('https://graph.microsoft.com' + p.path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (res.ok) { results.push({ label: p.label, scope: p.scope, ok: true, status: res.status, note: 'OK' }); continue; }
      let note = `HTTP ${res.status}`;
      if (res.status === 403) note = 'Forbidden — scope not granted, or feature not licensed in this tenant';
      else if (res.status === 401) note = 'Unauthorised — consent missing';
      else { try { const j: any = await res.json(); if (j?.error?.message) note = String(j.error.message).slice(0, 120); } catch { /* ignore */ } }
      results.push({ label: p.label, scope: p.scope, ok: false, status: res.status, note });
    } catch (e: any) {
      results.push({ label: p.label, scope: p.scope, ok: false, status: 'error', note: String(e?.message || e).slice(0, 120) });
    }
  }
  return { tokenOk: true, tokenError: '', results };
}

export async function refreshGraphConsentForTenant(tenantId: string): Promise<void> {
  const t = (tenantId || '').trim();
  if (!t || !reportingApp().clientId) return;
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
  if (!reportingApp().clientId) return { checked: 0 };
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
