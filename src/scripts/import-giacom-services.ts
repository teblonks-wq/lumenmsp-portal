import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { applyAllCustomerRanges } from '../lib/comms-billing';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Imports the real Giacom telephony/connectivity services export (PKL…_Services.CSV):
//   Site, CLI, From Date, To Date, Quantity, Unit Cost, Total Cost, Description, User, Department, VAT Status
// Every line is keyed on a CLI — the customer is resolved purely via the CLI directory
// (customer_external_ids 'cli'). Product name is Giacom's Description verbatim. Unit/Total Cost
// are the SUPPLIER cost; the sell lives in service_pricing. Supplier VAT flag is stored for
// reference (the customer is always billed 20% standard). A catalogue product is auto-created
// for each distinct Giacom product so QB → "Create all unmatched" can map them.
//
// Full snapshot: replaces all source='comms' rows (current state of what we're supplied).
// Usage: node dist/scripts/import-giacom-services.js "<PKL..._Services.CSV>"

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };
const pick = (r: any, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); } return ''; };
const toDate = (v: any): string | null => { const s = String(v || '').trim(); const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); return null; };
const normCli = (v: any): string => String(v ?? '').replace(/\s+/g, '');
// A line is "recurring" only if it spans a whole calendar month (1st → last day); anything
// part-period (mid-month start/end) is prorata = a one-off, not a recurring charge.
function periodInfo(from: string | null, to: string | null): { period: string | null; prorata: boolean } {
  if (!from) return { period: null, prorata: false };
  const period = from.slice(0, 7);
  const d = new Date(from + 'T00:00:00Z');
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const prorata = !(from === period + '-01' && to === lastDay);
  return { period, prorata };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const file = process.argv[2] || path.join(process.cwd(), 'seed-data', 'giacom_services.csv');
  if (!fs.existsSync(file)) { console.error('Services CSV not found:', file, '\nUsage: import-giacom-services.js "<PKL..._Services.CSV>" (or bundle as seed-data/giacom_services.csv)'); process.exit(1); }
  console.log('Importing from:', file);
  const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // CLI → customer directory.
  const dir = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='cli'")).rows
    .forEach((r: any) => dir.set(normCli(r.external_id), r.customer_id));

  // Existing catalogue products by lower(name) so we auto-create only what's new.
  const prod = new Map<string, number>();
  (await pool.query("SELECT id, lower(trim(name)) AS n FROM asset_products")).rows.forEach((r: any) => prod.set(r.n, r.id));

  const client = await pool.connect();
  let inserted = 0, matched = 0, productsCreated = 0; const noref: string[] = [];
  try {
    await client.query('BEGIN');
    // Full snapshot of RECURRING comms services — keep hand-added (is_manual) and one-off charges
    // (is_one_off, managed by the separate charges importer) so they aren't wiped each month.
    await client.query("DELETE FROM service_items WHERE source='comms' AND COALESCE(is_manual,false)=false AND COALESCE(is_one_off,false)=false");
    for (const r of recs) {
      const cli = normCli(pick(r, ['CLI']));
      const desc = pick(r, ['Description']) || '(unnamed)';
      if (!cli) { noref.push(desc); continue; } // every real line has a CLI; skip stragglers
      const site = pick(r, ['Site']);
      const qty = num(pick(r, ['Quantity'])) || 1;
      const unitCost = num(pick(r, ['Unit Cost']));
      const totalCost = num(pick(r, ['Total Cost']));
      const vat = pick(r, ['VAT Status']) || null;
      const from = toDate(pick(r, ['From Date']));
      const to = toDate(pick(r, ['To Date']));
      const { period, prorata } = periodInfo(from, to);
      // One-off vs monthly: a line with NO service period (no From date, or a single-day
      // From=To) is a one-time charge — a device PURCHASE, install/cease fee, etc. A line that
      // spans a service period is recurring. (Name-based ONEOFF_RE in comms-billing is a backstop.)
      const oneOff = !from || from === to;
      const cid = dir.get(cli) ?? null;
      if (cid) matched++;

      // Auto-create a catalogue product for this Giacom product name (sell VAT 20% standard).
      const key = desc.toLowerCase().trim();
      if (!prod.has(key)) {
        const ins = await client.query("INSERT INTO asset_products (name, item_type, billing_frequency, vat_rate, is_active, source_tag) VALUES ($1,'service','monthly',20,true,'giacom-comms') RETURNING id", [desc]);
        prod.set(key, ins.rows[0].id); productsCreated++;
      }

      await client.query(
        `INSERT INTO service_items (source, customer_id, external_customer_id, external_customer_name, product_id, product_reference, description, quantity, unit_cost, total_cost, billing_from, billing_to, billing_period, is_prorata, is_one_off, vat_status, synced_at)
         VALUES ('comms',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
        [cid, site || null, null, prod.get(key) ?? null, cli, desc, qty, unitCost, totalCost, from, to, period, prorata, oneOff, vat]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  console.log(`✓ Giacom services import: ${inserted} lines (${matched} matched to a customer via CLI), ${productsCreated} new catalogue product(s).`);
  if (noref.length) console.log(`  ⚠ ${noref.length} line(s) had no CLI and were skipped.`);
  // Auto-allocate any newly-imported CLIs that fall in a customer's stored number range.
  try { const a = await applyAllCustomerRanges(); console.log(`  → Range auto-allocate: ${a.lines} line(s), ${a.calls} call(s) across ${a.ranges} range(s).`); }
  catch (e) { console.error('  ⚠ range auto-allocate failed:', (e as Error).message); }
  console.log('  → Next: Settings → QuickBooks → Items → "Create all unmatched" to push the new products to QB.');
  await pool.end();
}

main().catch((e) => { console.error('Giacom services import failed:', e); process.exit(1); });
