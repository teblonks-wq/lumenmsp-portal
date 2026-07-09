import 'dotenv/config';
import { Pool } from 'pg';

// Seed the PRODUCT CATALOGUE (asset_products) with every distinct Giacom service so they appear in
// the product list with a fillable global sell price + their cost. Keyed by code=product_reference.
// Cost = the feed's per-seat cost, else derived from the line total. Sell (unit_price) left at 0 to
// fill in. Idempotent: re-run updates name/cost, never overwrites a sell price you've set.
//
//   DRY-RUN (default): prints what it would create/update.
//   APPLY:  node dist/scripts/seed-giacom-catalogue.js --apply

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

(async () => {
  // Distinct Giacom products across all customers, with a representative cost.
  const rows = (await pool.query(
    `SELECT COALESCE(product_reference,'') AS code,
            MIN(description) AS name,
            MAX(CASE WHEN unit_cost>0 THEN unit_cost
                     WHEN quantity>0 THEN total_cost/quantity ELSE 0 END)::numeric(12,4) AS cost
       FROM service_items
      WHERE source='giacom' AND COALESCE(product_reference,'')<>''
      GROUP BY product_reference
      ORDER BY MIN(description)`
  )).rows;

  // Category for cloud products.
  let catId: number | null = null;
  if (APPLY) {
    catId = (await pool.query(
      `INSERT INTO asset_categories (name, code) VALUES ('Cloud / Microsoft 365','GIACOM-CLOUD')
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`
    )).rows[0].id;
  }

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${rows.length} distinct Giacom product(s)\n`);
  let created = 0, updated = 0;
  for (const r of rows) {
    const cost = Number(r.cost) || 0;
    const existing = (await pool.query("SELECT id, unit_price FROM asset_products WHERE source_tag='giacom' AND lower(code)=lower($1) LIMIT 1", [r.code])).rows[0];
    console.log(`${existing ? 'update' : 'create'}  [${r.code}]  cost £${cost.toFixed(2)}  ${String(r.name).slice(0, 60)}${existing ? `  (sell £${Number(existing.unit_price).toFixed(2)} kept)` : '  (sell to fill)'}`);
    if (!APPLY) continue;
    if (existing) {
      await pool.query('UPDATE asset_products SET name=$1, cost_price=$2, is_active=true WHERE id=$3', [r.name, cost, existing.id]);
      updated++;
    } else {
      await pool.query(
        `INSERT INTO asset_products (name, code, category_id, item_type, billing_frequency, unit_price, cost_price, supplier, source_tag, vat_rate, is_active)
         VALUES ($1,$2,$3,'service','monthly',0,$4,'Giacom','giacom',20,true)`,
        [r.name, r.code, catId, cost]
      );
      created++;
    }
  }
  console.log(`\nSummary: ${rows.length} product(s). ${APPLY ? `Created ${created}, updated ${updated}.` : 'Dry-run only — re-run with --apply.'}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
