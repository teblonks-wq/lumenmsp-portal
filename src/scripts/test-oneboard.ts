/**
 * OneBoard baseline + demand-curve suite.
 *
 * The board grew a second comparison — "is this normal?" — and a curve that judges each
 * hour of the day against an answer target. Both are arithmetic over small integers, and
 * both are the kind of arithmetic that is wrong quietly: a mean that ignores which
 * weekdays a range contains reads perfectly and is simply untrue.
 *
 * Everything under test is pure, so this suite needs no database and no .env. Run with:
 *   npm run build && node dist/scripts/test-oneboard.js     (or: npx tsx src/scripts/test-oneboard.ts)
 *
 *   M1–M8   average wait: split, weighted, and the ten longest; average talk time
 *   B1–B6   the baseline window and its January edge
 *   W1–W6   weekday-weighted scaling of a year onto the dates on screen
 *   C1–C6   the curve, its verdicts and the "too few calls to judge" floor
 *   S1–S3   the branch summary
 *   V1–V4   the drawing itself
 *   D1–D8   the year average and the days it is allowed to divide by
 */
import { asDay, baselineLabel, baselineWindow, dowIndex, metricsOf, ONEBOARD_HOURS } from '../lib/oneboard-core';
import type { CallJourney } from '../lib/insights-journeys';
import {
  baselineForRange, buildCurve, curveSvg, summariseCurve, verdictFor,
  CURVE_MIN_SAMPLE, CURVE_TARGET_DEFAULT,
} from '../lib/oneboard-curve';
import {
  yearSeries, yearAvgCallsByHour, openPattern, hoursPattern, observeAvgCallsByHour,
} from '../lib/oneboard-year';
import type { DowBucket, SiteYearStats } from '../lib/oneboard-baseline';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function near(a: number, b: number, tol = 0.001): boolean { return Math.abs(a - b) <= tol; }

// A weekday bucket whose calls all land in one hour, so hour maths is checkable by eye.
function dow(days: number, total: number, answered: number, hour = 9, openDays = days): DowBucket {
  const hourTotal = Array(24).fill(0) as number[];
  const hourAnswered = Array(24).fill(0) as number[];
  hourTotal[hour] = total; hourAnswered[hour] = answered;
  return { days, openDays, total, answered, missed: total - answered, hourTotal, hourAnswered };
}
function stats(byDow: DowBucket[], firstDay = '2026-01-05', lastDay = '2026-08-23'): SiteYearStats {
  return { siteId: 1, daysCovered: byDow.reduce((n, b) => n + b.days, 0), firstDay, lastDay, byDow };
}
const NOTHING = () => dow(0, 0, 0);

