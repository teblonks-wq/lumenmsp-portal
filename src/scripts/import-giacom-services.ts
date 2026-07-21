import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/pool';
import { importGiacomServicesCsv } from '../lib/giacom-comms-import';

// CLI wrapper around the shared Giacom services import (src/lib/giacom-comms-import.ts).
// The same core runs automatically when the daily DWS SFTP sync lands a new Services CSV —
// this script exists for manual/backfill runs.
//
// PER-PERIOD replace: only the month(s) present in the file (From Date = the period) are
// replaced, so importing an old file can never clobber another month. Re-import safe.
// Usage: node dist/scripts/import-giacom-services.js "<PKL..._Services.CSV>"

async function main(): Promise<void> {
  const file = process.argv[2] || path.join(process.cwd(), 'seed-data', 'giacom_services.csv');
  if (!fs.existsSync(file)) { console.error('Services CSV not found:', file, '\nUsage: import-giacom-services.js "<PKL..._Services.CSV>" (or bundle as seed-data/giacom_services.csv)'); process.exit(1); }
  console.log('Importing from:', file);
  const r = await importGiacomServicesCsv(fs.readFileSync(file));
  console.log(`✓ Giacom services import: ${r.inserted} lines (${r.matched} matched to a customer via CLI), ${r.productsCreated} new catalogue product(s). Period(s): ${r.periods.join(', ') || '(none)'}.`);
  if (r.skippedNoCli) console.log(`  ⚠ ${r.skippedNoCli} line(s) had no CLI and were skipped.`);
  if (r.refreshedProjections.length) console.log(`  → Re-projected from these actuals: ${r.refreshedProjections.join(', ')}.`);
  console.log('  → Next: Settings → QuickBooks → Items → "Create all unmatched" to push the new products to QB.');
  await pool.end();
}

main().catch((e) => { console.error('Giacom services import failed:', e); process.exit(1); });
