import { pool } from '../db/pool';

// ── What an invoice is owed ─────────────────────────────────────────────────────
// 2026-09-03. Terry: "im not sure the direct debit is working as expected." It was not the
// direct debit. 38 of 42 invoices sitting at payment_status='pending' showed a balance of
// £0.00 — including Larkmead at £9,390.94 — so the ledger said nothing was owed while the
// payment status said nothing had arrived.
//
// The cause: `balance` has a database default of 0 and NOT ONE of the ten places that
// create or recalculate an invoice ever sets it. Totals are written; balance is not. So for
// every GoCardless invoice — which the QuickBooks sync deliberately never touches — balance
// has read £0 since the moment it was created and has never meant anything. Anything reading
// it (outstanding_invoices, payment reminders, the invoice list) has been understating what
// customers owe.
//
// Patching the ten call sites would fix today and lose to the eleventh. So the guarantee is
// made in the database instead, where every write has to go through it.

export async function ensureInvoiceBalanceGuard(): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION invoice_balance_guard() RETURNS trigger AS $fn$
    BEGIN
      -- Nothing is owed on a void invoice, or one whose payment has landed.
      IF NEW.status = 'void' OR NEW.payment_status IN ('paid', 'void') THEN
        NEW.balance := 0;

      -- An untouched balance on an invoice that has a total is the uninitialised case.
      -- Also catches the recalculation path: the total changes, the balance was left behind.
      ELSIF COALESCE(NEW.balance, 0) = 0
         OR (TG_OP = 'UPDATE' AND NEW.total IS DISTINCT FROM OLD.total
             AND NEW.balance IS NOT DISTINCT FROM OLD.balance) THEN
        NEW.balance := COALESCE(NEW.total, 0);
      END IF;

      -- A part-payment balance written deliberately (the QuickBooks sync does this for
      -- bank-transfer invoices) is left exactly as it was found. It is real information.
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;
  `);
  await pool.query('DROP TRIGGER IF EXISTS trg_invoice_balance_guard ON invoices');
  await pool.query(`
    CREATE TRIGGER trg_invoice_balance_guard
      BEFORE INSERT OR UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION invoice_balance_guard()
  `);
}

// One-off repair for everything created before the guard existed. Safe to run again: it only
// touches rows where the balance is zero on an invoice that is issued and unpaid, which is
// the impossible state.
export async function backfillInvoiceBalances(): Promise<{ fixed: number; value: number }> {
  const r = await pool.query(
    `UPDATE invoices SET balance = total, updated_at = NOW()
      WHERE deleted_at IS NULL
        AND status NOT IN ('draft', 'void')
        AND payment_status NOT IN ('paid', 'void')
        AND COALESCE(balance, 0) = 0
        AND COALESCE(total, 0) > 0
      RETURNING total`
  ).catch(() => ({ rows: [] as any[] }));
  const value = r.rows.reduce((n: number, x: any) => n + Number(x.total || 0), 0);
  return { fixed: r.rows.length, value };
}

// Invoices whose two answers disagree. NOT repaired automatically — a contradiction is
// information, and guessing which half is right is how the wrong half wins.
export interface Contradiction { id: number; invoice_number: string; customer_name: string | null; total: string; balance: string; status: string; payment_status: string; issue_date: string | null; why: string }

export async function balanceContradictions(): Promise<Contradiction[]> {
  const rows = (await pool.query(
    `SELECT i.id, i.invoice_number, c.name AS customer_name, i.total, i.balance,
            i.status, i.payment_status, i.issue_date,
            CASE
              WHEN i.status = 'paid' AND i.payment_status <> 'paid'
                THEN 'The invoice says paid; the payment says ' || i.payment_status || '.'
              WHEN i.payment_status = 'paid' AND COALESCE(i.balance,0) > 0
                THEN 'Marked paid but still shows a balance.'
              WHEN i.status NOT IN ('draft','void') AND i.payment_status NOT IN ('paid','void')
                   AND COALESCE(i.balance,0) = 0 AND COALESCE(i.total,0) > 0
                THEN 'Unpaid, but nothing is showing as owed.'
              WHEN i.issue_date IS NULL AND i.status NOT IN ('draft','void')
                THEN 'Issued with no issue date.'
              ELSE 'Inconsistent.'
            END AS why
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.deleted_at IS NULL
        AND (
          (i.status = 'paid' AND i.payment_status <> 'paid')
          OR (i.payment_status = 'paid' AND COALESCE(i.balance,0) > 0)
          OR (i.status NOT IN ('draft','void') AND i.payment_status NOT IN ('paid','void')
              AND COALESCE(i.balance,0) = 0 AND COALESCE(i.total,0) > 0)
          OR (i.issue_date IS NULL AND i.status NOT IN ('draft','void'))
        )
      ORDER BY i.total DESC NULLS LAST`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return rows;
}