console.log('\n── M: average wait ──────────────────────────────────────────────────');
{
  // Minimal journeys — only the fields metricsOf reads.
  const j = (status: CallJourney['status'], waitSecs: number, number = '07700900000', talkSecs = 0): CallJourney => ({
    datetime: '2026-08-24 09:00:00', number, ddi: '', status,
    overflowed: false, in_hours: true, wait: '', wait_secs: waitSecs, talk_secs: talkSecs, answered_by: null,
    steps: [], ivr_label: null, is_emergency: false, is_voicemail: false,
    is_ivr_voicemail: false, is_overflow_voicemail: false,
  });

  // Answered waits 10s and 20s (mean 15). Missed waits 200s and 400s (mean 300).
  // Blended they would be 157s — a number describing neither caller. That is the whole
  // point of keeping them apart, so the fixture is chosen to make a blend obvious.
  const m = metricsOf([j('Answered', 10), j('Answered', 20), j('Missed', 200), j('Abandoned', 400)]);
  check('M1 average wait for ANSWERED calls uses only answered journeys', m.avgWaitAnswered === 15, String(m.avgWaitAnswered));
  check('M2 average wait for MISSED calls counts abandoned too', m.avgWaitMissed === 300, String(m.avgWaitMissed));
  check('M3 the two are never blended into one figure',
    m.avgWaitAnswered !== m.avgWaitMissed && m.avgWaitAnswered !== 157 && m.avgWaitMissed !== 157);

  const empty = metricsOf([]);
  check('M4 no calls means zero, not NaN or a divide by zero',
    empty.avgWaitAnswered === 0 && empty.avgWaitMissed === 0 && empty.rate === 0);

  // A site where nobody was answered must still report a missed wait — the earlier code
  // path would have had nothing to divide by.
  const allMissed = metricsOf([j('Missed', 60), j('Missed', 120)]);
  check('M5 a period with no answered calls still reports the missed wait',
    allMissed.avgWaitAnswered === 0 && allMissed.avgWaitMissed === 90, String(allMissed.avgWaitMissed));

  // Talk time. Two answered calls of 60s and 120s, one answered call from before the
  // duration backfill (no talk time at all), and a missed call — which by definition has
  // none. Averaging the unknown one in as a zero would give 60s and describe nobody.
  const t = metricsOf([j('Answered', 10, 'a', 60), j('Answered', 10, 'b', 120), j('Answered', 10, 'c', 0), j('Missed', 200)]);
  check('M6 average talk time is the mean of the calls we know the length of',
    t.avgTalk === 90, String(t.avgTalk));
  check('M7 an answered call with no recorded talk time is unknown, never zero',
    t.talkKnown === 2 && t.talkTotal === 3, `${t.talkKnown}/${t.talkTotal}`);
  const noTalk = metricsOf([j('Answered', 10), j('Answered', 20)]);
  check('M8 a period with no talk time at all reports none, so the corpus can say so',
    noTalk.talkKnown === 0 && noTalk.avgTalk === 0, `${noTalk.talkKnown}/${noTalk.avgTalk}`);
}

console.log('\n── B: the baseline window ───────────────────────────────────────────');
{
  const w = baselineWindow('2026-08-24');
  check('B1 window ends yesterday, never today (a part day is not a typical day)', w.to === '2026-08-23', w.to);
  check('B2 mid-2026 the window is the calendar year to date', w.from === '2026-01-01', w.from);
  check('B3 …and is labelled by that year', baselineLabel(w.from, w.to) === '2026 average', baselineLabel(w.from, w.to));

  // Early in a new year there is no year yet. Rather than showing nothing until March,
  // it reaches back twelve months — and says so, so nobody reads it as "this year".
  const jan = baselineWindow('2027-02-10');
  check('B4 early January does not collapse the panel', jan.from === '2026-02-10', jan.from);
  check('B5 …and is honestly relabelled', baselineLabel(jan.from, jan.to) === '12-month average', baselineLabel(jan.from, jan.to));

  // Nothing may reach behind the Tollring history floor — there is no data there, and a
  // mean over days that never existed is a smaller mean.
  const early = baselineWindow('2026-03-01');
  check('B6 the window never reaches behind the 2026 history floor', early.from === '2026-01-01', early.from);
}

console.log('\n── A: reading a date back out of Postgres ───────────────────────────');
{
  // THE 2026-08-25 OUTAGE, encoded. node-pg parses a `date` column into a JS Date, so
  // String(v).slice(0,10) gives "Thu Jan 01" — and every window comparison in this
  // module is a plain string compare, where "2026-08-24" < "Thu Jan 01" is TRUE
  // because '2' sorts before 'T'. The baseline builder therefore decided its window
  // ended before it began and returned "nothing to do", instantly and silently, for
  // every customer. The board's compare-previous-period guard had the same read.
  const pgDate = new Date('2026-01-01T00:00:00.000Z');   // exactly what the driver returns
  check('A1 a Date from the driver becomes a real day string', asDay(pgDate) === '2026-01-01', String(asDay(pgDate)));
  check('A2 …and NOT the naive slice that caused this', String(pgDate).slice(0, 10) === 'Thu Jan 01' && asDay(pgDate) !== 'Thu Jan 01');
  check('A3 the broken form really does invert the comparison',
    ('2026-08-24' < String(pgDate).slice(0, 10)) === true && ('2026-08-24' < (asDay(pgDate) as string)) === false);
  check('A4 a plain day string passes through untouched', asDay('2026-03-07') === '2026-03-07');
  check('A5 an ISO timestamp is trimmed to its day', asDay('2026-03-07T14:22:11.000Z') === '2026-03-07');
  check('A6 null and rubbish give null, never a guess', asDay(null) === null && asDay(undefined) === null && asDay('not a date') === null);
  check('A7 an invalid Date gives null', asDay(new Date('nope')) === null);
}

