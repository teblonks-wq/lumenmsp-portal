import 'dotenv/config';
import { Pool } from 'pg';

// One-off import of the May 2026 Inform telecoms invoices. Figures, due dates and the
// invoice set come from the authoritative accounts export (InvoiceHistory…AccountsExport.csv);
// the line split comes from the invoice PDFs, mapped to the new category headings
// (Broadband and Internet / Hosted Telephone System / Line Rentals / Additional Services).
// Lines reconcile exactly to the export net. Keeps the original CS-xxx numbers; invoice
// date AND due date forced to 01/06/2026 (all collected on the 1st — overrides the CSV's
// 15/06 on six of them). Idempotent (skips existing numbers). Matches
// customers by account number / lumen external id / unique name. Versarien & Choose Leads
// (£0) intentionally excluded.

const INVOICE_DATE = '2026-06-01';
const SCHEME = 'CS';

const DATA: { number: string; account: string; name: string; due: string; net: number; vat: number; lines: { cat: string; amt: number }[] }[] = [
  { number: 'CS-003', account: 'AMR-001', name: 'AMR Sheet Metal Limited', due: '2026-06-01', net: 129.48, vat: 25.9, lines: [{ cat: 'Broadband and Internet', amt: 49.99 }, { cat: 'Hosted Telephone System', amt: 79.49 }] },
  { number: 'CS-004', account: 'CHR-001', name: 'Chropynska UK Limited', due: '2026-06-01', net: 49.99, vat: 10.0, lines: [{ cat: 'Broadband and Internet', amt: 49.99 }] },
  { number: 'CS-005', account: 'DYN-001', name: 'Dynamic Support Ltd', due: '2026-06-01', net: 185.42, vat: 37.08, lines: [{ cat: 'Hosted Telephone System', amt: 181.99 }, { cat: 'Additional Services', amt: 3.43 }] },
  { number: 'CS-006', account: 'GOT-001', name: 'GO TEL COMMUNICATIONS LIMITED', due: '2026-06-01', net: 16.56, vat: 3.31, lines: [{ cat: 'Hosted Telephone System', amt: 16.5 }, { cat: 'Additional Services', amt: 0.06 }] },
  { number: 'CS-007', account: 'PUR-001', name: 'Purely Recruitment Solutions Limited', due: '2026-06-01', net: 238.39, vat: 47.68, lines: [{ cat: 'Broadband and Internet', amt: 182.32 }, { cat: 'Hosted Telephone System', amt: 52.5 }, { cat: 'Additional Services', amt: 3.57 }] },
  { number: 'CS-008', account: 'LAR-001', name: 'Larkmead Veterinary Group Limited', due: '2026-06-01', net: 4373.16, vat: 874.63, lines: [{ cat: 'Broadband and Internet', amt: 1525.55 }, { cat: 'Hosted Telephone System', amt: 2815.55 }, { cat: 'Additional Services', amt: 32.06 }] },
  { number: 'CS-009', account: 'TLC-001', name: 'TLC Installations', due: '2026-06-15', net: 152.49, vat: 30.5, lines: [{ cat: 'Broadband and Internet', amt: 49.99 }, { cat: 'Hosted Telephone System', amt: 102.5 }] },
  { number: 'CS-0010', account: 'WIC-001', name: 'Wickstead Farm Equestrian Centre', due: '2026-06-15', net: 49.99, vat: 10.0, lines: [{ cat: 'Broadband and Internet', amt: 49.99 }] },
  { number: 'CS-0011', account: 'AVE-001', name: 'Aventis Capital Ltd', due: '2026-06-01', net: 455.8, vat: 91.16, lines: [{ cat: 'Broadband and Internet', amt: 455.8 }] },
  { number: 'CS-0012', account: 'UZI-001', name: 'UZI Sports', due: '2026-06-15', net: 17.5, vat: 3.5, lines: [{ cat: 'Hosted Telephone System', amt: 17.5 }] },
  { number: 'CS-0013', account: 'LAN-001', name: 'Landmark Hotel', due: '2026-06-15', net: 62.5, vat: 12.5, lines: [{ cat: 'Broadband and Internet', amt: 62.5 }] },
  { number: 'CS-0014', account: 'AUT-001', name: 'Auto Smart Oxford', due: '2026-06-01', net: 81.0, vat: 16.2, lines: [{ cat: 'Broadband and Internet', amt: 81.0 }] },
  { number: 'CS-0015', account: 'SBF-001', name: 'Steve Benson Farming Limited', due: '2026-06-15', net: 196.09, vat: 39.22, lines: [{ cat: 'Broadband and Internet', amt: 169.96 }, { cat: 'Hosted Telephone System', amt: 26.0 }, { cat: 'Additional Services', amt: 0.13 }] },
  { number: 'CS-0016', account: 'CT-001', name: 'Chris Trant', due: '2026-06-01', net: 30.0, vat: 6.0, lines: [{ cat: 'Broadband and Internet', amt: 30.0 }] },
  { number: 'CS-0017', account: 'APE-001', name: 'Apex Roofing', due: '2026-06-01', net: 52.5, vat: 10.5, lines: [{ cat: 'Broadband and Internet', amt: 35.0 }, { cat: 'Hosted Telephone System', amt: 17.5 }] },
  { number: 'CS-0018', account: 'JEN-001', name: 'Jenny Watts', due: '2026-06-01', net: 30.0, vat: 6.0, lines: [{ cat: 'Broadband and Internet', amt: 30.0 }] },
  { number: 'CS-0019', account: 'MIN-001', name: 'Minchinhampton Post Office', due: '2026-06-15', net: 30.0, vat: 6.0, lines: [{ cat: 'Broadband and Internet', amt: 30.0 }] },
  { number: 'CS-0020', account: 'JGO-001', name: 'J  Godfrey and Son', due: '2026-06-01', net: 172.18, vat: 34.44, lines: [{ cat: 'Broadband and Internet', amt: 155.68 }, { cat: 'Hosted Telephone System', amt: 16.5 }] },
  { number: 'CS-0021', account: 'GOD-001', name: 'Goddard Farrier Services Ltd', due: '2026-06-01', net: 45.99, vat: 9.2, lines: [{ cat: 'Broadband and Internet', amt: 45.99 }] },
  { number: 'CS-0022', account: 'CRO-001', name: 'Crowmarsh Consultants', due: '2026-06-01', net: 58.27, vat: 11.65, lines: [{ cat: 'Broadband and Internet', amt: 41.65 }, { cat: 'Hosted Telephone System', amt: 16.5 }, { cat: 'Additional Services', amt: 0.12 }] },
];

