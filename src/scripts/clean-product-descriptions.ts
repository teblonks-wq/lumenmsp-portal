import 'dotenv/config';
import { Pool } from 'pg';

// Removes the supplier reference (notably "Giacom") from catalogue product descriptions so
// nothing customer-facing names the wholesaler. By default it strips the trailing
// "· Giacom (…)" / "· <supplier>" note and keeps the useful detail (speed/term). Pass
// --mirror to make the description exactly equal the product name instead.
// Usage: node dist/scripts/clean-product-descriptions.js [--mirror]

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const mirror = process.argv.includes('--mirror');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  if (mirror) {
    const r = await pool.query(
      "UPDATE asset_products SET description = name, updated_at=NOW() WHERE description IS NOT NULL AND lower(description) LIKE '%giacom%'"
    );
    console.log(`✓ ${r.rowCount} description(s) set to mirror the product name.`);
  } else {
    // Strip a trailing " · Giacom (…)" or " · <supplier>" segment, and any stray "Giacom" word.
    const r = await pool.query(
      `UPDATE asset_products
          SET description = NULLIF(trim(regexp_replace(
                regexp_replace(description, '\\s*[·\\-]\\s*Giacom\\s*\\([^)]*\\)\\s*$', '', 'i'),
                '\\s*Giacom\\s*', ' ', 'gi')), ''),
              updated_at = NOW()
        WHERE lower(description) LIKE '%giacom%'`
    );
    console.log(`✓ ${r.rowCount} description(s) cleaned of supplier/Giacom text.`);
  }
  await pool.end();
}

main().catch((e) => { console.error('clean-product-descriptions failed:', e); process.exit(1); });
