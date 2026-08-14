import cron from 'node-cron';
import { pool } from '../db/pool';
import { GiacomBilling, giacomBillingConfigured } from './giacom';
import { getSetting, setSetting } from './settings';

// ── Microsoft / NCE subscriptions ─────────────────────────────────────────────
// A read-only mirror of Giacom's "SubscriptionsManagementReport" (Billing API v1).
// Purpose: close the NCE out-of-pocket gap. An Annual-term NCE subscription is a 12-month
// partner commitment — if a customer leaves mid-term with no back-to-back contract, Lumen
// eats the residual. This module lands the partner-side truth (seats, term, and the two
// dates that matter — renewalDate + cancellableUntilDate) next to our own contracts so we
// can SEE where cover is missing, and align Cloud contract dates to Microsoft's real ones.
// It never writes to Giacom and never bills; it only reflects and flags.

const str = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s || null; };
const bool = (v: any): boolean => v === true || v === 'true' || v === 1 || v === '1';
const int = (v: any): number => { const n = parseInt((v ?? '').toString(), 10); return isNaN(n) ? 0 : n; };
const dec = (v: any): number | null => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v.toString()); return isNaN(n) ? null : n; };
const date = (v: any): Date | null => { const s = str(v); if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; };
// Tolerate either camelCase or PascalCase keys from the API.
const pick = (o: any, ...keys: string[]): any => { for (const k of keys) { if (o && o[k] !== undefined && o[k] !== null) return o[k]; } return undefined; };

export interface SubRow {
  id: number;
  customerId: number | null;
  mexId: string | null;
  tenantId: string | null;
  customerName: string | null;
  hasGdap: boolean | null;
  subscriptionId: string;
  name: string;
  offerId: string | null;
  licences: number;
  term: string | null;            // 'Annual' | 'Monthly'
  billingFrequency: string | null;
  status: string | null;
  isNce: boolean;
  isPromoApplied: boolean;
  orderDate: Date | null;
  migratedToNceDate: Date | null;
  renewalDate: Date | null;
  cancellableUntil: Date | null;
  commitmentEndDate: Date | null;
  termEndAction: string | null;
  price: number | null;           // unit buy
  erp: number | null;             // unit RRP/sell reference
  syncedAt: Date;
}

