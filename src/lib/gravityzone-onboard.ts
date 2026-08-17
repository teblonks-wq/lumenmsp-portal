import { pool } from '../db/pool';
import { rpc, rpcAny, gzConfigured } from './gravityzone';
import { getSetting, setSetting } from './settings';
import { logActivity } from './activity';

// ─────────────────────────────────────────────────────────────────────────────────
// Onboarding customers INTO GravityZone as managed companies.
//
// Terry, 17 Aug: "Staybrook is the only customer but we need all our customers in
// there", then "IF WE DEPLOY WE NEED TO ASSIGN LICENCES - it's ok we have an MSP
// agreement with Giacom", then "they will start coming in on import". So this module
// exists to turn one button into a licensed company per customer.
//
// THE TRAP, straight from Bitdefender's createCompany docs, and it is a quiet one:
//
//   "This parameter can be used only when creating a company with license or
//    subscription of type 3. If NOT SPECIFIED, the company will be created with
//    license or subscription of type 1, TRIAL."
//
// Omit licenseSubscription and every customer we onboard silently lands on a trial
// that expires — protection would simply stop weeks later, on a schedule nobody is
// watching, across the whole estate at once. So type 3 is passed explicitly, always,
// and a company that comes back on any other subscription type is reported rather
// than assumed fine.
//
// THE SEAT DECISION. reservedSlots RESERVES seats out of Lumen's own pool. The docs:
// "If not specified, all license seats will be taken from the licenses pool shared
// with other companies." Shared-pool is exactly right for a Giacom monthly MSP
// agreement — seats flow on usage and get billed on usage — so we deliberately do
// NOT send reservedSlots. Reserving would ring-fence seats per customer and start
// failing installs for one customer while another sat on spare capacity.
//
// THE ADD-ON DECISION. Every manage* add-on (EDR, PHASR, Sandbox, HyperDetect, MDR,
// Patch Management, Encryption…) defaults to false / "unavailable if omitted". They
// are all omitted on purpose: each one is chargeable, and AV is what Lumen gives away
// with Managed IT. Nothing here can quietly enable a product Terry has not sold.
// ─────────────────────────────────────────────────────────────────────────────────

/** Endpoint Security. Not EDR (3), not PHASR (5) — those are chargeable products. */
const PRODUCT_ENDPOINT_SECURITY = 0;
/**
 * Terry, 17 Aug: "we will start with Just Endpoint Security as standard."
 *
 * From his Giacom reseller price list, per endpoint per month:
 *   aLaCarte / Endpoint Security  £0.99   ← this. Plain AV, no EDR.
 *   mspSecure                     £1.93   adds EDR
 *   mspSecurePlus                 £4.00   adds MDR Foundations
 *   mspSecureExtra                £5.07   adds XDR Identity & Productivity
 *
 * Leaving this UNSET inherits whatever Giacom made the partner default, which could be
 * any of the four — so an unset model is a blank cheque. At 100 endpoints the gap
 * between the cheapest and dearest is about £4,900 a year, on a product Lumen gives
 * away with the Managed IT package. Hence: pinned, and if GravityZone refuses the value
 * we FAIL rather than fall back, because a silent fallback is the expensive outcome.
 */
const DEFAULT_PROTECTION_MODEL = 'aLaCarte';
const PROTECTION_MODELS = ['aLaCarte', 'mspSecure', 'mspSecurePlus', 'mspSecureExtra'];
/** licenseSubscription.type 3 = monthly subscription. 1 = trial, which is the trap. */
const SUBSCRIPTION_MONTHLY = 3;
/** createCompany.type 1 = Customer company (0 would create a sub-Partner). */
const COMPANY_TYPE_CUSTOMER = 1;
/** GravityZone's own limit on the name field. */
const MAX_NAME = 64;

export interface OnboardOutcome {
  customerId: number;
  customerName: string;
  gzCompanyId: string | null;
  action: 'created' | 'already-there' | 'skipped' | 'failed';
  detail: string;
}

/**
 * The protection model new companies are put on. Settable so a change of Giacom
 * agreement is a settings edit, not a deploy — but it can only ever be one of the four
 * real values, so a typo cannot quietly become an expensive tier.
 */
export async function protectionModel(): Promise<string> {
  const v = await getSetting('gravityzone', 'protection_model');
  return v && PROTECTION_MODELS.includes(v) ? v : DEFAULT_PROTECTION_MODEL;
}

