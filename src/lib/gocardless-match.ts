import { pool } from '../db/pool';
import { GoCardless } from './gocardless';

// ─── GoCardless ↔ portal customer matching ────────────────────────────────────────────
// ONE matcher, used by the hourly sync AND the match screen, so what the screen shows is
// exactly what the sync will do. The old matcher linked on customers.email alone: a company
// whose email column was empty (the address only lived on a contact) could never be matched,
// and a customer already holding a CANCELLED mandate id was skipped forever because the code
// read "has a mandate id" as "already linked". Both are fixed here.
//
// The link that actually matters is now gocardless_customer_id, not the mandate id. A mandate
// is cancelled and re-signed routinely — bank change, failed DD, a fresh sign-up — and its id
// changes each time. The GC customer id does not, so gocardless_mandate_id is demoted to a
// cache of that customer's CURRENT active mandate and is refreshed on every sync.

export type MatchTier =
  | 'metadata'      // portal_customer_id stamped on the mandate / billing request by our own invite
  | 'gc_customer'   // gocardless_customer_id already stored against the portal customer
  | 'email'         // customers.email
  | 'contact_email' // any contact's email
  | 'domain'        // email domain = customers.domain
  | 'name'          // normalised company name, unique
  | 'fuzzy';        // near-miss name — SUGGESTION ONLY, never auto-linked

export const TIER_LABEL: Record<MatchTier, string> = {
  metadata: 'DD invite metadata',
  gc_customer: 'GoCardless customer id',
  email: 'company email',
  contact_email: 'contact email',
  domain: 'email domain',
  name: 'company name',
  fuzzy: 'similar name',
};

export interface PortalCustomer {
  id: number; name: string; email: string | null; domain: string | null;
  gocardless_customer_id: string | null; gocardless_mandate_id: string | null;
}

export interface GcRow {
  gcId: string; gcName: string; gcEmail: string;
  mandateId: string | null;          // current ACTIVE mandate, if any
  mandateStatus: string | null;      // status of the most relevant mandate we hold for them
  otherMandates: number;             // non-active mandates on record (cancelled, expired…)
  linked: PortalCustomer | null;     // already matched
  match: PortalCustomer | null;      // proposed match, when not linked
  tier: MatchTier | null;            // how the proposal was reached
  confident: boolean;                // true = safe to auto-link
  ambiguous: string | null;          // why a match was NOT taken (e.g. two customers share it)
}

export interface StaleLink {
  customer: PortalCustomer;
  reason: string;                    // mandate GoCardless doesn't report as active
}

export interface MatchState {
  rows: GcRow[];
  portalCustomers: PortalCustomer[];
  stale: StaleLink[];
  warnings: string[];
  stats: { total: number; withMandate: number; linked: number; suggested: number; unmatched: number; noMandate: number };
}

// Public webmail — an @gmail.com address says nothing about which company someone is, so the
// domain tier must never fire on one.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.co.uk',
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'msn.com', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'me.co.uk', 'blueyonder.co.uk', 'ntlworld.com', 'tiscali.co.uk', 'orange.net',
]);

// Tiers safe to act on unattended. 'domain' and 'fuzzy' are suggestions a human confirms.
const AUTO_TIERS = new Set<MatchTier>(['metadata', 'gc_customer', 'email', 'contact_email', 'name']);

export const gcName = (c: any): string =>
  (c?.company_name || [c?.given_name, c?.family_name].filter(Boolean).join(' ') || '').trim();

const lc = (s: any): string => String(s || '').toLowerCase().trim();
const domainOf = (email: any): string => { const e = lc(email); const i = e.lastIndexOf('@'); return i > 0 ? e.slice(i + 1) : ''; };

