import { pool } from '../db/pool';

// ── The Customer Register — Phase 1 of the billing register rebuild ─────────────
// (design: 02 Projects/[C] Billing Register Rebuild - Design & Build Plan.md)
//
// One durable rate card per customer. Every line has a SOURCE ('comms-feed' |
// 'cloud-feed' | 'lumen') and a stable identity within it (source_key):
//   comms-feed : '<cli>|p<catalogue id>'  (or '<cli>|d:<normalised description>')
//   cloud-feed : lowercased Giacom product code
//   lumen      : 'L<row id>' — Lumen's own services; NO reconciler ever touches them.
// The feed imports stay exactly as they are. The reconcilers below run AFTER each
// import/sync and UPDATE the register: new key → added (amber/unpriced unless a price
// resolves), qty/cost/description change → updated + change row, key missing → CEASED
// (history kept — never deleted; cloud ceases carry a 30-day notice in
// cease_effective, clock = the sync-drop date per the signed-off design).
// Feeds NEVER touch sale_price on an existing line — pricing changes are human.
// Every mutation writes a register_changes row (the customer-facing Service History).
//
// Phase 1 is WRITE-ONLY bookkeeping: nothing reads the register for billing yet.
// The Phase 2 cutover (behind billing/register_enabled) renders bills from it.

const NOTICE_DAYS = 30; // cloud cease bills through this notice window

type Client = any;

export interface ReconcileResult { added: number; updated: number; ceased: number; reinstated: number; unchanged: number; }
const zero = (): ReconcileResult => ({ added: 0, updated: 0, ceased: 0, reinstated: 0, unchanged: 0 });

async function logChange(client: Client, a: { lineId: number | null; customerId: number; type: string; old?: any; next?: any; actor: string }): Promise<void> {
  await client.query(
    `INSERT INTO register_changes (register_line_id, customer_id, change_type, old, new, actor)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [a.lineId, a.customerId, a.type, a.old ? JSON.stringify(a.old) : null, a.next ? JSON.stringify(a.next) : null, a.actor]
  );
}

const near = (a: any, b: any) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;

interface FeedLine {
  customerId: number; key: string; description: string; qty: number; unitCost: number;
  salePrice: number | null; cli?: string | null; productId?: number | null; location?: string | null;
}

// Shared diff core. `feed` is the current truth for ONE source. An empty feed is a
// no-op by design — a failed import/sync must never cease the estate.
async function reconcileSource(source: 'comms-feed' | 'cloud-feed', feed: FeedLine[], actor: string, opts: { noticeDays?: number } = {}): Promise<ReconcileResult> {
  const res = zero();
  if (!feed.length) return res;

  const feedCustomers = Array.from(new Set(feed.map((f) => f.customerId)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      'SELECT * FROM customer_register_lines WHERE source=$1 AND customer_id = ANY($2)',
      [source, feedCustomers]
    )).rows;
    const byKey = new Map<string, any>();
    for (const r of existing) byKey.set(r.customer_id + '|' + r.source_key, r);

    const seen = new Set<string>();
    for (const f of feed) {
      const mapKey = f.customerId + '|' + f.key;
      seen.add(mapKey);
      const ex = byKey.get(mapKey);
      if (!ex) {
        const status = f.salePrice === null ? 'unpriced' : 'active';
        const ins = await client.query(
          `INSERT INTO customer_register_lines (customer_id, source, source_key, cli, product_id, description, location, qty, unit_cost, sale_price, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [f.customerId, source, f.key, f.cli || null, f.productId || null, f.description, f.location || null, f.qty, f.unitCost, f.salePrice, status]
        );
        await logChange(client, { lineId: ins.rows[0].id, customerId: f.customerId, type: 'added',
          next: { key: f.key, description: f.description, qty: f.qty, unitCost: f.unitCost, salePrice: f.salePrice, status }, actor });
        res.added++;
        continue;
      }
      let changed = false;
      if (ex.status === 'ceased') {
        await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'reinstated', old: { ceasedAt: ex.ceased_at }, next: { qty: f.qty }, actor });
        res.reinstated++; changed = true;
      }
      if (!near(ex.qty, f.qty)) { await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'qty', old: { qty: Number(ex.qty) }, next: { qty: f.qty }, actor }); changed = true; }
      if (!near(ex.unit_cost, f.unitCost)) { await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'cost', old: { unitCost: Number(ex.unit_cost) }, next: { unitCost: f.unitCost }, actor }); changed = true; }
      if (String(ex.description) !== f.description) { await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'desc', old: { description: ex.description }, next: { description: f.description }, actor }); changed = true; }
      if (changed) {
        // Feeds never overwrite a human-set price; an unpriced line may pick one up.
        await client.query(
          `UPDATE customer_register_lines SET qty=$1, unit_cost=$2, description=$3,
             sale_price = COALESCE(sale_price, $4),
             status = CASE WHEN COALESCE(sale_price, $4) IS NULL THEN 'unpriced' ELSE 'active' END,
             ceased_at=NULL, cease_effective=NULL, last_seen=NOW(), updated_at=NOW()
           WHERE id=$5`,
          [f.qty, f.unitCost, f.description, f.salePrice, ex.id]
        );
        res.updated++;
      } else {
        await client.query('UPDATE customer_register_lines SET last_seen=NOW() WHERE id=$1', [ex.id]);
        res.unchanged++;
      }
    }

    // Keys that vanished from the feed → ceased (history kept; never deleted).
    for (const r of existing) {
      if (seen.has(r.customer_id + '|' + r.source_key) || r.status === 'ceased') continue;
      const notice = opts.noticeDays || 0;
      await client.query(
        `UPDATE customer_register_lines SET status='ceased', ceased_at=NOW(),
           cease_effective = NOW() + ($1 || ' days')::interval, updated_at=NOW() WHERE id=$2`,
        [String(notice), r.id]
      );
      await logChange(client, { lineId: r.id, customerId: r.customer_id, type: 'ceased',
        old: { qty: Number(r.qty), salePrice: r.sale_price === null ? null : Number(r.sale_price) },
        next: { noticeDays: notice }, actor });
      res.ceased++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return res;
}

