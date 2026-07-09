import 'dotenv/config';
import { Pool } from 'pg';

// Reconciliation aid for the invoice "migration gap". Prints a month-by-month count
// of invoices in Postgres (split portal-native vs legacy/QuickBooks), so gaps in the
// timeline are obvious. If LEGACY_MYSQL_* is configured it also pulls the legacy
// MySQL monthly counts alongside, so you can see exactly which months didn't migrate.

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  const pgRows = (await pg.query(
    `SELECT to_char(date_trunc('month', COALESCE(issue_date, created_at)), 'YYYY-MM') AS ym,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE quickbooks_invoice_id IS NOT NULL AND created_by IS NULL)::int AS legacy,
            COUNT(*) FILTER (WHERE quickbooks_invoice_id IS NULL OR created_by IS NOT NULL)::int AS portal
       FROM invoices WHERE deleted_at IS NULL
      GROUP BY 1 ORDER BY 1`
  )).rows;

  // Optional: legacy MySQL counts for the same months.
  let mysqlByMonth: Record<string, number> = {};
  if (process.env.LEGACY_MYSQL_USER) {
    try {
      const mysql = await import('mysql2/promise');
      const my = await mysql.createConnection({
        host: process.env.LEGACY_MYSQL_HOST || 'localhost', port: Number(process.env.LEGACY_MYSQL_PORT || 3306),
        user: process.env.LEGACY_MYSQL_USER, password: process.env.LEGACY_MYSQL_PASSWORD || '',
        database: process.env.LEGACY_MYSQL_DATABASE || 'lumenmsp',
      });
      const [rows] = await my.query(
        `SELECT DATE_FORMAT(COALESCE(issue_date, created_at), '%Y-%m') AS ym, COUNT(*) AS n
           FROM invoices GROUP BY 1 ORDER BY 1`
      );
      (rows as any[]).forEach((r) => { mysqlByMonth[r.ym] = Number(r.n); });
      await my.end();
    } catch (e) { console.log('(legacy MySQL not reachable — showing Postgres only):', (e as Error).message); }
  }

  const haveMysql = Object.keys(mysqlByMonth).length > 0;
  const months = Array.from(new Set([...pgRows.map((r: any) => r.ym), ...Object.keys(mysqlByMonth)])).sort();
  const pgByMonth: Record<string, any> = {}; pgRows.forEach((r: any) => { pgByMonth[r.ym] = r; });

  console.log('\nInvoice counts by month (portal Postgres' + (haveMysql ? ' vs legacy MySQL' : '') + ')');
  console.log('Month     PG total  portal  legacy' + (haveMysql ? '   MySQL   diff' : ''));
  console.log('-------   --------  ------  ------' + (haveMysql ? '   -----   ----' : ''));
  let prev: string | null = null;
  for (const m of months) {
    const p = pgByMonth[m] || { total: 0, portal: 0, legacy: 0 };
    const my = mysqlByMonth[m] || 0;
    const diff = my - p.total;
    // Flag a gap: a jump of more than one month between consecutive PG-populated months.
    if (prev && pgByMonth[m] && monthGap(prev, m) > 1) console.log(`          … gap: no invoices for ${monthGap(prev, m) - 1} month(s) …`);
    if (pgByMonth[m]) prev = m;
    console.log(
      `${m}   ${String(p.total).padStart(8)}  ${String(p.portal).padStart(6)}  ${String(p.legacy).padStart(6)}` +
      (haveMysql ? `   ${String(my).padStart(5)}   ${diff > 0 ? '+' + diff : String(diff)}` : '')
    );
  }
  const totalPg = pgRows.reduce((s: number, r: any) => s + r.total, 0);
  console.log(`\nTotal in Postgres: ${totalPg}` + (haveMysql ? `   Total in MySQL: ${Object.values(mysqlByMonth).reduce((a, b) => a + b, 0)}` : ''));
  if (haveMysql) console.log('A positive "diff" = invoices in MySQL that did not make it into the Portal for that month.');
  await pg.end();
}

function monthGap(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

main().catch((e) => { console.error('Gap report failed:', e); process.exit(1); });