// Company names as humans mean them: "Per Oculos Limited", "PER OCULOS LTD." and "Per-Oculos Ltd"
// are one company. Strip case, punctuation, the legal suffix and a leading "the".
// Only a TRAILING legal suffix is stripped, and only that. Stripping words like "group",
// "services" or "solutions" wherever they appear would collapse "Lumen Services" and
// "Lumen Group" into the same company — and this decides whose bank account gets debited.
const LEGAL_SUFFIX = /\s(limited|ltd|llp|llc|plc|inc|incorporated|co|company|cic|cio)$/;
export function normName(s: any): string {
  let n = lc(s).replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^the /, '');
  for (let i = 0; i < 3 && LEGAL_SUFFIX.test(n); i++) n = n.replace(LEGAL_SUFFIX, '').trim();
  return n;
}

// Levenshtein ratio, for the suggestion tier only.
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) / Math.max(m, n) > 0.5) return 0;
  let prev = new Array(n + 1); let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// A lookup that remembers collisions: a key claimed by two different customers is ambiguous
// and must never auto-link, however tempting the match looks.
class Index {
  private map = new Map<string, PortalCustomer | null>();
  add(key: string, c: PortalCustomer) {
    if (!key) return;
    const seen = this.map.get(key);
    if (seen === undefined) this.map.set(key, c);
    else if (seen && seen.id !== c.id) this.map.set(key, null); // collision → ambiguous
  }
  get(key: string): { hit: PortalCustomer | null; ambiguous: boolean } {
    if (!key || !this.map.has(key)) return { hit: null, ambiguous: false };
    const v = this.map.get(key)!;
    return v ? { hit: v, ambiguous: false } : { hit: null, ambiguous: true };
  }
}

