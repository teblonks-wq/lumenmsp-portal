// Push a contract's lines onto the customer's recurring billing template, so services are
// entered once on the contract rather than typed again on the rate card.
//
// Idempotent by design: every pushed row carries contract_line_id, so a second push UPDATES
// the same rows rather than appending a duplicate set. Lines removed from the contract are
// removed from the template; anything the template holds that did not come from this contract
// (manual entries, Giacom-synced lines) is never touched.
import { pool } from '../db/pool';

export interface PushResult { added: number; updated: number; removed: number; templateId: number | null; reason?: string; }

async function customerTemplateId(customerId: number): Promise<number | null> {
  const r = (await pool.query(
    `SELECT id FROM invoices WHERE customer_id=$1 AND is_recurring=true
       AND invoice_scheme IN ('IT','IC') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [customerId]
  )).rows[0];
  return r ? r.id : null;
}

async function recomputeTemplate(invoiceId: number): Promise<void> {
  await pool.query(
    `UPDATE invoices SET
       subtotal =(SELECT COALESCE(SUM(line_total),0)                  FROM invoice_items WHERE invoice_id=$1),
       tax_total=(SELECT COALESCE(SUM(line_total*tax_rate/100),0)     FROM invoice_items WHERE invoice_id=$1),
       total    =(SELECT COALESCE(SUM(line_total*(1+tax_rate/100)),0) FROM invoice_items WHERE invoice_id=$1),
       updated_at=NOW() WHERE id=$1`, [invoiceId]);
}

export async function pushContractToTemplate(contractId: number): Promise<PushResult> {
  const c = (await pool.query(
    'SELECT id, customer_id FROM contracts WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [contractId])).rows[0];
  if (!c) return { added: 0, updated: 0, removed: 0, templateId: null, reason: 'Contract not found.' };
  if (!c.customer_id) return { added: 0, updated: 0, removed: 0, templateId: null, reason: 'This contract has no customer.' };

  const templateId = await customerTemplateId(c.customer_id);
  if (!templateId) {
    return { added: 0, updated: 0, removed: 0, templateId: null,
      reason: 'This customer has no recurring IT & Cloud template yet — create one on the customer screen first.' };
  }

  // One-off lines are deliberately excluded: the template is the RECURRING bill, and a one-off
  // pushed onto it would re-bill every month.
  const lines = (await pool.query(
    `SELECT id, product_id, description, quantity, unit_price, line_total, billing_frequency, sort_order
       FROM contract_lines WHERE contract_id=$1 AND billing_frequency <> 'one_off' ORDER BY sort_order, id`, [contractId]
  )).rows;

  const client = await pool.connect();
  let added = 0, updated = 0, removed = 0;
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      'SELECT id, contract_line_id FROM invoice_items WHERE invoice_id=$1 AND source=$2 AND contract_line_id IS NOT NULL',
      [templateId, 'contract'])).rows;
    const byLine = new Map<number, number>(existing.map((r: any) => [r.contract_line_id, r.id]));

    const maxSort = ((await client.query(
      'SELECT COALESCE(MAX(sort_order),0) m FROM invoice_items WHERE invoice_id=$1', [templateId])).rows[0].m) || 0;
    let sort = maxSort;

    for (const l of lines) {
      // An annual contract line bills monthly on the template at a twelfth of its value, so the
      // recurring invoice stays a true monthly figure.
      const monthly = l.billing_frequency === 'annual' ? Number(l.line_total) / 12 : Number(l.line_total);
      const qty = Number(l.quantity) || 1;
      const unit = qty ? monthly / qty : monthly;
      const desc = l.billing_frequency === 'annual' ? `${l.description} (annual, billed monthly)` : l.description;
      const hit = byLine.get(l.id);
      if (hit) {
        await client.query(
          `UPDATE invoice_items SET description=$1, quantity=$2, unit_price=$3, line_total=$4, product_id=$5
             WHERE id=$6`, [desc, qty, unit.toFixed(2), monthly.toFixed(2), l.product_id, hit]);
        byLine.delete(l.id); updated++;
      } else {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, source, contract_line_id, sort_order,
                                      description, quantity, unit_price, tax_rate, line_total)
           VALUES ($1,$2,'contract',$3,$4,$5,$6,$7,20,$8)`,
          [templateId, l.product_id, l.id, ++sort, desc, qty, unit.toFixed(2), monthly.toFixed(2)]);
        added++;
      }
    }

    // Whatever is left in the map came from this contract but is no longer on it.
    for (const orphanId of byLine.values()) {
      await client.query('DELETE FROM invoice_items WHERE id=$1', [orphanId]);
      removed++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await recomputeTemplate(templateId);
  return { added, updated, removed, templateId };
}

