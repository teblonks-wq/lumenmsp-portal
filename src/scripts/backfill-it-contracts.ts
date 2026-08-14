import { pool } from '../db/pool';
import { backfillContractsToRegister } from '../lib/register';

// ── Back-fill IT service contracts from the monthly IT (IC) invoices ────────────
// Terry, 2026-08-14: "take the monthly IT invoice, add the services to a contract
// dated 01/03/2026 — nothing sent to the customer."
//
// Per customer: the LATEST IC ("IT & Cloud") invoice is the source of truth for what
// recurs. Its NON-GIACOM lines are the Lumen IT services (support, backup, protection);
// its giacom lines are cloud and already live in the register as cloud-feed, so they are
// SKIPPED here — no double-count. Those support lines become one active IT contract per
// customer, dated 2026-03-01, no document generated or sent. backfillContractsToRegister
// then flows them into the register as lumen rows so the IC bill can render from it.
//
//   npm run backfill-it-contracts             ← DRY RUN: full report, writes nothing
//   npm run backfill-it-contracts -- --apply  ← creates the contracts + populates register
//
// Idempotent-ish: a customer who already has an active IT contract is SKIPPED (reported),
// so a second run never doubles a customer up. Delete a wrong contract and re-run.

const APPLY = process.argv.includes('--apply');
const START = '2026-03-01';
const say = (s: string) => console.log(s);
const money = (n: number) => '£' + (Math.round(n * 100) / 100).toFixed(2);

async function nextContractNumber(client: any): Promise<string> {
  const { rows } = await client.query('SELECT contract_number FROM contracts');
  let max = 0;
  for (const r of rows) { const m = String(r.contract_number).match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return 'CON-' + String(max + 1).padStart(4, '0');
}

async function main(): Promise<void> {
  say(`Back-fill IT contracts from monthly IC invoices — ${APPLY ? '*** APPLY ***' : 'DRY RUN (writes nothing)'} — start date ${START}`);
  say('');

  // The latest IC invoice per customer (real bills only — staged drafts have no number).
  const latest = (await pool.query(
    `SELECT DISTINCT ON (i.customer_id) i.id, i.invoice_number, i.customer_id, c.name, i.billing_period, i.issue_date
       FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.invoice_scheme='IC' AND i.deleted_at IS NULL AND i.invoice_number IS NOT NULL
        AND c.deleted_at IS NULL
      ORDER BY i.customer_id, i.issue_date DESC, i.id DESC`)).rows;

  let created = 0, skippedHasContract = 0, skippedNoLines = 0, totalMonthly = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const inv of latest) {
      // Already has an active IT contract? Leave it — don't create a second.
      const has = (await client.query(
        `SELECT 1 FROM contracts WHERE customer_id=$1 AND service_type='IT' AND status='active' AND deleted_at IS NULL LIMIT 1`,
        [inv.customer_id])).rowCount;
      if (has) { skippedHasContract++; say(`  skip  ${inv.name} — already has an active IT contract`); continue; }

      const lines = (await client.query(
        `SELECT description, quantity, unit_price, line_total, sort_order
           FROM invoice_items WHERE invoice_id=$1 AND COALESCE(source,'') <> 'giacom' AND COALESCE(line_total,0) <> 0
          ORDER BY sort_order, id`, [inv.id])).rows;
      if (!lines.length) { skippedNoLines++; say(`  skip  ${inv.name} — ${inv.invoice_number} has no non-cloud service lines (cloud-only customer)`); continue; }

      const monthly = lines.reduce((s: number, l: any) => s + (Number(l.line_total) || 0), 0);
      totalMonthly += monthly;
      say(`  ${APPLY ? 'CREATE' : 'would create'}  ${inv.name}  ← ${inv.invoice_number}  ${lines.length} line(s), ${money(monthly)}/mo`);
      for (const l of lines) say(`        · ${String(l.description).slice(0, 52).padEnd(52)} ${String(Number(l.quantity) || 1).padStart(4)} × ${money(Number(l.unit_price) || 0)}  = ${money(Number(l.line_total) || 0)}`);

      if (APPLY) {
        const number = await nextContractNumber(client);
        const end = new Date(START + 'T00:00:00Z'); end.setUTCFullYear(end.getUTCFullYear() + 1); end.setUTCDate(end.getUTCDate() - 1);
        const ins = await client.query(
          `INSERT INTO contracts (customer_id, contract_number, title, status, service_type, start_date, end_date,
                                  term_months, notice_days, auto_renew, renewal_mode, payment_method, notes, created_by)
           VALUES ($1,$2,'Managed IT Services','active','IT',$3,$4,12,30,true,'auto','direct_debit',$5,NULL) RETURNING id`,
          [inv.customer_id, number, START, end.toISOString().slice(0, 10),
           `Back-filled from ${inv.invoice_number} on ${new Date().toISOString().slice(0, 10)} — internal, not sent to the customer.`]);
        const contractId = ins.rows[0].id;
        let sort = 1;
        for (const l of lines) {
          await client.query(
            `INSERT INTO contract_lines (contract_id, description, quantity, unit_price, billing_frequency, section, line_total, sort_order)
             VALUES ($1,$2,$3,$4,'monthly','IT',$5,$6)`,
            [contractId, l.description, Number(l.quantity) || 1, Number(l.unit_price) || 0, Number(l.line_total) || 0, sort++]);
        }
        await client.query(
          `INSERT INTO contract_terms (contract_id, seq, start_date, end_date, months, source, notes)
           VALUES ($1,1,$2,$3,12,'original','Back-filled from monthly IT invoice')`,
          [contractId, START, end.toISOString().slice(0, 10)]);
      }
      created++;
    }

    say('');
    say(`Summary: ${created} contract(s) ${APPLY ? 'created' : 'to create'}, ${skippedHasContract} skipped (already have one), ${skippedNoLines} skipped (cloud-only). Total ${money(totalMonthly)}/mo.`);

    if (APPLY) {
      await client.query('COMMIT');
      say('Committed. Populating the register from the new contracts…');
      const r = await backfillContractsToRegister('contract-backfill');
      say(`Register: +${r.added} lumen rows, ${r.updated} updated, ${r.ceased} ceased.`);
      say('Done. Open /bureau/register/shadow to compare.');
    } else {
      await client.query('ROLLBACK');
      say('Dry run — rolled back, nothing written. Re-run with --apply when the report looks right.');
    }
  } catch (e: any) {
    await client.query('ROLLBACK');
    say('FAILED, rolled back: ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