// Read everything both sides know, then decide. Never throws on a partial GoCardless failure —
// a missing billing-request list costs one matching tier, it must not blank the whole screen.
export async function buildMatchState(gc: GoCardless): Promise<MatchState> {
  const warnings: string[] = [];

  const customersP = gc.listCustomers();
  const mandatesP = gc.listMandates('');           // ALL statuses: active, cancelled, expired…
  const brP = gc.listBillingRequests('').catch((e: any) => {
    warnings.push('Could not read billing requests (DD-invite metadata tier is off this load): ' + (e?.message || 'unknown error'));
    return [] as any[];
  });
  const [gcCustomers, allMandates, billingRequests] = await Promise.all([customersP, mandatesP, brP]);

  const portal: PortalCustomer[] = (await pool.query(
    `SELECT id, name, email, domain, gocardless_customer_id, gocardless_mandate_id
       FROM customers WHERE deleted_at IS NULL`
  )).rows;
  const contacts = (await pool.query(
    `SELECT customer_id, email FROM customer_contacts WHERE email IS NOT NULL AND email <> '' AND archived = false`
  )).rows;

  const byId = new Map<number, PortalCustomer>(portal.map((c) => [c.id, c]));

  // ── GoCardless side indexes ────────────────────────────────────────────────────────
  const activeByCust = new Map<string, string>();     // GC customer → active mandate id
  const anyMandateByCust = new Map<string, number>(); // GC customer → mandate count
  const mandateById = new Map<string, any>();
  for (const m of allMandates) {
    if (!m?.id) continue;
    mandateById.set(String(m.id), m);
    const cust = m?.links?.customer; if (!cust) continue;
    anyMandateByCust.set(cust, (anyMandateByCust.get(cust) || 0) + 1);
    if (m.status === 'active' && !activeByCust.has(cust)) activeByCust.set(cust, String(m.id));
  }

  // portal_customer_id stamped by our own DD invite — the one tier that cannot be wrong.
  const metaByGcCustomer = new Map<string, number>();
  const readMeta = (md: any): number | null => {
    const raw = md?.portal_customer_id ?? md?.customer_id;
    const n = parseInt(String(raw ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  for (const m of allMandates) {
    const cust = m?.links?.customer; const pid = readMeta(m?.metadata);
    if (cust && pid && !metaByGcCustomer.has(cust)) metaByGcCustomer.set(cust, pid);
  }
  for (const br of billingRequests) {
    const cust = br?.links?.customer; const pid = readMeta(br?.metadata);
    if (cust && pid && !metaByGcCustomer.has(cust)) metaByGcCustomer.set(cust, pid);
  }

  // ── Portal side indexes ────────────────────────────────────────────────────────────
  const byGcCustomerId = new Map<string, PortalCustomer>();
  const emailIdx = new Index(), contactIdx = new Index(), domainIdx = new Index(), nameIdx = new Index();
  for (const c of portal) {
    if (c.gocardless_customer_id) byGcCustomerId.set(String(c.gocardless_customer_id), c);
    emailIdx.add(lc(c.email), c);
    const d = lc(c.domain).replace(/^www\./, '');
    if (d && !FREEMAIL.has(d)) domainIdx.add(d, c);
    nameIdx.add(normName(c.name), c);
  }
  for (const ct of contacts) {
    const c = byId.get(ct.customer_id); if (!c) continue;
    contactIdx.add(lc(ct.email), c);
  }

  // A portal customer is free to take a new link if nothing else holds it. A mandate id that
  // GoCardless no longer reports as ACTIVE is dead weight, not a link — that is precisely the
  // state that used to make a re-signed customer permanently unmatchable.
  const mandateIsLive = (mid: any): boolean => {
    const m = mid ? mandateById.get(String(mid)) : null;
    return !!m && m.status === 'active';
  };
  const heldByOther = new Map<number, string>(); // portal customer → GC customer already linked to it
  for (const c of portal) if (c.gocardless_customer_id) heldByOther.set(c.id, String(c.gocardless_customer_id));

  const rows: GcRow[] = [];
  for (const qc of gcCustomers) {
    const gcId = String(qc.id);
    const activeMandate = activeByCust.get(gcId) || null;
    const total = anyMandateByCust.get(gcId) || 0;
    const email = lc(qc.email);
    const name = gcName(qc);

    // Already linked? Either by stored GC customer id (durable) or by the mandate it holds (legacy).
    let linked: PortalCustomer | null = byGcCustomerId.get(gcId) || null;
    if (!linked && activeMandate) linked = portal.find((c) => String(c.gocardless_mandate_id || '') === activeMandate) || null;

    let match: PortalCustomer | null = null, tier: MatchTier | null = null, ambiguous: string | null = null;
    if (!linked) {
      const ladder: Array<[MatchTier, { hit: PortalCustomer | null; ambiguous: boolean }]> = [];
      const metaId = metaByGcCustomer.get(gcId);
      const metaHit = metaId ? byId.get(metaId) || null : null;
      ladder.push(['metadata', { hit: metaHit, ambiguous: false }]);
      ladder.push(['email', emailIdx.get(email)]);
      ladder.push(['contact_email', contactIdx.get(email)]);
      const d = domainOf(email);
      ladder.push(['domain', FREEMAIL.has(d) ? { hit: null, ambiguous: false } : domainIdx.get(d)]);
      ladder.push(['name', nameIdx.get(normName(name))]);

      for (const [t, r] of ladder) {
        if (r.hit) { match = r.hit; tier = t; break; }
        if (r.ambiguous && !ambiguous) ambiguous = `more than one portal customer shares this ${TIER_LABEL[t]}`;
      }

      // Nothing exact — offer the closest name as a suggestion a human confirms.
      if (!match) {
        const target = normName(name);
        if (target.length >= 4) {
          let best: PortalCustomer | null = null, bestScore = 0;
          for (const c of portal) {
            const s = similarity(target, normName(c.name));
            if (s > bestScore) { bestScore = s; best = c; }
          }
          if (best && bestScore >= 0.72) { match = best; tier = 'fuzzy'; }
        }
      }
    }

    // Confident = an EXACT tier, and the target isn't already spoken for. Domain and fuzzy are
    // deliberately excluded: this decides which bank account gets debited, so anything short of
    // an exact identifier is put in front of a human instead of acted on.
    let confident = false;
    if (match && tier && AUTO_TIERS.has(tier)) {
      const held = heldByOther.get(match.id);
      const mandateClash = !!match.gocardless_mandate_id
        && String(match.gocardless_mandate_id) !== String(activeMandate || '')
        && mandateIsLive(match.gocardless_mandate_id);
      if (held && held !== gcId) ambiguous = `${match.name} is already linked to another GoCardless customer`;
      else if (mandateClash) ambiguous = `${match.name} already holds a live mandate`;
      else confident = true;
    }

    rows.push({
      gcId, gcName: name || '(no name)', gcEmail: qc.email || '',
      mandateId: activeMandate,
      mandateStatus: activeMandate ? 'active' : (total ? 'no active mandate' : null),
      otherMandates: total - (activeMandate ? 1 : 0),
      linked, match, tier, confident, ambiguous,
    });
  }
  rows.sort((a, b) => a.gcName.localeCompare(b.gcName));

  // The reverse view: portal customers holding a mandate GoCardless does not report as active.
  // These are the ones that silently stop collecting.
  const stale: StaleLink[] = [];
  for (const c of portal) {
    if (!c.gocardless_mandate_id) continue;
    const m = mandateById.get(String(c.gocardless_mandate_id));
    if (!m) stale.push({ customer: c, reason: 'GoCardless has no record of this mandate' });
    else if (m.status !== 'active') stale.push({ customer: c, reason: `mandate is ${m.status}` });
  }

  if (gcCustomers.length === 0) warnings.push('GoCardless returned no customers at all — check the API key and environment in Settings → Integrations.');

  const stats = {
    total: rows.length,
    withMandate: rows.filter((r) => r.mandateId).length,
    linked: rows.filter((r) => r.linked).length,
    suggested: rows.filter((r) => !r.linked && r.match).length,
    unmatched: rows.filter((r) => !r.linked && !r.match).length,
    noMandate: rows.filter((r) => !r.mandateId).length,
  };
  const portalCustomers = portal.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { rows, portalCustomers, stale, warnings, stats };
}

// Write one link. Stores the GC CUSTOMER id (durable) and caches their current active mandate.
// Anything else holding either id is cleared first, so a link can always be moved.
export async function linkGcCustomer(gcCustomerId: string, portalCustomerId: number, mandateId: string | null): Promise<void> {
  await pool.query('UPDATE customers SET gocardless_customer_id=NULL WHERE gocardless_customer_id=$1 AND id<>$2', [gcCustomerId, portalCustomerId]);
  if (mandateId) await pool.query('UPDATE customers SET gocardless_mandate_id=NULL WHERE gocardless_mandate_id=$1 AND id<>$2', [mandateId, portalCustomerId]);
  await pool.query('UPDATE customers SET gocardless_customer_id=$1, gocardless_mandate_id=$2 WHERE id=$3', [gcCustomerId, mandateId, portalCustomerId]);
}

// Auto-link every confident row, and refresh the cached mandate of everyone already linked so a
// re-signed customer starts collecting again on its own.
export async function applyMatches(state: MatchState): Promise<{ linked: number; refreshed: number }> {
  let linked = 0, refreshed = 0;
  for (const r of state.rows) {
    if (r.linked) {
      const c = r.linked;
      const wantCust = String(c.gocardless_customer_id || '') !== r.gcId;
      const wantMandate = String(c.gocardless_mandate_id || '') !== String(r.mandateId || '');
      if (wantCust || wantMandate) {
        await linkGcCustomer(r.gcId, c.id, r.mandateId);
        c.gocardless_customer_id = r.gcId; c.gocardless_mandate_id = r.mandateId;
        refreshed++;
      }
      continue;
    }
    if (r.match && r.confident) {
      await linkGcCustomer(r.gcId, r.match.id, r.mandateId);
      r.linked = r.match; r.match.gocardless_customer_id = r.gcId; r.match.gocardless_mandate_id = r.mandateId;
      r.match = null; r.tier = null; r.confident = false;
      linked++;
    }
  }
  if (linked || refreshed) {
    state.stats.linked = state.rows.filter((x) => x.linked).length;
    state.stats.suggested = state.rows.filter((x) => !x.linked && x.match).length;
    state.stats.unmatched = state.rows.filter((x) => !x.linked && !x.match).length;
  }
  return { linked, refreshed };
}
