import { pool } from '../db/pool';

// ── IT & Cloud billing (consolidated recurring invoice) ────────────────────────────
// One invoice per customer = IT Services contract lines (rated) + Cloud/Microsoft 365 lines
// pulled live from Giacom service_items. This module computes the LIVE PREVIEW: it never
// writes — it recomputes what the next IT & Cloud invoice would contain, every time it's read.
// Mirrors the comms commsAccount/commsRateCard shape so the customer panel + bureau can render
// the bill "as a whole" before anything is generated.

export interface ItCloudLine {
  kind: 'it' | 'cloud';
  category: string;            // 'IT Services' | 'Cloud / Microsoft 365'
  ref: string | null;          // contract number (IT) or product_reference (cloud)
  description: string;
  qty: number;
  cost: number;                // monthly buy (cloud from Giacom; IT contract carries no separate cost → 0)
  unitCost: number;            // per-unit buy (cloud = si.unit_cost) — the key for setSalePrice
  sale: number | null;         // monthly sale (line total); null = not yet priced
  salePriceEach: number | null;// per-unit sell (what the editable rate-card box holds)
  source: 'contract' | 'giacom';
  priced: boolean;
  customerOverride?: boolean;   // true = price is a per-customer override (else global standard / none)
  inCatalogue?: boolean;        // false = this Giacom product has NO matching product in the DB catalogue (flag)
  catalogueId?: number | null;  // asset_products.id of the matched catalogue product (→ QB item + reporting)
  qbMapped?: boolean;           // matched catalogue product has a QuickBooks item set
}

export interface ItCloudAccount {
  customerId: number;
  itLines: ItCloudLine[];
  cloudLines: ItCloudLine[];
  adjustments: ItCloudLine[]; // advance-month (upfront) charges + pinned removals in notice period
  totals: { cost: number; sale: number; profit: number };
  giacomLinked: boolean;       // a Giacom customer id is paired → cloud activity flows automatically
  unpriced: number;            // cloud lines with no sale price yet (need attention before generate)
  unmatched: number;           // cloud lines whose Giacom product_id is NOT in the DB catalogue (flag)
  hasBillingContact: boolean;  // gate: no invoice may be generated without a billing contact
}

