import 'dotenv/config';
import { Pool } from 'pg';

// Clears the comms slate before re-importing fresh from the Giacom services feed:
//   • deletes all comms service lines (the old 'lumen' artefacts + any 'comms')
//   • deletes all comms durable sale prices (re-price from scratch)
// Catalogue products are intentionally NOT deleted (posted invoices reference some, e.g.
// "Telecoms Services") — instead the old custom comms products are DEACTIVATED only when
// nothing references them, so they drop out of pickers without orphaning history.
// Run BEFORE import-giacom-services. Usage: node dist/scripts/reset-comms.js [--deactivate-products]

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const deactivate = process.argv.includes('--deactivate-products');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const items = await pool.query("DELETE FROM service_items WHERE source IN ('lumen','comms')");
  const prices = await pool.query("DELETE FROM service_pricing WHERE source IN ('lumen','comms')");

  let deactivated = 0;
  if (deactivate) {
    // Only deactivate old custom comms products (source_tag 'lumen') that NO invoice references,
    // so the posted CS invoices keep their product links intact.
    const r = await pool.query(
      `UPDATE asset_products SET is_active=false, updated_at=NOW()
        WHERE source_tag='lumen' AND is_active=true
          AND id NOT IN (SELECT product_id FROM invoice_items WHERE product_id IS NOT NULL)`
    );
    deactivated = r.rowCount || 0;
  }

  console.log(`✓ Comms reset: ${items.rowCount} service line(s) and ${prices.rowCount} sale price(s) cleared.`);
  if (deactivate) console.log(`  ${deactivated} unused old comms product(s) deactivated.`);
  console.log('  → Next: node dist/scripts/import-giacom-services.js "<PKL..._Services.CSV>"');
  await pool.end();
}

main().catch((e) => { console.error('reset-comms failed:', e); process.exit(1); });
