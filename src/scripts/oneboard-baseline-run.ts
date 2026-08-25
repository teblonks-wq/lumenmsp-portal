/**
 * Rebuild the OneBoard year cache (oneboard_day_stats) on demand.
 *
 * The nightly job runs at 02:25. This is for when you don't want to wait, or when you
 * want to WATCH it and see why it did nothing — which is the situation that produced
 * this script (2026-08-25: the builder returned "nothing to do" instantly and silently
 * for every customer, because a Postgres date came back as a JS Date and a string
 * comparison quietly decided the window ended before it began).
 *
 *   node dist/scripts/oneboard-baseline-run.js              # every active customer
 *   node dist/scripts/oneboard-baseline-run.js 1            # one customer id
 *   node dist/scripts/oneboard-baseline-run.js --status     # what is cached, no rebuild
 *
 * Run it from the app directory so .env is picked up:  cd /srv/apps/lumenmsp-portal
 */
import { insightsPool } from '../db/pool';
import { baselineWindow } from '../lib/oneboard-core';
import { refreshBaselineForCustomer } from '../lib/oneboard-baseline';

async function status(): Promise<void> {
  const r = await insightsPool!.query(`
    SELECT c.id, c.name,
           COUNT(d.day)                                   AS days,
           COUNT(DISTINCT d.site_id)                      AS sites,
           to_char(MIN(d.day), 'YYYY-MM-DD')              AS first_day,
           to_char(MAX(d.day), 'YYYY-MM-DD')              AS last_day,
           to_char(MAX(d.computed_at), 'YYYY-MM-DD HH24:MI') AS last_built
      FROM customers c
      LEFT JOIN sites s ON s.customer_id = c.id
      LEFT JOIN oneboard_day_stats d ON d.site_id = s.id
     WHERE c.is_active = true
     GROUP BY c.id, c.name
     ORDER BY c.id`);
  console.log('\nCached day-stats by customer:\n');
  for (const row of r.rows) {
    const days = Number(row.days) || 0;
    console.log(
      `  ${String(row.id).padStart(3)}  ${String(row.name).slice(0, 38).padEnd(40)}` +
      (days
        ? `${String(days).padStart(6)} site-days · ${row.sites} sites · ${row.first_day} → ${row.last_day} · built ${row.last_built}`
        : '     — nothing cached'));
  }
  const w = baselineWindow();
  console.log(`\nWindow the builder would use: ${w.from} → ${w.to}\n`);
}

async function main(): Promise<void> {
  if (!insightsPool) {
    console.error('INSIGHTS_DATABASE_URL is not set — nothing to do. Run this from the app directory.');
    process.exit(1);
  }
  const args = process.argv.slice(2);

  if (args.includes('--status')) { await status(); await insightsPool.end(); return; }

  const only = args.find((a) => /^\d+$/.test(a));
  const ids: number[] = only
    ? [Number(only)]
    : (await insightsPool.query('SELECT id FROM customers WHERE is_active = true ORDER BY id')).rows.map((r: any) => Number(r.id));

  const w = baselineWindow();
  console.log(`Rebuilding ${ids.length} customer(s) over ${w.from} → ${w.to}. This walks the year a week at a time; give it a few minutes each.\n`);

  let totalDays = 0;
  for (const id of ids) {
    const started = Date.now();
    const res = await refreshBaselineForCustomer(id, { log: true });
    totalDays += res.days;
    console.log(`  customer ${id}: ${res.sites} site(s), ${res.days} site-days written in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  console.log(`\nDone — ${totalDays} site-days written in total.`);
  if (!totalDays) {
    console.log('Nothing was written. The reason is logged above, on the line beginning "nothing done —".');
  }
  await status();
  await insightsPool.end();
}

main().catch((e) => { console.error('FAILED:', e?.message || e); console.error(e?.stack); process.exit(1); });
