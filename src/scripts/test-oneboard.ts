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
 *   B1–B6   the baseline window and its January edge
 *   W1–W6   weekday-weighted scaling of a year onto the dates on screen
 *   C1–C6   the curve, its verdicts and the "too few calls to judge" floor
 *   S1–S3   the branch summary
 *   V1–V4   the drawing itself
 */
import { baselineLabel, baselineWindow, dowIndex, ONEBOARD_HOURS } from '../lib/oneboard-core';
import {
  baselineForRange, buildCurve, curveSvg, summariseCurve, verdictFor,
  CURVE_MIN_SAMPLE, CURVE_TARGET_DEFAULT,
} from '../lib/oneboard-curve';
import type { DowBucket, SiteYearStats } from '../lib/oneboard-baseline';
import { buildDaily, buildDow, buildMissedHours, dailySvg, dowSvg, missedHourSvg } from '../lib/oneboard-charts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function near(a: number, b: number, tol = 0.001): boolean { return Math.abs(a - b) <= tol; }

// A weekday bucket whose calls all land in one hour, so hour maths is checkable by eye.
function dow(days: number, total: number, answered: number, hour = 9): DowBucket {
  const hourTotal = Array(24).fill(0) as number[];
  const hourAnswered = Array(24).fill(0) as number[];
  hourTotal[hour] = total; hourAnswered[hour] = answered;
  return { days, total, answered, missed: total - answered, hourTotal, hourAnswered };
}
function stats(byDow: DowBucket[], firstDay = '2026-01-05', lastDay = '2026-08-23'): SiteYearStats {
  return { siteId: 1, daysCovered: byDow.reduce((n, b) => n + b.days, 0), firstDay, lastDay, byDow };
}
const NOTHING = () => dow(0, 0, 0);

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

console.log('\n── G: the rest of the board, as charts ──────────────────────────────');
{
  const DOW_AVG      = [100, 100, 100, 100, 100, 10, 0];   // a typical Mon..Sun
  const DOW_MISS_AVG = [10, 10, 10, 10, 10, 1, 0];
  const daily = [
    { day: '2026-08-17', label: 'Mon 17 Aug', total: 120, answered: 114, missed: 6 },   // 95% - met
    { day: '2026-08-18', label: 'Tue 18 Aug', total: 100, answered: 75,  missed: 25 },  // 75% - short (82% would be 'near')
    { day: '2026-08-22', label: 'Sat 22 Aug', total: 4,   answered: 0,   missed: 4 },   // below the floor
    { day: '2026-08-23', label: 'Sun 23 Aug', total: 0,   answered: 0,   missed: 0 },
  ];
  const dp = buildDaily(daily, dowIndex, DOW_AVG, 90);

  // The reference MOVES with the weekday. A flat "average day" would mark every
  // Saturday as a collapse and every Tuesday as a triumph.
  check('G1 each day is compared with its OWN weekday average',
    dp[0].expected === 100 && dp[2].expected === 10 && dp[3].expected === 0,
    `${dp[0].expected} / ${dp[2].expected} / ${dp[3].expected}`);
  check('G2 the day verdict uses the same rule as the hour verdict',
    dp[0].verdict === 'met' && dp[1].verdict === 'short' && dp[2].verdict === 'quiet',
    `${dp[0].verdict} / ${dp[1].verdict} / ${dp[2].verdict}`);
  check('G3 no baseline means no reference line, not a zero one',
    buildDaily(daily, dowIndex, null, 90).every((d) => d.expected === null));

  const dw = buildDow([500, 300, 0, 0, 0, 20, 0], [50, 60, 0, 0, 0, 2, 0], [5, 2, 0, 0, 0, 1, 0], DOW_AVG, DOW_MISS_AVG);
  // Five Mondays and two Tuesdays: the raw totals say Monday is worse, the per-day
  // figures say the opposite. This is the whole reason the chart plots per-day.
  check('G4 weekday bars are PER DAY, not totals',
    dw[0].perDay === 100 && dw[1].perDay === 150 && dw[0].missedPerDay === 10 && dw[1].missedPerDay === 30,
    `${dw[0].perDay}/${dw[1].perDay} · ${dw[0].missedPerDay}/${dw[1].missedPerDay}`);
  check('G5 a weekday the range never contained reads as nothing, not as zero calls',
    dw[2].seen === 0 && dw[2].perDay === 0 && dw[2].basePerDay === 100, String(dw[2].basePerDay));

  const HOURS = [7, 8, 9];
  const missedByHour = Array(24).fill(0); missedByHour[8] = 14; missedByHour[9] = 7;
  const totalByHour = Array(24).fill(0);  totalByHour[8] = 70;  totalByHour[9] = 70;
  const baseMissed = Array(24).fill(0);   baseMissed[8] = 1.0;  baseMissed[9] = 1.5;
  const mh = buildMissedHours(HOURS, missedByHour, totalByHour, 7, baseMissed);
  check('G6 missed-per-hour is per day of the range', mh[1].avg === 2 && mh[2].avg === 1, `${mh[1].avg}/${mh[2].avg}`);
  check('G7 …and carries the year average for the same hour', mh[1].baseAvg === 1 && mh[2].baseAvg === 1.5);
  check('G8 a zero-day range divides by zero nowhere',
    buildMissedHours(HOURS, missedByHour, totalByHour, 0, null).every((h) => h.avg === 0 && h.baseAvg === null));

  const svgs = [
    dailySvg({ label: 'Didcot', points: dp, target: 90, baselineLabel: '2026 average' }),
    dowSvg({ label: 'Didcot', points: dw, baselineLabel: '2026 average' }),
    missedHourSvg({ label: 'Didcot', points: mh, baselineLabel: '2026 average' }),
  ];
  check('G9 all three charts draw, with a tooltip on every mark that has data',
    svgs.every((x) => x.includes('<svg') && x.includes('<title>')));
  check('G10 no chart produces NaN or Infinity from empty data', (() => {
    const empty = [
      dailySvg({ label: 'Q', points: buildDaily([{ day: '2026-08-23', label: 'Sun', total: 0, answered: 0, missed: 0 }], dowIndex, null, 90), target: 90 }),
      dowSvg({ label: 'Q', points: buildDow(Array(7).fill(0), Array(7).fill(0), Array(7).fill(0), null, null) }),
      missedHourSvg({ label: 'Q', points: buildMissedHours([7, 8], Array(24).fill(0), Array(24).fill(0), 0, null) }),
    ];
    return empty.every((x) => x.includes('<svg') && !/NaN|Infinity/.test(x));
  })());
  check('G11 the year average is a dashed reference on every chart that has one',
    svgs.every((x) => x.includes('stroke-dasharray')));
}

console.log('\n── the label a customer reads ───────────────────────────────────────');
{
  // dowIndex is Monday-first everywhere on this board; a Sunday-first slip would shift
  // every weekday mean by one day and still look plausible.
  check('X1 dowIndex is Monday-first', dowIndex('2026-08-24') === 0 && dowIndex('2026-08-23') === 6);
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