// ── comms-feed reconcile — run after the monthly PKL import ─────────────────────
// The file's newest month's recurring, allocated, non-manual lines are the truth.
export async function reconcileCommsRegister(periods: string[], actor = 'comms-import'): Promise<ReconcileResult> {
  const period = [...periods].sort().pop();
  if (!period) return zero();
  const rows = (await pool.query(
    `SELECT si.customer_id, si.product_reference AS cli, si.product_id, si.description,
            SUM(si.quantity)::numeric AS qty, MAX(si.unit_cost)::numeric AS unit_cost,
            MAX(si.external_customer_id) AS site, MAX(sp.sale_price)::numeric AS sale_price
       FROM service_items si
       LEFT JOIN service_pricing sp
              ON sp.source='comms' AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.billing_period=$1
        AND COALESCE(si.is_prorata,false)=false AND COALESCE(si.is_one_off,false)=false
        AND COALESCE(si.is_manual,false)=false AND COALESCE(si.is_projected,false)=false
      GROUP BY si.customer_id, si.product_reference, si.product_id, si.description`,
    [period]
  )).rows;
  const feed: FeedLine[] = rows.map((r: any) => ({
    customerId: r.customer_id,
    key: String(r.cli || '') + '|' + (r.product_id ? 'p' + r.product_id : 'd:' + String(r.description || '').toLowerCase().trim()),
    cli: r.cli || null,
    productId: r.product_id && /^\d+$/.test(String(r.product_id)) ? parseInt(String(r.product_id), 10) : null,
    description: String(r.description || '(unnamed)'),
    qty: Number(r.qty) || 1,
    unitCost: Number(r.unit_cost) || 0,
    salePrice: r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price),
    location: r.site || null,
  }));
  return reconcileSource('comms-feed', feed, actor);
}

// ── cloud-feed reconcile — run after the nightly Giacom sync ────────────────────
// The freshly-synced full state is the truth; a missing code starts the 30-day notice.
export async function reconcileCloudRegister(actor = 'cloud-sync'): Promise<ReconcileResult> {
  const rows = (await pool.query(
    `SELECT si.customer_id, lower(COALESCE(si.product_id::text,'')) AS code, MAX(si.description) AS description,
            SUM(si.quantity)::numeric AS qty, MAX(si.unit_cost)::numeric AS unit_cost, SUM(si.total_cost)::numeric AS total_cost,
            MAX(sp.sale_price)::numeric AS override, MAX(ap.unit_price)::numeric AS global_price
       FROM service_items si
       LEFT JOIN service_pricing sp ON sp.source='giacom' AND sp.customer_id=si.customer_id AND sp.product_reference=si.product_id::text
       LEFT JOIN asset_products ap ON ap.source_tag='giacom' AND lower(ap.code)=lower(si.product_id::text) AND ap.unit_price > 0
      WHERE si.source='giacom' AND si.customer_id IS NOT NULL AND COALESCE(si.product_id::text,'') <> ''
      GROUP BY si.customer_id, lower(COALESCE(si.product_id::text,''))`
  )).rows;
  const feed: FeedLine[] = rows.map((r: any) => {
    const qty = Number(r.qty) || 0;
    const unit = Number(r.unit_cost) || 0;
    const unitCost = unit > 0 ? unit : (qty > 0 ? (Number(r.total_cost) || 0) / qty : 0);
    const sale = r.override !== null && r.override !== undefined ? Number(r.override)
      : (r.global_price !== null && r.global_price !== undefined && Number(r.global_price) > 0 ? Number(r.global_price) : null);
    return { customerId: r.customer_id, key: String(r.code), description: String(r.description || '(unnamed)'),
      qty, unitCost: Math.round(unitCost * 10000) / 10000, salePrice: sale };
  }).filter((f) => f.qty > 0);
  return reconcileSource('cloud-feed', feed, actor, { noticeDays: NOTICE_DAYS });
}

// ── Read helpers for the Phase 1 view ───────────────────────────────────────────
export async function registerLines(customerId?: number | null): Promise<any[]> {
  return (await pool.query(
    `SELECT r.*, c.name AS customer_name FROM customer_register_lines r JOIN customers c ON c.id=r.customer_id
      WHERE ($1::int IS NULL OR r.customer_id=$1)
      ORDER BY c.name, r.source, r.status, r.description LIMIT 2000`, [customerId || null])).rows;
}

export async function registerRecentChanges(customerId?: number | null, limit = 120): Promise<any[]> {
  return (await pool.query(
    `SELECT g.*, c.name AS customer_name, r.description AS line_description
       FROM register_changes g JOIN customers c ON c.id=g.customer_id
       LEFT JOIN customer_register_lines r ON r.id=g.register_line_id
      WHERE ($1::int IS NULL OR g.customer_id=$1) ORDER BY g.created_at DESC LIMIT $2`, [customerId || null, limit])).rows;
}
