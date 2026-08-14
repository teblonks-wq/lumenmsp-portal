import { pool } from '../db/pool';
import { commsRateCard, commsCallCharge, currentCommsPeriod } from './comms-billing';
import { itCloudAccount } from './it-cloud-billing';
import { renderRegisterBill } from './register-render';

// ── Shadow report (design §6): register engine vs live engine, penny-diff ───────
// The cutover gate. For each customer, on the same period, we compute the bill the
// CURRENT engine would produce and the bill the REGISTER would produce, and compare
// the ex-VAT subtotal. Nothing is written; no invoice is created or touched. Cutover
// only when every row is green (or every red is explained).
//
//   green  — within 1p
//   amber  — a difference that is EXPECTED because the register has unpriced lines the
//            live engine also can't price (so both under-bill equally) OR the register
//            simply hasn't been seeded for this customer yet (live > 0, register 0)
//   red    — a real disagreement: the two engines bill different money

export interface ShadowRow {
  customerId: number; customer: string; scheme: 'CS' | 'IC';
  live: number; register: number; diff: number;
  verdict: 'green' | 'amber' | 'red';
  note: string;
  registerUnpriced: number;
}

const p2 = (n: number) => Math.round(n * 100) / 100;

// The live CS subtotal = the same lines generateCommsBillRun would bill: rate-card
// recurring + one-offs + prorata (priced, non-zero) + the arrears calls line.
async function liveCS(customerId: number, period: string | null): Promise<{ subtotal: number; unpriced: number }> {
  const rc = await commsRateCard(customerId, period || undefined);
  const all = [...rc.lines, ...rc.oneOffs, ...rc.prorata];
  const billable = all.filter((l) => l.sale !== null && Number(l.sale) !== 0);
  const unpriced = all.filter((l) => l.sale === null).length;
  let sub = billable.reduce((s, l) => s + (l.sale || 0), 0);
  const cc = await commsCallCharge(customerId, period || undefined);
  if (cc.sell > 0) sub += cc.sell;
  return { subtotal: p2(sub), unpriced };
}

// The live IC subtotal = itCloudAccount priced lines (it + cloud + adjustments).
async function liveIC(customerId: number): Promise<{ subtotal: number; unpriced: number }> {
  const a = await itCloudAccount(customerId);
  const lines = [...a.itLines, ...a.cloudLines, ...a.adjustments];
  const sub = lines.filter((l) => l.sale !== null && Number(l.sale) !== 0).reduce((s, l) => s + (l.sale as number), 0);
  return { subtotal: p2(sub), unpriced: a.unpriced };
}

function judge(live: number, register: number, regUnpriced: number): { verdict: ShadowRow['verdict']; note: string } {
  const diff = p2(register - live);
  if (Math.abs(diff) < 0.01) return { verdict: 'green', note: '' };
  if (register === 0 && live > 0) return { verdict: 'amber', note: 'register not seeded for this customer yet — run Reconcile' };
  if (regUnpriced > 0 && register < live) return { verdict: 'amber', note: `${regUnpriced} register line(s) unpriced — price them and the gap should close` };
  return { verdict: 'red', note: `engines disagree by £${diff.toFixed(2)} — investigate before cutover` };
}

export async function shadowReport(period?: string | null): Promise<{ period: string | null; rows: ShadowRow[]; summary: { green: number; amber: number; red: number; total: number } }> {
  const per = period || (await currentCommsPeriod());

  // CS candidates: customers with recurring comms lines this period.
  const csCustomers = per ? (await pool.query(
    `SELECT DISTINCT si.customer_id AS id, c.name FROM service_items si JOIN customers c ON c.id=si.customer_id
      WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.is_prorata=false AND si.billing_period=$1
        AND c.deleted_at IS NULL ORDER BY c.name`, [per])).rows : [];
  // IC candidates: customers with Giacom lines or an active IT contract.
  const icCustomers = (await pool.query(
    `SELECT c.id, c.name FROM customers c
      WHERE c.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM service_items si WHERE si.customer_id=c.id AND si.source='giacom')
        OR EXISTS (SELECT 1 FROM contracts ct WHERE ct.customer_id=c.id AND ct.service_type='IT' AND ct.status='active' AND ct.deleted_at IS NULL))
      ORDER BY c.name`)).rows;

  const rows: ShadowRow[] = [];
  for (const c of csCustomers) {
    try {
      const live = await liveCS(c.id, per);
      const reg = await renderRegisterBill(c.id, 'CS', per);
      const j = judge(live.subtotal, reg.subtotal, reg.unpriced);
      rows.push({ customerId: c.id, customer: c.name, scheme: 'CS', live: live.subtotal, register: reg.subtotal,
        diff: p2(reg.subtotal - live.subtotal), verdict: j.verdict, note: j.note, registerUnpriced: reg.unpriced });
    } catch (e: any) {
      rows.push({ customerId: c.id, customer: c.name, scheme: 'CS', live: 0, register: 0, diff: 0, verdict: 'red', note: 'error: ' + e.message, registerUnpriced: 0 });
    }
  }
  for (const c of icCustomers) {
    try {
      const live = await liveIC(c.id);
      const reg = await renderRegisterBill(c.id, 'IC', per);
      const j = judge(live.subtotal, reg.subtotal, reg.unpriced);
      rows.push({ customerId: c.id, customer: c.name, scheme: 'IC', live: live.subtotal, register: reg.subtotal,
        diff: p2(reg.subtotal - live.subtotal), verdict: j.verdict, note: j.note, registerUnpriced: reg.unpriced });
    } catch (e: any) {
      rows.push({ customerId: c.id, customer: c.name, scheme: 'IC', live: 0, register: 0, diff: 0, verdict: 'red', note: 'error: ' + e.message, registerUnpriced: 0 });
    }
  }
  rows.sort((a, b) => (a.verdict === b.verdict ? Math.abs(b.diff) - Math.abs(a.diff) : (a.verdict === 'red' ? -1 : b.verdict === 'red' ? 1 : a.verdict === 'amber' ? -1 : 1)));
  const summary = { green: rows.filter((r) => r.verdict === 'green').length, amber: rows.filter((r) => r.verdict === 'amber').length, red: rows.filter((r) => r.verdict === 'red').length, total: rows.length };
  return { period: per, rows, summary };
}