// Live, read-only preview of a customer's IT & Cloud bill. Recomputed on every call.
export async function itCloudAccount(customerId: number): Promise<ItCloudAccount> {
  // IT Services contract lines — active IT contracts, monthly-billed lines only.
  const itRows = (await pool.query(
    `SELECT ct.contract_number, cl.description, cl.quantity, cl.line_total
       FROM contracts ct
       JOIN contract_lines cl ON cl.contract_id = ct.id
      WHERE ct.customer_id = $1 AND ct.service_type = 'IT' AND ct.status = 'active'
        AND ct.deleted_at IS NULL AND cl.billing_frequency = 'monthly'
      ORDER BY ct.contract_number, cl.sort_order, cl.id`, [customerId]
  )).rows;
  const itLines: ItCloudLine[] = itRows.map((r: any) => {
    const qty = Number(r.quantity) || 1; const sale = Number(r.line_total) || 0;
    return {
      kind: 'it', category: 'IT Services', ref: r.contract_number,
      description: r.description || 'IT service', qty,
      cost: 0, unitCost: 0, sale, salePriceEach: qty ? sale / qty : sale, source: 'contract', priced: true,
    } as ItCloudLine;
  });

  // Cloud / Microsoft 365 lines — live from Giacom service_items (durable sale price wins,
  // else fall back to supplier total_cost so the customer at least sees the pass-through cost).
  // Sell price resolves COALESCE(per-customer override in service_pricing, GLOBAL catalogue price).
  // The catalogue (asset_products) is the product list: matched to Giacom by code=product_reference,
  // it carries the global sell (unit_price) AND the cost (cost_price). Per-unit Giacom cost is
  // derived from the line total when the feed gives no per-seat cost.
  // Keyed on the feed's stable Giacom product_id (e.g. 55-a) — the product list (asset_products) is
  // seeded with the same code, so this join is exact (no fuzzy matching). Override (per-customer)
  // wins; else the global catalogue price.
  const cloudRows = (await pool.query(
    `SELECT si.product_id AS code, MIN(si.description) AS description, SUM(si.quantity)::numeric AS quantity,
            si.unit_cost, SUM(si.total_cost)::numeric AS total_cost,
            spc.sale_price AS override_price,
            ap.unit_price AS catalogue_price, ap.cost_price AS catalogue_cost, ap.id AS catalogue_id,
            ap.quickbooks_item_id AS catalogue_qb_item
       FROM service_items si
       LEFT JOIN service_pricing spc
              ON spc.source='giacom' AND spc.customer_id=si.customer_id
             AND COALESCE(spc.product_reference,'')=COALESCE(si.product_id,'')
       LEFT JOIN asset_products ap
              ON ap.source_tag='giacom' AND ap.is_active=true
             AND lower(ap.code)=lower(COALESCE(si.product_id,''))
      WHERE si.customer_id=$1 AND si.source='giacom'
      GROUP BY si.product_id, si.unit_cost, spc.sale_price, ap.unit_price, ap.cost_price, ap.id, ap.quickbooks_item_id
      ORDER BY MIN(si.description)`, [customerId]
  )).rows;
  let unpriced = 0, unmatched = 0;
  const cloudLines: ItCloudLine[] = cloudRows.map((r: any) => {
    const qty = Number(r.quantity) || 1;
    const totalCost = Number(r.total_cost) || 0;
    // Per-unit cost: feed cost → else catalogue cost → else derive from line total.
    const feedUnit = Number(r.unit_cost) || 0;
    const catCost = Number(r.catalogue_cost) || 0;
    const unitCost = feedUnit > 0 ? feedUnit : (catCost > 0 ? catCost : (qty ? totalCost / qty : 0));
    const cost = unitCost * qty;
    // Sell: per-customer override wins; else global catalogue price (>0). 0/absent = unpriced.
    const override = (r.override_price !== null && r.override_price !== undefined) ? Number(r.override_price) : null;
    const global = Number(r.catalogue_price) > 0 ? Number(r.catalogue_price) : null;
    const salePriceEach = override != null ? override : global;
    const hasSale = salePriceEach != null;
    if (!hasSale) unpriced++;
    // FLAG: Giacom is billing us for a product that has no matching row in the DB catalogue
    // (ap.id null). It can't be priced/mapped to a QB item until someone adds it to the product list.
    const inCatalogue = r.catalogue_id != null;
    if (!inCatalogue) unmatched++;
    return {
      kind: 'cloud', category: 'Cloud / Microsoft 365', ref: r.code,
      description: r.description || 'Cloud service', qty, cost, unitCost,
      sale: hasSale ? (salePriceEach as number) * qty : null, salePriceEach,
      source: 'giacom', priced: hasSale, customerOverride: override != null, inCatalogue,
      catalogueId: inCatalogue ? Number(r.catalogue_id) : null,
      qbMapped: inCatalogue && r.catalogue_qb_item != null && String(r.catalogue_qb_item) !== '',
    };
  });

  // Delta engine: advance-month (upfront) charges for new adds + pinned removals still in notice.
  const { itCloudAdjustments } = await import('./it-cloud-deltas');
  let adjustments: ItCloudLine[] = [];
  try { adjustments = await itCloudAdjustments(customerId); } catch { /* ledger not migrated yet */ }

  const totals = { cost: 0, sale: 0, profit: 0 };
  for (const l of [...itLines, ...cloudLines, ...adjustments]) {
    totals.cost += l.cost;
    if (l.sale !== null) { totals.sale += l.sale; totals.profit += l.sale - l.cost; }
  }

  const giacomLinked = !!(await pool.query(
    "SELECT 1 FROM customer_external_ids WHERE customer_id=$1 AND source_system='giacom' LIMIT 1", [customerId]
  )).rowCount;
  const hasBillingContact = !!(await pool.query(
    "SELECT 1 FROM customers WHERE id=$1 AND billing_contact_id IS NOT NULL", [customerId]
  )).rowCount;

  return { customerId, itLines, cloudLines, adjustments, totals, giacomLinked, unpriced, unmatched, hasBillingContact };
}

// Customers who would be billed in the IT & Cloud run (have IT contract lines or Giacom cloud
// lines) but have NO billing contact set. Used to (a) alert when the bill-run period kicks in
// and (b) block invoice generation for them. Returns id + name.
export async function itCloudMissingBillingContact(): Promise<{ id: number; name: string }[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.name
       FROM customers c
      WHERE c.deleted_at IS NULL AND c.billing_contact_id IS NULL
        AND (
          EXISTS (SELECT 1 FROM service_items si WHERE si.customer_id=c.id AND si.source='giacom')
          OR EXISTS (SELECT 1 FROM contracts ct WHERE ct.customer_id=c.id AND ct.service_type='IT'
                       AND ct.status='active' AND ct.deleted_at IS NULL)
        )
      ORDER BY c.name`
  );
  return rows.map((r: any) => ({ id: r.id, name: r.name }));
}