// ── Sync: pull the report and full-refresh the mirror ──────────────────────────
export async function syncMsSubscriptions(): Promise<{ fetched: number; matched: number; unmatched: number; ignored: number; customers: number }> {
  if (!(await giacomBillingConfigured())) return { fetched: 0, matched: 0, unmatched: 0, ignored: 0, customers: 0 };

  const resp = await GiacomBilling.raw('/SubscriptionsManagementReport', { query: { pageSize: 5000 } });
  const blocks: any[] = (resp && (resp.data || resp.Data)) || (Array.isArray(resp) ? resp : []);

  // Resolution maps (best key first): tenant GUID → mexId → unique lowercase name.
  const tenantMap = new Map<string, number>();
  (await pool.query("SELECT id, lower(entra_tenant_id) AS tid FROM customers WHERE entra_tenant_id IS NOT NULL AND deleted_at IS NULL"))
    .rows.forEach((r: any) => { if (r.tid) tenantMap.set(r.tid, r.id); });
  const mexMap = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='giacom'"))
    .rows.forEach((r: any) => mexMap.set(String(r.external_id), r.customer_id));
  const nameCount = new Map<string, number>(), nameId = new Map<string, number>();
  (await pool.query("SELECT id, lower(name) AS lname FROM customers WHERE deleted_at IS NULL AND is_placeholder=false"))
    .rows.forEach((c: any) => { nameCount.set(c.lname, (nameCount.get(c.lname) || 0) + 1); nameId.set(c.lname, c.id); });

  // Accounts the operator has chosen to ignore (demo/internal tenants). Keyed by mexId or tenantId.
  const ignored = new Set(((await getSetting('subscriptions', 'ignored')) || '').split(',').map((s) => s.trim()).filter(Boolean));

  const resolve = (tenantId: string | null, mexId: string | null, name: string | null): number | null => {
    if (tenantId && tenantMap.has(tenantId.toLowerCase())) return tenantMap.get(tenantId.toLowerCase())!;
    if (mexId && mexMap.has(mexId)) return mexMap.get(mexId)!;
    const ln = (name || '').toLowerCase().trim();
    if (ln && nameCount.get(ln) === 1) return nameId.get(ln)!;
    return null;
  };

  let fetched = 0, matched = 0, unmatched = 0, ignoredN = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ms_subscription');
    for (const b of blocks) {
      const mexId = str(pick(b, 'mexId', 'MexId', 'mexID'));
      const tenantId = str(pick(b, 'tenantId', 'TenantId', 'tenantID'));
      const customerName = str(pick(b, 'customerName', 'CustomerName'));
      const hasGdap = pick(b, 'hasGdap', 'HasGdap');
      if ((mexId && ignored.has(mexId)) || (tenantId && ignored.has(tenantId))) { ignoredN++; continue; }
      const cid = resolve(tenantId, mexId, customerName);
      const subs: any[] = pick(b, 'subscriptions', 'Subscriptions') || [];
      for (const s of subs) {
        const subscriptionId = str(pick(s, 'subscriptionId', 'SubscriptionId', 'subscriptionID'));
        if (!subscriptionId) continue;
        fetched++;
        if (cid) matched++; else unmatched++;
        await client.query(
          `INSERT INTO ms_subscription
             (customer_id, mex_id, tenant_id, customer_name, has_gdap, subscription_id, name, offer_id,
              licences, term, billing_frequency, status, is_nce, is_promo_applied, order_date,
              migrated_to_nce_date, renewal_date, cancellable_until_date, commitment_end_date, term_end_action,
              price, erp, raw, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
           ON CONFLICT (subscription_id) DO UPDATE SET
             customer_id=EXCLUDED.customer_id, mex_id=EXCLUDED.mex_id, tenant_id=EXCLUDED.tenant_id,
             customer_name=EXCLUDED.customer_name, has_gdap=EXCLUDED.has_gdap, name=EXCLUDED.name,
             offer_id=EXCLUDED.offer_id, licences=EXCLUDED.licences, term=EXCLUDED.term,
             billing_frequency=EXCLUDED.billing_frequency, status=EXCLUDED.status, is_nce=EXCLUDED.is_nce,
             is_promo_applied=EXCLUDED.is_promo_applied, order_date=EXCLUDED.order_date,
             migrated_to_nce_date=EXCLUDED.migrated_to_nce_date, renewal_date=EXCLUDED.renewal_date,
             cancellable_until_date=EXCLUDED.cancellable_until_date, commitment_end_date=EXCLUDED.commitment_end_date,
             term_end_action=EXCLUDED.term_end_action, price=EXCLUDED.price, erp=EXCLUDED.erp,
             raw=EXCLUDED.raw, synced_at=NOW()`,
          [cid, mexId, tenantId, customerName, hasGdap === undefined ? null : bool(hasGdap), subscriptionId,
           str(pick(s, 'name', 'Name')) || 'Subscription', str(pick(s, 'offerId', 'OfferId')),
           int(pick(s, 'licences', 'Licences', 'licenses', 'quantity')), str(pick(s, 'term', 'Term')),
           str(pick(s, 'billingFrequency', 'BillingFrequency')), str(pick(s, 'status', 'Status')),
           bool(pick(s, 'isNce', 'IsNce')), bool(pick(s, 'isPromoApplied', 'IsPromoApplied')),
           date(pick(s, 'orderDate', 'OrderDate')), date(pick(s, 'migratedToNCEDate', 'migratedToNceDate', 'MigratedToNCEDate')),
           date(pick(s, 'renewalDate', 'RenewalDate')), date(pick(s, 'cancellableUntilDate', 'CancellableUntilDate')),
           date(pick(s, 'commitmentEndDate', 'CommitmentEndDate')), str(pick(s, 'termEndAction', 'TermEndAction')),
           dec(pick(s, 'price', 'Price')), dec(pick(s, 'erp', 'Erp', 'ERP')),
           JSON.stringify(s)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await setSetting('subscriptions', 'last_sync', new Date().toISOString());
  return { fetched, matched, unmatched, ignored: ignoredN, customers: blocks.length };
}

// ── Exposure assessment ────────────────────────────────────────────────────────
export type ExposureState = 'covered' | 'exposed' | 'flexible' | 'unmatched';
export interface SubAssessment extends SubRow {
  committed: boolean;              // Annual NCE term = a real 12-month commitment
  coverEnd: Date | null;           // latest Cloud contract cover for this customer
  state: ExposureState;
  reason: string;
  daysToRenewal: number | null;
  daysToCancellable: number | null;
  cancellableOpen: boolean;        // penalty-free window still open
  monthlyBuy: number | null;       // price * licences
  monthlyErp: number | null;       // erp * licences
}

// Latest date to which an active contract covers this customer's cloud/Microsoft services.
// Cloud-section lines carry their own term_end; fall back to the line/contract end date.
export async function contractCloudCover(customerId: number): Promise<Date | null> {
  const r = (await pool.query(
    `SELECT MAX(COALESCE(cl.term_end, ct.end_date)) AS cover
       FROM contracts ct JOIN contract_lines cl ON cl.contract_id = ct.id
      WHERE ct.customer_id = $1 AND ct.status = 'active' AND ct.deleted_at IS NULL
        AND (cl.section = 'Cloud' OR ct.service_type = 'Cloud')`, [customerId]
  )).rows[0];
  return r && r.cover ? new Date(r.cover) : null;
}

function daysBetween(from: Date, to: Date | null): number | null {
  if (!to) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

export function assess(row: SubRow, coverEnd: Date | null, now = new Date()): SubAssessment {
  const committed = (row.term || '').toLowerCase() === 'annual';
  const daysToRenewal = daysBetween(now, row.renewalDate);
  const daysToCancellable = daysBetween(now, row.cancellableUntil);
  const cancellableOpen = !!row.cancellableUntil && row.cancellableUntil.getTime() > now.getTime();
  let state: ExposureState; let reason: string;
  if (row.customerId == null) { state = 'unmatched'; reason = 'Not linked to a portal customer'; }
  else if (!committed) { state = 'flexible'; reason = 'Monthly term — cancel any time, no residual'; }
  else if (!coverEnd) { state = 'exposed'; reason = 'Annual commitment with no cloud contract covering it'; }
  else if (row.renewalDate && coverEnd.getTime() < row.renewalDate.getTime()) {
    state = 'exposed'; reason = 'Contract cover ends before the Microsoft renewal date';
  } else { state = 'covered'; reason = 'Covered by contract to at least the renewal date'; }
  return {
    ...row, committed, coverEnd, state, reason, daysToRenewal, daysToCancellable, cancellableOpen,
    monthlyBuy: row.price != null ? row.price * row.licences : null,
    monthlyErp: row.erp != null ? row.erp * row.licences : null,
  };
}

function mapRow(r: any): SubRow {
  return {
    id: r.id, customerId: r.customer_id, mexId: r.mex_id, tenantId: r.tenant_id, customerName: r.customer_name,
    hasGdap: r.has_gdap, subscriptionId: r.subscription_id, name: r.name, offerId: r.offer_id,
    licences: Number(r.licences) || 0, term: r.term, billingFrequency: r.billing_frequency, status: r.status,
    isNce: r.is_nce, isPromoApplied: r.is_promo_applied,
    orderDate: r.order_date ? new Date(r.order_date) : null,
    migratedToNceDate: r.migrated_to_nce_date ? new Date(r.migrated_to_nce_date) : null,
    renewalDate: r.renewal_date ? new Date(r.renewal_date) : null,
    cancellableUntil: r.cancellable_until_date ? new Date(r.cancellable_until_date) : null,
    commitmentEndDate: r.commitment_end_date ? new Date(r.commitment_end_date) : null,
    termEndAction: r.term_end_action, price: r.price != null ? Number(r.price) : null,
    erp: r.erp != null ? Number(r.erp) : null, syncedAt: r.synced_at ? new Date(r.synced_at) : new Date(),
  };
}

export interface CustomerSubs {
  linked: boolean;
  lastSync: Date | null;
  coverEnd: Date | null;
  subs: SubAssessment[];
  totals: { count: number; committed: number; exposed: number; seats: number; monthlyBuy: number };
  worst: ExposureState;             // headline state for the panel badge
  nextRenewal: Date | null;
  nextCancellable: Date | null;     // soonest still-open penalty-free window
}

const RANK: Record<ExposureState, number> = { exposed: 3, unmatched: 2, flexible: 1, covered: 0 };

// Live per-customer read used by the customer detail panel. Returns [] gracefully if the
// table isn't migrated yet (pre-deploy), so the page never 500s.
export async function customerSubscriptions(customerId: number): Promise<CustomerSubs> {
  const empty: CustomerSubs = { linked: false, lastSync: null, coverEnd: null, subs: [], totals: { count: 0, committed: 0, exposed: 0, seats: 0, monthlyBuy: 0 }, worst: 'covered', nextRenewal: null, nextCancellable: null };
  try {
    const rows = (await pool.query('SELECT * FROM ms_subscription WHERE customer_id=$1 ORDER BY name', [customerId])).rows;
    const lastSyncStr = await getSetting('subscriptions', 'last_sync');
    const lastSync = lastSyncStr ? new Date(lastSyncStr) : (rows[0] ? new Date(rows[0].synced_at) : null);
    if (!rows.length) return { ...empty, lastSync };
    const coverEnd = await contractCloudCover(customerId);
    const now = new Date();
    const subs = rows.map((r: any) => assess(mapRow(r), coverEnd, now)).sort((a, b) => RANK[b.state] - RANK[a.state] || (a.name > b.name ? 1 : -1));
    const totals = { count: subs.length, committed: subs.filter((s) => s.committed).length, exposed: subs.filter((s) => s.state === 'exposed').length, seats: subs.reduce((n, s) => n + s.licences, 0), monthlyBuy: subs.reduce((n, s) => n + (s.monthlyBuy || 0), 0) };
    const worst = subs.reduce<ExposureState>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), 'covered');
    const renewals = subs.map((s) => s.renewalDate).filter((d): d is Date => !!d && d.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime());
    const cancels = subs.filter((s) => s.committed && s.cancellableOpen).map((s) => s.cancellableUntil!).sort((a, b) => a.getTime() - b.getTime());
    return { linked: true, lastSync, coverEnd, subs, totals, worst, nextRenewal: renewals[0] || null, nextCancellable: cancels[0] || null };
  } catch { return empty; }
}

// ── Estate-wide overview + exposure report (settings page) ─────────────────────
export interface OverviewCustomer {
  customerId: number | null;
  name: string;
  mexId: string | null;
  tenantId: string | null;
  coverEnd: Date | null;
  subs: SubAssessment[];
  seats: number;
  committed: number;
  exposed: number;
  monthlyBuy: number;
  worst: ExposureState;
}
export interface Overview {
  lastSync: Date | null;
  configured: boolean;
  customers: OverviewCustomer[];    // matched, worst-exposure first
  unmatched: OverviewCustomer[];    // no portal customer — need linking or ignoring
  totals: { subs: number; committed: number; exposed: number; seats: number; monthlyBuy: number; customers: number };
}

export async function subscriptionsOverview(): Promise<Overview> {
  const configured = await giacomBillingConfigured();
  const lastSyncStr = await getSetting('subscriptions', 'last_sync');
  const lastSync = lastSyncStr ? new Date(lastSyncStr) : null;
  let rows: any[] = [];
  try { rows = (await pool.query('SELECT * FROM ms_subscription ORDER BY customer_name, name')).rows; } catch { rows = []; }
  const names = new Map<number, string>();
  (await pool.query('SELECT id, name FROM customers WHERE deleted_at IS NULL')).rows.forEach((c: any) => names.set(c.id, c.name));

  const now = new Date();
  const coverCache = new Map<number, Date | null>();
  const byKey = new Map<string, OverviewCustomer>();
  for (const r0 of rows) {
    const row = mapRow(r0);
    let coverEnd: Date | null = null;
    if (row.customerId != null) {
      if (!coverCache.has(row.customerId)) coverCache.set(row.customerId, await contractCloudCover(row.customerId));
      coverEnd = coverCache.get(row.customerId)!;
    }
    const a = assess(row, coverEnd, now);
    const key = row.customerId != null ? 'c' + row.customerId : 't' + (row.tenantId || row.mexId || row.customerName || Math.random());
    let g = byKey.get(key);
    if (!g) {
      g = { customerId: row.customerId, name: row.customerId != null ? (names.get(row.customerId) || row.customerName || ('#' + row.customerId)) : (row.customerName || 'Unknown'), mexId: row.mexId, tenantId: row.tenantId, coverEnd, subs: [], seats: 0, committed: 0, exposed: 0, monthlyBuy: 0, worst: 'covered' };
      byKey.set(key, g);
    }
    g.subs.push(a);
    g.seats += a.licences;
    if (a.committed) g.committed++;
    if (a.state === 'exposed') g.exposed++;
    g.monthlyBuy += a.monthlyBuy || 0;
    if (RANK[a.state] > RANK[g.worst]) g.worst = a.state;
  }
  const all = [...byKey.values()];
  const matched = all.filter((g) => g.customerId != null).sort((a, b) => RANK[b.worst] - RANK[a.worst] || b.exposed - a.exposed || a.name.localeCompare(b.name));
  const unmatched = all.filter((g) => g.customerId == null).sort((a, b) => b.seats - a.seats);
  const totals = {
    subs: rows.length,
    committed: all.reduce((n, g) => n + g.committed, 0),
    exposed: all.reduce((n, g) => n + g.exposed, 0),
    seats: all.reduce((n, g) => n + g.seats, 0),
    monthlyBuy: all.reduce((n, g) => n + g.monthlyBuy, 0),
    customers: matched.length,
  };
  return { lastSync, configured, customers: matched, unmatched, totals };
}

// Nightly refresh — 05:20, just after the Giacom billing sync (05:00). No-ops if unconfigured.
let _started = false;
export function startMsSubscriptionsSync(): void {
  if (_started) return;
  _started = true;
  cron.schedule('20 5 * * *', () => {
    syncMsSubscriptions()
      .then((r) => console.log(`[ms-subs] nightly: ${r.fetched} subs, ${r.matched} matched, ${r.unmatched} unmatched, ${r.ignored} ignored`))
      .catch((e) => console.error('[ms-subs] nightly sync failed:', (e as Error).message));
  });
}
