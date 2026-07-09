import { pool } from '../db/pool';
import type { ItCloudLine } from './it-cloud-billing';

// IT & Cloud delta engine. Giacom service_items are wiped & re-inserted nightly, so we keep a
// change-ledger (it_cloud_service_state) of the last-known state per (customer, description, buy
// price). On each Giacom sync we diff current vs ledger to:
//   • ADD (new product, or qty up) → bill that qty a MONTH UPFRONT (in advance) — tracked in
//     upfront_pending_qty, billed once on the next invoice then cleared.
//   • REMOVAL (gone from Giacom) → set removed_at; KEEP billing it for a 30-day notice period
//     (pinned, since it's no longer in service_items), then purge. No credit.

const NOTICE_DAYS = 30;

// Record a detected change to the service history (best-effort — never breaks the sync).
async function logChange(customerId: number, description: string, changeType: string, oldQty: number | null, newQty: number | null): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO it_cloud_change_log (customer_id, description, change_type, old_qty, new_qty) VALUES ($1,$2,$3,$4,$5)',
      [customerId, description, changeType, oldQty, newQty]
    );
  } catch { /* table not migrated yet — ignore */ }
}

// Re-baseline the ledger from current Giacom state + record adds/removals. Run on each Giacom sync.
export async function syncItCloudDeltas(): Promise<{ adds: number; removals: number; purged: number }> {
  const cur = (await pool.query(
    `SELECT si.customer_id, si.description, si.unit_cost,
            SUM(si.quantity)::int AS qty, SUM(si.total_cost)::numeric AS cost, MAX(sp.sale_price) AS sale_price
       FROM service_items si
       LEFT JOIN service_pricing sp ON sp.source='giacom' AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.source='giacom' AND si.customer_id IS NOT NULL AND si.description IS NOT NULL
      GROUP BY si.customer_id, si.description, si.unit_cost`
  )).rows;

  // First-ever run = baseline the existing book WITHOUT upfronts (they're not new). Only genuine
  // adds AFTER the ledger exists get the advance month.
  const baseline = ((await pool.query('SELECT 1 FROM it_cloud_service_state LIMIT 1')).rowCount || 0) === 0;

  let adds = 0, removals = 0;
  const seen = new Set<string>();
  for (const r of cur) {
    const qty = Number(r.qty) || 0; if (qty <= 0) continue;
    const buy = Number(r.unit_cost) || 0;
    const saleEach = r.sale_price != null ? Number(r.sale_price) : (qty ? (Number(r.cost) || 0) / qty : 0);
    seen.add(`${r.customer_id}|${r.description}|${buy.toFixed(4)}`);
    const ex = (await pool.query(
      'SELECT id, qty, removed_at FROM it_cloud_service_state WHERE customer_id=$1 AND description=$2 AND unit_cost=$3',
      [r.customer_id, r.description, buy]
    )).rows[0];
    if (!ex) {
      // Brand new → the whole qty gets a month upfront — UNLESS this is the first baseline run.
      const upfront = baseline ? 0 : qty;
      await pool.query(
        `INSERT INTO it_cloud_service_state (customer_id, description, unit_cost, qty, sale_each, upfront_pending_qty)
         VALUES ($1,$2,$3,$4,$5,$6)`, [r.customer_id, r.description, buy, qty, saleEach, upfront]
      );
      if (!baseline) { adds++; await logChange(r.customer_id, r.description, 'added', null, qty); }
    } else {
      const prevQty = Number(ex.qty) || 0;
      const inc = Math.max(0, qty - prevQty); // only increases get an upfront; decreases handled as part-removals below
      if (inc > 0) adds++;
      if (!baseline && qty !== prevQty) await logChange(r.customer_id, r.description, qty > prevQty ? 'qty_up' : 'qty_down', prevQty, qty);
      await pool.query(
        `UPDATE it_cloud_service_state SET qty=$1, sale_each=$2,
            upfront_pending_qty = upfront_pending_qty + $3, removed_at = NULL, updated_at = NOW()
          WHERE id=$4`, [qty, saleEach, inc, ex.id]
      );
    }
  }

  // Anything active in the ledger but no longer in Giacom → start the 30-day notice clock.
  const active = (await pool.query('SELECT id, customer_id, description, unit_cost FROM it_cloud_service_state WHERE removed_at IS NULL')).rows;
  for (const a of active) {
    if (seen.has(`${a.customer_id}|${a.description}|${Number(a.unit_cost).toFixed(4)}`)) continue;
    await pool.query('UPDATE it_cloud_service_state SET removed_at=NOW(), updated_at=NOW() WHERE id=$1', [a.id]);
    if (!baseline) await logChange(a.customer_id, a.description, 'removed', null, null);
    removals++;
  }
  // Purge fully-expired removals (past the notice period).
  const purged = (await pool.query(
    `DELETE FROM it_cloud_service_state WHERE removed_at IS NOT NULL AND removed_at < NOW() - INTERVAL '${NOTICE_DAYS} days'`
  )).rowCount || 0;

  console.log(`[itcloud-deltas] ${adds} add(s), ${removals} removal(s) started notice, ${purged} purged`);
  return { adds, removals, purged };
}

// Extra IT&Cloud lines for a customer beyond the live Giacom pass-through:
//   • upfront (advance-month) charges for recently-added qty, and
//   • pinned removals still inside the 30-day notice window (kept billing though gone from Giacom).
export async function itCloudAdjustments(customerId: number): Promise<ItCloudLine[]> {
  const out: ItCloudLine[] = [];
  const rows = (await pool.query(
    'SELECT description, unit_cost, qty, sale_each, upfront_pending_qty, removed_at FROM it_cloud_service_state WHERE customer_id=$1',
    [customerId]
  )).rows;
  for (const r of rows) {
    const buy = Number(r.unit_cost) || 0; const saleEach = Number(r.sale_each) || 0;
    const upQ = Number(r.upfront_pending_qty) || 0;
    if (upQ > 0) {
      out.push({ kind: 'cloud', category: 'Advance (new this month)', ref: null, description: r.description + ' — month upfront', qty: upQ, cost: 0, unitCost: buy, sale: saleEach * upQ, salePriceEach: saleEach, source: 'giacom', priced: saleEach > 0 });
    }
    if (r.removed_at) {
      // Pinned: gone from Giacom but inside the 30-day notice → keep billing the qty.
      out.push({ kind: 'cloud', category: 'Cloud / Microsoft 365 (in notice period)', ref: null, description: r.description + ' — notice period', qty: Number(r.qty) || 1, cost: buy * (Number(r.qty) || 1), unitCost: buy, sale: saleEach * (Number(r.qty) || 1), salePriceEach: saleEach, source: 'giacom', priced: saleEach > 0 });
    }
  }
  return out;
}

// After billing, clear the upfront-pending so it's charged once.
export async function clearItCloudUpfronts(customerId: number): Promise<void> {
  await pool.query('UPDATE it_cloud_service_state SET upfront_pending_qty=0, updated_at=NOW() WHERE customer_id=$1 AND upfront_pending_qty>0', [customerId]);
}
