// Renewal watch. Without this a term simply lapses, or auto-renews, with nobody noticing —
// which is exactly how Staybrook got to three days out before anyone looked.
//
// Two dates matter, and they are not the same one: the term END, and the last day NOTICE can
// still be given (end minus notice_days). The notice date is the one that actually costs
// money to miss, so it is what the stages are anchored to.
import cron from 'node-cron';
import { pool } from '../db/pool';
import { alertGroup } from './notifications';
import { logDocEvent } from './doc-events';

export interface RenewalRow {
  id: number; contract_number: string; title: string; customer_id: number | null;
  customer_name: string | null; end_date: Date; notice_days: number; renewal_mode: string;
  term_months: number | null; monthly: string; days_to_end: number; days_to_notice: number;
}

// Stages, in days-to-notice-deadline. Each fires once per contract per term.
// ORDER MATTERS: tightest threshold first, because stageFor returns the first match. Listed
// loosest-first, a contract 3 days from its deadline matches the 60-day stage, alerts once as
// "60 days", and — having already alerted — never escalates. It would go quiet exactly when
// it mattered most.
const STAGES: { key: string; atOrBelow: number; label: string }[] = [
  { key: 'past', atOrBelow: 0,  label: 'notice deadline passed' },
  { key: 't-7',  atOrBelow: 7,  label: '7 days' },
  { key: 't-30', atOrBelow: 30, label: '30 days' },
  { key: 't-60', atOrBelow: 60, label: '60 days' },
];

export async function dueRenewals(withinDays = 90): Promise<RenewalRow[]> {
  const { rows } = await pool.query(
    `SELECT ct.id, ct.contract_number, ct.title, ct.customer_id, ct.end_date, ct.notice_days,
            ct.renewal_mode, ct.term_months, c.name AS customer_name,
            COALESCE((SELECT SUM(line_total) FROM contract_lines cl
                       WHERE cl.contract_id = ct.id AND cl.billing_frequency='monthly'), 0) AS monthly,
            (ct.end_date - CURRENT_DATE)                        AS days_to_end,
            (ct.end_date - ct.notice_days - CURRENT_DATE)       AS days_to_notice
       FROM contracts ct
       LEFT JOIN customers c ON c.id = ct.customer_id
      WHERE ct.deleted_at IS NULL
        AND ct.status = 'active'
        AND ct.end_date IS NOT NULL
        AND ct.end_date >= CURRENT_DATE - 30
        AND (ct.end_date - CURRENT_DATE) <= $1
      ORDER BY ct.end_date ASC`, [withinDays]);
  return rows;
}

function stageFor(daysToNotice: number): { key: string; label: string } | null {
  for (const s of STAGES) if (daysToNotice <= s.atOrBelow) return { key: s.key, label: s.label };
  return null;
}

// Has this contract already been chased at this stage for its CURRENT end date? Keyed on the
// end date as well as the stage, so extending the term re-arms every reminder.
async function alreadySent(contractId: number, stage: string, endDate: any): Promise<boolean> {
  const key = stage + '|' + new Date(endDate).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT 1 FROM document_events
      WHERE doc_type='contract' AND doc_id=$1 AND event='reminder_sent'
        AND meta->>'stageKey' = $2 LIMIT 1`, [contractId, key]);
  return rows.length > 0;
}

export async function runRenewalSweep(): Promise<{ checked: number; alerted: number }> {
  const due = await dueRenewals(90);
  let alerted = 0;
  for (const r of due) {
    const stage = stageFor(Number(r.days_to_notice));
    if (!stage) continue;
    if (await alreadySent(r.id, stage.key, r.end_date)) continue;

    const who = r.customer_name || 'Unknown customer';
    const monthly = '£' + (Number(r.monthly) || 0).toFixed(2);
    const ends = new Date(r.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const body = stage.key === 'past'
      ? `${who} — the notice deadline has passed. The term ends ${ends} and will ` +
        `${r.renewal_mode === 'signed_extension' ? 'NOT renew without a signed extension' : 'auto-renew'}. ${monthly}/month.`
      : `${who} — ${stage.label} left to give notice. Term ends ${ends}. ${monthly}/month.`;

    await alertGroup('sales', 'Contract renewal — ' + r.contract_number, body, '/contracts/' + r.id);
    await logDocEvent('contract', r.id, 'reminder_sent', {
      customerId: r.customer_id,
      meta: { stage: stage.key, stageKey: stage.key + '|' + new Date(r.end_date).toISOString().slice(0, 10),
              daysToEnd: Number(r.days_to_end), daysToNotice: Number(r.days_to_notice) },
    });
    alerted++;
  }
  return { checked: due.length, alerted };
}

export function startRenewalScheduler(): void {
  // 08:15 daily — just after the other morning reminders, so the team gets one batch.
  cron.schedule('15 8 * * *', () => {
    runRenewalSweep()
      .then((r) => { if (r.alerted) console.log(`[renewals] ${r.alerted} alert(s) from ${r.checked} contract(s) in window`); })
      .catch((e) => console.error('[renewals] sweep failed:', e.message));
  });
  console.log('✓ Contract renewal watch scheduled (08:15 daily)');
}
