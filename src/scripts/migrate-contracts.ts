import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// Data migration: legacy MySQL contracts + contract_lines → Postgres. Preserves IDs, idempotent.
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
    const [contracts] = await my.query('SELECT * FROM contracts') as [any[], any];
    for (const c of contracts) {
      await client.query(
        `INSERT INTO contracts
          (id, customer_id, quote_id, contract_number, title, status, service_type, start_date, end_date,
           notice_days, auto_renew, payment_method, notes, created_by, deleted_at, deleted_by_user_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17, NOW()), COALESCE($18, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, quote_id=EXCLUDED.quote_id, contract_number=EXCLUDED.contract_number,
           title=EXCLUDED.title, status=EXCLUDED.status, service_type=EXCLUDED.service_type, start_date=EXCLUDED.start_date,
           end_date=EXCLUDED.end_date, notice_days=EXCLUDED.notice_days, auto_renew=EXCLUDED.auto_renew,
           payment_method=EXCLUDED.payment_method, notes=EXCLUDED.notes, created_by=EXCLUDED.created_by,
           deleted_at=EXCLUDED.deleted_at, deleted_by_user_id=EXCLUDED.deleted_by_user_id, updated_at=EXCLUDED.updated_at`,
        [
          n(c.id), n(c.customer_id), n(c.quote_id), c.contract_number, c.title, c.status || 'draft',
          c.service_type || 'IT', c.start_date, c.end_date, n(c.notice_days) ?? 30, b(c.auto_renew),
          c.payment_method || 'upfront', c.notes, n(c.created_by), c.deleted_at, n(c.deleted_by_user_id),
          c.created_at, c.updated_at,
        ]
      );
    }
    counts.contracts = contracts.length;

    const [lines] = await my.query('SELECT * FROM contract_lines') as [any[], any];
    for (const l of lines) {
      await client.query(
        `INSERT INTO contract_lines (id, contract_id, product_id, description, quantity, unit_price, billing_frequency, line_total, sort_order, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           contract_id=EXCLUDED.contract_id, product_id=EXCLUDED.product_id, description=EXCLUDED.description,
           quantity=EXCLUDED.quantity, unit_price=EXCLUDED.unit_price, billing_frequency=EXCLUDED.billing_frequency,
           line_total=EXCLUDED.line_total, sort_order=EXCLUDED.sort_order`,
        [n(l.id), n(l.contract_id), n(l.product_id), l.description, l.quantity, l.unit_price, l.billing_frequency || 'monthly', l.line_total, n(l.sort_order) ?? 1, l.created_at]
      );
    }
    counts.contract_lines = lines.length;

    for (const t of ['contracts', 'contract_lines']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
    }
    console.log('✓ Contracts migration complete:', counts);
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
