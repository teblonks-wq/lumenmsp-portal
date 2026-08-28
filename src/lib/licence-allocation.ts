import { pool } from '../db/pool';
import { listSkus, listUsers, M365Sku, M365User } from './m365';

// ── Who is actually SITTING on the seats Giacom bills us for ─────────────────────
//
// The Services page has always been able to answer "what does Giacom charge this
// customer for" (ms_subscription: seats, term, renewal date, buy price). It has never
// been able to answer the question that saves money — "and who is using them?"
//
// Giacom says 25 Business Premium. Graph can say: 25 in the pool, 22 assigned, 3 never
// handed out, and 2 of the 22 sitting on accounts that are disabled. That is five seats
// of nothing, every month, invisible until somebody counts by hand.
//
// READ-ONLY, deliberately. Everything here goes through m365.ts, which is the read-only
// reporting app most customers have already consented to. Nothing in this file can change
// anything in a customer's tenant — licence assignment lives behind its own capability
// pack and is a separate decision.
//
// It degrades rather than fails. A customer with no tenant id, or one who has never
// granted consent, gets a panel that says so and tells you what to do about it — never a
// 500 and never a silent empty table, because "no waste found" and "we could not look"
// are very different answers.

export type AllocationState =
  | 'ok'            // Graph answered
  | 'no-tenant'     // customer has no entra_tenant_id on the record
  | 'no-consent'    // token or directory read refused — the app is not consented here
  | 'error';        // anything else, with the message kept

/** One licence pool, as Giacom bills it and as the tenant actually holds it. */
export interface SkuAllocation {
  // Graph side
  skuId: string | null;
  partNumber: string | null;
  name: string;
  poolTotal: number;          // prepaid units in the tenant
  assigned: number;           // units consumed
  spare: number;              // bought, on nobody
  // Giacom side
  billedSeats: number | null; // ms_subscription.licences, null when we bill nothing for it
  unitPrice: number | null;   // buy, per unit, per month
  term: string | null;
  renewalDate: Date | null;
  cancellableUntil: Date | null;
  // The join
  matched: boolean;           // did a Giacom line and a Graph pool meet?
  seatDrift: number | null;   // billedSeats − poolTotal; non-zero means one side is stale
  // The money
  onDisabled: number;         // assigned to accounts that are switched off
  reclaimable: number;        // spare + onDisabled
  monthlyWaste: number | null;// reclaimable × unitPrice
  holders: Holder[];
}

export interface Holder {
  id: string;
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
  enabled: boolean;
  isGuest: boolean;
  createdAt: string | null;
}

export interface Allocation {
  state: AllocationState;
  detail: string;             // human sentence for the panel when state !== 'ok'
  tenantId: string | null;
  skus: SkuAllocation[];      // worst waste first
  unlicensedUsers: number;    // enabled accounts holding nothing (context, not waste)
  totals: {
    poolSeats: number;
    assigned: number;
    spare: number;
    onDisabled: number;
    reclaimable: number;
    monthlyWaste: number;
  };
  checkedAt: Date;
}

// ── Name matching ────────────────────────────────────────────────────────────────
// Giacom's offer names and Microsoft's SKU part numbers are two different vocabularies
// for the same thing, and neither side carries the other's key. Giacom gives us
// "Microsoft 365 Business Premium (Annual Commitment - Monthly Billing)"; Graph gives us
// the part number SPB, which m365.ts already names "Microsoft 365 Business Premium".
//
// So the friendly name is the bridge. Everything below is about getting two strings into
// a shape where that comparison is fair — and, when it is not fair, saying "unmatched"
// out loud rather than quietly pairing the wrong two rows.

const NOISE = [
  'annual commitment', 'monthly commitment', 'annual billing', 'monthly billing',
  'annual', 'monthly', 'commitment', 'subscription', 'licence', 'license',
  'nce', 'csp', 'new commerce', 'per user', 'seat', 'seats',
];

