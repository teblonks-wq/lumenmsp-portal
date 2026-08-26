/**
 * Ask Portal suite — the device-page analyst.
 *
 * What is actually at risk here, and therefore what this tests:
 *
 *   S1–S6  **Secrets must never reach the prompt.** This machine's row neighbours a
 *          BitLocker recovery key and command payloads that carry generated passwords. The
 *          protection is that device-ask.ts never SELECTs them — not that it redacts them
 *          afterwards — so this reads the source and proves the columns are absent. A
 *          future edit that adds `SELECT *` to one of those queries fails here rather than
 *          quietly posting a recovery key to an API.
 *   P1–P8  **The prompt's load-bearing rules.** Each of these exists because of a specific
 *          way the answer goes wrong: stale readings presented as current, "no data" read
 *          as "healthy", Bitdefender `installed` reported as protected, invented event IDs.
 *          They are one careless trim away from disappearing, and nothing else would notice.
 *   A1–A7  ageWords — the freshness wording that travels with every section of evidence.
 *          It is also what keeps the prompt cache warm, so it must NOT vary minute to
 *          minute for the same reading.
 *   D1–D5  The database side, run for real when a database is reachable and skipped with a
 *          note when it is not (Postgres is localhost-only on the App Server).
 *
 * Run: npx tsx src/scripts/test-device-ask.ts
 *  or: npm run build && node dist/scripts/test-device-ask.js
 */
