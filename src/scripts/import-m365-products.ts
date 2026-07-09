import 'dotenv/config';
import { Pool } from 'pg';

// Imports Microsoft 365 Business licences into the catalogue as sellable products.
// These figures are RRP (sell), stored in unit_price; cost is set separately.
// One product per SKU/tier (annual paid-yearly / annual billed-monthly / monthly),
// so tiers can be swapped on recurring invoices and old SKUs retired (is_active=false).
// Idempotent — re-running updates by code. Usage: node dist/scripts/import-m365-products.js

// [name, code, billing_frequency, rrp]
type Row = [string, string, string, number];

const PRODUCTS: Row[] = [
  // Business Basic
  ['Microsoft 365 Business Basic — Annual (paid yearly)',   'M365-BB-ANNUAL', 'annual',  58.80],
  ['Microsoft 365 Business Basic — Annual (billed monthly)', 'M365-BB-ANNMTH', 'monthly',  5.15],
  ['Microsoft 365 Business Basic — Monthly',                 'M365-BB-MTH',    'monthly',  5.90],
  // Business Standard
  ['Microsoft 365 Business Standard — Annual (paid yearly)',   'M365-BS-ANNUAL', 'annual', 115.20],
  ['Microsoft 365 Business Standard — Annual (billed monthly)', 'M365-BS-ANNMTH', 'monthly', 10.10],
  ['Microsoft 365 Business Standard — Monthly',                 'M365-BS-MTH',    'monthly', 11.50],
  // Business Premium
  ['Microsoft 365 Business Premium — Annual (paid yearly)',   'M365-BP-ANNUAL', 'annual', 202.80],
  ['Microsoft 365 Business Premium — Annual (billed monthly)', 'M365-BP-ANNMTH', 'monthly', 17.75],
  ['Microsoft 365 Business Premium — Monthly',                 'M365-BP-MTH',    'monthly', 20.30],
  // Apps for Business (annual-yearly derived as monthly £8.20 × 12)
  ['Microsoft 365 Apps for Business — Annual (paid yearly)',   'M365-AB-ANNUAL', 'annual',  98.40],
  ['Microsoft 365 Apps for Business — Annual (billed monthly)', 'M365-AB-ANNMTH', 'monthly',  8.60],
  ['Microsoft 365 Apps for Business — Monthly',                 'M365-AB-MTH',    'monthly',  9.85],
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (check .env).'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const cat = await pool.query(
    `INSERT INTO asset_categories (code, name) VALUES ('M365','Microsoft 365 licences')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`
  );
  const categoryId = cat.rows[0].id;

  let created = 0, updated = 0;
  for (const [name, code, freq, rrp] of PRODUCTS) {
    const desc = 'Microsoft 365 Business · 300-seat cap · RRP';
    const ex = await pool.query("SELECT id FROM asset_products WHERE code=$1 AND source_tag='m365' LIMIT 1", [code]);
    if (ex.rows.length) {
      // Update name/price/freq but never clobber a cost the team has set.
      await pool.query(
        `UPDATE asset_products SET category_id=$1, name=$2, description=$3, item_type='service',
           billing_frequency=$4, unit_price=$5, vat_rate=20, is_active=true, updated_at=NOW() WHERE id=$6`,
        [categoryId, name, desc, freq, rrp, ex.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO asset_products (category_id, code, name, supplier, description, item_type, billing_frequency, unit_price, cost_price, vat_rate, source_tag, is_active)
         VALUES ($1,$2,$3,'Microsoft',$4,'service',$5,$6,0,20,'m365',true)`,
        [categoryId, code, name, desc, freq, rrp]
      );
      created++;
    }
  }

  console.log(`✓ M365 licence import: ${created} created, ${updated} updated (${PRODUCTS.length} SKUs).`);
  await pool.end();
}

main().catch((err) => { console.error('M365 import failed:', err); process.exit(1); });
