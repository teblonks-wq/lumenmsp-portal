import { pool } from '../db/pool';
import { rpc, rpcAny, gzConfigured } from './gravityzone';
import { logActivity } from './activity';

// ─────────────────────────────────────────────────────────────────────────────────
// Reconciling Portal customers against GravityZone companies.
//
// THE THING THIS FILE USED TO GET WRONG. It was originally written to CREATE companies
// in GravityZone via companies/createCompany. Terry tested it properly and the answer
// came back plainly: "so we need to add the service in giacm first" — the Bitdefender
// service is added to the customer in Giacom Cloud Market, and the company then appears
// in GravityZone on its own. Giacom's own documentation was pointing at this all along
// ("select an existing Organisation as created in Cloud.Market"), and creating a company
// directly in GravityZone would have produced one Cloud Market knew nothing about:
// unlicensed, unbilled, or simply missing from the Giacom invoice.
//
// So the create path is GONE, deliberately, rather than left behind a flag. A tempting
// wrong button is worse than no button — the next person to read this should not be able
// to switch it on without first re-reading why it was removed.
//
// What the Portal does instead, which is all Terry asked for:
//   * says which customers still need the service adding in Giacom (the to-do list)
//   * maps GravityZone companies to Portal customers, exactly, never by guess
//   * leaves licensing alone — that lives in Giacom and GravityZone
//
// The deployment itself, and the removal of whatever AV is already on the machine, is
// gravityzone-deploy.ts. Monitoring and reporting is the estate view plus the agent's
// own security collector.
// ─────────────────────────────────────────────────────────────────────────────────

/** GravityZone's own limit on the company name field — useful when matching by name. */
const MAX_NAME = 64;

/** Lumen's own company id — the partner root everything else hangs from. */
export async function ownCompanyId(): Promise<string | null> {
  try {
    const own = await rpcAny<any>([['companies', 'getCompanyDetails'], ['network', 'getCompanyDetails']], {});
    return own.result?.id ? String(own.result.id) : null;
  } catch { return null; }
}

/**
 * Every company in the tenant, keyed by lower-cased name. Read once per reconcile
 * rather than per customer — the point of this is that it might be twenty customers.
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
  } catch { /* the caller decides what an unreadable list means */ }
  return out;
}

/** Why a name would not match cleanly, or null if it is fine. */
export function nameProblem(name: string): string | null {
  const n = (name || '').trim();
  if (!n) return 'no name';
  if (n.length > MAX_NAME) return `name is ${n.length} characters — GravityZone's limit is ${MAX_NAME}`;
  return null;
}

export interface ReconcileRow {
  customerId: number;
  customerName: string;
  gzCompanyId: string | null;
  state: 'mapped' | 'matched-by-name' | 'awaiting-giacom';
  detail: string;
}

/**
 * Where every in-scope customer stands. This is the screen Terry works from:
 * 'awaiting-giacom' is his to-do list in Cloud Market, and nothing else needs doing.
 *
 * A company already mapped stays mapped. A company whose name matches a customer
 * EXACTLY (case-insensitively) is adopted automatically, because that is a fact rather
 * than a guess. Anything else is left alone and reported — a near-miss name is not
 * evidence, and a wrong mapping would show one customer another customer's machines.
 */
export async function reconcile(userId: number | null = null): Promise<{ rows: ReconcileRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!await gzConfigured()) return { rows: [], warnings: ['No GravityZone API key saved yet.'] };

  const existing = await existingCompanies();
  if (!existing.size) warnings.push('No companies readable in GravityZone — check the API key has Network access.');

  // In scope = the contract says so (is_itsm), honouring per-customer overrides.
  const custs = (await pool.query(
    `SELECT c.id, c.name,
            (SELECT sc.gz_id FROM security_companies sc WHERE sc.customer_id = c.id ORDER BY sc.gz_id LIMIT 1) AS gz_id
       FROM customers c
      WHERE NOT c.is_placeholder AND c.is_itsm
      ORDER BY c.name`)).rows;

  const rows: ReconcileRow[] = [];
  for (const c of custs) {
    const customerId = Number(c.id);
    const customerName = String(c.name || '').trim();

    if (c.gz_id) {
      rows.push({ customerId, customerName, gzCompanyId: String(c.gz_id), state: 'mapped',
        detail: 'in GravityZone and mapped' });
      continue;
    }

    const hit = existing.get(customerName.toLowerCase());
    if (hit) {
      await adoptCompany(hit.id, customerId, hit.name);
      if (userId) await logActivity(userId, 'gz_map_company', 'customers', customerId,
        `Mapped ${customerName} to GravityZone company ${hit.id} by exact name match`);
      rows.push({ customerId, customerName, gzCompanyId: hit.id, state: 'matched-by-name',
        detail: hit.name === customerName ? 'matched by name' : `matched to "${hit.name}"` });
      continue;
    }

    const bad = nameProblem(customerName);
    rows.push({ customerId, customerName, gzCompanyId: null, state: 'awaiting-giacom',
      detail: bad
        ? `add the Bitdefender service in Cloud Market — and note ${bad}, so the names will not auto-match`
        : 'add the Bitdefender service to this customer in Giacom Cloud Market; the company then appears here' });
  }
  return { rows, warnings };
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

/**
 * Put an existing company onto dynamic (shared-pool) seats.
 *
 * Kept because a company can arrive with reserved seats, and reserved seats are how a
 * rollout dies at machine eleven of ten while the partner pool still has hundreds free.
 * removeReservedSlots is the documented switch for dynamic provisioning. This is the one
 * licensing call the Portal makes, and only when a human asks for it.
 */
export async function useSharedSeats(gzCompanyId: string, userId: number | null = null): Promise<void> {
  await rpc('licensing', 'setMonthlySubscription', {
    companyId: gzCompanyId,
    removeReservedSlots: true,
    assignedProductType: 0,   // Endpoint Security — the standard tier
  });
  await logActivity(userId, 'gz_shared_seats', 'security_companies', null,
    `Switched GravityZone company ${gzCompanyId} to shared (usage-billed) licence seats`);
}
