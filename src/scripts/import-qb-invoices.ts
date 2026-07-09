import 'dotenv/config';
import { QuickBooks } from '../lib/quickbooks';

// Back-fill invoices from QuickBooks into the portal. Upserts by invoice number, so
// it's safe to re-run. Pass an optional date window (transaction date) to target a gap:
//   node dist/scripts/import-qb-invoices.js 2025-08-01 2026-04-30
//   node dist/scripts/import-qb-invoices.js 2025-08-01            (from date → now)
//   node dist/scripts/import-qb-invoices.js                       (everything)

async function main(): Promise<void> {
  const since = process.argv[2];
  const until = process.argv[3];
  const qb = await QuickBooks.load();
  if (!qb.hasCredentials()) { console.error('QB_CLIENT_ID/SECRET not set in .env.'); process.exit(1); }
  if (!qb.isConnected()) { console.error('Not connected to QuickBooks — connect first in Settings → Integrations.'); process.exit(1); }

  console.log(`Importing QuickBooks invoices${since ? ' from ' + since : ''}${until ? ' to ' + until : ''}…`);
  const r = await qb.importInvoices({ since, until });
  console.log(`✓ Imported ${r.imported} invoices (${r.skipped} skipped).`);
  process.exit(0);
}

main().catch((e) => { console.error('QB invoice import failed:', e.message || e); process.exit(1); });
