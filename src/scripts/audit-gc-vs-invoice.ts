import 'dotenv/config';
import { pool } from '../db/pool';
import { GoCardless } from '../lib/gocardless';

// Audit: compare every GoCardless-collected invoice's CURRENT total against the amount
// actually submitted to / collected by GoCardless for it. A mismatch means the invoice
// document changed after the money moved (June 2026: the QB import overwrote two Larkmead
// invoices' lines, collapsing their totals - the collected amounts were the truth).
// READ-ONLY - prints findings, changes nothing.
//
// Run on the server:  node dist/scripts/audit-gc-vs-invoice.js
// Optional args:      node dist/scripts/audit-gc-vs-invoice.js 2026-01-01   (issue_date from)

(async () => {
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) { console.error('GoCardless not configured.'); process.exit(1); }
  const since = process.argv[2] || null;

  const rows = (await pool.query(
    `SELECT i.id, i.invoice_number, i.title, i.total, i.status, i.gocardless_payment_id, c.name AS customer
       FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.gocardless_payment_id IS NOT NULL AND i.deleted_at IS NULL
        AND ($1::date IS NULL OR i.issue_date >= $1::date)
      ORDER BY i.id`, [since]
  )).rows;
  console.log(`Checking ${rows.length} GoCardless-linked invoice(s)...`);

  let ok = 0; const bad: any[] = [];
  for (const r of rows) {
    try {
      const p = await gc.getPayment(r.gocardless_payment_id);
      const collected = Number(p?.amount || 0) / 100;
      const total = Number(r.total);
      if (Math.abs(collected - total) > 0.005) {
        bad.push({ invoice: r.invoice_number, customer: r.customer, status: r.status, title: r.title,
          invoiceTotal: total.toFixed(2), collected: collected.toFixed(2), diff: (collected - total).toFixed(2),
          gcDescription: p?.description || '', gcStatus: p?.status || '' });
      } else ok++;
    } catch (e: any) {
      bad.push({ invoice: r.invoice_number, customer: r.customer, error: e.message.slice(0, 160) });
    }
    await new Promise(res => setTimeout(res, 150)); // gentle on the GC API
  }

  console.log(`\n${ok} of ${rows.length} match their collected amount.`);
  if (!bad.length) { console.log('No mismatches - every document matches the money.'); process.exit(0); }
  console.log(`\n${bad.length} MISMATCH/ERROR(S) - documents that do not match the money:`);
  for (const b of bad) console.log(JSON.stringify(b));
  process.exit(0);
})();
