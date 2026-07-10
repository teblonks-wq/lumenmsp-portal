import cron from 'node-cron';
import { pool } from '../db/pool';
import { GoCardless } from './gocardless';
import { notify } from './notifications';

// Pull active GoCardless mandates and AUTO-LINK the confident ones to portal customers by email
// (the DD-setup invite prefills the customer's email, so a fresh mandate matches here). Anything
// without a clean email match is left UNLINKED — it shows on Settings → GoCardless → Match
// customers for a human to match by hand. Runs hourly + can be called on demand.

const gcName = (c: any): string => (c.company_name || [c.given_name, c.family_name].filter(Boolean).join(' ') || '').trim();

export async function syncGoCardlessMandates(): Promise<{ total: number; linked: number; unmatched: number }> {
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) return { total: 0, linked: 0, unmatched: 0 };
  let gcCustomers: any[] = [], mandates: any[] = [];
  try { [gcCustomers, mandates] = await Promise.all([gc.listCustomers(), gc.listMandates('active')]); }
  catch (e) { console.error('[gocardless-sync] fetch failed:', (e as Error).message); return { total: 0, linked: 0, unmatched: 0 }; }

  // First active mandate per GoCardless customer id.
  const mandateByCust: Record<string, string> = {};
  for (const m of mandates) { const cust = m?.links?.customer; if (cust && !mandateByCust[cust]) mandateByCust[cust] = m.id; }

  const portal = (await pool.query('SELECT id, email, gocardless_mandate_id FROM customers WHERE deleted_at IS NULL')).rows;
  const linkedMandates = new Set<string>(portal.filter((c: any) => c.gocardless_mandate_id).map((c: any) => String(c.gocardless_mandate_id)));
  const emailTo: Record<string, any> = {};
  for (const c of portal) { const e = (c.email || '').toLowerCase().trim(); if (e) emailTo[e] = c; }

  let linked = 0, unmatched = 0;
  for (const qc of gcCustomers) {
    const mid = mandateByCust[qc.id];
    if (!mid || linkedMandates.has(String(mid))) continue; // no active mandate, or already linked
    const e = (qc.email || '').toLowerCase().trim();
    const pc = e ? emailTo[e] : null;
    if (pc && !pc.gocardless_mandate_id) {
      await pool.query('UPDATE customers SET gocardless_mandate_id=$1 WHERE id=$2', [mid, pc.id]);
      pc.gocardless_mandate_id = mid; linkedMandates.add(String(mid)); linked++;
    } else {
      unmatched++; // left for manual matching on the GoCardless match screen
    }
  }
  if (linked) console.log(`[gocardless-sync] auto-linked ${linked} new mandate(s) by email; ${unmatched} left for manual match`);
  return { total: gcCustomers.length, linked, unmatched };
}

// ── Payment status → invoice paid ─────────────────────────────────────────────────
// Asks GoCardless directly for every invoice sitting at payment_status='pending' with a
// GC payment submitted, so invoices flip to PAID as soon as GoCardless pays out — no
// waiting for the accounts team / QuickBooks to catch up.
//   paid_out                → paid (funds are with us)
//   failed / cancelled / charged_back / customer_approval_denied → failed
//   anything else (pending_submission, submitted, confirmed…)    → stays pending
const GC_FAILED = ['failed', 'cancelled', 'charged_back', 'customer_approval_denied'];

export async function syncGoCardlessPayments(): Promise<{ checked: number; paid: number; failed: number }> {
  const out = { checked: 0, paid: 0, failed: 0 };
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) return out;
  // 'pending' AND 'unpaid': the old QB payment sync (now disabled) had been knocking
  // GC-submitted invoices back to 'unpaid', which made them invisible to this sync —
  // include them so everything GoCardless has actually collected gets caught up.
  const rows = (await pool.query(
    `SELECT id, invoice_number, gocardless_payment_id, created_by
       FROM invoices
      WHERE deleted_at IS NULL AND gocardless_payment_id IS NOT NULL
        AND payment_status IN ('pending', 'unpaid')
      ORDER BY id`
  )).rows;
  for (const inv of rows) {
    try {
      const p = await gc.getPayment(inv.gocardless_payment_id);
      const st = String(p?.status || '').toLowerCase();
      out.checked++;
      if (st === 'paid_out') {
        // Pull the payout so the invoice can show the bank-statement reference + date.
        let payoutRef = '', paidOutAt: string | null = null;
        const payoutId = p?.links?.payout;
        if (payoutId) {
          try {
            const po = await gc.getPayout(payoutId);
            payoutRef = String(po?.reference || '');
            paidOutAt = po?.arrival_date || null;
          } catch (e: any) { console.error(`[gocardless-sync] payout lookup failed for ${payoutId}:`, e.message); }
        }
        // Draft/void invoice statuses are left alone (same rule as the old QB payment sync).
        await pool.query(
          `UPDATE invoices SET payment_status='paid',
                  status = CASE WHEN status IN ('draft','void') THEN status ELSE 'paid' END,
                  gocardless_payout_ref = COALESCE(NULLIF($2,''), gocardless_payout_ref),
                  gocardless_paid_out_at = COALESCE($3::date, gocardless_paid_out_at),
                  payment_synced_at = NOW()
            WHERE id=$1`, [inv.id, payoutRef, paidOutAt]);
        out.paid++;
        if (inv.created_by) {
          await notify(inv.created_by, `Invoice ${inv.invoice_number} paid (GoCardless)`,
            { type: 'invoice', body: 'GoCardless has paid out — invoice marked paid.', link: '/invoices/' + inv.id }).catch(() => {});
        }
      } else if (GC_FAILED.includes(st)) {
        await pool.query(`UPDATE invoices SET payment_status='failed', payment_synced_at=NOW() WHERE id=$1`, [inv.id]);
        out.failed++;
        if (inv.created_by) {
          await notify(inv.created_by, `Invoice ${inv.invoice_number} — GoCardless ${st.replace(/_/g, ' ')}`,
            { type: 'invoice', body: 'The Direct Debit collection did not complete — chase or re-submit.', link: '/invoices/' + inv.id }).catch(() => {});
        }
      }
    } catch (e) {
      console.error(`[gocardless-sync] payment check failed for invoice ${inv.invoice_number}:`, (e as Error).message);
    }
  }
  if (out.paid || out.failed) console.log(`[gocardless-sync] payments: ${out.checked} checked, ${out.paid} marked paid, ${out.failed} failed`);
  return out;
}