import fs from 'fs';
import path from 'path';
import { ageWords, SYSTEM } from '../lib/device-ask';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Secrets ─────────────────────────────────────────────────────────────────────
console.log('\nSecrets never reach the prompt');
{
  // Read the source, not the compiled output: the point is to catch a careless edit to the
  // file a human will actually change.
  const srcPath = path.join(process.cwd(), 'src', 'lib', 'device-ask.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  // Comments legitimately discuss these words; only the SQL matters. Strip line comments
  // and block comments before looking.
  const sql = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('S1 the BitLocker recovery key column is never selected',
        !/recovery_key_encrypted/.test(sql));
  check('S2 no agent_commands query pulls `payload` (it carries generated passwords)',
        !/\bpayload\b/.test(sql));
  check('S3 no SELECT * anywhere in this module',
        !/select\s+\*/i.test(sql));
  // The BitLocker query is allowed to exist — it must just be limited to status columns.
  const blMatch = sql.match(/SELECT[^`]*?FROM asset_bitlocker_keys/i);
  check('S4 the BitLocker query exists and reads only status columns',
        !!blMatch && /mount_point/.test(blMatch[0]) && /protection_status/.test(blMatch[0])
          && !/recovery/i.test(blMatch[0]),
        blMatch ? blMatch[0].replace(/\s+/g, ' ').slice(0, 120) : 'no BitLocker query found');
  check('S5 the corpus says out loud that keys are excluded',
        /Recovery keys are deliberately NOT included/.test(src));
  check('S6 no token/secret/password column is selected',
        !/\b(token_hash|api_key|client_secret|password)\b/.test(sql));
}

// ── The prompt's load-bearing rules ─────────────────────────────────────────────
console.log('\nThe rules the answer quality rests on');
{
  const sys = SYSTEM.toLowerCase();
  check('P1 answer leads, no restatement of the question', /lead with the answer/.test(sys));
  check('P2 evidence must be cited specifically', /cite the evidence/.test(sys));
  // The single most important one: an answer built on a nine-day-old reading, presented as
  // current, is the kind of wrong that gets believed and acted on.
  check('P3 age of the evidence must be stated', /age is part of the evidence/.test(sys));
  check('P4 missing data is never reported as healthy', /absence is not health/.test(sys));
  check('P5 Bitdefender "installed" must not be called protected',
        /"installed" is not a finished install/.test(sys) || /installed.*not.*finished install/.test(sys));
  check('P6 nothing may be invented', /never invent/.test(sys));
  check('P7 previous findings must be built on, and contradictions flagged',
        /build on previous findings/.test(sys) && /contradicts/.test(sys));
  check('P8 the JSON contract is declared', /"headline"/.test(SYSTEM) && /"actions"/.test(SYSTEM));
  check('P9 British English is asked for', /british english/.test(sys));
}

// ── Freshness wording ───────────────────────────────────────────────────────────
console.log('\nFreshness wording');
{
  const mins = (n: number) => new Date(Date.now() - n * 60_000);
  check('A1 nothing collected reads as "never", not as "just now"', ageWords(null) === 'never');
  check('A2 minutes ago', ageWords(mins(10)) === 'within the last hour', ageWords(mins(10)));
  check('A3 hours ago', /hours ago/.test(ageWords(mins(60 * 5))), ageWords(mins(60 * 5)));
  check('A4 days ago', /3 days ago/.test(ageWords(mins(60 * 24 * 3))), ageWords(mins(60 * 24 * 3)));
  check('A5 singular day is not "1 days"', !/1 days/.test(ageWords(mins(60 * 24))), ageWords(mins(60 * 24)));
  check('A6 weeks for a month-old reading', /weeks ago/.test(ageWords(mins(60 * 24 * 21))), ageWords(mins(60 * 24 * 21)));
  check('A7 months for an old one', /months ago/.test(ageWords(mins(60 * 24 * 200))), ageWords(mins(60 * 24 * 200)));
  // Cache warmth: the corpus is sent as a cached prefix, so the same reading must produce
  // the same words for hours. A minute-resolution age would bust the cache on every
  // follow-up question and quietly triple the cost of a conversation.
  const t = mins(60 * 24 * 3);
  check('A8 the same reading gives the same words twice (prompt cache stays warm)',
        ageWords(t) === ageWords(new Date(t.getTime() - 30_000)),
        ageWords(t) + ' vs ' + ageWords(new Date(t.getTime() - 30_000)));
}

// ── Database ────────────────────────────────────────────────────────────────────
async function dbChecks(): Promise<void> {
  console.log('\nThe logic file (database)');
  let pool: any;
  try {
    pool = require('../db/pool').pool;
    await pool.query('SELECT 1');
  } catch (e: any) {
    console.log('  – skipped: no database reachable from here (' + String(e.message).slice(0, 60) + ')');
    return;
  }
  try {
    const t = (await pool.query(`SELECT to_regclass('public.device_findings') IS NOT NULL AS ok`)).rows[0];
    check('D1 device_findings exists (prisma db push has run)', !!t.ok,
          t.ok ? '' : 'not pushed yet — the feature saves nothing until it is');
    if (!t.ok) return;

    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='device_findings'`)).rows.map((r: any) => r.column_name);
    check('D2 it stores the QUESTION as well as the answer', cols.includes('question') && cols.includes('answer'),
          cols.join(','));
    check('D3 it is keyed to both the machine and the customer',
          cols.includes('asset_id') && cols.includes('customer_id'));

    // The read-back that makes the feature compound: findings from this customer's OTHER
    // machines. Wrong join here and an engineer silently loses the most useful evidence.
    const r = (await pool.query(
      `SELECT count(*)::int AS n
         FROM device_findings f
         JOIN customer_assets a ON a.id = f.asset_id
        WHERE f.customer_id IS NOT NULL AND f.asset_id <> -1`)).rows[0];
    check('D4 the customer-wide finding read-back runs', Number.isInteger(r.n), String(r.n));

    // The case shortlist ordering — cases naming the machine must be able to sort first.
    const c = (await pool.query(
      `SELECT count(*)::int AS n FROM inbox_tickets t
        WHERE t.customer_id IS NOT NULL AND t.deleted_at IS NULL AND t.is_spam = false
          AND (t.subject ILIKE ANY($1::text[]) OR t.description ILIKE ANY($1::text[]))`,
      [['%DESKTOP%']])).rows[0];
    check('D5 the "cases naming this machine" clause runs', Number.isInteger(c.n), String(c.n));
  } catch (e: any) {
    check('database checks completed', false, e.message);
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
  }
}

dbChecks().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
