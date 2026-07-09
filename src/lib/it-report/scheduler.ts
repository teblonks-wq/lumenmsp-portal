import cron from 'node-cron';
import { pool } from '../../db/pool';
import { config } from '../../config';
import { sendMail } from '../mailer';
import { getItConfig, getReportNotes, compileSdmNotes, generateItReport, reportDomain } from './generate';

// Monthly IT Snapshot scheduler. Fires at 00:00 on the 1st and produces the PREVIOUS
// calendar month's report for every customer with the monthly report switched on.
// auto_send=true → emails the recipients; auto_send=false → stores a draft for review.
// Dedupes on (customer, period) so a re-run never double-sends.

function prevMonth(ref = new Date()): { from: Date; to: Date; label: string } {
  const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
  const label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from, to, label };
}

export async function runItReportBatch(ref = new Date()): Promise<void> {
  const { from, to, label } = prevMonth(ref);
  const configs = (await pool.query(
    `SELECT cfg.*, c.name AS customer_name, c.entra_tenant_id
       FROM it_report_configs cfg JOIN customers c ON c.id = cfg.customer_id
      WHERE cfg.is_active = true AND c.deleted_at IS NULL`
  )).rows;

  for (const cfg of configs) {
    try {
      // Skip if we've already SENT this customer's report for this period.
      const dup = await pool.query(
        "SELECT 1 FROM it_report_runs WHERE customer_id=$1 AND period_start=$2 AND status='sent' LIMIT 1",
        [cfg.customer_id, from]
      );
      if (dup.rowCount) { console.log(`[it-report] ${cfg.customer_name} already sent for ${label} — skipped`); continue; }

      const conf = await getItConfig(cfg.customer_id);
      const notes = await getReportNotes(cfg.customer_id, from, to);
      const sdmNotes = compileSdmNotes(conf?.sdm_notes || '', notes);
      const recipients = String(conf?.recipients || '').split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));

      const { html, subject } = await generateItReport({
        customerId: cfg.customer_id, customerName: cfg.customer_name, tenant: cfg.entra_tenant_id,
        domain: await reportDomain(cfg.customer_id, conf?.primary_domain), from, to, periodLabel: label,
        sdmNotes, manual: conf?.manual || {}, preparedBy: 'Lumen IT Solutions',
      });

      let status = 'draft';
      let sentAt: Date | null = null;
      if (cfg.auto_send && recipients.length) {
        let sent = 0;
        for (const to2 of recipients) { try { await sendMail({ to: to2, subject, html }); sent++; } catch (e) { console.error(`[it-report] send to ${to2} failed:`, (e as Error).message); } }
        status = sent ? 'sent' : 'failed';
        sentAt = sent ? new Date() : null;
      }
      await pool.query(
        `INSERT INTO it_report_runs (customer_id, period_start, period_end, period_label, sdm_notes, manual, subject, html, status, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [cfg.customer_id, from, to, label, sdmNotes, JSON.stringify(conf?.manual || {}), subject, html, status, sentAt]
      );
      // Review-mode (auto_send off): tell staff the draft is ready to check and send.
      if (status === 'draft') await notifyDraftReady(cfg.customer_id, cfg.customer_name, label).catch(() => {});
      console.log(`[it-report] ${cfg.customer_name} ${label}: ${status}`);
    } catch (e) {
      console.error(`[it-report] failed for customer ${cfg.customer_id}:`, (e as Error).message);
    }
  }
}

// Email staff that a review-mode draft has been generated and is waiting to be sent.
async function notifyDraftReady(customerId: number, customerName: string, label: string): Promise<void> {
  const staff = (await pool.query(
    "SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL"
  )).rows;
  if (!staff.length) return;
  const base = config.APP_URL || 'https://portal.lumenmsp.co.uk';
  const html = `<p style="font-size:15px;"><strong>${String(customerName).replace(/[&<>]/g, '')}'s IT Snapshot for ${label} is drafted and ready to review.</strong></p>
    <p>This customer is set to review-before-send, so it has NOT been emailed. Review it and send when you're happy:</p>
    <p><a href="${base}/it-report/${customerId}/preview" style="display:inline-block;background:#0ea5b7;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-weight:600;">Review &amp; send</a></p>`;
  await Promise.allSettled(staff.map((s: any) => sendMail({ to: s.email, subject: `Review: ${customerName} IT Snapshot — ${label}`, html }).catch(() => {})));
}

// ── 3-day warning ────────────────────────────────────────────────────────────────
// Reports send at 00:00 on the 1st. Three days before that (i.e. when today + 3 days is
// the 1st — handles 28/30/31-day months automatically) we email staff to finalise notes
// and figures for the month that's about to go out.
export async function sendItReportReminders(ref = new Date()): Promise<void> {
  const threeAhead = new Date(ref.getTime());
  threeAhead.setUTCDate(threeAhead.getUTCDate() + 3);
  if (threeAhead.getUTCDate() !== 1) return; // only fire on the day that's 3 days before a 1st

  const monthLabel = ref.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const customers = (await pool.query(
    `SELECT cfg.customer_id, c.name FROM it_report_configs cfg JOIN customers c ON c.id = cfg.customer_id
      WHERE cfg.is_active = true AND c.deleted_at IS NULL ORDER BY c.name`
  )).rows;
  if (!customers.length) return;

  const staff = (await pool.query(
    "SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL"
  )).rows;
  if (!staff.length) return;

  const base = config.APP_URL || 'https://portal.lumenmsp.co.uk';
  const list = customers.map((c: any) => `<li style="margin:3px 0;"><a href="${base}/it-report/${c.customer_id}">${String(c.name).replace(/[&<>]/g, '')}</a></li>`).join('');
  const html = `<p style="font-size:15px;"><strong>Monthly IT Snapshots for ${monthLabel} send at 00:00 on the 1st — in 3 days.</strong></p>
    <p>Please finalise the running notes, SDM commentary and any manual figures for:</p>
    <ul>${list}</ul>
    <p><a href="${base}/it-report" style="display:inline-block;background:#0ea5b7;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-weight:600;">Review IT Reports</a></p>`;
  const subject = `Action: finalise ${monthLabel} IT Snapshots (send in 3 days)`;
  await Promise.allSettled(staff.map((s: any) => sendMail({ to: s.email, subject, html }).catch(() => {})));
  console.log(`[it-report] 3-day reminder sent to ${staff.length} staff for ${monthLabel}`);
}

export function startItReportScheduler(): void {
  // 00:00 on the 1st of every month.
  cron.schedule('0 0 1 * *', () => { runItReportBatch().catch((e) => console.error('[it-report] batch error:', e.message)); });
  // Daily 08:00 check — emails the 3-day warning on the day that is 3 days before the 1st.
  cron.schedule('0 8 * * *', () => { sendItReportReminders().catch((e) => console.error('[it-report] reminder error:', e.message)); });
  console.log('✓ IT Snapshot scheduler started (00:00 on the 1st; 3-day warning at 08:00)');
}
