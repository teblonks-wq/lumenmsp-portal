import 'dotenv/config';
import { Pool } from 'pg';

// Turns the imported Inform invoices (scheme CS) into Comms recurring templates so they
// appear under Recurring → Comms Contracts as a starting point. Comms cycle: raise on the
// 1st (services in advance, calls in arrears), so send_day=1, due_day=1. Auto-actions are
// left OFF — generation won't email/QB/GoCardless until you turn them on after pricing.
// Idempotent. One Comms contract per customer (each customer has one CS invoice).

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query(
    `UPDATE invoices SET is_recurring=true, recurring_active=true, contract_type='Comms',
        send_day=1, due_day=1,
        recurring_name=COALESCE(NULLIF(recurring_name,''), title),
        auto_send=false, auto_qb=false, auto_gc=false, updated_at=NOW()
      WHERE invoice_scheme='CS' AND deleted_at IS NULL
      RETURNING invoice_number`
  );
  console.log(`✓ ${r.rowCount} CS invoice(s) set as Comms recurring templates (send day 1, auto-actions OFF).`);
  (r.rows as any[]).forEach((x) => console.log('   -', x.invoice_number));
  await pool.end();
}

main().catch((e) => { console.error('make-comms-templates failed:', e); process.exit(1); });