const r2 = (n: number) => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const byAcct = new Map<string, number>(); const byName = new Map<string, number>(); const nameCount = new Map<string, number>();
  for (const c of (await pool.query("SELECT id, account_number, lower(name) AS lname FROM customers WHERE deleted_at IS NULL AND is_placeholder=false")).rows) {
    if (c.account_number) byAcct.set(String(c.account_number).toLowerCase(), c.id);
    nameCount.set(c.lname, (nameCount.get(c.lname) || 0) + 1); byName.set(c.lname, c.id);
  }
  for (const e of (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system IN ('lumen','cli')")).rows) {
    byAcct.set(String(e.external_id).toLowerCase(), e.customer_id);
  }
  const productByName = new Map<string, number>();
  for (const p of (await pool.query("SELECT id, lower(name) AS lname FROM asset_products WHERE is_active=true")).rows) productByName.set(p.lname, p.id);
  const resolve = (acct: string, name: string): number | null =>
    byAcct.get(acct.toLowerCase()) ?? (nameCount.get(name.toLowerCase()) === 1 ? byName.get(name.toLowerCase())! : null) ?? null;

  let created = 0, skipped = 0; const unmatched: string[] = [];
  for (const d of DATA) {
    if ((await pool.query('SELECT 1 FROM invoices WHERE invoice_number=$1', [d.number])).rows.length) { skipped++; continue; }
    const customerId = resolve(d.account, d.name);
    if (!customerId) { unmatched.push(`${d.number} (${d.account} / ${d.name})`); continue; }
    const gross = r2(d.net + d.vat);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, title, status, payment_status,
           issue_date, due_date, currency_code, subtotal, tax_total, total)
         VALUES ($1,$2,$3,$4,'issued','unpaid',$5,$6,'GBP',$7,$8,$9) RETURNING id`,
        [customerId, d.number, SCHEME, 'Telecoms — May 2026', INVOICE_DATE, INVOICE_DATE, d.net.toFixed(2), d.vat.toFixed(2), gross.toFixed(2)]
      );
      const invId = ins.rows[0].id;
      let sort = 1;
      for (const l of d.lines) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, source, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,$2,'manual',$3,$4,1,$5,20,$5)`,
          [invId, productByName.get(l.cat.toLowerCase()) ?? null, sort++, l.cat, l.amt.toFixed(2)]
        );
      }
      await client.query('COMMIT');
      created++;
    } catch (e) { await client.query('ROLLBACK'); console.error('Failed', d.number, (e as Error).message); } finally { client.release(); }
  }

  console.log(`✓ Inform import: ${created} created, ${skipped} already existed.`);
  if (unmatched.length) { console.log(`  ⚠ ${unmatched.length} unmatched (set the account number / name and re-run):`); unmatched.forEach((u) => console.log('    -', u)); }
  await pool.end();
}

main().catch((e) => { console.error('Inform import failed:', e); process.exit(1); });
