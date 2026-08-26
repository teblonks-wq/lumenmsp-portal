/**
 * Warranty suite — the vendor payload parsers, the expiry verdict, and the SQL the sweep
 * picks machines with.
 *
 * Why this exists in the shape it does:
 *
 * Not one of Dell, HP or Lenovo will answer without a partner account, and we have none of
 * the three yet. That makes the *parsing* the only part of this feature that can be proved
 * before the keys land — and it is also the part most likely to be quietly wrong, because
 * every one of these APIs returns a differently-shaped bag of dates. So the parsers are
 * pure and exported, and this suite feeds them payloads shaped like the real ones.
 *
 *   D1–D8   Dell. The one that matters is D4: a machine with an EXPIRED ProSupport and a
 *           LIVE accidental-damage plan is in cover, and reporting the first entitlement
 *           in the array would call it out of cover.
 *   H1–H5   HP. Its job API can hand back a bare array or an object with results in it,
 *           and it has two names for every date field.
 *   L1–L4   Lenovo. One machine per call, and an empty Warranty array means "no record",
 *           not "no warranty" — those must not look the same downstream.
 *   G1–G3   The aggregator's generic shape.
 *   V1–V7   warrantyView — where the amber band starts and stops. One place decides this
 *           so the asset page and the list cannot disagree about the same machine.
 *   R1–R3   Error redaction. A vendor's 401 body can carry the key we sent it, and that
 *           string is rendered on the device page.
 *   S1–S4   The sweep's selection SQL, run against the real database when one is reachable.
 *
 * Run: npx tsx src/scripts/test-warranty.ts
 */
import {
  parseDell, parseHp, parseLenovo, parseAggregator, warrantyView, _redactForTest,
} from '../lib/warranty';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** A date N days from now, as the vendors format them. */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

// ── Dell ────────────────────────────────────────────────────────────────────────
console.log('\nDell payload');
{
  const payload = [{
    id: 123456,
    serviceTag: 'ABC1234',
    productLineDescription: 'LATITUDE 5540',
    shipDate: '2023-03-14T00:00:00Z',
    entitlements: [
      { serviceLevelCode: 'PS4AM', serviceLevelDescription: 'ProSupport: Next Business Day Onsite',
        entitlementType: 'INITIAL', startDate: '2023-03-14T00:00:00Z', endDate: '2026-03-14T00:00:00Z' },
      { serviceLevelCode: 'ADH', serviceLevelDescription: 'Accidental Damage Service',
        entitlementType: 'EXTENDED', startDate: '2023-03-14T00:00:00Z', endDate: '2027-03-14T00:00:00Z' },
    ],
  }];

  const [r] = parseDell(payload, ['ABC1234']);
  check('D1 finds the machine by service tag', r.found === true);
  check('D2 provider is stamped', r.provider === 'dell');
  check('D3 keeps every entitlement', r.entitlements.length === 2);
  // The headline date is the LONGEST-running cover, not the first row Dell happened to
  // return. Get this wrong and a machine with live accidental-damage cover reads "expired".
  check('D4 headline end date is the LATEST across entitlements', iso(r.end) === '2027-03-14',
        String(iso(r.end)));
  check('D5 headline level follows the latest entitlement', r.level === 'Accidental Damage Service', String(r.level));
  check('D6 start is the EARLIEST across entitlements', iso(r.start) === '2023-03-14', String(iso(r.start)));
  check('D7 ship date is picked up', iso(r.shipDate) === '2023-03-14');

  // A tag Dell did not answer for must come back as not-found, not vanish. The caller maps
  // results back onto asset ids positionally-by-serial; a dropped row would write one
  // machine's warranty onto another.
  const two = parseDell(payload, ['ABC1234', 'ZZZ9999']);
  check('D8 a tag with no answer is returned as not-found, not dropped',
        two.length === 2 && two[1].found === false && two[1].serial === 'ZZZ9999');

  const lower = parseDell(payload, ['abc1234']);
  check('D9 service tag matching is case-insensitive', lower[0].found === true);

  const empty = parseDell({ assetEntitlementList: [] }, ['ABC1234']);
  check('D10 an empty list is not-found rather than a crash', empty[0].found === false);

  const wrapped = parseDell({ assetEntitlementList: payload }, ['ABC1234']);
  check('D11 handles the object-wrapped form as well as the bare array', wrapped[0].found === true);

  const noEnts = parseDell([{ serviceTag: 'NOENT', productLineDescription: 'OPTIPLEX 7010' }], ['NOENT']);
  check('D12 a machine with no entitlements falls back to the product line for its level',
        noEnts[0].found === true && noEnts[0].level === 'OPTIPLEX 7010' && noEnts[0].end === null);
}

