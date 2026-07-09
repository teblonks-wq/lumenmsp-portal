import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Allocate comms CLIs to customers from a NUMBER-RANGE sheet (columns: from, to, customer, location).
// Every comms service_item whose CLI digits fall in [from,to] is allocated to the matched customer
// (CLI directory + service line + call records), and the location stamped. Revo/RevoIT → the
// Lumen/LITS customer (our own). Reports ranges that matched no CLIs and customer names not found.
// Usage: node dist/scripts/seed-cli-ranges.js "<ranges.csv>"  (defaults to seed-data/cli_ranges.csv)

const digits = (v: any): string => String(v ?? '').replace(/[^0-9]/g, '');

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const file = process.argv[2] || path.join(process.cwd(), 'seed-data', 'cli_ranges.csv');
  if (!fs.existsSync(file)) { console.error('Ranges CSV not found:', file); process.exit(1); }
  console.log('Seeding CLI ranges from:', file);
  const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Normalised key: lowercase, drop company suffixes + all non-alphanumerics, so "TLC Installations"
  // == "TLCInstallations" and "Larkmead Veterinary Group" == "...Group Limited".
  const normKey = (s: string): string => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|llp|llc|uk|the)\b/g, '').replace(/[^a-z0-9]/g, '');
  const byKey = new Map<string, number>();
  for (const c of (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL")).rows) {
    const k = normKey(c.name); if (k && !byKey.has(k)) byKey.set(k, c.id);
  }
  const litsId = byKey.get(normKey('Lumen IT Solutions')) ?? byKey.get('lits') ?? null;
  const resolveCust = (name: string): number | null => {
    const n = (name || '').toLowerCase().trim();
    if (!n) return null;
    if (/^revo/.test(n) || /revo\s*it/.test(n)) return litsId;
    return byKey.get(normKey(name)) ?? null;
  };

  let totalClis = 0, totalRanges = 0, callsClaimed = 0;
  const unknownCust = new Set<string>();
  const emptyRanges: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of recs) {
      const from = digits(r.from ?? r.From); const to = digits(r.to ?? r.To);
      const custName = (r.customer ?? r.Customer ?? '').toString().trim();
      const location = (r.location ?? r.Location ?? '').toString().trim() || null;
      if (!from || !to || !custName) continue;
      totalRanges++;
      const cid = resolveCust(custName);
      if (!cid) { unknownCust.add(custName); continue; }
      const lo = from <= to ? from : to; const hi = from <= to ? to : from;
      // Persist the range on the customer (idempotent) so it shows on their page + auto-allocates future numbers.
      const exists = (await client.query('SELECT 1 FROM customer_number_ranges WHERE customer_id=$1 AND range_from=$2 AND range_to=$3 LIMIT 1', [cid, lo, hi])).rowCount;
      if (!exists) await client.query('INSERT INTO customer_number_ranges (customer_id, range_from, range_to, location) VALUES ($1,$2,$3,$4)', [cid, lo, hi, location]);
      // Claim ALL call traffic in this numeric range to the customer — covers per-DDI numbers
      // that make calls but have no individual billing line (billing sits on the main number/
      // trunk). This attributes (and so bills) their calls and clears them from "active, no bill".
      try {
        const cr = await client.query(
          `UPDATE call_records SET customer_id=$1
            WHERE cli IS NOT NULL AND regexp_replace(cli,'[^0-9]','','g') <> ''
              AND length(regexp_replace(cli,'[^0-9]','','g')) <= 15
              AND regexp_replace(cli,'[^0-9]','','g')::bigint BETWEEN $2::bigint AND $3::bigint`,
          [cid, lo, hi]
        );
        callsClaimed += cr.rowCount || 0;
      } catch { /* call_records not present */ }
      const clis = (await client.query(
        `SELECT DISTINCT product_reference AS cli FROM service_items
          WHERE source='comms' AND product_reference IS NOT NULL
            AND regexp_replace(product_reference,'[^0-9]','','g') <> ''
            AND length(regexp_replace(product_reference,'[^0-9]','','g')) <= 15
            AND regexp_replace(product_reference,'[^0-9]','','g')::bigint BETWEEN $1::bigint AND $2::bigint`,
        [lo, hi]
      )).rows.map((x: any) => String(x.cli));
      if (!clis.length) { emptyRanges.push(`${from}-${to} (${custName})`); continue; }
      for (const cliRaw of clis) {
        const cli = cliRaw.replace(/\s+/g, '');
        await client.query(
          `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
           ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [cid, cli]
        );
        await client.query("UPDATE service_items SET customer_id=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2", [cid, cli]);
        if (location) await client.query("UPDATE service_items SET location=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2 AND (location IS NULL OR location='')", [location, cli]);
        try { await client.query("UPDATE call_records SET customer_id=$1 WHERE replace(cli,' ','')=$2", [cid, cli]); } catch { /* ignore */ }
        totalClis++;
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  console.log(`✓ ${totalClis} CLI(s) allocated across ${totalRanges} range(s); ${callsClaimed} call record(s) attributed by range.`);
  if (!litsId) console.log('  ⚠ No LITS/Lumen customer found — Revo ranges were skipped. Create a "Lumen IT Solutions" customer and re-run.');
  if (unknownCust.size) { console.log(`  ⚠ ${unknownCust.size} customer name(s) not found (ranges skipped) — create these then re-run:`); Array.from(unknownCust).forEach((u) => console.log('    -', u)); }
  if (emptyRanges.length) { console.log(`  ℹ ${emptyRanges.length} range(s) matched no imported comms CLIs (nothing billing in that range yet):`); emptyRanges.slice(0, 20).forEach((u) => console.log('    -', u)); }
  await pool.end();
}

main().catch((e) => { console.error('seed-cli-ranges failed:', e); process.exit(1); });
