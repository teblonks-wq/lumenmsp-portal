import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// Data migration: legacy MySQL quotes + quote_items → Postgres. Preserves IDs, idempotent.
// Drops tenant_id. Reads LEGACY_MYSQL_* from .env (same as migrate-customers).

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

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
    const [quotes] = await my.query('SELECT * FROM quotes') as [any[], any];
    for (const q of quotes) {
      await client.query(
        `INSERT INTO quotes
          (id, customer_id, inbox_ticket_id, quote_number, title, status, accept_token, view_count,
           issue_date, valid_until, currency_code, subtotal, tax_total, total, notes, terms,
           created_by, created_at, updated_at, accepted_by_name, accepted_by_email, accepted_at,
           approve_note, reject_reason, sent_to, deleted_at, deleted_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 COALESCE($18, NOW()), COALESCE($19, NOW()), $20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, inbox_ticket_id=EXCLUDED.inbox_ticket_id,
           quote_number=EXCLUDED.quote_number, title=EXCLUDED.title, status=EXCLUDED.status,
           accept_token=EXCLUDED.accept_token, view_count=EXCLUDED.view_count, issue_date=EXCLUDED.issue_date,
           valid_until=EXCLUDED.valid_until, currency_code=EXCLUDED.currency_code, subtotal=EXCLUDED.subtotal,
           tax_total=EXCLUDED.tax_total, total=EXCLUDED.total, notes=EXCLUDED.notes, terms=EXCLUDED.terms,
           created_by=EXCLUDED.created_by, updated_at=EXCLUDED.updated_at,
           accepted_by_name=EXCLUDED.accepted_by_name, accepted_by_email=EXCLUDED.accepted_by_email,
           accepted_at=EXCLUDED.accepted_at, approve_note=EXCLUDED.approve_note, reject_reason=EXCLUDED.reject_reason,
           sent_to=EXCLUDED.sent_to, deleted_at=EXCLUDED.deleted_at, deleted_by_user_id=EXCLUDED.deleted_by_user_id`,
        [
          n(q.id), n(q.customer_id), n(q.inbox_ticket_id), q.quote_number, q.title, q.status || 'draft',
          q.accept_token, n(q.view_count) ?? 0, q.issue_date, q.valid_until, q.currency_code || 'GBP',
          q.subtotal, q.tax_total, q.total, q.notes, q.terms, n(q.created_by), q.created_at, q.updated_at,
          q.accepted_by_name, q.accepted_by_email, q.accepted_at, q.approve_note, q.reject_reason, q.sent_to,
          q.deleted_at, n(q.deleted_by_user_id),
        ]
      );
    }
    counts.quotes = quotes.length;

    const [items] = await my.query('SELECT * FROM quote_items') as [any[], any];
    for (const it of items) {
      await client.query(
        `INSERT INTO quote_items
          (id, quote_id, product_id, supplier_id, sort_order, description, quantity, unit_price,
           tax_rate, line_total, buy_price, supplier_name, supplier_url, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           quote_id=EXCLUDED.quote_id, product_id=EXCLUDED.product_id, supplier_id=EXCLUDED.supplier_id,
           sort_order=EXCLUDED.sort_order, description=EXCLUDED.description, quantity=EXCLUDED.quantity,
           unit_price=EXCLUDED.unit_price, tax_rate=EXCLUDED.tax_rate, line_total=EXCLUDED.line_total,
           buy_price=EXCLUDED.buy_price, supplier_name=EXCLUDED.supplier_name, supplier_url=EXCLUDED.supplier_url`,
        [
          n(it.id), n(it.quote_id), n(it.product_id), n(it.supplier_id), n(it.sort_order) ?? 1, it.description,
          it.quantity, it.unit_price, it.tax_rate, it.line_total, it.buy_price, it.supplier_name, it.supplier_url,
          it.created_at,
        ]
      );
    }
    counts.quote_items = items.length;

    for (const t of ['quotes', 'quote_items']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
    }

    console.log('✓ Quotes migration complete:', counts);
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
