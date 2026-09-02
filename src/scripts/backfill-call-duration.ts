/**
 * backfill-call-duration.ts — fill call_events.duration_secs from tollring_calls.
 *
 *   node dist/scripts/backfill-call-duration.ts            DRY RUN — writes nothing
 *   node dist/scripts/backfill-call-duration.js --apply    writes
 *
 * WHY: talk time was never carried onto call_events (the sync wrote fifteen columns and
 * duration was not one of them), so OneBoard, the exports and Ask Insights have never been
 * able to say how long a call lasted. The sync now writes it going forward; this fills in
 * the history that already sits in tollring_calls.
 *
 * THE JOIN IS EXACT, not fuzzy. Every derived call_event carries
 *     event_hash = sha256('tollring|<customer_id>|<record_id>')
 * so each event maps to exactly one tollring_calls row. No time windows, no guessing,
 * no chance of attaching one leg's duration to another leg.
 *
 * Only rows synced by 'tollring-sync' are touched. Anything imported from the older
 * ContactGroupDetail files has no tollring_calls row behind it and is left alone rather
 * than being filled with a plausible-looking wrong number.
 */
import { createHash } from 'crypto';
import { insightsPool } from '../db/pool';

const APPLY = process.argv.includes('--apply');
const hash = (customerId: number, recordId: number): string =>
  createHash('sha256').update(`tollring|${customerId}|${recordId}`).digest('hex');

async function main(): Promise<void> {
  if (!insightsPool) { console.error('No insights pool — is INSIGHTS_DATABASE_URL set?'); process.exit(1); }
  console.log(APPLY ? 'APPLYING — this writes.' : 'DRY RUN — nothing will be written. Pass --apply to write.');

  await insightsPool.query('ALTER TABLE call_events ADD COLUMN IF NOT EXISTS duration_secs INTEGER');

  const todo = (await insightsPool.query(
    `SELECT COUNT(*)::int n FROM call_events
      WHERE source_file = 'tollring-sync' AND duration_secs IS NULL`)).rows[0].n;
  console.log(`call_events rows from the sync with no duration yet: ${todo}`);
  if (!todo) { console.log('Nothing to do.'); await insightsPool.end(); return; }

  // Walked in batches so a long history cannot hold one enormous transaction open.
  const BATCH = 5000;
  let scanned = 0, matched = 0, written = 0, noRecord = 0;
  for (let offset = 0; ; offset += BATCH) {
    const raw = (await insightsPool.query(
      `SELECT customer_id, record_id, duration FROM tollring_calls
        ORDER BY id LIMIT $1 OFFSET $2`, [BATCH, offset])).rows;
    if (!raw.length) break;
    scanned += raw.length;

    const pairs = raw
      .filter((r: any) => r.duration != null)
      .map((r: any) => ({ h: hash(Number(r.customer_id), Number(r.record_id)), d: Number(r.duration) }));
    if (!pairs.length) { noRecord += raw.length; continue; }
    matched += pairs.length;

    if (APPLY) {
      // One statement per batch, values joined in — the hashes are hex from our own
      // createHash, so there is nothing to escape and nothing user-supplied here.
      const res = await insightsPool.query(
        `UPDATE call_events ce SET duration_secs = v.d
           FROM (VALUES ${pairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::int)`).join(',')}) AS v(h, d)
          WHERE ce.event_hash = v.h AND ce.duration_secs IS DISTINCT FROM v.d`,
        pairs.flatMap((p) => [p.h, p.d]));
      written += res.rowCount ?? 0;
    }
    if (scanned % 50000 === 0) console.log(`  … ${scanned} tollring rows scanned, ${written} events updated`);
  }

  console.log(`\ntollring_calls rows scanned : ${scanned}`);
  console.log(`  carrying a duration        : ${matched}`);
  console.log(`  with no duration at all    : ${noRecord}`);
  console.log(APPLY ? `call_events rows updated     : ${written}` : 'DRY RUN — no rows were written.');

  const left = (await insightsPool.query(
    `SELECT COUNT(*)::int n FROM call_events
      WHERE source_file = 'tollring-sync' AND duration_secs IS NULL`)).rows[0].n;
  console.log(`still without a duration     : ${left}`);
  console.log('\nA remainder here is expected and healthy: legs that rang and were never');
  console.log('answered have no talk time to carry, and Tollring sends those as null.');
  await insightsPool.end();
}
main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
