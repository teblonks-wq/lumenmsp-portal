import 'dotenv/config';
import { Pool } from 'pg';

// Seeds the standard packages + their Giacom core products. Idempotent (matched by name).
// A package = friendly invoice name + its Giacom core products + a set price. Cost comes from
// the live matched lines (tier floats). Recording / Feature Pack are NOT packages (no Giacom
// core product) — they stay as standalone add-ons.
//
// `pattern` is an optional family regex so a package still catches FUTURE tier SKUs that Giacom
// auto-bumps to (e.g. EE30ES2 → EE30ES4 → …ESU) without re-listing every SKU.

const PACKAGES: Array<{ name: string; category: string; price: number; term: string | null; sort: number; pattern: string | null; products: string[] }> = [
  { name: 'Simply VoIP Seat', category: 'voice', price: 16.50, term: '3y', sort: 10, pattern: 'hv select',
    products: ['HV Select User License', 'HV Select User License 36mths'] },
  { name: 'Simply Mobile — Unlimited (EE) 12m', category: 'mobile', price: 0, term: '12m', sort: 40, pattern: 'EE30',
    products: ['EE30ES2-Everyway Standard 2GB', 'EEEO-Data Optimiser'] },
  { name: 'Simply Mobile — Unlimited (EE) 24m', category: 'mobile', price: 0, term: '24m', sort: 41, pattern: 'EE24',
    products: ['EE24ES2-Everyway Standard 24 Month 2GB', 'EEEO-Data Optimiser'] },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // Recording / Feature Pack are not packages — remove if a prior seed created them.
  await pool.query("DELETE FROM packages WHERE lower(name) IN ('call recording','feature pack')");
  let made = 0, updated = 0;
  for (const p of PACKAGES) {
    let id = (await pool.query('SELECT id FROM packages WHERE lower(name)=lower($1) LIMIT 1', [p.name])).rows[0]?.id;
    if (id) {
      await pool.query('UPDATE packages SET category=$1, kind=$2, match_pattern=$3, term_label=$4, sort_order=$5, requires_seat=false, updated_at=NOW() WHERE id=$6',
        [p.category, 'per_cli', p.pattern, p.term, p.sort, id]); // leave price alone if already set
      updated++;
    } else {
      id = (await pool.query('INSERT INTO packages (name, category, kind, match_pattern, requires_seat, standard_price, term_label, sort_order, is_active) VALUES ($1,$2,$3,$4,false,$5,$6,$7,true) RETURNING id',
        [p.name, p.category, 'per_cli', p.pattern, p.price, p.term, p.sort])).rows[0].id;
      made++;
    }
    for (const prod of p.products) {
      await pool.query('INSERT INTO package_products (package_id, product_name) VALUES ($1,$2) ON CONFLICT (package_id, product_name) DO NOTHING', [id, prod]);
    }
  }
  console.log(`✓ Packages seeded: ${made} created, ${updated} updated (+ core products). Set the Simply Mobile prices in Admin → Package Manager.`);
  await pool.end();
}

main().catch((e) => { console.error('seed-packages failed:', e); process.exit(1); });
