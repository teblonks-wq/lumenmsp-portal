import { config } from '../config';
import { getSetting } from './settings';

// Giacom / Cloud Market API client (Azure API Management).
// Auth is a subscription key in the `Ocp-Apim-Subscription-Key` header.
// Keys/base URLs are read from the settings table (Admin → Integrations) first,
// falling back to env (GIACOM_*). So they can be managed in the UI without touching .env.
//
// Confirmed from cloudmarket-services.developer.azure-api.net:
//   Billing Service API v1 — base https://cloudmarket-services.azure-api.net/Billing/v1
//   Ops: AccountTotals, BillingList, Azure Billing List, CreatePayment, ListCards,
//        CancelPaymentMethods, UpdateAccountPaymentMethod, PostDirectDebitCancellation,
//        Invoice Export, Subscriptions Management Report, AuthorizeHostedPage(s), Status.

const trim = (s: string) => (s || '').replace(/\/$/, '');

async function resolve(product: 'billing' | 'partner'): Promise<{ key: string; base: string }> {
  if (product === 'billing') {
    return {
      key: (await getSetting('giacom', 'billing_key')) || config.GIACOM_BILLING_KEY || '',
      base: (await getSetting('giacom', 'billing_base_url')) || config.GIACOM_BILLING_BASE_URL,
    };
  }
  return {
    key: (await getSetting('giacom', 'partnercenter_key')) || config.GIACOM_PARTNERCENTER_KEY || '',
    base: (await getSetting('giacom', 'partnercenter_base_url')) || config.GIACOM_PARTNERCENTER_BASE_URL,
  };
}

export async function giacomBillingConfigured(): Promise<boolean> { return !!(await resolve('billing')).key; }
export async function giacomPartnerConfigured(): Promise<boolean> { return !!(await resolve('partner')).key; }

interface GiacomOpts { method?: string; query?: Record<string, any>; body?: any; }

async function giacomFetch(base: string, key: string, path: string, opts: GiacomOpts = {}): Promise<any> {
  if (!key) throw new Error('Giacom API key not configured (set it in Admin → Integrations).');
  const url = new URL(trim(base) + (path.startsWith('/') ? path : '/' + path));
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json' };
  const init: any = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Giacom ${init.method} ${path} failed ${res.status}: ${text.slice(0, 400)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// ── Billing Service API v1 ────────────────────────────────────────────────────
async function billing(path: string, opts?: GiacomOpts): Promise<any> {
  const { key, base } = await resolve('billing');
  return giacomFetch(base, key, path, opts);
}

export const GiacomBilling = {
  accountTotals: (query?: Record<string, any>) => billing('/AccountTotals', { query }),
  billingList: (query?: Record<string, any>) => billing('/BillingList', { query }),
  status: () => billing('/Status'),
  invoiceExport: (query?: Record<string, any>) => billing('/Invoice Export', { query }),
  createPayment: (body: any) => billing('/CreatePayment', { method: 'POST', body }),
  raw: (path: string, opts?: GiacomOpts) => billing(path, opts),
};

// ── PartnerCenter Service API v2 ──────────────────────────────────────────────
async function partner(path: string, opts?: GiacomOpts): Promise<any> {
  const { key, base } = await resolve('partner');
  return giacomFetch(base, key, path, opts);
}

export const GiacomPartner = {
  status: () => partner('/Status'),
  raw: (path: string, opts?: GiacomOpts) => partner(path, opts),
};

// Lightweight connection test for the Integrations page. Tries a couple of safe
// read endpoints and reports the first that responds (or the error).
export async function giacomBillingTest(): Promise<{ ok: boolean; message: string }> {
  const { key } = await resolve('billing');
  if (!key) return { ok: false, message: 'No Billing key saved.' };
  for (const path of ['/Status', '/AccountTotals']) {
    try {
      await billing(path, path === '/AccountTotals' ? { query: { pageSize: 1 } } : undefined);
      return { ok: true, message: `Connected — ${path} responded OK.` };
    } catch (e: any) {
      // A 400 still proves auth reached the API; only treat 401/403 as a key problem.
      const m = String(e.message || '');
      if (/ 4(0[13]) /.test(m)) return { ok: false, message: 'Key rejected (401/403): ' + m };
      if (path === '/AccountTotals') return { ok: false, message: m };
    }
  }
  return { ok: false, message: 'No response from Billing API.' };
}
