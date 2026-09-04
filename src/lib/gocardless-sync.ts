import cron from 'node-cron';
import { pool } from '../db/pool';
import { GoCardless } from './gocardless';
import { notify } from './notifications';
import { buildMatchState, applyMatches } from './gocardless-match';

// Pull GoCardless customers + mandates and link them to portal customers using the shared
// matcher in gocardless-match.ts (DD-invite metadata → GC customer id → company email →
// contact email → company name). Anything less than exact — a domain-only or near-name match —
// is left for a human on Settings → GoCardless → Match customers. Also REFRESHES the cached
// mandate of everyone already linked, so a customer who cancelled and re-signed starts
// collecting again without anyone noticing they had stopped. Runs hourly + on demand.

export async function syncGoCardlessMandates(): Promise<{ total: number; linked: number; unmatched: number; refreshed: number }> {
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) return { total: 0, linked: 0, unmatched: 0, refreshed: 0 };
  let state;
  try { state = await buildMatchState(gc); }
  catch (e) { console.error('[gocardless-sync] fetch failed:', (e as Error).message); return { total: 0, linked: 0, unmatched: 0, refreshed: 0 }; }

  const { linked, refreshed, linkedNames } = await applyMatches(state);
  const unmatched = state.rows.filter((r) => !r.linked && r.mandateId).length;
  if (linked || refreshed) {
    console.log(`[gocardless-sync] linked ${linked} new mandate(s), refreshed ${refreshed}; ${unmatched} active mandate(s) still unmatched`);
  }
  // Terry, 3 Sep 2026: a customer signing up to Direct Debit should reach the team, not just
  // the log. Named, because "1 new mandate" is not something anyone can act on. This runs
  // hourly, so it only fires on the run that actually linked one.
  if (linked && linkedNames.length) {
    const { notifyStaff } = await import('./notifications');
    await notifyStaff(
      linked === 1 ? `Direct Debit set up — ${linkedNames[0]}` : `${linked} new Direct Debit mandates`,
      { type: 'info', link: '/settings/gocardless',
        body: linkedNames.slice(0, 8).join(', ') + (linkedNames.length > 8 ? ` and ${linkedNames.length - 8} more` : '') + ' — now collecting by Direct Debit.' });
  }
  for (const w of state.warnings) console.warn('[gocardless-sync]', w);
  return { total: state.rows.length, linked, unmatched, refreshed };
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
        // balance=0 here because GoCardless is the sole owner of this invoice's payment state
        // (see DIVISION OF AUTHORITY note in lib/quickbooks.ts) — QB's sync never clears it for
        // GC-linked invoices, so this is the only place it ever gets zeroed.
        await pool.query(
          `UPDATE invoices SET payment_status='paid', balance=0,
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
        `UPDATE invoices SET gocardless_payment_id=$2, gocardless_submitted_at=NOW(), payment_status='pending' WHERE id=$1`,
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
