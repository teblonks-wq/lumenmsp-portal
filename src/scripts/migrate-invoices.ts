import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// Data migration: legacy MySQL invoices + invoice_items → Postgres. Preserves IDs, idempotent.
// Drops tenant_id. Reads LEGACY_MYSQL_* from .env.

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown): boolean => v === 1 || v === true || v === '1';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.LEGACY_MYSQL_USER) throw new Error('LEGACY_MYSQL_USER not set');

  const my = await mysql.createConnection({
    host:     process.env.LEGACY_MYSQL_HOST || 'localhost',
    port:     Number(process.env.LEGACY_MYSQL_PORT || 3306),
    user:     process.env.LEGACY_MYSQL_USER,
    password: process.env.LEGACY_MYSQL_PASSWORD || '',
    database: process.env.LEGACY_MYSQL_DATABASE || 'lumenmsp',
  });
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pg.connect();
  const counts: Record<string, number> = {};

  try {
    const [invoices] = await my.query('SELECT * FROM invoices') as [any[], any];
    for (const inv of invoices) {
      await client.query(
        `INSERT INTO invoices
          (id, customer_id, quote_id, quickbooks_invoice_id, gocardless_payment_id, payment_status,
           invoice_number, invoice_scheme, title, payment_method, status, emailed_at, is_locked,
           issue_date, due_date, currency_code, subtotal, tax_total, total, notes, terms,
           created_by, created_at, updated_at, deleted_at, deleted_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 COALESCE($23, NOW()), COALESCE($24, NOW()), $25, $26)
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, quote_id=EXCLUDED.quote_id,
           quickbooks_invoice_id=EXCLUDED.quickbooks_invoice_id, gocardless_payment_id=EXCLUDED.gocardless_payment_id,
           payment_status=EXCLUDED.payment_status, invoice_number=EXCLUDED.invoice_number,
           invoice_scheme=EXCLUDED.invoice_scheme, title=EXCLUDED.title, payment_method=EXCLUDED.payment_method,
           status=EXCLUDED.status, emailed_at=EXCLUDED.emailed_at, is_locked=EXCLUDED.is_locked,
           issue_date=EXCLUDED.issue_date, due_date=EXCLUDED.due_date, currency_code=EXCLUDED.currency_code,
           subtotal=EXCLUDED.subtotal, tax_total=EXCLUDED.tax_total, total=EXCLUDED.total,
           notes=EXCLUDED.notes, terms=EXCLUDED.terms, created_by=EXCLUDED.created_by, updated_at=EXCLUDED.updated_at,
           deleted_at=EXCLUDED.deleted_at, deleted_by_user_id=EXCLUDED.deleted_by_user_id`,
        [
          n(inv.id), n(inv.customer_id), n(inv.quote_id), inv.quickbooks_invoice_id, inv.gocardless_payment_id,
          inv.payment_status || 'unpaid', inv.invoice_number, inv.invoice_scheme || 'IT', inv.title,
          inv.payment_method || 'upfront', inv.status || 'draft', inv.emailed_at, b(inv.is_locked),
          inv.issue_date, inv.due_date, inv.currency_code || 'GBP', inv.subtotal, inv.tax_total, inv.total,
          inv.notes, inv.terms, n(inv.created_by), inv.created_at, inv.updated_at, inv.deleted_at, n(inv.deleted_by_user_id),
        ]
      );
    }
    counts.invoices = invoices.length;

    const [items] = await my.query('SELECT * FROM invoice_items') as [any[], any];
    for (const it of items) {
      await client.query(
        `INSERT INTO invoice_items (id, invoice_id, product_id, sort_order, description, quantity, unit_price, tax_rate, line_total, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           invoice_id=EXCLUDED.invoice_id, product_id=EXCLUDED.product_id, sort_order=EXCLUDED.sort_order,
           description=EXCLUDED.description, quantity=EXCLUDED.quantity, unit_price=EXCLUDED.unit_price,
           tax_rate=EXCLUDED.tax_rate, line_total=EXCLUDED.line_total`,
        [n(it.id), n(it.invoice_id), n(it.product_id), n(it.sort_order) ?? 1, it.description, it.quantity, it.unit_price, it.tax_rate, it.line_total, it.created_at]
      );
    }
    counts.invoice_items = items.length;

    for (const t of ['invoices', 'invoice_items']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
    }
    console.log('✓ Invoices migration complete:', counts);
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