export function normaliseOffer(s: string): string {
  let t = String(s || '').toLowerCase();
  t = t.replace(/\([^)]*\)/g, ' ');        // drop parenthetical billing terms wholesale
  t = t.replace(/[‐-―]/g, '-');  // unicode dashes → ascii
  t = t.replace(/[^a-z0-9+ ]+/g, ' ');     // keep the + in "E5 + Teams"
  for (const n of NOISE) t = t.split(n).join(' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Pair one Giacom offer name with one Graph SKU. Returns the index into `skus`, or -1.
 *
 * Deliberately ordered strongest-first and deliberately refuses a guess: an offer that
 * matches nothing is reported as unmatched, because a wrong pairing here would put a
 * confident seat-drift number on the screen that nobody can trace back.
 */
export function matchSku(offerName: string, skus: M365Sku[]): number {
  const want = normaliseOffer(offerName);
  if (!want) return -1;

  // 1. the friendly name, exactly
  let i = skus.findIndex((s) => normaliseOffer(s.name) === want);
  if (i >= 0) return i;

  // 2. the part number, exactly (Giacom occasionally ships the raw SKU)
  i = skus.findIndex((s) => normaliseOffer(s.partNumber) === want);
  if (i >= 0) return i;

  // 3. the friendly name appears inside the offer name — "Microsoft 365 Business
  //    Premium" inside "Microsoft 365 Business Premium for Faculty". Longest first, so
  //    "Business Premium" can never win over a more specific pool that also fits.
  const byLength = skus
    .map((s, idx) => ({ idx, n: normaliseOffer(s.name) }))
    .filter((x) => x.n.length >= 6)
    .sort((a, b) => b.n.length - a.n.length);
  for (const c of byLength) if (want.includes(c.n)) return c.idx;

  // 4. …and the other way round, for a Giacom name shorter than ours
  for (const c of byLength) if (c.n.includes(want) && want.length >= 6) return c.idx;

  return -1;
}

// ── The read ─────────────────────────────────────────────────────────────────────

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Everything the Services page needs for one customer.
 *
 * Never throws. Every failure becomes a state + a sentence, because this hangs off a
 * customer page that must render whatever Microsoft is doing today.
 */
export async function customerAllocation(customerId: number): Promise<Allocation> {
  const base: Allocation = {
    state: 'no-tenant', detail: '', tenantId: null, skus: [], unlicensedUsers: 0,
    totals: { poolSeats: 0, assigned: 0, spare: 0, onDisabled: 0, reclaimable: 0, monthlyWaste: 0 },
    checkedAt: new Date(),
  };

  let tenant: string | null = null;
  try {
    const c = (await pool.query('SELECT entra_tenant_id FROM customers WHERE id=$1', [customerId])).rows[0];
    tenant = (c?.entra_tenant_id || '').trim() || null;
  } catch { /* fall through to no-tenant */ }

  if (!tenant) {
    return { ...base, state: 'no-tenant',
      detail: 'No Entra tenant ID on this customer, so there is nothing to ask Microsoft about. Add it on the customer record and this fills in by itself.' };
  }
  base.tenantId = tenant;

  let skus: M365Sku[] = [];
  let users: M365User[] = [];
  try {
    // Sequential on purpose: listUsers() calls listSkus() internally for its name map, and
    // firing both at once just doubles the token requests on a cold cache.
    skus = await listSkus(tenant);
    users = await listUsers(tenant);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const denied = /401|403|Authorization|consent|AADSTS|Forbidden|InvalidAuthentication/i.test(msg);
    return { ...base,
      state: denied ? 'no-consent' : 'error',
      detail: denied
        ? 'Microsoft refused the read for this tenant — the portal’s Graph app has not been admin-consented here. Send the consent link from the customer record, then refresh.'
        : `Microsoft could not be read: ${msg.slice(0, 200)}`,
    };
  }

  // What Giacom bills, keyed for the join. Several Giacom lines can land on one pool
  // (an add-on ordered twice), so seats and spend are summed rather than overwritten.
  let billed: any[] = [];
  try {
    billed = (await pool.query(
      `SELECT name, licences, term, price, renewal_date, cancellable_until_date
         FROM ms_subscription
        WHERE customer_id=$1 AND COALESCE(status,'') NOT IN ('Deleted','Cancelled','Suspended')`,
      [customerId])).rows;
  } catch { billed = []; }

  const rows: SkuAllocation[] = skus.map((s) => {
    const holders = users
      .filter((u) => u.licences.includes(s.name))
      .map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, jobTitle: u.jobTitle,
                     department: u.department, enabled: u.enabled, isGuest: u.isGuest, createdAt: u.createdAt }));
    const onDisabled = holders.filter((h) => !h.enabled).length;
    const reclaimable = s.spare + onDisabled;
    return {
      skuId: s.skuId, partNumber: s.partNumber, name: s.name,
      poolTotal: s.total, assigned: s.assigned, spare: s.spare,
      billedSeats: null, unitPrice: null, term: null, renewalDate: null, cancellableUntil: null,
      matched: false, seatDrift: null,
      onDisabled, reclaimable, monthlyWaste: null,
      holders: holders.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName)),
    };
  });

  // Attach the Giacom side.
  const unmatchedOffers: string[] = [];
  for (const b of billed) {
    const idx = matchSku(b.name, skus);
    if (idx < 0) { unmatchedOffers.push(b.name); continue; }
    const r = rows[idx];
    r.matched = true;
    r.billedSeats = (r.billedSeats || 0) + (Number(b.licences) || 0);
    if (b.price != null) r.unitPrice = Number(b.price);
    r.term = r.term || b.term || null;
    const rd = b.renewal_date ? new Date(b.renewal_date) : null;
    if (rd && (!r.renewalDate || rd < r.renewalDate)) r.renewalDate = rd;
    const cu = b.cancellable_until_date ? new Date(b.cancellable_until_date) : null;
    if (cu && (!r.cancellableUntil || cu < r.cancellableUntil)) r.cancellableUntil = cu;
  }

  for (const r of rows) {
    if (r.billedSeats != null) r.seatDrift = r.billedSeats - r.poolTotal;
    r.monthlyWaste = r.unitPrice != null ? money(r.reclaimable * r.unitPrice) : null;
  }

  // A Giacom line we could not pair is shown as its own row rather than dropped — an
  // unmatched offer is a gap in the mapping, and hiding it makes the totals a lie.
  for (const name of unmatchedOffers) {
    const b = billed.find((x: any) => x.name === name);
    rows.push({
      skuId: null, partNumber: null, name,
      poolTotal: 0, assigned: 0, spare: 0,
      billedSeats: Number(b?.licences) || 0,
      unitPrice: b?.price != null ? Number(b.price) : null,
      term: b?.term || null,
      renewalDate: b?.renewal_date ? new Date(b.renewal_date) : null,
      cancellableUntil: b?.cancellable_until_date ? new Date(b.cancellable_until_date) : null,
      matched: false, seatDrift: null,
      onDisabled: 0, reclaimable: 0, monthlyWaste: null, holders: [],
    });
  }

  rows.sort((a, b) => (b.monthlyWaste || 0) - (a.monthlyWaste || 0) || b.reclaimable - a.reclaimable || a.name.localeCompare(b.name));

  const totals = rows.reduce((t, r) => ({
    poolSeats: t.poolSeats + r.poolTotal,
    assigned: t.assigned + r.assigned,
    spare: t.spare + r.spare,
    onDisabled: t.onDisabled + r.onDisabled,
    reclaimable: t.reclaimable + r.reclaimable,
    monthlyWaste: t.monthlyWaste + (r.monthlyWaste || 0),
  }), { poolSeats: 0, assigned: 0, spare: 0, onDisabled: 0, reclaimable: 0, monthlyWaste: 0 });
  totals.monthlyWaste = money(totals.monthlyWaste);

  return {
    state: 'ok', detail: '', tenantId: tenant, skus: rows,
    unlicensedUsers: users.filter((u) => u.enabled && !u.isGuest && !u.licences.length).length,
    totals, checkedAt: new Date(),
  };
}
