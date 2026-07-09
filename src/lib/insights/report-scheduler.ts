/**
 * Report Scheduler (ported from Insights into the portal).
 *
 * Runs a cron check every minute. For each active report_config, checks if a report
 * is due and generates it, then emails it to the configured recipients.
 * All DB access against the Insights DB via insightsPool.
 */

import cron from 'node-cron';
import { insightsPool } from '../../db/pool';
import { generateWeekly, generateDaily, emailReport } from './report-generator';

function db() {
  if (!insightsPool) throw new Error('Insights database not connected');
  return insightsPool;
}

const DAY_MAP: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 }; // 1=Mon..7=Sun → JS 0=Sun..6=Sat

async function getDueConfigs(): Promise<any[]> {
  const now = new Date();
  const ukOffset = ([4, 5, 6, 7, 8, 9, 10].includes(now.getUTCMonth() + 1)) ? 60 : 0;
  const ukNow    = new Date(now.getTime() + ukOffset * 60000);
  const ukDow    = ukNow.getUTCDay();
  const ukHour   = ukNow.getUTCHours();
  const ukMin    = ukNow.getUTCMinutes();
  const ukHHMM   = `${String(ukHour).padStart(2, '0')}:${String(ukMin).padStart(2, '0')}`;

  const res = await db().query(
    `SELECT rc.*, s.id AS site_id, s.site_label, c.name AS customer_name
     FROM report_configs rc
     JOIN sites s ON s.id = rc.site_id
     JOIN customers c ON c.id = s.customer_id
     WHERE rc.is_active = true`
  );

  const due: any[] = [];
  for (const cfg of res.rows) {
    const sendHHMM = String(cfg.send_time || '').slice(0, 5);
    if (!sendHHMM || sendHHMM !== ukHHMM) continue;

    if (cfg.report_type === 'weekly_call_stats') {
      const targetDow = DAY_MAP[cfg.send_day] ?? 1;
      if (ukDow !== targetDow) continue;
      due.push({ ...cfg, dueDate: getLastMonday(ukNow) });
    } else {
      const yesterday = new Date(ukNow);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      due.push({ ...cfg, dueDate: yesterday });
    }
  }
  return due;
}

function getLastMonday(d: Date): Date {
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() - 7);
  const dow = result.getUTCDay();
  const daysToMon = (dow === 0) ? -6 : 1 - dow;
  result.setUTCDate(result.getUTCDate() + daysToMon);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

async function runScheduler(): Promise<void> {
  if (!insightsPool) return;
  try {
    const due = await getDueConfigs();
    if (due.length === 0) return;

    for (const cfg of due) {
      try {
        const { reportStart, reportEnd } = cfg.report_type === 'weekly_call_stats'
          ? await generateWeekly(cfg.id, cfg.dueDate)
          : await generateDaily(cfg.id, cfg.dueDate);
        const sent = await emailReport(cfg.id, reportStart, reportEnd);
        console.log(`[scheduler] config ${cfg.id} generated; emailed ${sent} recipient(s)`);
      } catch (err) {
        console.error(`Report generation failed for config ${cfg.id}:`, err);
        await db().query(
          `UPDATE generated_reports SET status = 'failed', error_message = $1, updated_at = NOW()
           WHERE config_id = $2 AND status = 'pending'`,
          [String(err), cfg.id]
        );
      }
    }
  } catch (err) {
    console.error('Scheduler error:', err);
  }
}

export function startReportScheduler(): void {
  if (!insightsPool) { console.log('• Report scheduler not started (INSIGHTS_DATABASE_URL not set)'); return; }
  cron.schedule('* * * * *', runScheduler);
  console.log('✓ Report scheduler started (Insights)');
}
