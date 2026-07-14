/**
 * Journey-builder regression suite — THE gate for the core product claim.
 *
 * LITS sells "the magic key to group calls": one physical call = one journey, whatever the
 * phone system logs. This suite encodes every failure class we've hit in production, so a
 * broken journey builder can never ship again. deploy.ps1 runs it after the build and ABORTS
 * the deploy on failure. Run manually with:  npm run test:journeys
 *
 * When a new counting bug is found: fix it, then ADD A FIXTURE HERE that fails without the fix.
 *   T1–T5  call identity   (Didcot 2026-07-14: Tollring's new call_id per queue hop made one
 *                           caller look like six missed calls — +11% totals, +27% missed)
 *   T6–T8  site boundaries (Didcot 2026-07-14: empty site logic = whole-customer report)
 *   T9–T11 business hours  (BST 2026-06: UTC-evaluated hours shifted the window an hour)
 *   T12+   statuses, IVR, min-wait
 */
import { buildJourneys, isInHours, type CallEventRow, type LogicConfig } from '../lib/insights-journeys';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

let idSeq = 0;
function leg(o: Partial<CallEventRow> & { at: string }): CallEventRow {
  return {
    id: ++idSeq, site_id: 1,
    event_datetime: new Date(o.at),
    group_name: o.group_name ?? 'Didcot-sa-1',
    outcome: o.outcome ?? 'Missed',
    number_raw: o.number_raw ?? '07700900001',
    number_normalised: o.number_normalised ?? o.number_raw ?? '07700900001',
    ddi: null, wait_seconds: o.wait_seconds ?? 15,
    source_file: 'tollring-sync',
    call_id: o.call_id ?? null, extno: o.extno ?? '', direction: o.direction ?? 'inbound',
  } as CallEventRow;
}

// All test times are WEEKDAY UK business hours unless a test says otherwise.
// 2026-07-06 is a Monday; 10:00 UTC = 11:00 UK (BST). Use explicit hours config that's open then.
const OPEN: LogicConfig = { business_hours: { start: '08:00', end: '18:30' } };

console.log('\n── Call identity (one caller = one call) ──');
{
  // T1: multi-handset/multi-leg ring under ONE call_id = one journey (the original crack).
  const j = buildJourneys([
    leg({ at: '2026-07-06T09:00:00Z', call_id: 'A', group_name: 'Didcot-sa-1' }),
    leg({ at: '2026-07-06T09:00:20Z', call_id: 'A', group_name: 'Didcot-sa-2' }),
    leg({ at: '2026-07-06T09:00:40Z', call_id: 'A', group_name: 'didcot-sa-3', outcome: 'Answered', extno: 'DI.Reception1' }),
  ], OPEN);
  check('T1 one call_id, many legs → 1 journey, Answered', j.length === 1 && j[0].status === 'Answered', `got ${j.length}/${j[0]?.status}`);
  check('T1b answered_by is the person', j[0]?.answered_by === 'DI.Reception1', String(j[0]?.answered_by));
}
{
  // T2: THE DIDCOT CASE — same caller, six DIFFERENT call_ids inside the window = ONE call,
  // answered if any fragment answered, credited to the answering person.
  const rows: CallEventRow[] = [];
  for (let i = 0; i < 6; i++) {
    rows.push(leg({ at: `2026-07-06T10:15:${String(i * 10).padStart(2, '0')}Z`, call_id: 'frag-' + i, group_name: i % 2 ? 'didcot-sa-3' : 'Didcot-sa-1', wait_seconds: 8, outcome: i === 5 ? 'Answered' : 'Missed', extno: i === 5 ? 'DI.Telephony2' : '' }));
  }
  const j = buildJourneys(rows, OPEN);
  check('T2 six call_ids, one caller, one window → 1 journey', j.length === 1, `got ${j.length}`);
  check('T2b merged journey is Answered by the person', j[0]?.status === 'Answered' && j[0]?.answered_by === 'DI.Telephony2', `${j[0]?.status}/${j[0]?.answered_by}`);
}
{
  // T3: two DIFFERENT callers in the same minute never merge.
  const j = buildJourneys([
    leg({ at: '2026-07-06T11:00:00Z', call_id: 'B1', number_raw: '07700900002' }),
    leg({ at: '2026-07-06T11:00:30Z', call_id: 'B2', number_raw: '07700900003' }),
  ], OPEN);
  check('T3 different callers stay separate', j.length === 2, `got ${j.length}`);
}
{
  // T4: anonymous/withheld callers NEVER merge across call_ids (they may be different people).
  const j = buildJourneys([
    leg({ at: '2026-07-06T11:10:00Z', call_id: 'C1', number_raw: 'anonymous' }),
    leg({ at: '2026-07-06T11:10:40Z', call_id: 'C2', number_raw: 'anonymous' }),
  ], OPEN);
  check('T4 anonymous callers never merge', j.length === 2, `got ${j.length}`);
}
{
  // T5: same caller ringing back AFTER the journey window = a genuinely new call.
  const j = buildJourneys([
    leg({ at: '2026-07-06T12:00:00Z', call_id: 'D1', outcome: 'Answered', extno: 'DI.Reception1', wait_seconds: 5 }),
    leg({ at: '2026-07-06T12:20:00Z', call_id: 'D2', outcome: 'Answered', extno: 'DI.Reception2', wait_seconds: 5 }),
  ], OPEN);
  check('T5 ring-back after window = 2 calls', j.length === 2, `got ${j.length}`);
}
{
  // T5c: rows WITHOUT call_id still merge by number + window (the legacy path).
  const j = buildJourneys([
    leg({ at: '2026-07-06T13:00:00Z', group_name: 'Didcot-sa-1' }),
    leg({ at: '2026-07-06T13:01:00Z', group_name: 'didcot-sa-3', outcome: 'Answered', extno: 'DI.SMT' }),
  ], OPEN);
  check('T5c no-call_id legs merge by number+window', j.length === 1 && j[0].status === 'Answered', `got ${j.length}/${j[0]?.status}`);
}

