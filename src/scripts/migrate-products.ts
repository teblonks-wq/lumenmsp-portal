import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// Data migration: legacy MySQL asset_categories + asset_products + suppliers → Postgres.
// Preserves IDs, idempotent. Drops tenant_id (suppliers). Reads LEGACY_MYSQL_* from .env.

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
    const [cats] = await my.query('SELECT * FROM asset_categories') as [any[], any];
    for (const c of cats) {
      await client.query(
        `INSERT INTO asset_categories (id, code, name, created_at, updated_at)
         VALUES ($1,$2,$3, COALESCE($4, NOW()), COALESCE($5, NOW()))
         ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name, updated_at=EXCLUDED.updated_at`,
        [n(c.id), c.code, c.name, c.created_at, c.updated_at]
      );
    }
    counts.asset_categories = cats.length;

    const [prods] = await my.query('SELECT * FROM asset_products') as [any[], any];
    for (const p of prods) {
      await client.query(
        `INSERT INTO asset_products
          (id, category_id, quickbooks_item_id, code, name, supplier, description, item_type, billing_frequency,
           unit_price, cost_price, vat_rate, source_tag, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15, NOW()), COALESCE($16, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           category_id=EXCLUDED.category_id, quickbooks_item_id=EXCLUDED.quickbooks_item_id, code=EXCLUDED.code,
           name=EXCLUDED.name, supplier=EXCLUDED.supplier, description=EXCLUDED.description, item_type=EXCLUDED.item_type,
           billing_frequency=EXCLUDED.billing_frequency, unit_price=EXCLUDED.unit_price, cost_price=EXCLUDED.cost_price,
           vat_rate=EXCLUDED.vat_rate, source_tag=EXCLUDED.source_tag, is_active=EXCLUDED.is_active, updated_at=EXCLUDED.updated_at`,
        [
          n(p.id), n(p.category_id), p.quickbooks_item_id, p.code, p.name, p.supplier, p.description,
          p.item_type || 'service', p.billing_frequency || 'monthly', p.unit_price, p.cost_price, p.vat_rate,
          p.source_tag, b(p.is_active), p.created_at, p.updated_at,
        ]
      );
    }
    counts.asset_products = prods.length;

    const [sups] = await my.query('SELECT * FROM suppliers') as [any[], any];
    for (const s of sups) {
      await client.query(
        `INSERT INTO suppliers (id, name, url, notes, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6, NOW()), COALESCE($7, NOW()))
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url, notes=EXCLUDED.notes,
           is_active=EXCLUDED.is_active, updated_at=EXCLUDED.updated_at`,
        [n(s.id), s.name, s.url, s.notes, b(s.is_active), s.created_at, s.updated_at]
      );
    }
    counts.suppliers = sups.length;

    for (const t of ['asset_categories', 'asset_products', 'suppliers']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
    }
    console.log('✓ Products migration complete:', counts);
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
