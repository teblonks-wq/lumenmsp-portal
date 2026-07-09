import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Build the CLOUD PRODUCT LIST (asset_products, source_tag='giacom') from the live Giacom billing
// feed married to the reseller price list (seed-data/reseller-pricing.csv). Each distinct feed
// product (keyed by its stable Giacom product_id, e.g. 55-a) becomes a catalogue row:
//   code        = product_id            (the sync key)
//   cost_price  = feed unit_cost        (= reseller Price; pins the term/variant)
//   unit_price  = reseller RRP          (the standard sell; ~15% margin) — only set if not already set
// Products with no reseller match (e.g. Exclaimer — third-party) are created with sell=0 to fill.
//
//   DRY-RUN (default): prints the marry-up + proposed rows.
//   APPLY:  node dist/scripts/seed-cloud-products.js --apply

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const norm = (s: any): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = (d: string): string => d.replace(/\s*\(NCE.*?Term\)\s*/i, '').trim();

// Standard sell for non-reseller (third-party) products that aren't in the Microsoft price list.
// Keyed by normalised product name. Exclaimer sells at £1.10 regardless of package.
const MANUAL_SELL: Record<string, number> = {
  'exclaimer pro': 1.10,
  'exclaimer starter': 1.10,
};

(async () => {
  // Reseller list
  const csvPath = path.join(__dirname, '..', '..', 'seed-data', 'reseller-pricing.csv');
  const rows: any[] = parse(fs.readFileSync(csvPath), { columns: true, skip_empty_lines: true, relax_column_count: true });
  const reseller = rows.map((r) => ({
    name: String(r['Product Name'] || '').trim().replace(/^"+|"+$/g, ''),
    offer: r['Offer Id'], price: parseFloat(r['Price']), rrp: r['RRP'] ? parseFloat(r['RRP']) : null,
  })).filter((r) => !isNaN(r.price));

  // Distinct feed products
  const feed = (await pool.query(
    `SELECT product_id, MIN(description) AS description, unit_cost
       FROM service_items WHERE source='giacom' AND COALESCE(product_id,'')<>''
       GROUP BY product_id, unit_cost ORDER BY MIN(description)`
  )).rows;

  // Category
  let catId: number | null = null;
  if (APPLY) catId = (await pool.query(
    `INSERT INTO asset_categories (name, code) VALUES ('Cloud / Microsoft 365','GIACOM-CLOUD')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`
  )).rows[0].id;

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${feed.length} feed product(s) vs ${reseller.length} reseller row(s)\n`);
  let matched = 0, unmatched = 0, created = 0, updated = 0;
  for (const f of feed) {
    const cost = Number(f.unit_cost) || 0;
    const nm = cleanName(f.description);
    const cands = reseller.filter((r) => Math.abs(r.price - cost) < 0.005);
    const byName = cands.filter((r) => norm(nm).includes(norm(r.name)) || norm(r.name).includes(norm(nm)));
    const pick = byName[0] || null;
    let rrp = pick && pick.rrp ? pick.rrp : null;
    if (rrp == null && MANUAL_SELL[norm(nm)] != null) rrp = MANUAL_SELL[norm(nm)]; // third-party (e.g. Exclaimer £1.10)
    if (pick) matched++; else unmatched++;
    console.log(`[${f.product_id}] ${nm.slice(0, 44).padEnd(44)} cost £${cost.toFixed(2)}  -> ${rrp != null ? 'sell £' + rrp.toFixed(2) + (pick ? '  (' + pick.offer + ')' : '') : 'NO RESELLER MATCH — sell to fill'}`);
    if (!APPLY) continue;
    const ex = (await pool.query("SELECT id, unit_price FROM asset_products WHERE source_tag='giacom' AND lower(code)=lower($1) LIMIT 1", [f.product_id])).rows[0];
    if (ex) {
      // update cost + name; only set sell if it's still 0/unset (don't clobber a manual price)
      await pool.query(
        `UPDATE asset_products SET name=$1, cost_price=$2, is_active=true,
            unit_price = CASE WHEN COALESCE(unit_price,0)=0 AND $3::numeric IS NOT NULL THEN $3 ELSE unit_price END
          WHERE id=$4`, [f.description, cost, rrp, ex.id]);
      updated++;
    } else {
      await pool.query(
        `INSERT INTO asset_products (name, code, category_id, item_type, billing_frequency, unit_price, cost_price, supplier, source_tag, vat_rate, is_active)
         VALUES ($1,$2,$3,'service','monthly',$4,$5,'Giacom','giacom',20,true)`,
        [f.description, f.product_id, catId, rrp || 0, cost]);
      created++;
    }
  }
  console.log(`\nSummary: ${matched} matched to reseller, ${unmatched} unmatched (manual sell). ${APPLY ? `Created ${created}, updated ${updated}.` : 'Dry-run only — re-run with --apply.'}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