console.log('\n── W: a year weighted onto the dates on screen ───────────────────────');
{
  // Mon–Fri busy, Sat quiet, Sun shut. 20 of each weekday in the year.
  const byDow = [dow(20, 2000, 1800), dow(20, 2000, 1800), dow(20, 2000, 1800), dow(20, 2000, 1800),
                 dow(20, 2000, 1800), dow(20, 200, 190), dow(20, 0, 0)];
  const s = stats(byDow);

  // A working week: 5 weekdays at 100/day + one Saturday at 10 + one shut Sunday.
  const wholeWeek = baselineForRange(s, [1, 1, 1, 1, 1, 1, 1]);
  check('W1 a Mon–Sun week expects the sum of its weekday means', wholeWeek.expected.total === 510, String(wholeWeek.expected.total));

  // The whole point: the same maths on a Mon–Fri range must NOT carry the weekend.
  const workWeek = baselineForRange(s, [1, 1, 1, 1, 1, 0, 0]);
  check('W2 a Mon–Fri range is not dragged down by the year\'s shut Sundays', workWeek.expected.total === 500, String(workWeek.expected.total));

  // Two Mondays in a ten-day range must expect two Mondays' worth.
  const twoMon = baselineForRange(s, [2, 1, 1, 1, 1, 0, 0]);
  check('W3 a range holding two Mondays expects two Mondays', twoMon.expected.total === 600, String(twoMon.expected.total));

  check('W4 the expected answer rate is a rate, not an average of rates',
    workWeek.expected.rate === 90 && workWeek.expected.answered === 450,
    `${workWeek.expected.rate}% / ${workWeek.expected.answered}`);

  // Hourly means are per day OF THE RANGE, so they line up with the curve drawn beside them.
  check('W5 hourly means are per day of the range', near(workWeek.hourAvg[9], 100) && near(workWeek.hourAvg[10], 0),
    String(workWeek.hourAvg[9]));

  // A weekday with no history at all (the only Sunday of a young dataset) falls back to
  // the overall daily mean and OWNS UP to it, rather than silently expecting zero.
  const noSat = stats([dow(20, 2000, 1800), dow(20, 2000, 1800), dow(20, 2000, 1800), dow(20, 2000, 1800),
                       dow(20, 2000, 1800), NOTHING(), NOTHING()]);
  const withSat = baselineForRange(noSat, [1, 1, 1, 1, 1, 1, 0]);
  check('W6 a weekday with no history falls back to the daily mean and reports the gap',
    withSat.gapDays === 1 && withSat.expected.total === 600, `${withSat.gapDays} / ${withSat.expected.total}`);
}

