import 'dotenv/config';
import { GiacomBilling, giacomBillingConfigured } from '../lib/giacom';

// Pull the line-level service report for a Giacom invoice from the Billing API (the PDF doesn't
// itemise it). Dumps the structure + matching rows so we can see how Giacom bills each service
// (advance vs arrears, part-month proration, dates).
//   Usage:  npm run giacom-invoice -- INV00144186

const arg = (process.argv.find((a) => /^INV/i.test(a)) || process.argv[2] || '').trim();

function rowsOf(r: any): any[] {
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.data)) return r.data;
  if (r && Array.isArray(r.items)) return r.items;
  if (r && Array.isArray(r.results)) return r.results;
  return [];
}

(async () => {
  if (!(await giacomBillingConfigured())) { console.error('Giacom Billing API not configured.'); process.exit(1); }
  console.log(`Looking up Giacom service report for: ${arg || '(no invoice given — dumping recent export)'}\n`);

  // Try the Invoice Export and BillingList endpoints with a few likely filters; dump whatever returns.
  const attempts: Array<{ name: string; call: () => Promise<any> }> = [
    { name: 'invoiceExport{invoiceNumber}', call: () => GiacomBilling.invoiceExport({ invoiceNumber: arg }) },
    { name: 'invoiceExport{InvoiceNumber}', call: () => GiacomBilling.invoiceExport({ InvoiceNumber: arg }) },
    { name: 'invoiceExport{invoice}', call: () => GiacomBilling.invoiceExport({ invoice: arg }) },
    { name: 'invoiceExport{}', call: () => GiacomBilling.invoiceExport({}) },
    { name: 'billingList{invoiceNumber}', call: () => GiacomBilling.billingList({ invoiceNumber: arg }) },
    { name: 'billingList{}', call: () => GiacomBilling.billingList({}) },
  ];

  for (const a of attempts) {
    try {
      const r = await a.call();
      if (typeof r === 'string') { console.log(`\n=== ${a.name} → text/CSV (${r.length} chars) ===`); console.log(r.slice(0, 4000)); break; }
      const rows = rowsOf(r);
      console.log(`\n=== ${a.name} → ${rows.length} row(s) ===`);
      if (!rows.length) { if (r && !Array.isArray(r)) console.dir(r, { depth: 2 }); continue; }
      console.log('columns:', Object.keys(rows[0]).join(', '));
      const match = arg ? rows.filter((x) => JSON.stringify(x).toUpperCase().includes(arg.toUpperCase())) : rows;
      console.log(`${match.length} row(s) matching ${arg || '(all)'} — showing up to 30:`);
      console.dir((match.length ? match : rows).slice(0, 30), { depth: null });
      break;
    } catch (e: any) { console.log(`\n--- ${a.name} failed: ${e.message}`); }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