console.log('\n── Site boundaries (site logic = the report) ──');
{
  // T6: source_of_truth_group keeps ONLY the site's groups (the Didcot/Cholsey leak).
  const cfg: LogicConfig = { ...OPEN, source_of_truth_group: ['Didcot-sa-1', 'didcot-sa-3'] };
  const j = buildJourneys([
    leg({ at: '2026-07-06T09:30:00Z', call_id: 'E1', group_name: 'Didcot-sa-1', outcome: 'Answered', extno: 'DI.Reception1' }),
    leg({ at: '2026-07-06T09:31:00Z', call_id: 'E2', group_name: 'cholsey-aa', number_raw: '07700900004' }),
    leg({ at: '2026-07-06T09:32:00Z', call_id: 'E3', group_name: 'WantageIVR', number_raw: '07700900005' }),
  ], cfg);
  check('T6 other sites\' groups are excluded', j.length === 1 && j[0].steps[0].group === 'Didcot-sa-1', `got ${j.length}`);
}
{
  // T7: group matching is case/space tolerant.
  const cfg: LogicConfig = { ...OPEN, source_of_truth_group: ['didcot-SA-1 '] };
  const j = buildJourneys([leg({ at: '2026-07-06T09:40:00Z', call_id: 'F1', group_name: 'Didcot-sa-1', outcome: 'Answered', extno: 'DI.Reception1' })], cfg);
  check('T7 group match ignores case/whitespace', j.length === 1, `got ${j.length}`);
}
{
  // T8: empty logic = NO group filter (single-site behaviour) — documents current semantics;
  // multi-site refusal is enforced upstream in generateFromTemplate.
  const j = buildJourneys([leg({ at: '2026-07-06T09:50:00Z', call_id: 'G1', group_name: 'AnyGroupAtAll', outcome: 'Answered', extno: 'X.Y' })], OPEN);
  check('T8 empty logic keeps all groups (guarded upstream)', j.length === 1, `got ${j.length}`);
}

