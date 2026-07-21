import cron from 'node-cron';
import { pool } from '../db/pool';
import { QuickBooks } from './quickbooks';
import { GoCardless, chargeDateFor } from './gocardless';
import { sendMail } from './mailer';
import { renderInvoicePdf } from './invoice-pdf';
import { invoiceEmailHtml } from './emails';
import { logActivity } from './activity';
import { notify } from './notifications';
import { getSetting } from './settings';
import { currentCommsPeriod, prevCommsPeriod, unallocatedClis, commsRateCard, ONEOFF_RE, commsCallCharge } from './comms-billing';
import { itCloudAccount } from './it-cloud-billing';
import { clearItCloudUpfronts } from './it-cloud-deltas';
import { pricedServiceLines } from './service-pricing';
import { config } from '../config';

// A real email address — guards sends so one bad recipient (e.g. an "admin" login with no
// email domain) can't 400 the whole Graph send.
const isEmailAddr = (e: any): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());

// Recurring billing engine. A recurring invoice is a template; on its send_day the
// engine clones it into a fresh invoice dated to the next due_day (e.g. send on the
// 23rd → due the 1st of next month), copies the lines, and runs whichever auto-actions
// are enabled (auto_send / auto_qb / auto_gc). Fully hands-off on the day.

export async function nextInvoiceNumber(scheme: string): Promise<string> {
  // Highest number used within this scheme...
  const { rows } = await pool.query('SELECT invoice_number FROM invoices WHERE invoice_scheme = $1', [scheme]);
  let max = 0;
  for (const r of rows) { const m = String(r.invoice_number || '').match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  // ...but the invoice_number unique constraint is GLOBAL (and recycled/soft-deleted rows still hold
  // their number), so skip past anything already taken to avoid a duplicate-key collision.
  const taken = new Set((await pool.query('SELECT invoice_number FROM invoices')).rows.map((r: any) => String(r.invoice_number)));
  let n = max + 1;
  let num = scheme + '-' + String(n).padStart(4, '0');
  while (taken.has(num)) { n++; num = scheme + '-' + String(n).padStart(4, '0'); }
  return num;
}

// Rebuild an invoice's Giacom (cloud) lines from the customer's current service_items,
// leaving manual/other lines untouched, then recompute totals. The per-unit SELL comes from
// the durable service_pricing table (set in the bureau / pricing sheet). If a line has no
// durable price yet it's "uncosted" — to avoid silently billing at no margin we fall back to
// the supplier total_cost (legacy behaviour); these surface in the bureau needs-attention queue.
export async function refreshGiacomLines(invoiceId: number, customerId: number): Promise<number> {
  const cloud = (await pool.query(
    `SELECT si.product_reference, MIN(si.description) AS description, SUM(si.quantity)::numeric AS quantity,
            si.unit_cost, SUM(si.total_cost)::numeric AS total_cost, sp.sale_price
       FROM service_items si
       LEFT JOIN service_pricing sp
              ON sp.source='giacom' AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.customer_id=$1 AND si.source='giacom'
      GROUP BY si.product_reference, si.unit_cost, sp.sale_price
      ORDER BY MIN(si.description)`, [customerId]
  )).rows;
  await pool.query("DELETE FROM invoice_items WHERE invoice_id=$1 AND source='giacom'", [invoiceId]);
  let sort = Number((await pool.query("SELECT COALESCE(MAX(sort_order),0) AS n FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0].n);
  for (const c of cloud) {
    const qty = Number(c.quantity) || 1;
    // Durable sale price wins; otherwise fall back to supplier total_cost (then unit_cost*qty).
    const unit = c.sale_price !== null && c.sale_price !== undefined ? Number(c.sale_price)
      : (Number(c.total_cost) > 0 ? Number(c.total_cost) / qty : Number(c.unit_cost));
    const lineTotal = unit * qty;
    await pool.query(
      `INSERT INTO invoice_items (invoice_id, source, sort_order, description, quantity, unit_price, tax_rate, line_total)
       VALUES ($1,'giacom',$2,$3,$4,$5,20,$6)`,
      [invoiceId, ++sort, c.description || 'Cloud service', qty, unit.toFixed(2), lineTotal.toFixed(2)]
    );
  }
  const agg = (await pool.query("SELECT COALESCE(SUM(line_total),0) AS sub, COALESCE(SUM(line_total*tax_rate/100),0) AS tax FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0];
  await pool.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3, updated_at=NOW() WHERE id=$4',
    [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invoiceId]);
  return cloud.length;
}

// Rebuild a Comms invoice's call-charges line from call_records for the billing period,
// leaving manual/other lines untouched, then recompute totals. Sell = SUM(cost) × (1 + markup%).
// markup comes from setting bureau/call_markup_pct (default 50). Period defaults to the latest
// imported billing_period for the customer (calls billed in arrears, one month at a time).
export async function refreshCallCharges(invoiceId: number, customerId: number, period?: string): Promise<{ period: string | null; cost: number; sell: number; calls: number }> {
  const markupRaw = await getSetting('bureau', 'call_markup_pct');
  const markup = Number(markupRaw) || 50;
  const per = period || (await pool.query('SELECT MAX(billing_period) AS p FROM call_records WHERE customer_id=$1', [customerId])).rows[0]?.p || null;
  // Remove any prior call-charge line (our managed source='calls', or an imported/relabelled
  // 'Call Charges' line) so we never duplicate it.
  await pool.query("DELETE FROM invoice_items WHERE invoice_id=$1 AND (source='calls' OR lower(description) LIKE 'call charges%')", [invoiceId]);
  let cost = 0, sell = 0, calls = 0;
  if (per) {
    const agg = (await pool.query('SELECT COALESCE(SUM(cost),0) AS c, COUNT(*) AS n FROM call_records WHERE customer_id=$1 AND billing_period=$2', [customerId, per])).rows[0];
    cost = Number(agg.c) || 0; calls = Number(agg.n) || 0;
    sell = Math.round(cost * (1 + markup / 100) * 100) / 100;
  }
  // Always carry a Call Charges line on a Comms invoice — £0 until calls are pulled, then it fills.
  const sort = Number((await pool.query("SELECT COALESCE(MAX(sort_order),0) AS n FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0].n);
  // Tie the line to the 'Telecoms Services' catalogue product so it can be pushed to QuickBooks.
  const prod = (await pool.query("SELECT id FROM asset_products WHERE lower(name)='telecoms services' AND is_active=true ORDER BY id LIMIT 1")).rows[0];
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, product_id, source, sort_order, description, quantity, unit_price, tax_rate, line_total)
     VALUES ($1,$2,'calls',$3,$4,1,$5,20,$5)`,
    [invoiceId, prod?.id ?? null, sort + 1, per ? `Call Charges (${per})` : 'Call Charges', sell.toFixed(2)]
  );
  const agg = (await pool.query("SELECT COALESCE(SUM(line_total),0) AS sub, COALESCE(SUM(line_total*tax_rate/100),0) AS tax FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0];
  await pool.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3, updated_at=NOW() WHERE id=$4',
    [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invoiceId]);
  return { period: per, cost, sell, calls };
}

// First due_day-of-month strictly after `from` (so the 23rd resolves to the 1st of next month).
export function nextDueDate(from: Date, dueDay: number): Date {
  let t = new Date(from.getFullYear(), from.getMonth(), dueDay);
  if (t <= from) t = new Date(from.getFullYear(), from.getMonth() + 1, dueDay);
  return t;
}

export async function generateFromTemplate(templateId: number, userId: number | null): Promise<{ invoiceId: number; number: string; actions: string[] }> {
  const tpl = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND deleted_at IS NULL', [templateId])).rows[0];
  if (!tpl) throw new Error('Template not found');
  // For contract templates, refresh the variable lines so the clone tracks the latest data:
  // IT contracts → Giacom cloud quantities; Comms contracts → call charges for the period.
  if (tpl.customer_id) {
    if (tpl.contract_type === 'IT') { try { await refreshGiacomLines(templateId, tpl.customer_id); } catch (e: any) { console.error('[recurring] giacom refresh failed:', e.message); } }
    else if (tpl.contract_type === 'Comms') { try { await refreshCallCharges(templateId, tpl.customer_id); } catch (e: any) { console.error('[recurring] call-charge refresh failed:', e.message); } }
  }
  const due = nextDueDate(new Date(), tpl.due_day || 1);
  const scheme = tpl.invoice_scheme || 'IT';
  const number = await nextInvoiceNumber(scheme);

  const client = await pool.connect();
  let invoiceId = 0;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, title, payment_method, status, payment_status,
         issue_date, due_date, currency_code, subtotal, tax_total, total, notes, terms, created_by, recurring_parent_id)
       VALUES ($1,$2,$3,$4,$5,'issued','unpaid',$6,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [tpl.customer_id, number, scheme, tpl.title, tpl.payment_method, due, tpl.currency_code,
       tpl.subtotal, tpl.tax_total, tpl.total, tpl.notes, tpl.terms, tpl.created_by, templateId]
    );
    invoiceId = ins.rows[0].id;
    const items = (await client.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id', [templateId])).rows;
    for (const it of items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_id, source, sort_order, description, quantity, unit_price, tax_rate, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoiceId, it.product_id, it.source || 'manual', it.sort_order, it.description, it.quantity, it.unit_price, it.tax_rate, it.line_total]
      );
    }
    // Recompute totals from the copied lines (template totals may have just been refreshed).
    const agg = (await client.query("SELECT COALESCE(SUM(line_total),0) AS sub, COALESCE(SUM(line_total*tax_rate/100),0) AS tax FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0];
    await client.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3 WHERE id=$4',
      [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invoiceId]);
    await client.query('UPDATE invoices SET last_generated_at=NOW() WHERE id=$1', [templateId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  const actions: string[] = [`generated ${number} (due ${due.toISOString().slice(0, 10)})`];
  const inv = (await pool.query(
    `SELECT i.*, c.name, c.email, c.phone, c.website, c.gocardless_mandate_id, c.quickbooks_customer_id, c.billing_contact_id
       FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [invoiceId]
  )).rows[0];

  if (tpl.auto_send) { try { await autoEmail(inv); actions.push('emailed'); } catch (e: any) { actions.push('email failed: ' + e.message); } }
  if (tpl.auto_qb)   { try { const id = await autoQb(inv); actions.push(id ? 'pushed to QB' : 'QB skipped'); } catch (e: any) { actions.push('QB failed: ' + e.message); } }
  if (tpl.auto_gc)   { try { const ok = await autoGc(inv); actions.push(ok ? 'submitted to GoCardless' : 'GC skipped'); } catch (e: any) { actions.push('GC failed: ' + e.message); } }

  await logActivity(userId, 'created', 'invoices', invoiceId, `Recurring: ${actions.join(', ')} (from #${templateId})`);
  return { invoiceId, number, actions };
}

async function autoEmail(inv: any): Promise<void> {
  let to = '';
  if (inv.billing_contact_id) { const bc = await pool.query('SELECT email FROM customer_contacts WHERE id=$1', [inv.billing_contact_id]); to = bc.rows[0]?.email || ''; }
  if (!to && inv.customer_id) { const pc = await pool.query("SELECT email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, id LIMIT 1", [inv.customer_id]); to = pc.rows[0]?.email || ''; }
  if (!to) to = inv.email || '';
  if (!to) throw new Error('no finance email on customer');
  const total = '£' + (Number(inv.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dueDate = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  const html = invoiceEmailHtml({ contactName: '', invoiceNumber: inv.invoice_number, title: inv.title, total, dueDate, directDebit: !!inv.gocardless_mandate_id });
  // Never auto-send a bare invoice: if the PDF render fails, throw so this is recorded as
  // 'email failed' on the bill-run result (staff can retry) rather than the customer
  // receiving an attachment-less invoice.
  let attachments: { filename: string; contentType: string; base64: string }[] = [];
  try { const pdf = await renderInvoicePdf(inv.id); attachments = [{ filename: inv.invoice_number + '.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') }]; }
  catch (e) { console.error('[recurring] invoice PDF attach failed:', (e as Error).message); throw new Error('invoice PDF render failed — not sent (' + (e as Error).message + ')'); }
  await sendMail({ to, subject: 'Invoice ' + inv.invoice_number + ' from Lumen IT Solutions', html, attachments });
  await pool.query(`INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body) VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6)`,
    [inv.id, config.FROM_NAME, config.FROM_EMAIL, to, 'Invoice ' + inv.invoice_number, 'Recurring invoice ' + inv.invoice_number]);
  await pool.query('UPDATE invoices SET emailed_at=NOW() WHERE id=$1', [inv.id]);
}

async function autoQb(inv: any): Promise<string | null> {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) return null;
  let qbCust = inv.quickbooks_customer_id;
  if (!qbCust && inv.customer_id) { qbCust = await qb.findOrCreateCustomer({ name: inv.name, email: inv.email, phone: inv.phone, website: inv.website }); await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbCust, inv.customer_id]); }
  if (!qbCust) return null;
  const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [inv.id])).rows;
  const qbId = await qb.pushInvoice(inv, items, qbCust);
  await pool.query('UPDATE invoices SET quickbooks_invoice_id=$1 WHERE id=$2', [qbId, inv.id]);
  return qbId;
}

async function autoGc(inv: any): Promise<boolean> {
  if (!inv.gocardless_mandate_id || inv.gocardless_payment_id) return false;
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) return false;
  const gcId = await gc.createPayment(inv.gocardless_mandate_id, Math.round(Number(inv.total) * 100), 'Invoice ' + inv.invoice_number, chargeDateFor(inv.due_date));
  await pool.query(`UPDATE invoices SET gocardless_payment_id=$1, payment_status='pending' WHERE id=$2`, [gcId, inv.id]);
  return true;
}

