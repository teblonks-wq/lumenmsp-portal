import 'dotenv/config';
import { Pool } from 'pg';

// Points every Comms (CS-scheme) invoice line at a single catalogue product, "Telecoms
// Services", so each line resolves to one QuickBooks item on push. The customer-facing line
// text (Broadband and Internet, Hosted Telephone System, Line Rentals, Additional Services,
// Call Charges …) is kept as the line description; only the QB item mapping is unified.
// Idempotent — safe to re-run.
//
// After running: Settings → QuickBooks → Items → map/create "Telecoms Services" to a QB item.

const PRODUCT = 'Telecoms Services';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  let product = (await pool.query("SELECT id FROM asset_products WHERE lower(name)=lower($1) ORDER BY id LIMIT 1", [PRODUCT])).rows[0];
  if (!product) {
    product = (await pool.query("INSERT INTO asset_products (name, item_type, is_active) VALUES ($1,'service',true) RETURNING id", [PRODUCT])).rows[0];
    console.log(`  + created catalogue product: ${PRODUCT} (#${product.id})`);
  }

  // Point ALL CS-scheme invoice lines at the Telecoms Services product (line descriptions are
  // left exactly as imported — Broadband, Hosted, Line Rentals, Additional Services, etc.).
  const r = await pool.query(
    `UPDATE invoice_items ii SET product_id=$1
       FROM invoices i
      WHERE ii.invoice_id=i.id AND i.invoice_scheme='CS'
        AND (ii.product_id IS DISTINCT FROM $1)`,
    [product.id]
  );

  console.log(`✓ Telecoms Services product #${product.id} — ${r.rowCount || 0} CS invoice line(s) updated.`);
  console.log('  → Next: Settings → QuickBooks → Items → map/create "Telecoms Services" to a QB item.');
  await pool.end();
}

main().catch((e) => { console.error('ensure-comms-catalogue failed:', e); process.exit(1); });
