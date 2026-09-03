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

      -- A part-payment balance written deliberately (the QuickBooks sync does this for
      -- bank-transfer invoices) is left exactly as it was found. It is real information.
      END IF;

      -- ── An issued invoice always has an issue date ──────────────────────────────
      -- Terry, 2026-09-03: "it should not be possible to have invoices with no issue date."
      -- Quite right. The issue date is the TAX POINT — it decides which VAT quarter the
      -- invoice falls in, when it becomes due, and where it lands in every dated report.
      -- Four Larkmead invoices were sitting issued and paid with no issue date at all,
      -- because a draft can legitimately have none and nothing stamped one on the way out
      -- of draft.
      --
      -- created_at is used rather than NOW() so that an invoice issued today and one being
      -- corrected years later both get the date the invoice actually came into existence,
      -- not the date somebody happened to touch the row.
      IF NEW.status IS NOT NULL AND NEW.status NOT IN ('draft', 'void') AND NEW.issue_date IS NULL THEN
        NEW.issue_date := COALESCE(NEW.created_at, NOW())::date;
      END IF;

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
// Invoices already issued without a date. Stamped from created_at — the moment the invoice
// came into existence, which is the most honest evidence we hold. Never invented.
export async function backfillIssueDates(): Promise<number> {
  const r = await pool.query(
    `UPDATE invoices SET issue_date = created_at::date, updated_at = NOW()
      WHERE deleted_at IS NULL AND status NOT IN ('draft','void') AND issue_date IS NULL
        AND created_at IS NOT NULL`
  ).catch(() => ({ rowCount: 0 }));
  return r.rowCount || 0;
}

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

// ── Invoices that never reached QuickBooks, and why ─────────────────────────────
// "Not in QuickBooks" was previously only answerable as a filter, and it could not tell you
// the reason. Now every push records its outcome on the invoice, so the ones that quietly
// did not go can say so themselves — and the ones nobody has ever tried are distinguished
// from the ones that were tried and refused.
export interface QbGap {
  id: number; invoice_number: string; customer_name: string | null; total: string;
  issue_date: string | null; qb_push_state: string | null; qb_push_error: string | null; qb_push_at: string | null;
}

export async function invoicesNotInQb(): Promise<QbGap[]> {
  return (await pool.query(
    `SELECT i.id, i.invoice_number, c.name AS customer_name, i.total, i.issue_date,
            i.qb_push_state, i.qb_push_error, i.qb_push_at
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.deleted_at IS NULL
        AND i.status NOT IN ('draft', 'void')
        AND i.quickbooks_invoice_id IS NULL
      ORDER BY i.issue_date DESC NULLS LAST, i.total DESC NULLS LAST`
  ).catch(() => ({ rows: [] as any[] }))).rows;
}

// ── Reconcile the Portal against QuickBooks itself ──────────────────────────────
// "Is this in QuickBooks?" has only ever been answered by our own column. This asks
// QuickBooks. Three answers matter and they are all different:
//   missing  — we think it is there, QuickBooks has never heard of it. The dangerous one:
//              the screen says "✓ In QuickBooks" and hides the button that would send it.
//   absent   — we know it is not there. Confirms the gap is real, not a stale column.
//   mismatch — QuickBooks has that invoice number under a DIFFERENT id than we recorded.
export interface QbVerify {
  checked: number; matched: number;
  missing: Array<{ id: number; invoice_number: string; total: string; qb_id: string }>;
  mismatch: Array<{ id: number; invoice_number: string; ours: string; theirs: string }>;
  absent: Array<{ id: number; invoice_number: string; total: string }>;
}

