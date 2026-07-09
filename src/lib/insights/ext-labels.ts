import cron from 'node-cron';
import { pool, insightsPool } from '../../db/pool';

// Overnight: label each comms CLI with the extension/user that most handles it, read from the
// Insights per-extension call data (`call_events.group_name` on `ListCallsbyExtension%` rows).
// Numbers are canonicalised (digits, strip leading 44/0) so 01793…, 441793…, 1793… all match.
// Display-only — shown next to the CLI on the comms asset list.

// SQL fragment: canonical number form.
const CANON = (col: string) => `regexp_replace(regexp_replace(${col},'[^0-9]','','g'),'^(44|0)','')`;

export async function labelClisFromInsights(): Promise<{ labelled: number }> {
  if (!insightsPool) return { labelled: 0 };
  let rows: any[] = [];
  try {
    rows = (await insightsPool.query(
      `SELECT ${CANON('ddi')} AS cli, group_name AS ext, COUNT(*)::int AS n
         FROM call_events
        WHERE source_file ILIKE 'ListCallsbyExtension%'
          AND ddi IS NOT NULL AND ${CANON('ddi')} <> ''
          AND group_name IS NOT NULL AND group_name <> ''
        GROUP BY 1, 2`
    )).rows;
  } catch (e) { console.error('[ext-labels] Insights query failed:', (e as Error).message); return { labelled: 0 }; }

  // Winning extension per CLI = the one with the most calls.
  const best = new Map<string, { ext: string; n: number }>();
  for (const r of rows) {
    const cli = String(r.cli || ''); if (cli.length < 5) continue;
    const cur = best.get(cli);
    if (!cur || r.n > cur.n) best.set(cli, { ext: String(r.ext), n: r.n });
  }

  let labelled = 0;
  for (const [cli, v] of best) {
    await pool.query(
      `INSERT INTO cli_extension_labels (cli, ext_name, calls) VALUES ($1,$2,$3)
       ON CONFLICT (cli) DO UPDATE SET ext_name=EXCLUDED.ext_name, calls=EXCLUDED.calls, updated_at=NOW()`,
      [cli, v.ext, v.n]
    );
    labelled++;
  }
  console.log(`[ext-labels] labelled ${labelled} CLI(s) from Insights extension data`);
  return { labelled };
}

let _started = false;
export function startExtLabelSync(): void {
  if (_started) return;
  if (!insightsPool) { console.log('• CLI extension-label sync not started (Insights not connected)'); return; }
  _started = true;
  cron.schedule('30 4 * * *', () => { labelClisFromInsights().catch((e) => console.error('[ext-labels]', e.message)); }); // 04:30 daily
  console.log('✓ CLI extension-label sync scheduled (04:30 daily)');
}
