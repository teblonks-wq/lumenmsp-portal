import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Seeds the CLI directory from your reviewed CLI→Customer sheet (columns: CLI, Customer),
// then re-resolves the comms service lines and call records by CLI. RevoIT/REVO lines are
// Lumen's own → attached to the LITS customer automatically.
// Usage: node dist/scripts/seed-cli-directory.js "<reviewed.csv>"

const normCli = (v: any): string => String(v ?? '').replace(/\s+/g, '');

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const file = process.argv[2] || path.join(process.cwd(), 'seed-data', 'cli_allocation.csv');
  if (!fs.existsSync(file)) { console.error('CLI allocation CSV not found:', file, '\nUsage: seed-cli-directory.js "<CLI->Customer CSV>" (or bundle as seed-data/cli_allocation.csv)'); process.exit(1); }
  console.log('Seeding CLI directory from:', file);
  const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Customer name → id. RevoIT/REVO resolves to the LITS customer (Lumen's own account).
  const byName = new Map<string, number>();
  for (const c of (await pool.query("SELECT id, lower(trim(name)) AS n FROM customers WHERE deleted_at IS NULL")).rows) byName.set(c.n, c.id);
  const litsId = byName.get('lits') ?? byName.get('lumen it solutions') ?? byName.get('lumen it solutions ltd') ?? byName.get('lumen it solutions limited') ?? null;
  const resolveCust = (name: string): number | null => {
    const n = (name || '').toLowerCase().trim().replace(/\s+/g, ' '); // collapse double spaces
    if (!n) return null;
    if (/^revo/.test(n) || /revo\s*it/.test(n)) return litsId;
    return byName.get(n) ?? byName.get(n.replace(/\s+/g, ' ')) ?? null;
  };

  // Build CLI → customer (dedupe; warn on conflicting customer for the same CLI).
  const cli2cust = new Map<string, number>(); const conflicts: string[] = []; const unknownCust = new Set<string>();
  for (const r of recs) {
    const cli = normCli(r.CLI ?? r.cli ?? r.cli_ref ?? '');
    const custName = (r.Customer ?? r.customer ?? r.matched_customer ?? '').toString().trim();
    if (!cli || !custName) continue;
    const cid = resolveCust(custName);
    if (!cid) { unknownCust.add(custName); continue; }
    if (cli2cust.has(cli) && cli2cust.get(cli) !== cid) conflicts.push(cli);
    cli2cust.set(cli, cid);
  }

  // Upsert the directory + re-resolve service_items and call_records.
  let dir = 0, svc = 0, calls = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [cli, cid] of cli2cust) {
      await client.query(
        `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
         ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [cid, cli]
      );
      dir++;
      const s = await client.query("UPDATE service_items SET customer_id=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2", [cid, cli]);
      svc += s.rowCount || 0;
      try { const c = await client.query("UPDATE call_records SET customer_id=$1 WHERE replace(cli,' ','')=$2", [cid, cli]); calls += c.rowCount || 0; } catch { /* ignore */ }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  console.log(`✓ CLI directory seeded: ${dir} CLI(s) mapped → ${svc} comms line(s) and ${calls} call(s) allocated.`);
  if (!litsId) console.log('  ⚠ No LITS/Lumen customer found — RevoIT lines were left unmapped. Create a "LITS" customer and re-run.');
  if (conflicts.length) console.log(`  ⚠ ${conflicts.length} CLI(s) had conflicting customers in the sheet (last one won): ${conflicts.slice(0, 8).join(', ')}`);
  if (unknownCust.size) { console.log(`  ⚠ ${unknownCust.size} customer name(s) not found (CLIs skipped):`); Array.from(unknownCust).slice(0, 15).forEach((u) => console.log('    -', u)); }
  await pool.end();
}

main().catch((e) => { console.error('seed-cli-directory failed:', e); process.exit(1); });