// Generate for every active template whose send_day is today (once per month).
export async function runDueRecurring(): Promise<number> {
  // SAFETY KILL-SWITCH — recurring auto-billing only runs when explicitly enabled.
  // Defaults OFF so no invoices are emailed / pushed to QB / charged via GoCardless until
  // someone sets billing.recurring_enabled='true'. Manual comms/cloud bill runs are unaffected.
  if ((await getSetting('billing', 'recurring_enabled')) !== 'true') {
    console.log('[recurring] skipped — billing.recurring_enabled is off (no auto-invoicing)');
    return 0;
  }
  const today = new Date();
  const ym = today.getFullYear() * 100 + (today.getMonth() + 1);
  const tpls = (await pool.query(
    "SELECT id, last_generated_at FROM invoices WHERE is_recurring=true AND recurring_active=true AND send_day=$1 AND deleted_at IS NULL", [today.getDate()]
  )).rows;
  let n = 0;
  for (const t of tpls) {
    if (t.last_generated_at) { const d = new Date(t.last_generated_at); if (d.getFullYear() * 100 + (d.getMonth() + 1) === ym) continue; }
    try { await generateFromTemplate(t.id, null); n++; } catch (e: any) { console.error('[recurring] generate failed for template', t.id, e.message); }
  }
  if (n) console.log('[recurring] generated', n, 'invoices');
  return n;
}

