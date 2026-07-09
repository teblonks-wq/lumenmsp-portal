import { pool } from '../db/pool';
import { itCloudAccount, ItCloudLine } from './it-cloud-billing';
import { nextDueDate, nextInvoiceNumber } from './recurring-billing';
import { logActivity } from './activity';
import { getSetting } from './settings';

// IT & Cloud has its OWN billing period, independent of the Comms bill run. Setting
// `itcloud/current_period` (YYYY-MM); defaults to the current calendar month.
export async function itCloudPeriod(): Promise<string> {
  return ((await getSetting('itcloud', 'current_period')) || '').trim() || new Date().toISOString().slice(0, 7);
}

// Hybrid IT & Cloud billing: a customer's `is_recurring` IC invoice is the TEMPLATE (base manual /
// contract lines). Each period we generate an invoice from it (cloning the base) then SYNC the
// Giacom-derived lines on top. Editing a synced line locks it (sync_locked) — sync then leaves it
// alone but records drift vs the latest Giacom figure.

const norm = (s: any): string => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const keyOf = (l: { ref?: string | null; description: string }): string => norm(l.ref || l.description);

async function recomputeAndStamp(client: any, invoiceId: number): Promise<void> {
  const agg = (await client.query("SELECT COALESCE(SUM(line_total),0) sub, COALESCE(SUM(line_total*tax_rate/100),0) tax FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0];
  await client.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3, synced_at=NOW(), updated_at=NOW() WHERE id=$4',
    [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invoiceId]);
}

// Sync the Giacom (source='giacom') lines of one IT&Cloud invoice. Model:
//   • QTY always comes from the import (Giacom feed) — we never set it.
//   • SELL comes from the product list (catalogue standard, or per-customer override in service_pricing),
//     already resolved into acct.cloudLines.
//   • A service that STARTED this billing month is PRO-RATED for the part-month (days live ÷ days in
//     month); everything ongoing bills the full month. ("Changes in arrears.")
// Base lines (manual/contract on the template) are never touched — only giacom lines are rebuilt.
export async function syncItCloudInvoice(invoiceId: number): Promise<{ synced: number; locked: number; drift: number; gone: number; prorata: number }> {
  const inv = (await pool.query('SELECT id, customer_id, billing_period FROM invoices WHERE id=$1 AND deleted_at IS NULL', [invoiceId])).rows[0];
  if (!inv || !inv.customer_id) throw new Error('Invoice not found or has no customer');
  const acct = await itCloudAccount(inv.customer_id);
  const desired = acct.cloudLines.filter((l) => l.salePriceEach !== null) as ItCloudLine[];

  // billing_period = the month billed IN ADVANCE (the full-month run-rate). A service that started in
  // the PRIOR month gets a one-off part-month CATCH-UP in arrears (days live from start → start of the
  // advance month). So a new service's first bill = full advance month + prior part-month, no overlap.
  const ym = (inv.billing_period && /^\d{4}-\d{2}/.test(inv.billing_period)) ? inv.billing_period.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const py = parseInt(ym.slice(0, 4), 10), pm = parseInt(ym.slice(5, 7), 10);
  const periodStart = new Date(Date.UTC(py, pm - 1, 1));      // 1st of the advance month
  const prevMonthStart = new Date(Date.UTC(py, pm - 2, 1));   // 1st of the prior month
  const daysInPrevMonth = new Date(Date.UTC(py, pm - 1, 0)).getUTCDate();
  // Per product_id: qty that started in the PRIOR month (→ needs a part-month catch-up) + earliest start.
  // Qty is import-controlled; this only identifies how much of it is newly-started.
  const splits = (await pool.query(
    `SELECT product_id,
            SUM(quantity) FILTER (WHERE billing_date >= $2 AND billing_date < $3)::numeric AS new_qty,
            MIN(billing_date) FILTER (WHERE billing_date >= $2 AND billing_date < $3) AS new_from
       FROM service_items WHERE customer_id=$1 AND source='giacom' GROUP BY product_id`,
    [inv.customer_id, prevMonthStart.toISOString(), periodStart.toISOString()]
  )).rows;
  const splitByPid = new Map<string, { newQty: number; newFrom: Date | null }>();
  for (const s of splits) splitByPid.set(String(s.product_id), { newQty: Number(s.new_qty) || 0, newFrom: s.new_from ? new Date(s.new_from) : null });

  const client = await pool.connect();
  let synced = 0, prorata = 0;
  const proEvents: Array<{ desc: string; qty: number; from: Date; days: number; ofDays: number }> = [];
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM invoice_items WHERE invoice_id=$1 AND source='giacom'", [invoiceId]);
    const maxSort = (await client.query("SELECT COALESCE(MAX(sort_order),0) m FROM invoice_items WHERE invoice_id=$1 AND source<>'giacom'", [invoiceId])).rows[0].m;
    let sort = Number(maxSort) + 1;
    for (const d of desired) {
      const pid = String(d.ref || '');
      const sell = Number(d.salePriceEach) || 0;
      const totalQty = Number(d.qty) || 0;
      if (totalQty <= 0) continue;
      const baseDesc = d.description + (d.ref ? ' (' + d.ref + ')' : '');
      const split = splitByPid.get(pid) || { newQty: 0, newFrom: null };
      const newQty = Math.min(totalQty, split.newQty);
      const catId = d.catalogueId != null ? d.catalogueId : null; // links the line to its catalogue product → QB item + reporting
      // FULL month for the whole quantity (services in advance) — always billed, never removed.
      await client.query(
        `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total, sync_ref, product_id, last_synced_at)
         VALUES ($1,'giacom','cloud',$2,$3,$4,$5,20,$6,$7,$8,NOW())`,
        [invoiceId, sort++, baseDesc, totalQty, sell.toFixed(2), (sell * totalQty).toFixed(2), norm(d.ref || d.description), catId]
      );
      synced++;
      // PLUS a separate part-month CATCH-UP line (arrears) for qty that started in the PRIOR month —
      // the days it was live before the full advance month begins. Full advance month stays; this is
      // added on top, in the prior month's day-count (no overlap with the advance month).
      if (newQty > 0 && split.newFrom) {
        const startDay = split.newFrom.getUTCDate();
        const daysActive = Math.max(1, Math.min(daysInPrevMonth, daysInPrevMonth - startDay + 1));
        const lineTotal = sell * newQty * (daysActive / daysInPrevMonth);
        const unit = newQty ? lineTotal / newQty : lineTotal;
        const fromStr = split.newFrom.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total, sync_ref, product_id, last_synced_at)
           VALUES ($1,'giacom','cloud',$2,$3,$4,$5,20,$6,$7,$8,NOW())`,
          [invoiceId, sort++, `${baseDesc} — part-month catch-up (${daysActive}/${daysInPrevMonth} days from ${fromStr})`, newQty, unit.toFixed(2), lineTotal.toFixed(2), norm(d.ref || d.description) + '|pro', catId]
        );
        prorata++;
        proEvents.push({ desc: d.description, qty: newQty, from: split.newFrom, days: daysActive, ofDays: daysInPrevMonth });
      }
    }
    await recomputeAndStamp(client, invoiceId);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  // Record each part-month as a detected change in the Service history (once per customer/product/
  // month). Best-effort — never breaks the sync.
  const ps = periodStart.toISOString();
  for (const e of proEvents) {
    try {
      await pool.query(
        `INSERT INTO it_cloud_change_log (customer_id, description, change_type, new_qty, detected_at)
         SELECT $1,$2,'prorata',$3,$4
          WHERE NOT EXISTS (SELECT 1 FROM it_cloud_change_log WHERE customer_id=$1 AND lower(description)=lower($2) AND change_type='prorata' AND detected_at >= $5)`,
        [inv.customer_id, `${e.desc} — part-month ${e.days}/${e.ofDays} days`, e.qty, e.from, ps]
      );
    } catch { /* change log not migrated — ignore */ }
  }
  return { synced, locked: 0, drift: 0, gone: 0, prorata };
}

// Pre-completion audit: scan the Giacom lines of every STAGED invoice in a period and flag any whose
// product doesn't resolve to the DB catalogue (→ no QB item / no reporting category). Matches by the
// Giacom code in sync_ref, so it works whether or not the line was stamped with product_id yet.
//   notInDb = code not in asset_products · noQbItem = in catalogue but no QB item AND no giacom default.
export interface ItCloudAuditRow { invoiceId: number; name: string; notInDb: string[]; noQbItem: string[] }
export async function itCloudStagedAudit(period: string): Promise<ItCloudAuditRow[]> {
  const giacomDefault = ((await getSetting('quickbooks', 'item_giacom')) || (await getSetting('quickbooks', 'item_default')) || '').trim();
  const hasGiacomDefault = !!giacomDefault;
  const { rows } = await pool.query(
    `SELECT i.id AS invoice_id, c.name, ii.description,
            ap.id AS cat_id, ap.quickbooks_item_id AS cat_qb
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN invoice_items ii ON ii.invoice_id = i.id AND ii.source = 'giacom'
       LEFT JOIN asset_products ap ON ap.source_tag = 'giacom' AND ap.is_active = true
              AND lower(ap.code) = lower(split_part(COALESCE(ii.sync_ref,''), '|', 1))
      WHERE i.invoice_scheme = 'IC' AND COALESCE(i.staged, false) = true AND i.deleted_at IS NULL
        AND i.billing_period = $1
      ORDER BY c.name, ii.sort_order, ii.id`, [period]
  );
  const byInv = new Map<number, ItCloudAuditRow>();
  for (const r of rows) {
    let e = byInv.get(r.invoice_id);
    if (!e) { e = { invoiceId: r.invoice_id, name: r.name, notInDb: [], noQbItem: [] }; byInv.set(r.invoice_id, e); }
    if (r.cat_id == null) e.notInDb.push(r.description);
    else if (!(r.cat_qb && String(r.cat_qb).trim()) && !hasGiacomDefault) e.noQbItem.push(r.description);
  }
  return [...byInv.values()].filter((e) => e.notInDb.length || e.noQbItem.length);
}

// Clear the override-lock on a single synced line and re-pull it from Giacom (take-Giacom).
export async function resyncItCloudLine(itemId: number): Promise<number> {
  const it = (await pool.query("SELECT invoice_id FROM invoice_items WHERE id=$1 AND source='giacom'", [itemId])).rows[0];
  if (!it) throw new Error('Not a synced line');
  await pool.query('UPDATE invoice_items SET sync_locked=false, sync_drift=NULL WHERE id=$1', [itemId]);
  const r = await syncItCloudInvoice(it.invoice_id);
  return r.synced;
}

// Generate a period invoice from a customer's template: clone the BASE (non-giacom, non-one-off)
// lines, then layer Giacom on top. Idempotent per (template, period) — re-runs just re-sync.
export async function generateItCloudFromTemplate(templateId: number, period: string, userId: number | null): Promise<{ invoiceId: number; number: string | null; resynced: boolean }> {
  const tpl = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND deleted_at IS NULL', [templateId])).rows[0];
  if (!tpl) throw new Error('Template not found');
  if (!tpl.customer_id) throw new Error('Template has no customer');

  const ex = (await pool.query(
    "SELECT id, invoice_number FROM invoices WHERE recurring_parent_id=$1 AND billing_period=$2 AND deleted_at IS NULL LIMIT 1", [templateId, period]
  )).rows[0];
  if (ex) { await syncItCloudInvoice(ex.id); return { invoiceId: ex.id, number: ex.invoice_number, resynced: true }; }

  const due = nextDueDate(new Date(), tpl.due_day || 1);
  // STAGED: no invoice number is allocated until the run is Completed — the draft lives in Bureau,
  // hidden from the Invoices list, until then.
  const client = await pool.connect();
  let invoiceId = 0;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, billing_period, title, status, payment_status,
         issue_date, due_date, currency_code, subtotal, tax_total, total, notes, terms, created_by, recurring_parent_id, staged)
       VALUES ($1,NULL,'IC',$2,$3,'draft','unpaid',NOW(),$4,'GBP',0,0,0,$5,$6,$7,$8,true) RETURNING id`,
      [tpl.customer_id, period, 'IT & Cloud — ' + period, due, tpl.notes, tpl.terms, userId, templateId]
    );
    invoiceId = ins.rows[0].id;
    // Carry forward the BASE: manual/contract lines AND locked Giacom overrides (the priced M365
    // lines — Giacom itself is unpriced, so the price lives on the override and must persist).
    // Drop one-offs and unlocked auto-synced lines (those re-derive from Giacom on sync below).
    const base = (await client.query(
      "SELECT * FROM invoice_items WHERE invoice_id=$1 AND (source<>'giacom' OR sync_locked=true) AND COALESCE(is_one_off,false)=false ORDER BY sort_order, id", [templateId]
    )).rows;
    let sort = 1;
    for (const b of base) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total, sync_ref, sync_locked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [invoiceId, b.product_id, b.source || 'manual', b.invoice_category, sort++, b.description, b.quantity, b.unit_price, b.tax_rate, b.line_total, b.sync_ref || null, b.sync_locked || false]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await syncItCloudInvoice(invoiceId);
  if (userId) await logActivity(userId, 'created', 'invoices', invoiceId, `IT & Cloud staged from template #${templateId} for ${period}`);
  return { invoiceId, number: null, resynced: false };
}

// Complete the staged IT&Cloud run for a period, END TO END: for every STAGED draft —
//   1) allocate the real IC invoice number + mark it issued (no longer staged → moves to Invoices),
//   2) email the finance contact the PDF, push to QuickBooks, and submit for Direct Debit
//      (reusing the same completeInvoice action as the per-invoice Complete button).
export async function completeItCloudRun(period: string, userId: number | null, issueDate?: string | null, dueDate?: string | null): Promise<{ numbered: number; sent: number; issues: string[] }> {
  const staged = (await pool.query(
    "SELECT id FROM invoices WHERE invoice_scheme='IC' AND staged=true AND billing_period=$1 AND deleted_at IS NULL ORDER BY id", [period]
  )).rows;
  const { completeInvoice } = await import('../routes/integrations');
  const issue = issueDate || null, due = dueDate || null;
  let numbered = 0, sent = 0; const issues: string[] = [];
  for (const s of staged) {
    // 1) allocate a number with retry on the (rare) collision, mark issued + un-stage; set the
    //    confirmed invoice + due dates if provided.
    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      const number = await nextInvoiceNumber('IC');
      try {
        await pool.query(
          `UPDATE invoices SET invoice_number=$1, staged=false, status='issued',
             issue_date=COALESCE($3::date, issue_date), due_date=COALESCE($4::date, due_date), updated_at=NOW() WHERE id=$2`,
          [number, s.id, issue, due]
        );
        done = true; numbered++;
      } catch (e: any) { if (e && e.code === '23505') continue; throw e; }
    }
    if (!done) { issues.push(`#${s.id}: could not allocate a number`); continue; }
    // 2) email finance + push QB + submit for DD (per-invoice complete).
    try {
      const r = await completeInvoice(s.id, userId || 0);
      if (r) { sent++; const probs = r.filter((x) => /fail|no finance|no QB|not emailed/i.test(x)); if (probs.length) issues.push(`#${s.id}: ${probs.join('; ')}`); }
    } catch (e: any) { issues.push(`#${s.id}: complete failed — ${e.message}`); }
  }
  if (userId) await logActivity(userId, 'updated', 'invoices', 0, `IT & Cloud run ${period} completed — ${numbered} numbered, ${sent} sent`);
  return { numbered, sent, issues };
}

// Promote an issued period invoice to be the customer's next template: strip one-offs, set it
// recurring, and retire the old template. Base lines carry forward; synced lines re-derive next run.
export async function promoteItCloudToTemplate(invoiceId: number, userId: number | null): Promise<void> {
  const inv = (await pool.query('SELECT id, customer_id, recurring_parent_id FROM invoices WHERE id=$1 AND deleted_at IS NULL', [invoiceId])).rows[0];
  if (!inv) throw new Error('Invoice not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM invoice_items WHERE invoice_id=$1 AND COALESCE(is_one_off,false)=true', [invoiceId]);
    if (inv.recurring_parent_id) await client.query('UPDATE invoices SET is_recurring=false, recurring_active=false WHERE id=$1', [inv.recurring_parent_id]);
    await client.query('UPDATE invoices SET is_recurring=true, recurring_active=true, recurring_parent_id=NULL WHERE id=$1', [invoiceId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  if (userId) await logActivity(userId, 'updated', 'invoices', invoiceId, 'Promoted to next IT & Cloud template (one-offs stripped)');
}