console.log('\n── C: the curve and its verdicts ────────────────────────────────────');
{
  check('C1 an hour at exactly the target is met, one point under is near',
    verdictFor(100, 90, 90) === 'met' && verdictFor(100, 89, 90) === 'near');
  check('C2 more than ten points under target is short, not near',
    verdictFor(100, 80, 90) === 'near' && verdictFor(100, 79, 90) === 'short');

  // The honesty floor. One call missed is not "0% cover" — it is one call, and painting
  // 07:00 red every week because of it is how a dashboard loses its reader.
  check('C3 an hour below the sample floor is never judged',
    verdictFor(CURVE_MIN_SAMPLE - 1, 0, 90) === 'quiet' && verdictFor(CURVE_MIN_SAMPLE, 0, 90) === 'short',
    String(CURVE_MIN_SAMPLE));

  const totalByHour = Array(24).fill(0) as number[];
  const missedByHour = Array(24).fill(0) as number[];
  totalByHour[9] = 70; missedByHour[9] = 7;      // 90% — met
  totalByHour[10] = 40; missedByHour[10] = 10;   // 75% — short
  totalByHour[11] = 4; missedByHour[11] = 4;     // 0% of four calls — quiet
  const base = baselineForRange(stats([dow(20, 2000, 1800), dow(20, 2000, 1800), dow(20, 2000, 1800),
                                       dow(20, 2000, 1800), dow(20, 2000, 1800), NOTHING(), NOTHING()]),
                                [1, 1, 1, 1, 1, 0, 0]);
  const curve = buildCurve({ totalByHour, missedByHour, days: 5, baseline: base, target: CURVE_TARGET_DEFAULT });

  check('C4 the curve covers exactly the business hours the heatmaps use',
    curve.length === ONEBOARD_HOURS.length && curve[0].hour === ONEBOARD_HOURS[0]);
  const nine = curve.find((c) => c.hour === 9)!;
  check('C5 an hour reads as calls-per-day, answered = total − missed',
    near(nine.avg, 14) && nine.answered === 63 && nine.rate === 90, `${nine.avg} / ${nine.answered} / ${nine.rate}`);
  check('C6 the baseline curve rides alongside it, per day, from the same window',
    near(nine.baseAvg || 0, 100) && nine.verdict === 'met', String(nine.baseAvg));

  console.log('\n── S: the branch summary ────────────────────────────────────────────');
  const sum = summariseCurve(curve);
  check('S1 quiet hours are counted apart from judged ones',
    sum.judged === 2 && sum.met === 1 && sum.short === 1 && sum.quiet === curve.length - 2,
    `${sum.judged}/${sum.met}/${sum.short}/${sum.quiet}`);
  check('S2 the weakest hour is the worst JUDGED hour, never the quietest',
    sum.weakest?.hour === 10, String(sum.weakest?.hour));
  check('S3 "calls arriving in a covered hour" counts calls, not hours',
    sum.callsMet === 70 && sum.callsJudged === 110, `${sum.callsMet}/${sum.callsJudged}`);

  console.log('\n── V: the drawing ───────────────────────────────────────────────────');
  const svg = curveSvg({ label: 'Didcot', curve, target: 90, baselineLabel: '2026 average' });
  check('V1 one marker per hour, each with a tooltip',
    (svg.match(/<title>/g) || []).length === curve.length, String((svg.match(/<title>/g) || []).length));
  // A marker path starts "M120 45L…"; the area fill starts "M40,152 L…" — the comma is
  // what tells them apart, so this really is checking for a drawn SHAPE, not the area.
  check('V2 verdicts differ in SHAPE as well as colour (colourblind, mono print, forced colours)',
    svg.includes('<circle') && /<path d="M[0-9.]+ [0-9.]+L/.test(svg), 'shapes');
  check('V3 the baseline is drawn as its own dashed series', svg.includes('stroke-dasharray'));
  check('V4 an empty day does not throw or divide by zero', (() => {
    const flat = buildCurve({ totalByHour: Array(24).fill(0), missedByHour: Array(24).fill(0), days: 7, baseline: null, target: 90 });
    const out = curveSvg({ label: 'Quiet', curve: flat, target: 90 });
    return out.includes('<svg') && !/NaN|Infinity/.test(out);
  })());
}

console.log('\n── the label a customer reads ───────────────────────────────────────');
{
  // dowIndex is Monday-first everywhere on this board; a Sunday-first slip would shift
  // every weekday mean by one day and still look plausible.
  check('X1 dowIndex is Monday-first', dowIndex('2026-08-24') === 0 && dowIndex('2026-08-23') === 6);
}

console.log('\n── D: the year average and the days it divides by ───────────────────');
{
  // Wantage, 8 Sep 2026. The daily table read c.35 calls a day; the year average said 21.
  // Nothing was wrong with the calls — the divisor counted days the branch was shut.
  // TWO mistakes, so the fixture carries both: a handful of Sunday emergency calls that
  // turned all 36 Sundays into "open days", and one divisor shared by every hour, so a
  // branch trading Saturday MORNINGS had its Tuesday afternoons divided by Saturdays too.
  const bucket = (days: number, openDays: number, byHour: Array<[number, number]>): DowBucket => {
    const hourTotal = Array(24).fill(0) as number[];
    const hourAnswered = Array(24).fill(0) as number[];
    let total = 0;
    for (const [h, n] of byHour) { hourTotal[h] = n; hourAnswered[h] = n; total += n; }
    return { days, openDays, total, answered: total, missed: 0, hourTotal, hourAnswered };
  };
  const WEEKDAY = (): DowBucket => bucket(36, 36, [[9, 360], [15, 360]]);   // 10 calls in each hour, each day
  const y = yearSeries(stats([
    WEEKDAY(), WEEKDAY(), WEEKDAY(), WEEKDAY(), WEEKDAY(),
    bucket(36, 36, [[9, 36]]),          // Saturday: mornings only, 1 call a day at 09:00
    bucket(36, 4, [[9, 4]]),            // Sunday: shut, but four emergency calls all year
  ]));
  const HOURS = {
    mon: { open: '09:00', close: '18:00' }, tue: { open: '09:00', close: '18:00' },
    wed: { open: '09:00', close: '18:00' }, thu: { open: '09:00', close: '18:00' },
    fri: { open: '09:00', close: '18:00' }, sat: { open: '09:00', close: '12:00' },
    sun: { closed: true },
  };
  const cells = yearAvgCallsByHour(y, ONEBOARD_HOURS, openPattern(y, HOURS));
  const at = (h: number) => cells.find((c) => Number(c.key) === h)!;

  check('D1 a stray Sunday call no longer turns every Sunday into an open day',
    at(9).days === 216, String(at(9).days));
  check('D2 …and those Sunday calls leave the numerator with them',
    at(9).total === 1836 && near(at(9).avg as number, 1836 / 216), `${at(9).total} / ${at(9).avg}`);
  check('D3 an hour the branch is shut on Saturday divides by weekdays only',
    at(15).days === 180 && near(at(15).avg as number, 10), `${at(15).days} / ${at(15).avg}`);
  // The bug, stated as arithmetic: one divisor of 252 for every hour.
  check('D4 the old whole-weekday divisor really did read low',
    near(1840 / 252, 7.30, 0.01) && (at(9).avg as number) > 8.4 && (at(15).avg as number) > 9.9,
    `${at(9).avg} / ${at(15).avg}`);
  check('D5 an hour outside every open day is closed, not zero',
    at(7).avg === null && at(19).avg === null, `${at(7).avg} / ${at(19).avg}`);
  check('D6 the observation says how many open days it is measured over',
    observeAvgCallsByHour(cells).includes('216 days'), observeAvgCallsByHour(cells));

  // No business hours configured: fall back to the evidence, and still drop the days that
  // carried nothing — four bank-holiday Mondays are closed days, not quiet ones.
  const yBank = yearSeries(stats([
    bucket(36, 32, [[9, 320]]), bucket(36, 36, [[9, 360]]), bucket(36, 36, [[9, 360]]),
    bucket(36, 36, [[9, 360]]), bucket(36, 36, [[9, 360]]), bucket(36, 0, []), bucket(36, 0, []),
  ]));
  const bank = yearAvgCallsByHour(yBank, ONEBOARD_HOURS, openPattern(yBank, null)).find((c) => Number(c.key) === 9)!;
  check('D7 with no hours configured, days that carried nothing are still left out',
    bank.days === 176 && near(bank.avg as number, 10), `${bank.days} / ${bank.avg}`);

  // A weekday the rota says is open but which has never taken a call is closed, and an
  // empty year divides by nothing rather than producing NaN.
  const yEmpty = yearSeries(stats(Array.from({ length: 7 }, () => bucket(36, 0, []))));
  const empty = yearAvgCallsByHour(yEmpty, ONEBOARD_HOURS, openPattern(yEmpty, HOURS));
  check('D8 config never outvotes an empty year, and nothing divides by zero',
    empty.every((c) => c.avg === null) && !empty.some((c) => Number.isNaN(c.avg as number)));

  check('D9 business hours with no per-day detail are read as Mon–Fri, as isInHours reads them',
    (() => { const p = hoursPattern({ start: '08:00', end: '18:30' })!;
             return p.dow[0] && p.dow[4] && !p.dow[5] && !p.dow[6] && p.hour[0][18] && !p.hour[0][19]; })());
  check('D10 no hours configured at all reads as "not configured", not "never open"',
    hoursPattern(null) === null && hoursPattern({}) === null);
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
