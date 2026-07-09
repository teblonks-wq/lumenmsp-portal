import 'dotenv/config';
import { QuickBooks } from '../lib/quickbooks';

// Read-only check: pull every invoice from QuickBooks via the API and report which
// references aren't in the portal yet. No import, no changes. Optional date window:
//   node dist/scripts/validate-qb-invoices.js 2026-01-01 2026-06-30
//   node dist/scripts/validate-qb-invoices.js                      (all)

async function main(): Promise<void> {
  const since = process.argv[2];
  const until = process.argv[3];
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { console.error('Not connected to QuickBooks — connect in Settings → Integrations.'); process.exit(1); }

  const r = await qb.reconcileInvoices({ since, until });
  console.log(`\nQuickBooks invoices${since ? ' from ' + since : ''}${until ? ' to ' + until : ''}:`);
  console.log(`  in QuickBooks: ${r.qbTotal}`);
  console.log(`  in portal:     ${r.matched}`);
  console.log(`  MISSING:       ${r.missing.length}`);
  if (r.missing.length) {
    const total = r.missing.reduce((a, m) => a + m.amount, 0);
    console.log(`\n  Ref            Date         Amount      Customer`);
    for (const m of r.missing) {
      console.log(`  ${m.doc.padEnd(14)} ${(m.date || '').padEnd(11)} ${('£' + m.amount.toFixed(2)).padStart(10)}  ${m.customer}`);
    }
    console.log(`\n  Missing total: £${total.toFixed(2)}`);
    console.log(`  → run:  npm run import-qb-invoices ${since || ''} ${until || ''}`);
  } else {
    console.log('\n  ✓ Everything in QuickBooks is in the portal.');
  }
  process.exit(0);
}

main().catch((e) => { console.error('Reconcile failed:', e.message || e); process.exit(1); });
