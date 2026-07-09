import { pool } from '../db/pool';

// Durable sell prices for supplier service lines (service_pricing). Keyed by
// (source, customer_id, product_reference, unit_cost) — a different buy price for the
// same product is its own pricing row. service_items are refreshed from suppliers, so
// the sale price lives here and survives the nightly Giacom wipe.

export interface PricedLine {
  source: string;
  customer_id: number | null;
  customer_name: string | null;
  product_reference: string | null;
  description: string | null;
  quantity: number;
  unit_cost: number;   // buy price (per unit)
  sale_price: number | null; // per-unit sell from service_pricing, null = uncosted
  catalogue_product_id: number | null;
  service_from: string | null; // earliest service start across the grouped lines (YYYY-MM-DD)
  service_to: string | null;   // latest service end
  is_prorata: boolean;         // any part-month line in the group (new/changed this period)
}

// One row per distinct (customer, product, buy price) across live supplier service_items,
// left-joined to its durable sale price. The grouping gives the "same product, different
// price = separate line" behaviour. sources: pass a list to filter (default all).
export async function pricedServiceLines(opts: { customerId?: number | null; sources?: string[] } = {}): Promise<PricedLine[]> {
  const params: any[] = [];
  const where: string[] = ['si.customer_id IS NOT NULL'];
  if (opts.customerId) { params.push(opts.customerId); where.push('si.customer_id = $' + params.length); }
  if (opts.sources && opts.sources.length) { params.push(opts.sources); where.push('si.source = ANY($' + params.length + ')'); }
  const { rows } = await pool.query(
    `SELECT si.source, si.customer_id, c.name AS customer_name, si.product_reference,
            MIN(si.description) AS description,
            SUM(si.quantity)::numeric AS quantity, si.unit_cost,
            MIN(si.billing_from) AS service_from, MAX(si.billing_to) AS service_to,
            bool_or(si.is_prorata) AS is_prorata,
            sp.sale_price, sp.catalogue_product_id
       FROM service_items si
       LEFT JOIN customers c ON c.id = si.customer_id
       LEFT JOIN service_pricing sp
              ON sp.source = si.source AND sp.customer_id = si.customer_id
             AND COALESCE(sp.product_reference,'') = COALESCE(si.product_reference,'')
             AND sp.unit_cost = si.unit_cost
      WHERE ${where.join(' AND ')}
      GROUP BY si.source, si.customer_id, c.name, si.product_reference, si.unit_cost, sp.sale_price, sp.catalogue_product_id
      ORDER BY c.name NULLS LAST, si.product_reference`, params
  );
  // Comms prices live under the package's sentinel keys (SEAT / REC / FEATURE_PACK / LR:<cli> /
  // MOB:<cli>), not the per-CLI line ref — so the direct join above misses them. Build a
  // customer→key→sale map and fall back to the classified key for any comms line still null.
  const SEAT_RE = /hv select/i, BB_RE = /fttp|sogea|fttc|adsl|ethernet|internet access|broadband|fibre|leased/i;
  const REC_RE = /voice recording|call recording/i, LR_RE = /line rental/i;
  const MOBILE_RE = /everyway|vodashare|gprs|data optimiser|\bee\d|mobile/i;
  const commsPrice = new Map<number, Map<string, number>>();
  if (rows.some((r: any) => r.source === 'comms' && (r.sale_price === null || r.sale_price === undefined))) {
    const pr = await pool.query("SELECT customer_id, product_reference, sale_price FROM service_pricing WHERE source='comms'");
    for (const r of pr.rows) {
      if (!commsPrice.has(r.customer_id)) commsPrice.set(r.customer_id, new Map());
      commsPrice.get(r.customer_id)!.set(String(r.product_reference || ''), Number(r.sale_price));
    }
  }
  const commsKey = (cli: string, d: string): string => {
    if (SEAT_RE.test(d)) return 'SEAT';
    if (REC_RE.test(d)) return 'REC';
    if (LR_RE.test(d)) return 'LR:' + cli;
    if (MOBILE_RE.test(d)) return 'MOB:' + cli;
    return cli; // broadband + anything else keyed by the circuit/CLI ref itself
  };
  return rows.map((r: any) => {
    let sale = r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price);
    if (sale === null && r.source === 'comms') {
      const m = commsPrice.get(r.customer_id);
      if (m) { const v = m.get(commsKey(String(r.product_reference || ''), String(r.description || ''))); if (v !== undefined) sale = v; }
    }
    return {
      source: r.source,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      product_reference: r.product_reference,
      description: r.description,
      quantity: Number(r.quantity) || 0,
      unit_cost: Number(r.unit_cost) || 0,
      sale_price: sale,
      catalogue_product_id: r.catalogue_product_id ?? null,
      service_from: r.service_from ? new Date(r.service_from).toISOString().slice(0, 10) : null,
      service_to: r.service_to ? new Date(r.service_to).toISOString().slice(0, 10) : null,
      is_prorata: !!r.is_prorata,
    };
  });
}

// Upsert a sale price for a (source, customer, product, buy-price) key.
export async function setSalePrice(p: { source: string; customerId: number; productReference: string | null; description?: string | null; unitCost: number; salePrice: number; catalogueProductId?: number | null }): Promise<void> {
  await pool.query(
    `INSERT INTO service_pricing (source, customer_id, product_reference, description, unit_cost, sale_price, catalogue_product_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (source, customer_id, product_reference, unit_cost)
     DO UPDATE SET sale_price=EXCLUDED.sale_price, description=COALESCE(EXCLUDED.description, service_pricing.description),
                   catalogue_product_id=COALESCE(EXCLUDED.catalogue_product_id, service_pricing.catalogue_product_id), updated_at=NOW()`,
    [p.source, p.customerId, p.productReference ?? '', p.description ?? null, p.unitCost, p.salePrice, p.catalogueProductId ?? null]
  );
}
