import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Imports the Giacom ONE-OFF charges / hardware export — device purchases (Yealink W73P Addl £92,
// W73H £67…), install/cease fees, etc. These are NOT on the recurring Services export. Each line
// is a one-time charge (no service period), keyed on a CLI. Inserts as service_items with
// is_one_off=true so they: survive the recurring import wipe, bill ONCE in the bill run, then drop
// (billed_at). Re-running replaces only the UNBILLED imported one-offs (billed + manual preserved).
//
// Flexible columns — accepts the charges export or a supplier_comms-style file:
//   CLI/cli_ref · (matched_)customer · description · qty · unit_cost · total/line_cost · billing_date
// Usage: node dist/scripts/import-giacom-charges.js "<charges.csv>"  (or seed-data/giacom_charges.csv)

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };
const pick = (r: any, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); } return ''; };
const normCli = (v: any): string => String(v ?? '').replace(/\s+/g, '');
const toDate = (v: any): string | null => { const s = String(v || '').trim(); const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); return null; };

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const file = process.argv[2] || path.join(process.cwd(), 'seed-data', 'giacom_charges.csv');
  if (!fs.existsSync(file)) { console.error('Charges CSV not found:', file, '\nUsage: import-giacom-charges.js "<charges.csv>" (or bundle as seed-data/giacom_charges.csv)'); process.exit(1); }
  console.log('Importing one-off charges from:', file);
  const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // CLI → customer directory, plus a customer-name fallback.
  const dir = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='cli'")).rows.forEach((r: any) => dir.set(normCli(r.external_id), r.customer_id));
  const byName = new Map<string, number>();
  (await pool.query("SELECT id, lower(trim(name)) AS n FROM customers WHERE deleted_at IS NULL")).rows.forEach((r: any) => byName.set(r.n, r.id));

  const prod = new Map<string, number>();
  (await pool.query("SELECT id, lower(trim(name)) AS n FROM asset_products")).rows.forEach((r: any) => prod.set(r.n, r.id));

  const client = await pool.connect();
  let inserted = 0, matched = 0, productsCreated = 0; const skipped: string[] = [];
  try {
    await client.query('BEGIN');
    // Replace only the UNBILLED imported one-offs (keep billed history + hand-added manual ones).
    await client.query("DELETE FROM service_items WHERE source='comms' AND is_one_off=true AND COALESCE(is_manual,false)=false AND billed_at IS NULL");
    for (const r of recs) {
      const cli = normCli(pick(r, ['CLI', 'cli_ref', 'cli', 'CLI Ref', 'Billing ID']));
      const desc = pick(r, ['Description', 'description']) || '(unnamed charge)';
      if (!cli) { skipped.push(desc); continue; }
      const qty = num(pick(r, ['Quantity', 'qty'])) || 1;
      const unitCost = num(pick(r, ['Unit Cost', 'unit_cost']));
      const totalCost = num(pick(r, ['Total Cost', 'line_cost', 'total'])) || unitCost * qty;
      const vat = pick(r, ['VAT Status', 'vat_status']) || 'VAT 20%';
      const date = toDate(pick(r, ['billing_date', 'Charge Date', 'Date', 'From Date', 'service_from']));
      const period = date ? date.slice(0, 7) : null;
      // Resolve customer: CLI directory first, else matched-customer name.
      let cid = dir.get(cli) ?? null;
      if (!cid) { const nm = pick(r, ['matched_customer', 'customer', 'Customer']).toLowerCase().replace(/\s+/g, ' ').trim(); if (nm) cid = byName.get(nm) ?? null; }
      if (cid) matched++;

      const key = desc.toLowerCase().trim();
      if (!prod.has(key)) {
        const ins = await client.query("INSERT INTO asset_products (name, item_type, billing_frequency, vat_rate, is_active, source_tag) VALUES ($1,'product','one_off',20,true,'giacom-charge') RETURNING id", [desc]);
        prod.set(key, ins.rows[0].id); productsCreated++;
      }
      await client.query(
        `INSERT INTO service_items (source, customer_id, product_id, product_reference, description, quantity, unit_cost, total_cost,
            billing_date, billing_period, is_prorata, is_one_off, is_manual, vat_status, synced_at)
         VALUES ('comms',$1,$2,$3,$4,$5,$6,$7,$8,$9,false,true,false,$10,NOW())`,
        [cid, prod.get(key) ?? null, cli, desc, qty, unitCost, totalCost, date, period, vat]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  console.log(`✓ Giacom charges import: ${inserted} one-off charge(s) (${matched} matched to a customer), ${productsCreated} new product(s).`);
  if (skipped.length) console.log(`  ⚠ ${skipped.length} line(s) had no CLI and were skipped.`);
  console.log('  → They appear in the bill run as One-off Charges to price, bill once, then drop.');
  await pool.end();
}

main().catch((e) => { console.error('Giacom charges import failed:', e); process.exit(1); });