export async function setProtectionModel(model: string): Promise<void> {
  if (!PROTECTION_MODELS.includes(model)) throw new Error('Unknown protection model.');
  await setSetting('gravityzone', 'protection_model', model);
}

/** Lumen's own company id — the parent every managed company hangs from. */
export async function ownCompanyId(): Promise<string | null> {
  try {
    const own = await rpcAny<any>([['companies', 'getCompanyDetails'], ['network', 'getCompanyDetails']], {});
    return own.result?.id ? String(own.result.id) : null;
  } catch { return null; }
}

/**
 * Every company already in the tenant, keyed by lower-cased name.
 * Read once per onboarding run rather than per customer: the whole point of "import"
 * is that it might be twenty customers, and this is the check that stops us creating
 * a duplicate of one that is already there under a slightly different case.
 */
export async function existingCompanies(): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  try {
    const got = await rpcAny<any>([['network', 'getCompaniesList'], ['companies', 'getCompaniesList']], {});
    const items = Array.isArray(got.result) ? got.result : (got.result?.items || []);
    for (const c of items) {
      if (!c?.id) continue;
      out.set(String(c.name || '').trim().toLowerCase(), { id: String(c.id), name: String(c.name || '') });
    }
  } catch { /* caller decides what an unreadable list means */ }
  return out;
}

/** Why a name cannot be used, or null if it is fine. */
export function nameProblem(name: string): string | null {
  const n = (name || '').trim();
  if (!n) return 'no name';
  if (n.length > MAX_NAME) return `name is ${n.length} characters — GravityZone's limit is ${MAX_NAME}`;
  if (/[<>]/.test(n)) return 'name contains angle brackets, which GravityZone rejects';
  return null;
}

/**
 * Create ONE customer as a licensed managed company. Idempotent: an exact
 * (case-insensitive) name match already in the tenant is adopted, never duplicated,
 * because a duplicate company is worse than no company — endpoints would scatter
 * across both and the estate view would show a customer half-protected.
 */
export async function onboardCustomer(
  customerId: number,
  opts: { parentId?: string | null; existing?: Map<string, { id: string; name: string }>; userId?: number | null } = {},
): Promise<OnboardOutcome> {
  const row = (await pool.query(
    `SELECT id, name, phone, address_line_1, city, postcode FROM customers WHERE id=$1`, [customerId])).rows[0];
  if (!row) return { customerId, customerName: '?', gzCompanyId: null, action: 'failed', detail: 'no such customer' };

  const name = String(row.name || '').trim();
  const base: OnboardOutcome = { customerId, customerName: name, gzCompanyId: null, action: 'failed', detail: '' };

  const bad = nameProblem(name);
  if (bad) return { ...base, action: 'skipped', detail: bad };

  const existing = opts.existing ?? await existingCompanies();
  const hit = existing.get(name.toLowerCase());
  if (hit) {
    await adoptCompany(hit.id, customerId);
    return { ...base, gzCompanyId: hit.id, action: 'already-there',
      detail: hit.name === name ? 'already in GravityZone' : `already there as "${hit.name}"` };
  }

  const parentId = opts.parentId ?? await ownCompanyId();

  // Deliberately minimal. Address/phone are sent when we have them because the
  // GravityZone console is easier to work in when companies are recognisable, but
  // nothing here is required and nothing chargeable is switched on.
  const model = await protectionModel();
  const params: any = {
    type: COMPANY_TYPE_CUSTOMER,
    name,
    canBeManagedByAbove: true,   // we ARE the ITSM — without this we cannot manage their security
    licenseSubscription: {
      type: SUBSCRIPTION_MONTHLY,                    // never omit: omitting means TRIAL
      assignedProductType: PRODUCT_ENDPOINT_SECURITY,
      additionalProductTypes: [PRODUCT_ENDPOINT_SECURITY],
      assignedProtectionModel: model,                // pinned — see DEFAULT_PROTECTION_MODEL
      // no reservedSlots  → shared pool → usage-billed, per the Giacom MSP agreement
      // no manage* add-ons → nothing chargeable is enabled
    },
  };
  if (parentId) params.parentId = parentId;
  const addr = [row.address_line_1, row.city, row.postcode].filter(Boolean).join(', ');
  if (addr) params.address = addr.slice(0, 128);
  if (row.phone) params.phone = String(row.phone).slice(0, 32);

  let gzId: string;
  try {
    const res = await rpc<any>('companies', 'createCompany', params);
    gzId = typeof res === 'string' ? res : String(res?.id || res || '');
    if (!gzId) return { ...base, detail: 'GravityZone accepted the call but returned no company id' };
  } catch (e: any) {
    return { ...base, detail: e.message || String(e) };
  }

  await adoptCompany(gzId, customerId, name);
  await logActivity(opts.userId ?? null, 'gz_onboard_company', 'customers', customerId,
    `Onboarded ${name} into GravityZone as a monthly-subscription company (${gzId})`);
  return { ...base, gzCompanyId: gzId, action: 'created', detail: 'created on a monthly subscription, seats from the shared pool' };
}