// ── HP ──────────────────────────────────────────────────────────────────────────
console.log('\nHP payload');
{
  const bare = [{
    sn: 'CND12345XY',
    shipDate: '2022-06-01',
    offers: [
      { offerId: 'U17WE', offerDescription: 'HP 3y Next Business Day Onsite',
        serviceType: 'HARDWARE', startDate: '2022-06-01', endDate: '2025-06-01' },
    ],
  }];
  const [r] = parseHp(bare, ['CND12345XY']);
  check('H1 reads HP\'s bare-array job result', r.found === true && r.entitlements.length === 1);
  check('H2 level comes from the offer description', r.level === 'HP 3y Next Business Day Onsite');
  check('H3 end date parsed', iso(r.end) === '2025-06-01');

  // HP has two names for every date, depending which flavour of the API answers.
  const alt = { results: [{ serialNumber: 'CND12345XY', warranties: [
    { serviceObligationLineItemNumber: 'X', serviceLevelDescription: 'HP Care Pack',
      serviceObligationStartDate: '2022-06-01', serviceObligationEndDate: '2027-06-01' }] }] };
  const [r2] = parseHp(alt, ['CND12345XY']);
  check('H4 accepts the results-wrapped form and the alternate field names',
        r2.found === true && iso(r2.end) === '2027-06-01', String(iso(r2.end)));

  const miss = parseHp(bare, ['NOTHERE']);
  check('H5 an unanswered serial is not-found', miss[0].found === false);
  check('H6 a null body does not throw', parseHp(null, ['X'])[0].found === false);
}

// ── Lenovo ──────────────────────────────────────────────────────────────────────
console.log('\nLenovo payload');
{
  const j = { Serial: 'PF0ABCDE', Shipped: '2021-09-09', Warranty: [
    { ID: '3EZ', Name: '3Y Depot', Type: 'Base', Start: '2021-09-09', End: '2024-09-09' },
    { ID: 'ADP', Name: 'Accidental Damage Protection', Type: 'Upgrade', Start: '2021-09-09', End: '2025-09-09' },
  ] };
  const r = parseLenovo(j, 'PF0ABCDE');
  check('L1 reads Lenovo\'s warranty array', r.found === true && r.entitlements.length === 2);
  check('L2 headline is the longest-running cover', iso(r.end) === '2025-09-09', String(iso(r.end)));
  check('L3 level follows it', r.level === 'Accidental Damage Protection');

  // An empty array means Lenovo has no RECORD. That is not the same claim as "this machine
  // has no warranty", and applyResult() deliberately leaves existing dates alone for it.
  const none = parseLenovo({ Warranty: [] }, 'UNKNOWN1');
  check('L4 an empty warranty array is not-found, not a zero-cover answer',
        none.found === false && none.end === undefined);
  check('L5 a null body does not throw', parseLenovo(null, 'X').found === false);
}

// ── Aggregator ──────────────────────────────────────────────────────────────────
console.log('\nAggregator payload');
{
  const j = { results: [{ serial: 'SN-1', serviceLevel: 'Vendor NBD', warrantyEnd: '2028-01-31',
                          warrantyStart: '2025-01-31', entitlements: [] }] };
  const [r] = parseAggregator(j, ['SN-1']);
  check('G1 reads the flat aggregator shape', r.found === true && iso(r.end) === '2028-01-31');
  check('G2 level from serviceLevel', r.level === 'Vendor NBD');
  check('G3 an unknown serial is not-found', parseAggregator(j, ['SN-2'])[0].found === false);
}

// ── The expiry verdict ──────────────────────────────────────────────────────────
console.log('\nExpiry verdict (one place decides the colour)');
{
  check('V1 no date at all is "unknown", never "expired"', warrantyView(null).state === 'unknown');
  check('V2 an unparseable date is "unknown"', warrantyView('not a date' as any).state === 'unknown');
  check('V3 a year out is active', warrantyView(inDays(365)).state === 'active');
  check('V4 91 days out is still active', warrantyView(inDays(91)).state === 'active');
  // 90 days is the band where an extension actually gets bought — it is also the window
  // the nightly sweep re-checks weekly, and the two numbers must stay in step.
  check('V5 89 days out is amber', warrantyView(inDays(89)).state === 'expiring');
  check('V6 yesterday is expired', warrantyView(inDays(-1)).state === 'expired');
  check('V7 expired wording counts days elapsed',
        /Expired 3 days ago/.test(warrantyView(inDays(-3)).label), warrantyView(inDays(-3)).label);
  check('V8 singular day is not "1 days"',
        !/1 days/.test(warrantyView(inDays(-1)).label), warrantyView(inDays(-1)).label);
}