// ── The other direction: build a draft contract FROM what the customer is already billed ──
//
// Most customers already have a recurring IT & Cloud template — that IS the commercial truth
// of the relationship. Retyping it into a contract invites drift and takes an afternoon per
// customer. This pulls the template straight in, guesses each line's document section, and
// links the two together so a later "Send to billing" updates the same rows instead of
// appending duplicates.

const SECTION_RULES: { section: string; re: RegExp }[] = [
  { section: 'Backup', re: /backup|acronis|veeam|replicat/i },
  { section: 'Cloud',  re: /365|azure|licen[cs]e|cloud|entra|sharepoint|exchange|onedrive|teams|google workspace/i },
  { section: 'Comms',  re: /voip|sip|call|mobile|broadband|line rental|comms|telephon|ddi|circuit|fttp|fttc|leased/i },
  { section: 'Hardware', re: /laptop|desktop|server|hardware|switch|firewall|nas|router|access point|monitor|printer/i },
];

export function guessSection(description: string): string {
  const t = String(description || '');
  for (const r of SECTION_RULES) if (r.re.test(t)) return r.section;
  return 'IT';
}

export interface BuildResult { contractId: number | null; lines: number; monthly: number; reason?: string; }

export async function buildContractFromBilling(
  customerId: number, userId: number | null, nextNumber: () => Promise<string>,
): Promise<BuildResult> {
  const cust = (await pool.query(
    'SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL', [customerId])).rows[0];
  if (!cust) return { contractId: null, lines: 0, monthly: 0, reason: 'Customer not found.' };

  const templateId = await customerTemplateId(customerId);
  if (!templateId) {
    return { contractId: null, lines: 0, monthly: 0,
      reason: 'This customer has no recurring IT & Cloud template, so there is no monthly bill to build from.' };
  }

  // One-offs are excluded: they are not part of a recurring commitment and would misstate the
  // contract value. Zero-value lines are dropped too — usually placeholders on the rate card.
  const src = (await pool.query(
    `SELECT id, product_id, description, quantity, unit_price, line_total
       FROM invoice_items
      WHERE invoice_id=$1 AND COALESCE(is_one_off,false)=false AND COALESCE(line_total,0) > 0
      ORDER BY sort_order, id`, [templateId])).rows;
  if (!src.length) {
    return { contractId: null, lines: 0, monthly: 0,
      reason: 'That customer\'s monthly bill has no recurring lines to build a contract from.' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await nextNumber();
    // Starts on the 1st of next month — a contract that starts mid-billing-period makes the
    // first invoice impossible to reconcile against it.
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() + 1);
    const startIso = start.toISOString().slice(0, 10);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 12);
    end.setUTCDate(end.getUTCDate() - 1);

    const ins = await client.query(
      `INSERT INTO contracts (customer_id, contract_number, title, status, service_type, start_date, end_date,
                              term_months, notice_days, auto_renew, renewal_mode, payment_method, notes, created_by)
       VALUES ($1,$2,$3,'draft','IT',$4,$5,12,30,true,'auto','direct_debit',$6,$7) RETURNING id`,
      [customerId, number, 'Multi Service Agreement', startIso, end.toISOString().slice(0, 10),
       'Drafted from the recurring monthly bill on ' + new Date().toISOString().slice(0, 10) +
       '. Check quantities and prices before sending.', userId]);
    const contractId = ins.rows[0].id;

    let sort = 1, monthly = 0;
    for (const l of src) {
      const section = guessSection(l.description);
      const lineTotal = Number(l.line_total) || 0;
      monthly += lineTotal;
      const cl = await client.query(
        `INSERT INTO contract_lines (contract_id, product_id, description, quantity, unit_price,
                                     billing_frequency, section, line_total, sort_order)
         VALUES ($1,$2,$3,$4,$5,'monthly',$6,$7,$8) RETURNING id`,
        [contractId, l.product_id, l.description, Number(l.quantity) || 1,
         Number(l.unit_price) || 0, section, lineTotal, sort++]);
      // Link the source rate-card row to the contract line it produced, so a later push back
      // to billing updates this row rather than adding a second copy of the same service.
      await client.query(
        `UPDATE invoice_items SET contract_line_id=$1, source='contract' WHERE id=$2`, [cl.rows[0].id, l.id]);
    }

    // Term 1, so the contract can be extended without a backfill later.
    await client.query(
      `INSERT INTO contract_terms (contract_id, seq, start_date, end_date, months, source, notes)
       VALUES ($1,1,$2,$3,12,'original','Drafted from the recurring monthly bill')`,
      [contractId, startIso, end.toISOString().slice(0, 10)]);

    await client.query('COMMIT');
    return { contractId, lines: src.length, monthly };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
