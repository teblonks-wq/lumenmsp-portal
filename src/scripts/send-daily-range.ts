/**
 * One-shot: generate AND email a daily report for every day in a range.
 *
 *   node dist/scripts/send-daily-range.js <configId> <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry]
 *   e.g.  node dist/scripts/send-daily-range.js 4 2026-07-01 2026-07-07
 *
 * Uses the exact same unified template pipeline + emailReport as the scheduler, so output
 * is identical to the 09:00 sends. Regenerating a day resets its status, so a previously
 * sent (legacy-rendered) day is re-sent corrected rather than skipped. --dry generates for
 * review only (no emails).
 */
import { generateDaily, emailReport } from '../lib/insights/report-generator';

async function main(): Promise<void> {
  const [cfgArg, fromArg, toArg, flag] = process.argv.slice(2);
  const configId = parseInt(cfgArg || '', 10);
  const from = new Date(fromArg || '');
  const to = new Date(toArg || fromArg || '');
  const dry = flag === '--dry';
  if (!configId || isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) {
    console.error('Usage: node dist/scripts/send-daily-range.js <configId> <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry]');
    process.exit(1);
  }
  let days = 0, emails = 0;
  for (let d = new Date(from); d <= to && days < 60; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = new Date(d);
    try {
      const { reportStart, reportEnd } = await generateDaily(configId, day);
      days++;
      if (!dry) {
        const n = await emailReport(configId, reportStart, reportEnd);
        emails += n;
        console.log(`  ${day.toISOString().slice(0, 10)} — generated, emailed ${n} recipient(s)`);
      } else {
        console.log(`  ${day.toISOString().slice(0, 10)} — generated (dry run, not emailed)`);
      }
    } catch (e: any) {
      console.error(`  ${day.toISOString().slice(0, 10)} — FAILED: ${e.message}`);
    }
  }
  console.log(`Done: ${days} day(s) generated${dry ? '' : `, ${emails} email(s) sent`}.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