// Generate the comms bill run for a period — one DRAFT invoice per customer, built from the
// rate card (six categories) + priced one-off charges. One-offs are stamped billed_at so they
// bill once and then drop. Invoices are dated/due the 1st of next month. Idempotent: skips a
// customer who already has a CS invoice for this period.
export async function generateCommsBillRun(period: string, userId: number | null): Promise<{ created: number; skipped: number; invoiceIds: number[] }> {
  const custs = (await pool.query(
    `SELECT DISTINCT si.customer_id AS id
       FROM service_items si
      WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.is_prorata=false AND si.billing_period=$1`, [period]
  )).rows;
  const due = nextDueDate(new Date(), 1); // 1st of next month
  let created = 0, skipped = 0; const invoiceIds: number[] = [];
  for (const c of custs) {
    const exists = (await pool.query(
      "SELECT 1 FROM invoices WHERE customer_id=$1 AND invoice_scheme='CS' AND billing_period=$2 AND deleted_at IS NULL LIMIT 1", [c.id, period]
    )).rowCount;
    if (exists) { skipped++; continue; }
    const rc = await commsRateCard(c.id, period);
    const billable = [...rc.lines, ...rc.oneOffs, ...rc.prorata].filter((l) => l.sale !== null && Number(l.sale) !== 0);
    if (!billable.length) { skipped++; continue; }
    const number = await nextInvoiceNumber('CS');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, billing_period, title, status, payment_status,
           issue_date, due_date, currency_code, subtotal, tax_total, total, created_by)
         VALUES ($1,$2,'CS',$3,$4,'draft','unpaid',$5,$5,'GBP',0,0,0,$6) RETURNING id`,
        [c.id, number, period, 'Comms Services — ' + period, due, userId]
      );
      const invId = ins.rows[0].id; let sort = 1;
      for (const l of billable) {
        const qty = l.qty || 1; const lineTotal = Number(l.sale) || 0; const unit = qty ? lineTotal / qty : lineTotal;
        const desc = l.label + (l.ref ? ' (' + l.ref + ')' : '') + (l.location ? ' — ' + l.location : '');
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,'comms',$2,$3,$4,$5,$6,20,$7)`,
          [invId, l.category, sort++, desc, qty, unit.toFixed(2), lineTotal.toFixed(2)]
        );
      }
      // Call charges = the PREVIOUS month's calls (arrears), per-type markup. Single summary line.
      const cc = await commsCallCharge(c.id, period);
      if (cc.sell > 0) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,'calls','call',$2,$3,1,$4,20,$4)`,
          [invId, sort++, 'Call Charges — ' + (cc.period || '') + ' (prev month)', cc.sell.toFixed(2)]
        );
      }
      const agg = (await client.query("SELECT COALESCE(SUM(line_total),0) sub, COALESCE(SUM(line_total*tax_rate/100),0) tax FROM invoice_items WHERE invoice_id=$1", [invId])).rows[0];
      await client.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3 WHERE id=$4',
        [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invId]);
      // Stamp one-offs as billed so they drop off future rate cards/bills.
      await client.query(
        `UPDATE service_items SET billed_at=NOW() WHERE source='comms' AND customer_id=$1 AND billed_at IS NULL
           AND (is_one_off=true OR description ~* $2 OR (billing_from IS NOT NULL AND billing_from = billing_to)
                OR is_prorata=true)`,
        [c.id, ONEOFF_RE.source]
      );
      await client.query('COMMIT');
      invoiceIds.push(invId); created++;
    } catch (e) { await client.query('ROLLBACK'); console.error('[bill-run] customer', c.id, 'failed:', (e as Error).message); skipped++; }
    finally { client.release(); }
  }
  if (userId) await logActivity(userId, 'created', 'invoices', 0, `Comms bill run ${period}: ${created} draft invoice(s), ${skipped} skipped`);
  return { created, skipped, invoiceIds };
}

// Finalise (send) a comms bill run: for every DRAFT CS invoice in the period —
//  1) email it to the billing/finance contact WITH the PDF attached,
//  2) push it to QuickBooks (if connected),
//  3) GoCardless: if the customer has a mandate → request payment; else → email a DD-setup invite.
// Each step is independent + guarded; integrations that aren't configured are skipped, not failed.
// Returns a per-step summary + any issues. This is the deliberate "Complete & send" action.
export async function finaliseCommsBillRun(period: string, userId: number | null): Promise<{ count: number; emailed: number; qbPushed: number; collected: number; invited: number; issues: string[] }> {
  const invs = (await pool.query(
    `SELECT i.id, i.invoice_number, i.title, i.total, i.due_date, i.quickbooks_invoice_id,
            c.id AS customer_id, c.name AS customer_name, c.email AS cust_email, c.phone, c.website,
            c.quickbooks_customer_id, c.gocardless_mandate_id,
            bc.email AS billing_email, bc.full_name AS billing_name
       FROM invoices i JOIN customers c ON c.id=i.customer_id
       LEFT JOIN customer_contacts bc ON bc.id=c.billing_contact_id
      WHERE i.invoice_scheme='CS' AND i.billing_period=$1 AND i.status='draft' AND i.deleted_at IS NULL`, [period]
  )).rows;
  const qb = await QuickBooks.load(); const qbOn = qb.isConnected();
  const gc = await GoCardless.load(); const gcOn = gc.isConfigured();
  let emailed = 0, qbPushed = 0, collected = 0, invited = 0; const issues: string[] = [];

  for (const inv of invs) {
    const to = inv.billing_email || ''; // finance/billing contact ONLY — no general-email fallback
    const name = inv.billing_name || inv.customer_name || 'there';
    // 1) Email + PDF — never email a bare invoice; if the PDF fails, skip the email for this one.
    try {
      if (!isEmailAddr(to)) { issues.push(`${inv.customer_name}: no finance contact email — not sent (set a billing contact)`); }
      else {
        const pdf = await renderInvoicePdf(inv.id);
        if (!pdf || pdf.length < 1000) throw new Error('invoice PDF render produced an empty/invalid file — not sending a bare invoice');
        const total = '£' + (Number(inv.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const dueDate = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
        const body = invoiceEmailHtml({ contactName: name, invoiceNumber: inv.invoice_number, title: inv.title, total, dueDate, directDebit: !!inv.gocardless_mandate_id });
        await sendMail({ to, subject: `Invoice ${inv.invoice_number} from Lumen IT Solutions`, html: body, signatureName: 'Accounts Department', attachments: [{ filename: inv.invoice_number + '.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') }] });
        await pool.query("UPDATE invoices SET emailed_at=NOW(), status=CASE WHEN status='draft' THEN 'issued' ELSE status END WHERE id=$1", [inv.id]);
        // Record the send in communications too — the invoice list's "emailed" envelope (and
        // the emailed=yes/no filter) read from THERE, not from emailed_at. Mirrors the manual
        // per-invoice send so bulk-sent and hand-sent invoices look identical.
        await pool.query(
          `INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, sent_by_user_id)
           VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6,$7)`,
          [inv.id, config.FROM_NAME, config.FROM_EMAIL, to, 'Invoice ' + inv.invoice_number, 'Invoice ' + inv.invoice_number + ' sent to finance contact (bill run).', userId]
        );
        emailed++;
      }
    } catch (e) { issues.push(`${inv.customer_name}: email failed — ${(e as Error).message}`); }

    // 2) QuickBooks push (skip if not connected or already pushed).
    if (qbOn && !inv.quickbooks_invoice_id) {
      try {
        let qbCust = inv.quickbooks_customer_id;
        if (!qbCust) { qbCust = await qb.findOrCreateCustomer({ name: inv.customer_name, email: inv.cust_email, phone: inv.phone, website: inv.website }); await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbCust, inv.customer_id]); }
        const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id', [inv.id])).rows;
        const qbId = await qb.pushInvoice(inv, items, qbCust);
        await pool.query('UPDATE invoices SET quickbooks_invoice_id=$1 WHERE id=$2', [qbId, inv.id]);
        qbPushed++;
      } catch (e) { issues.push(`${inv.customer_name}: QuickBooks push failed — ${(e as Error).message}`); }
    }

    // 3) GoCardless — collect if there's a mandate, else invite to set up Direct Debit.
    if (gcOn) {
      try {
        if (inv.gocardless_mandate_id) {
          const pence = Math.round((Number(inv.total) || 0) * 100);
          if (pence > 0) {
            const gcId = await gc.createPayment(inv.gocardless_mandate_id, pence, 'Invoice ' + inv.invoice_number, chargeDateFor(inv.due_date));
            await pool.query("UPDATE invoices SET gocardless_payment_id=$1, payment_status='pending' WHERE id=$2", [gcId, inv.id]);
            collected++;
          }
        } else if (isEmailAddr(to)) {
          const flow = await gc.createMandateSetupFlow({
            redirectUri: config.APP_URL + '/gc/return', exitUri: config.APP_URL + '/gc/return',
            email: to, companyName: inv.customer_name, metadata: { customer_id: String(inv.customer_id) },
          });
          await sendMail({
            to, subject: 'Set up Direct Debit — Lumen IT Solutions',
            html: `<p>Hi ${name},</p><p>To pay your invoices automatically by Direct Debit, please set up a mandate using the secure link below (it takes a minute):</p><p><a href="${flow.authorisationUrl}">Set up Direct Debit</a></p><p>Your latest invoice <strong>${inv.invoice_number}</strong> is attached to a separate email.</p>`,
            signatureName: 'Accounts Department',
          });
          invited++;
        }
      } catch (e) { issues.push(`${inv.customer_name}: GoCardless failed — ${(e as Error).message}`); }
    }

    // 4) LOCKDOWN — stamp the calls this invoice covered (same window the draft billed:
    // unbilled, newer than the floor, up to the month before the service period). Selection
    // by flag means a skipped/rolled month can never orphan or double-bill calls.
    try {
      const floor = String((await getSetting('comms', 'calls_billed_floor')) || '2026-05');
      await pool.query(
        `UPDATE call_records SET billed_at=NOW()
          WHERE customer_id=$1 AND billed_at IS NULL AND billing_period > $2 AND billing_period <= $3`,
        [inv.customer_id, floor, prevCommsPeriod(period)]
      );
    } catch (e) { issues.push(`${inv.customer_name}: call billed-stamp failed — ${(e as Error).message}`); }
  }
  if (userId) await logActivity(userId, 'updated', 'invoices', 0, `Comms bill run ${period} finalised: ${emailed} emailed, ${qbPushed} → QB, ${collected} DD collected, ${invited} DD invite(s)`);
  return { count: invs.length, emailed, qbPushed, collected, invited, issues };
}

// IT & Cloud bill run — ONE consolidated draft invoice per customer = IT Services contract lines +
// live Giacom O365/cloud lines (from itCloudAccount). Blocks customers with no billing contact.
// Idempotent (skips a customer already invoiced for the period). Invoices dated/due the 1st.
export async function generateItCloudBillRun(period: string, userId: number | null): Promise<{ created: number; skipped: number; blocked: string[]; invoiceIds: number[] }> {
  const custs = (await pool.query(
    `SELECT c.id, c.name FROM customers c
      WHERE c.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM service_items si WHERE si.customer_id=c.id AND si.source='giacom')
        OR EXISTS (SELECT 1 FROM contracts ct WHERE ct.customer_id=c.id AND ct.service_type='IT' AND ct.status='active' AND ct.deleted_at IS NULL))
      ORDER BY c.name`
  )).rows;
  const due = nextDueDate(new Date(), 1);
  let created = 0, skipped = 0; const blocked: string[] = []; const invoiceIds: number[] = [];
  for (const c of custs) {
    const acct = await itCloudAccount(c.id);
    if (!acct.hasBillingContact) { blocked.push(c.name); continue; }
    const lines = [...acct.itLines, ...acct.cloudLines, ...acct.adjustments].filter((l) => l.sale !== null && Number(l.sale) !== 0);
    if (!lines.length) { skipped++; continue; }
    const exists = (await pool.query(
      "SELECT 1 FROM invoices WHERE customer_id=$1 AND invoice_scheme='IC' AND billing_period=$2 AND deleted_at IS NULL LIMIT 1", [c.id, period]
    )).rowCount;
    if (exists) { skipped++; continue; }
    const number = await nextInvoiceNumber('IC');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, billing_period, title, status, payment_status,
           issue_date, due_date, currency_code, subtotal, tax_total, total, created_by)
         VALUES ($1,$2,'IC',$3,$4,'draft','unpaid',$5,$5,'GBP',0,0,0,$6) RETURNING id`,
        [c.id, number, period, 'IT & Cloud — ' + period, due, userId]
      );
      const invId = ins.rows[0].id; let sort = 1;
      for (const l of lines) {
        const qty = l.qty || 1; const lineTotal = Number(l.sale) || 0; const unit = qty ? lineTotal / qty : lineTotal;
        const desc = l.description + (l.ref ? ' (' + l.ref + ')' : '');
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,20,$8)`,
          [invId, l.source === 'contract' ? 'contract' : 'giacom', l.kind === 'it' ? 'it_services' : 'cloud', sort++, desc, qty, unit.toFixed(2), lineTotal.toFixed(2)]
        );
      }
      const agg = (await client.query("SELECT COALESCE(SUM(line_total),0) sub, COALESCE(SUM(line_total*tax_rate/100),0) tax FROM invoice_items WHERE invoice_id=$1", [invId])).rows[0];
      await client.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3 WHERE id=$4',
        [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invId]);
      await client.query('COMMIT');
      await clearItCloudUpfronts(c.id); // the advance-month charges are now billed — don't repeat
      invoiceIds.push(invId); created++;
    } catch (e) { await client.query('ROLLBACK'); console.error('[itcloud bill-run] customer', c.id, 'failed:', (e as Error).message); skipped++; }
    finally { client.release(); }
  }
  if (userId) await logActivity(userId, 'created', 'invoices', 0, `IT & Cloud bill run ${period}: ${created} draft invoice(s), ${skipped} skipped, ${blocked.length} blocked (no billing contact)`);
  return { created, skipped, blocked, invoiceIds };
}

// Regenerate an EXISTING invoice's lines from current source data, in place (keeps the same
// invoice number/record). Dispatches on scheme: CS=comms (rate card + arrears calls),
// IC=IT&Cloud (itCloudAccount), else by contract_type (Giacom / call charges). Never touches a
// paid or void invoice. QuickBooks is NOT auto-updated — re-push separately if already in QB.
export async function regenerateInvoice(invoiceId: number, userId: number | null): Promise<{ ok: boolean; message: string }> {
  const inv = (await pool.query(
    'SELECT id, customer_id, invoice_scheme, billing_period, contract_type, status FROM invoices WHERE id=$1 AND deleted_at IS NULL', [invoiceId]
  )).rows[0];
  if (!inv) return { ok: false, message: 'Invoice not found' };
  if (!inv.customer_id) return { ok: false, message: 'Invoice has no customer to rebuild from' };
  if (['paid', 'void'].includes(inv.status)) return { ok: false, message: `Cannot regenerate a ${inv.status} invoice` };

  const scheme = inv.invoice_scheme || '';
  const cid = inv.customer_id;
  const recompute = async (client: any) => {
    const agg = (await client.query("SELECT COALESCE(SUM(line_total),0) sub, COALESCE(SUM(line_total*tax_rate/100),0) tax FROM invoice_items WHERE invoice_id=$1", [invoiceId])).rows[0];
    await client.query('UPDATE invoices SET subtotal=$1, tax_total=$2, total=$3, updated_at=NOW() WHERE id=$4',
      [Number(agg.sub).toFixed(2), Number(agg.tax).toFixed(2), (Number(agg.sub) + Number(agg.tax)).toFixed(2), invoiceId]);
  };

  if (scheme === 'CS') {
    const period = inv.billing_period;
    if (!period) return { ok: false, message: 'Comms invoice has no billing period to rebuild from' };
    const rc = await commsRateCard(cid, period);
    const billable = [...rc.lines, ...rc.oneOffs, ...rc.prorata].filter((l) => l.sale !== null && Number(l.sale) !== 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM invoice_items WHERE invoice_id=$1', [invoiceId]);
      let sort = 1;
      for (const l of billable) {
        const qty = l.qty || 1; const lineTotal = Number(l.sale) || 0; const unit = qty ? lineTotal / qty : lineTotal;
        const desc = l.label + (l.ref ? ' (' + l.ref + ')' : '') + (l.location ? ' — ' + l.location : '');
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,'comms',$2,$3,$4,$5,$6,20,$7)`, [invoiceId, l.category, sort++, desc, qty, unit.toFixed(2), lineTotal.toFixed(2)]
        );
      }
      const cc = await commsCallCharge(cid, period);
      if (cc.sell > 0) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,'calls','call',$2,$3,1,$4,20,$4)`, [invoiceId, sort++, 'Call Charges — ' + (cc.period || '') + ' (prev month)', cc.sell.toFixed(2)]
        );
      }
      await recompute(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (userId) await logActivity(userId, 'updated', 'invoices', invoiceId, 'Regenerated comms lines from source');
    return { ok: true, message: `rebuilt ${billable.length} comms line(s) + call charges` };
  }

  if (scheme === 'IC') {
    const acct = await itCloudAccount(cid);
    const lines = [...acct.itLines, ...acct.cloudLines, ...acct.adjustments].filter((l) => l.sale !== null && Number(l.sale) !== 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM invoice_items WHERE invoice_id=$1', [invoiceId]);
      let sort = 1;
      for (const l of lines) {
        const qty = l.qty || 1; const lineTotal = Number(l.sale) || 0; const unit = qty ? lineTotal / qty : lineTotal;
        const desc = l.description + (l.ref ? ' (' + l.ref + ')' : '');
        await client.query(
          `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,20,$8)`,
          [invoiceId, l.source === 'contract' ? 'contract' : 'giacom', l.kind === 'it' ? 'it_services' : 'cloud', sort++, desc, qty, unit.toFixed(2), lineTotal.toFixed(2)]
        );
      }
      await recompute(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (userId) await logActivity(userId, 'updated', 'invoices', invoiceId, 'Regenerated IT & Cloud lines from source');
    return { ok: true, message: `rebuilt ${lines.length} IT & Cloud line(s)` };
  }

  if (inv.contract_type === 'IT') {
    const n = await refreshGiacomLines(invoiceId, cid);
    if (userId) await logActivity(userId, 'updated', 'invoices', invoiceId, 'Regenerated Giacom lines from source');
    return { ok: true, message: `refreshed ${n} Giacom line(s)` };
  }
  if (inv.contract_type === 'Comms') {
    const r = await refreshCallCharges(invoiceId, cid);
    if (userId) await logActivity(userId, 'updated', 'invoices', invoiceId, 'Regenerated call charges from source');
    return { ok: true, message: r.period ? `refreshed calls for ${r.period}` : 'no call records found' };
  }

  return { ok: false, message: 'This is a manual invoice with no linked source to rebuild from — edit the lines directly.' };
}

// Comms bill-run reminder. Fires every 4 hours across the 20th→23rd so the 23rd deadline
// isn't missed. Stage-aware: it reports exactly what's still outstanding (CLIs to allocate,
// services to price) and stops once the run for this period is marked complete.
export async function remindCommsBillRun(force = false): Promise<number> {
  const period = await currentCommsPeriod();
  // Already completed this period? Don't nag.
  if (period && !force) {
    const done = await getSetting('comms', 'billrun_done_' + period);
    if (done) { return 0; }
  }
  const day = new Date().getDate();
  const clis = await unallocatedClis();
  const priced = await pricedServiceLines({ sources: ['comms'] });
  const uncosted = priced.filter((l) => l.sale_price === null).length;
  const outstanding = clis.length + uncosted;
  const link = '/bureau/bill-run';
  const stage = clis.length ? `${clis.length} CLI(s) to allocate` : uncosted ? `${uncosted} service(s) to price` : 'intray clear — ready to run the month';
  const title = day >= 23 ? 'Comms bill run — RUN DUE TODAY (23rd)' : 'Comms bill run due by the 23rd';
  const body = `${stage}. ${outstanding ? 'Clear the intray, then run the month (due the 1st).' : 'Press Run month on the bill-run screen.'}`;
  const users = (await pool.query(
    "SELECT id, email, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND (finance_group=true OR role='admin')"
  )).rows;
  let sent = 0;
  for (const u of users) {
    await notify(u.id, title, { body, link, type: 'action' });
    if (isEmailAddr(u.email)) {
      try {
        await sendMail({ to: u.email, subject: title,
          html: `<p>Hi ${u.display_name || ''},</p><p><strong>${stage}.</strong></p><p>${body}</p><p><a href="${config.APP_URL}${link}">Open the Comms Bill Run →</a></p>` });
      } catch (e) { console.error('[bill-run reminder] email failed:', (e as Error).message); }
    }
    sent++;
  }
  console.log('[bill-run reminder] notified', sent, 'finance user(s);', outstanding, 'item(s) outstanding');
  return sent;
}

let _started = false;
export function startRecurringBilling(): void {
  if (_started) return; _started = true;
  cron.schedule('0 6 * * *', () => { runDueRecurring().catch((e) => console.error('[recurring]', e.message)); });
  // Comms bill-run reminder: every 4 hours on the 20th–23rd (08:00 first). Stops when done.
  cron.schedule('0 8,12,16,20 20-23 * *', () => { remindCommsBillRun().catch((e) => console.error('[bill-run reminder]', e.message)); });
  console.log('[recurring] billing scheduled (06:00 daily); bill-run reminder (4-hourly, 20th–23rd)');
}