/** Record the mapping our side so the next sync attributes endpoints immediately. */
async function adoptCompany(gzId: string, customerId: number, name?: string): Promise<void> {
  await pool.query(
    `INSERT INTO security_companies (gz_id, name, customer_id, synced_at)
     VALUES ($1, COALESCE($2, '(pending first sync)'), $3, NOW())
     ON CONFLICT (gz_id) DO UPDATE SET customer_id = EXCLUDED.customer_id,
       name = COALESCE(security_companies.name, EXCLUDED.name)`,
    [gzId, name ?? null, customerId]);
}

export interface ImportResult {
  outcomes: OnboardOutcome[];
  created: number; alreadyThere: number; skipped: number; failed: number;
  warnings: string[];
}

/**
 * "They will start coming in on import" — onboard every in-scope customer that is not
 * already a company. Sequential on purpose: this is a write into a live security
 * tenant that consumes licence seats, so a partial run should stop having done a
 * countable amount of work, not fire twenty concurrent creates and leave us guessing.
 */
export async function importAllCustomers(
  customerIds: number[], userId: number | null = null,
): Promise<ImportResult> {
  const out: ImportResult = { outcomes: [], created: 0, alreadyThere: 0, skipped: 0, failed: 0, warnings: [] };
  if (!await gzConfigured()) { out.warnings.push('No GravityZone API key saved yet.'); return out; }

  const parentId = await ownCompanyId();
  if (!parentId) out.warnings.push('Could not read our own company id — companies will be created without an explicit parent.');
  const existing = await existingCompanies();

  for (const id of customerIds) {
    const r = await onboardCustomer(id, { parentId, existing, userId });
    out.outcomes.push(r);
    if (r.action === 'created') { out.created++; existing.set(r.customerName.toLowerCase(), { id: r.gzCompanyId!, name: r.customerName }); }
    else if (r.action === 'already-there') out.alreadyThere++;
    else if (r.action === 'skipped') out.skipped++;
    else out.failed++;
  }
  return out;
}

/**
 * Put an existing company onto dynamic (shared-pool) seats.
 *
 * Needed because a company created by hand in the console — Staybrook, for instance —
 * may have reserved seats, and reserved seats are how a rollout dies at machine
 * eleven of ten while the partner pool still has hundreds free. removeReservedSlots
 * is the documented switch for "allow dynamic provisioning of license seats".
 */
export async function useSharedSeats(gzCompanyId: string, userId: number | null = null): Promise<void> {
  await rpc('licensing', 'setMonthlySubscription', {
    companyId: gzCompanyId,
    removeReservedSlots: true,
    assignedProductType: PRODUCT_ENDPOINT_SECURITY,
  });
  await logActivity(userId, 'gz_shared_seats', 'security_companies', null,
    `Switched GravityZone company ${gzCompanyId} to shared (usage-billed) licence seats`);
}

/**
 * Which companies are NOT on a monthly subscription — i.e. sitting on a trial that
 * will expire and take their protection with it. Read from what sync already stored,
 * so this costs nothing and can be shown on the settings page as a standing warning.
 */
export async function trialCompanies(): Promise<Array<{ gzId: string; name: string; type: number | null }>> {
  const r = await pool.query(
    `SELECT gz_id, name, raw FROM security_companies ORDER BY name`);
  const out: Array<{ gzId: string; name: string; type: number | null }> = [];
  for (const row of r.rows) {
    const lic = row.raw?.licenseSubscription || row.raw?.license || {};
    const type = lic.type == null ? null : Number(lic.type);
    // Only flag what we can actually see. An unknown type is not evidence of a trial,
    // and crying wolf on a security page is how real warnings get ignored.
    if (type != null && type !== SUBSCRIPTION_MONTHLY && type !== 2) {
      out.push({ gzId: String(row.gz_id), name: String(row.name || ''), type });
    }
  }
  return out;
}