// ── Back-link imported invoices to their GoCardless payments ─────────────────────
// Invoices imported from QB have no gocardless_payment_id, so the paid-sync can't see
// them. For every customer with a mandate, pull that mandate's GC payments and match
// unlinked, unpaid invoices by EXACT amount (nearest charge date when several payments
// share an amount). Linked invoices then flow through the normal paid-out sync.
export async function linkGcPaymentsToInvoices(): Promise<{ customers: number; linked: number; unmatched: number }> {
  const out = { customers: 0, linked: 0, unmatched: 0 };
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) return out;

  // Every GC payment id already linked to ANY invoice — never link one payment twice.
  const used = new Set<string>(
    (await pool.query('SELECT gocardless_payment_id AS id FROM invoices WHERE gocardless_payment_id IS NOT NULL')).rows.map((r: any) => String(r.id)));

  const custs = (await pool.query(
    `SELECT DISTINCT c.id, c.gocardless_mandate_id
       FROM customers c JOIN invoices i ON i.customer_id = c.id
      WHERE c.deleted_at IS NULL AND c.gocardless_mandate_id IS NOT NULL
        AND i.deleted_at IS NULL AND i.gocardless_payment_id IS NULL
        AND i.payment_status IN ('unpaid', 'pending') AND i.status NOT IN ('draft', 'void')`
  )).rows;

  for (const c of custs) {
    out.customers++;
    let payments: any[] = [];
    try { payments = await gc.listPayments(c.gocardless_mandate_id); }
    catch (e: any) { console.error(`[gocardless-sync] listPayments failed for customer ${c.id}:`, e.message); continue; }

    const invoices = (await pool.query(
      `SELECT id, invoice_number, total, due_date, issue_date FROM invoices
        WHERE customer_id=$1 AND deleted_at IS NULL AND gocardless_payment_id IS NULL
          AND payment_status IN ('unpaid','pending') AND status NOT IN ('draft','void')
        ORDER BY issue_date NULLS LAST, id`, [c.id])).rows;

    for (const inv of invoices) {
      const pence = Math.round(Number(inv.total || 0) * 100);
      if (!pence) { out.unmatched++; continue; }
      const anchor = new Date(inv.due_date || inv.issue_date || Date.now()).getTime();
      const candidates = payments
        .filter((p) => Number(p.amount) === pence && !used.has(String(p.id)) && !['cancelled', 'customer_approval_denied'].includes(String(p.status)))
        .sort((a, b) => Math.abs(new Date(a.charge_date).getTime() - anchor) - Math.abs(new Date(b.charge_date).getTime() - anchor));
      if (!candidates.length) { out.unmatched++; continue; }
      const pick = candidates[0];
      used.add(String(pick.id));
      await pool.query(
        `UPDATE invoices SET gocardless_payment_id=$2, payment_status='pending' WHERE id=$1`,
        [inv.id, pick.id]);
      out.linked++;
      console.log(`[gocardless-sync] linked ${inv.invoice_number} → ${pick.id} (${pick.status}, £${(pence / 100).toFixed(2)}, ${pick.charge_date})`);
    }
  }
  return out;
}

let _started = false;
export function startGoCardlessSync(): void {
  if (_started) return;
  _started = true;
  cron.schedule('0 * * * *', () => { syncGoCardlessMandates().catch((e) => console.error('[gocardless-sync]', e.message)); }); // hourly
  cron.schedule('30 * * * *', () => { syncGoCardlessPayments().catch((e) => console.error('[gocardless-sync]', e.message)); }); // hourly at :30
  console.log('[gocardless-sync] mandate auto-link (hourly) + payment status → paid (hourly at :30) scheduled');
}