export async function verifyAgainstQuickBooks(): Promise<QbVerify> {
  const { QuickBooks } = await import('./quickbooks');
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) throw new Error('QuickBooks is not connected, so there is nothing to compare against.');
  const theirs = await qb.listInvoiceDocNumbers();
  const ours = (await pool.query(
    `SELECT id, invoice_number, total, quickbooks_invoice_id FROM invoices
      WHERE deleted_at IS NULL AND status NOT IN ('draft','void') AND invoice_number IS NOT NULL`
  ).catch(() => ({ rows: [] as any[] }))).rows;

  const out: QbVerify = { checked: ours.length, matched: 0, missing: [], mismatch: [], absent: [] };
  for (const i of ours) {
    const num = String(i.invoice_number).trim();
    const theirId = theirs.get(num);
    if (i.quickbooks_invoice_id) {
      if (!theirId) out.missing.push({ id: i.id, invoice_number: num, total: i.total, qb_id: String(i.quickbooks_invoice_id) });
      else if (String(theirId) !== String(i.quickbooks_invoice_id)) out.mismatch.push({ id: i.id, invoice_number: num, ours: String(i.quickbooks_invoice_id), theirs: String(theirId) });
      else out.matched++;
    } else if (theirId) {
      // It IS in QuickBooks; we simply never recorded the link. Safe to repair.
      await pool.query('UPDATE invoices SET quickbooks_invoice_id=$1 WHERE id=$2', [theirId, i.id]).catch(() => {});
      out.matched++;
    } else {
      out.absent.push({ id: i.id, invoice_number: num, total: i.total });
    }
  }
  // A claim of "in QuickBooks" that QuickBooks contradicts is cleared, so the invoice shows
  // its Push button again instead of a tick that is not true.
  for (const m of out.missing) {
    await pool.query(
      "UPDATE invoices SET quickbooks_invoice_id=NULL, qb_push_state='failed', qb_push_error=$2, qb_push_at=NOW() WHERE id=$1",
      [m.id, 'The Portal recorded a QuickBooks id (' + m.qb_id + ') but QuickBooks has no invoice with this number. The link has been cleared so it can be sent again.']
    ).catch(() => {});
  }
  return out;
}

// ── Will this invoice actually go to QuickBooks? ────────────────────────────────
// Terry, 2026-09-03, after pressing Push on Pealby Living and getting
// "These lines have no QuickBooks item: Extended Warranty - 3 Years":
// "review which cats for the line is in use - we need to see them on invoices."
//
// Every invoice line carries a SOURCE (manual, giacom, comms, calls, product) and, for comms
// lines, a CATEGORY (voice, mobile, internet, additional, oneoff, call). Together those decide
// which QuickBooks item the line posts under. None of it has ever been visible on the invoice,
// so the first anyone learns that a line cannot be mapped is when the push refuses — and until
// this morning it did not even say that.
//
// This works out the same answer buildInvoiceLines does, but WITHOUT sending anything, so the
// invoice can show which lines are ready and which will block it before anyone presses a button.
export interface LineMapping {
  description: string; source: string; category: string | null;
  itemId: string | null; via: string;    // how it resolved, in plain words
  ok: boolean;
}

export async function qbLinePreview(invoiceId: number): Promise<{ lines: LineMapping[]; blocked: string[] }> {
  const { getSetting } = await import('./settings');
  const items = (await pool.query(
    'SELECT description, source, invoice_category, product_id, sync_ref FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [invoiceId]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  if (!items.length) return { lines: [], blocked: [] };

  const s = async (k: string) => ((await getSetting('quickbooks', k)) || '').trim();
  const commsItem = await s('item_comms'), giacomItem = await s('item_giacom'), defItem = await s('item_default');
  const catItems: Record<string, string> = {};
  for (const c of ['voice', 'mobile', 'internet', 'additional', 'oneoff', 'call']) catItems[c] = await s('item_cat_' + c);

  const productMap: Record<number, string> = {};
  const pids = items.map((i: any) => Number(i.product_id || 0)).filter(Boolean);
  if (pids.length) {
    for (const r of (await pool.query('SELECT id, quickbooks_item_id FROM asset_products WHERE id = ANY($1) AND quickbooks_item_id IS NOT NULL', [pids]).catch(() => ({ rows: [] as any[] }))).rows) {
      productMap[r.id] = r.quickbooks_item_id;
    }
  }

  const lines: LineMapping[] = [];
  for (const it of items) {
    const src = String(it.source || 'manual');
    const cat = it.invoice_category ? String(it.invoice_category) : null;
    let itemId: string | null = null, via = '';
    if (productMap[Number(it.product_id)]) { itemId = productMap[Number(it.product_id)]; via = 'the catalogue product it was billed from'; }
    else if ((src === 'comms' || src === 'calls')) {
      const c = cat || 'additional';
      itemId = catItems[c] || commsItem || defItem || null;
      // Comms and call lines self-heal: an unmapped category creates its own item on push.
      via = itemId ? `the ${c} comms item` : `nothing yet — but a "${c}" item is created automatically when it is pushed`;
      if (!itemId) { lines.push({ description: it.description, source: src, category: cat, itemId: null, via, ok: true }); continue; }
    }
    else if (src === 'giacom') { itemId = giacomItem || defItem || null; via = itemId ? 'the Giacom item' : ''; }
    else { itemId = defItem || null; via = itemId ? 'the fallback default item' : ''; }
    lines.push({
      description: it.description, source: src, category: cat, itemId, ok: !!itemId,
      via: itemId ? via : 'no QuickBooks item — this line will stop the whole invoice',
    });
  }
  return { lines, blocked: lines.filter((l) => !l.ok).map((l) => l.description) };
}
