import 'dotenv/config';
import { Pool } from 'pg';

// Backfill the new first-class `leads` table from existing customer-leads (customers
// that have a lead_status set, or status='lead'). Idempotent: skips customers that
// already have a lead row. Carries status, source and the original created_at across.

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set (check .env).'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows } = await pool.query(
    `SELECT c.id, c.created_at, c.created_by, c.lead_source,
            COALESCE(c.lead_status, 'new') AS lead_status, c.status
       FROM customers c
       LEFT JOIN leads l ON l.customer_id = c.id AND l.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND c.is_placeholder = false
        AND (c.lead_status IS NOT NULL OR c.status = 'lead')
        AND l.id IS NULL`
  );

  let created = 0;
  for (const c of rows) {
    const status = ['new', 'open', 'proposed', 'won', 'lost'].includes(c.lead_status) ? c.lead_status : 'new';
    await pool.query(
      `INSERT INTO leads (customer_id, status, source, won_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [c.id, status, c.lead_source || null, status === 'won' ? c.created_at : null, c.created_by || null, c.created_at]
    );
    created++;
  }

  console.log(`✓ Lead migration: ${rows.length} customer-leads found, ${created} lead rows created.`);
  await pool.end();
}

main().catch((e) => { console.error('Lead migration failed:', e); process.exit(1); });
