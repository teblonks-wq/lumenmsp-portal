import 'dotenv/config';
import { Pool } from 'pg';

// Wipes the CLI directory for a clean re-map: deletes all CLI→customer mappings and clears
// the customer allocation on comms service lines + call records (they'll be re-resolved by
// seed-cli-directory). The Giacom feed and prices are untouched. Run BEFORE seed-cli-directory.

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = await pool.query("DELETE FROM customer_external_ids WHERE source_system='cli'");
  const svc = await pool.query("UPDATE service_items SET customer_id=NULL WHERE source='comms' AND customer_id IS NOT NULL");
  let calls = { rowCount: 0 } as any;
  try { calls = await pool.query("UPDATE call_records SET customer_id=NULL WHERE customer_id IS NOT NULL"); } catch { /* call_records may not exist */ }
  console.log(`✓ CLI directory reset: ${dir.rowCount} mapping(s) removed, ${svc.rowCount} comms line(s) and ${calls.rowCount} call(s) de-allocated.`);
  console.log('  → Next: node dist/scripts/seed-cli-directory.js "<reviewed CLI->Customer CSV>"');
  await pool.end();
}

main().catch((e) => { console.error('reset-cli-directory failed:', e); process.exit(1); });