console.log('\n── Business hours (UK local, year-round) ──');
{
  // T9: JULY (BST): 18:45 UK = 17:45 UTC — must be OUT of 08:00–18:30 hours.
  check('T9 BST evening excluded', !isInHours('2026-07-06T17:45:00Z', { start: '08:00', end: '18:30' }));
  // and 08:10 UK = 07:10 UTC — must be IN (the "empty 08:00 row" lesson).
  check('T9b BST early morning included', isInHours('2026-07-06T07:10:00Z', { start: '08:00', end: '18:30' }));
}
{
  // T10: JANUARY (GMT): 08:10 UK = 08:10 UTC in, 18:45 out.
  check('T10 GMT morning included', isInHours('2026-01-05T08:10:00Z', { start: '08:00', end: '18:30' }));
  check('T10b GMT evening excluded', !isInHours('2026-01-05T18:45:00Z', { start: '08:00', end: '18:30' }));
}
{
  // T11: per-day hours — Saturday open when configured, Sunday closed when closed.
  const perDay = { sat: { open: '09:00', close: '12:00' }, sun: { closed: true }, mon: { open: '08:00', close: '18:30' } } as any;
  check('T11 configured Saturday morning included', isInHours('2026-07-11T09:30:00Z', perDay)); // Sat 10:30 UK
  check('T11b closed Sunday excluded', !isInHours('2026-07-12T09:30:00Z', perDay));
  // business_hours_only journeys filter
  const j = buildJourneys([leg({ at: '2026-07-06T20:00:00Z', call_id: 'H1', outcome: 'Answered', extno: 'DI.X' })], OPEN);
  check('T11c out-of-hours call excluded from journeys', j.length === 0, `got ${j.length}`);
}

console.log('\n── Statuses, IVR, min-wait ──');
{
  // T12: Abandoned outranks Missed; Answered outranks both.
  const j = buildJourneys([
    leg({ at: '2026-07-06T14:00:00Z', call_id: 'I1', outcome: 'Abandoned' }),
    leg({ at: '2026-07-06T14:10:00Z', call_id: 'I2', number_raw: '07700900006', outcome: 'Missed' }),
  ], OPEN);
  check('T12 abandoned and missed statuses kept distinct',
    j.some((x) => x.status === 'Abandoned') && j.some((x) => x.status === 'Missed'), j.map((x) => x.status).join(','));
}
{
  // T13: IVR option counts as answered only when configured.
  const rows = [leg({ at: '2026-07-06T14:20:00Z', call_id: 'J1', group_name: 'DidcotEmergency' })];
  const ivrCfg: LogicConfig = { ...OPEN, ivr_options: [{ group: 'DidcotEmergency', label: 'Emergency' }], ivr_counts_as_answered: true };
  const j1 = buildJourneys(rows.map((r) => ({ ...r })), ivrCfg);
  const j2 = buildJourneys(rows.map((r) => ({ ...r })), { ...OPEN, ivr_options: [{ group: 'DidcotEmergency', label: 'Emergency' }], ivr_counts_as_answered: false });
  check('T13 IVR counts as answered when ticked', j1[0]?.status === 'Answered' && j1[0]?.ivr_label === 'Emergency', `${j1[0]?.status}/${j1[0]?.ivr_label}`);
  check('T13b IVR stays missed when unticked', j2[0]?.status === 'Missed', String(j2[0]?.status));
}
{
  // T14: min_wait_seconds drops sub-threshold missed blips but never answered calls.
  const cfg: LogicConfig = { ...OPEN, min_wait_seconds: 10 };
  const j = buildJourneys([
    leg({ at: '2026-07-06T15:00:00Z', call_id: 'K1', wait_seconds: 3 }),                                    // blip → dropped
    leg({ at: '2026-07-06T15:10:00Z', call_id: 'K2', number_raw: '07700900007', wait_seconds: 3, outcome: 'Answered', extno: 'DI.R1' }), // answered → kept
  ], cfg);
  check('T14 min-wait drops missed blips, keeps answered', j.length === 1 && j[0].status === 'Answered', `got ${j.length}/${j[0]?.status}`);
}
{
  // T15: answered_by never names a hunt group and falls back to Voicemail.
  const j = buildJourneys([
    leg({ at: '2026-07-06T15:30:00Z', call_id: 'L1', group_name: 'Didcot-sa-1', outcome: 'Answered', extno: 'Didcot-sa-1' }),   // pilot leg
    leg({ at: '2026-07-06T15:30:20Z', call_id: 'L1', group_name: 'DidcotVoiceMail', outcome: 'Answered', extno: 'VoiceMail' }),
  ], OPEN);
  check('T15 group pilot never shown as answerer; voicemail reported', j[0]?.answered_by === 'Voicemail', String(j[0]?.answered_by));
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) { console.error('\nJOURNEY BUILDER REGRESSION — DO NOT DEPLOY.'); process.exit(1); }
console.log('Journey builder OK — the magic key still turns. 🔑');