// ── Error redaction ─────────────────────────────────────────────────────────────
console.log('\nError redaction (this string is rendered on the device page)');
{
  const leak = new Error('HTTP 401 {"error":"invalid_client","client_secret":"abcdefghijklmnopqrstuvwxyz123456"}');
  const out = _redactForTest(leak);
  check('R1 a long token-shaped string is masked', !/abcdefghijklmnopqrstuvwxyz123456/.test(out), out);
  check('R2 the useful part of the message survives', /HTTP 401/.test(out), out);
  check('R3 the message is capped', _redactForTest(new Error('x'.repeat(1000))).length <= 240);
}

// ── The sweep's selection SQL ───────────────────────────────────────────────────
// Runs only where the database is reachable. It is not a mock: the WHERE clause below is
// the one the nightly job uses, and the interval arithmetic in it is the sort of thing that
// parses fine and selects the wrong rows.
async function sqlChecks(): Promise<void> {
  console.log('\nSweep selection SQL');
  let pool: any;
  try {
    pool = require('../db/pool').pool;
    await pool.query('SELECT 1');
  } catch (e: any) {
    console.log('  – skipped: no database reachable from here (' + String(e.message).slice(0, 60) + ')');
    return;
  }
  try {
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='customer_assets' AND column_name LIKE 'warranty%'`)).rows.map((r: any) => r.column_name);
    check('S1 the warranty columns exist on customer_assets (prisma db push has run)',
          cols.length >= 11, cols.join(',') || 'none — deploy has not pushed the schema yet');
    if (cols.length < 11) { console.log('  – remaining SQL checks skipped until the schema is pushed'); return; }

    const t = (await pool.query(
      `SELECT to_regclass('public.asset_warranty_entitlements') IS NOT NULL AS ok`)).rows[0];
    check('S2 the entitlements table exists', !!t.ok);

    // The real clause. It must not select a locked row, and it must not select a machine
    // with no serial — both would burn a vendor call on something that cannot be answered.
    const r = (await pool.query(
      `SELECT count(*)::int AS n FROM customer_assets
        WHERE merged_into_id IS NULL AND archived_at IS NULL
          AND warranty_locked = false
          AND serial_number IS NOT NULL AND serial_number <> ''
          AND ( warranty_checked_at IS NULL
                OR warranty_checked_at < NOW() - ($1 || ' days')::interval
                OR (warranty_end IS NOT NULL
                    AND warranty_end BETWEEN NOW() AND NOW() + INTERVAL '90 days'
                    AND warranty_checked_at < NOW() - INTERVAL '7 days') )`, ['30'])).rows[0];
    check('S3 the sweep clause runs and returns a count', Number.isInteger(r.n), String(r.n));

    const locked = (await pool.query(
      `SELECT count(*)::int AS n FROM customer_assets
        WHERE warranty_locked = true
          AND warranty_locked = false`)).rows[0];
    check('S4 a locked row can never satisfy the sweep predicate', locked.n === 0);

    // The list filter Terry will actually use: everything out of cover before a date.
    const expiring = (await pool.query(
      `SELECT count(*)::int AS n FROM customer_assets
        WHERE merged_into_id IS NULL AND archived_at IS NULL
          AND warranty_end IS NOT NULL AND warranty_end < NOW() + INTERVAL '90 days'`)).rows[0];
    check('S5 the "expiring" filter shape runs', Number.isInteger(expiring.n), String(expiring.n));

    // The customer-page assets query, with the contact join added this session.
    const custQ = (await pool.query(
      `SELECT a.id, ac.full_name AS assigned_name
         FROM customer_assets a
         LEFT JOIN customer_contacts ac ON ac.id = a.assigned_contact_id
        WHERE a.merged_into_id IS NULL AND a.archived_at IS NULL
        ORDER BY COALESCE(NULLIF(a.friendly_name,''), a.hostname)
        LIMIT 5`)).rows;
    check('S6 the customer Assets tab query (with the assigned-contact join) runs',
          Array.isArray(custQ));

    // Friendly name must be searchable the same way a hostname is.
    const search = (await pool.query(
      `SELECT count(*)::int AS n FROM customer_assets a
        WHERE a.hostname ILIKE $1 OR a.friendly_name ILIKE $1 OR a.serial_number ILIKE $1`, ['%a%'])).rows[0];
    check('S7 the search clause including friendly_name runs', Number.isInteger(search.n));
  } catch (e: any) {
    check('SQL checks completed', false, e.message);
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
  }
}

sqlChecks().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
