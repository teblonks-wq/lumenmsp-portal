import { insightsPool } from '../db/pool';
import { buildJourneys, formatWait, type LogicConfig } from './insights-journeys';
import {
  ONEBOARD_HOURS, DOW_LABELS, DOW_SHORT, dowIndex,
  addDays, asDay, dayList, ldn, logicFingerprint, metricsOf, siteLogicOf, type BoardMetrics,
} from './oneboard-core';
import {
  BASELINE_MIN_DAYS, baselineLabel, baselineWindow, fetchRowsBetween,
  isBaselineBuilding, kickBaselineBuild, loadSiteBaselines,
} from './oneboard-baseline';
import {
  baselineForRange, buildCurve, summariseCurve, CURVE_TARGET_DEFAULT,
  type CurveHour, type CurveSummary, type RangeBaseline,
} from './oneboard-curve';
import {
  yearSeries, yearMissedRateByHour, yearMissedRateByDow, yearShareByHour,
  yearAvgCallsByHour, observeAvgCallsByHour, type AvgCell,
  observeMissedByHour, observeMissedByDow, observeCallShare,
  type RateCell, type YearSeries,
} from './oneboard-year';

// ── OneBoard — "Dashboard for the whole company" ─────────────────────────────────
// One customer-facing dashboard that brings a customer's SITES together WITHOUT
// contaminating: every panel is built from journeys filtered by THAT site's own call
// logic (the same boundary discipline as the reports — see insights-journeys.ts).
// A site with no logic configured renders as "not set up" and contributes NOTHING,
// never a whole-customer bleed. Data is fetched once per range and re-filtered per
// site, so a 4-site customer costs one query, not four.
//
// Two questions, two comparisons. "Are we up or down?" is the previous-period compare.
// "Is this normal?" is the baseline — the year-to-date mean for these weekdays, read
// from the nightly cache in oneboard-baseline.ts. They answer different things and a
// week can easily be up on last week and still below a normal week.

export { ONEBOARD_HOURS, DOW_LABELS, DOW_SHORT, dowIndex };

/** One named call, for the "which call was the longest wait" question. */
export interface LongestWait {
  datetime: string;      // as the journey carries it, local
  number: string;        // the caller
  waitSecs: number;
  wait: string;          // pre-formatted, so every surface says it the same way
  status: string;        // Answered / Missed / Abandoned / Voicemail
  answeredBy: string | null;
}

export interface OneBoardSite {
  id: number;
  label: string;
  configured: boolean;              // has groups/staff in its logic — only then does it show data
  included: boolean;                // ticked onto the dashboard by this user
  metrics: BoardMetrics | null;
  prev:    BoardMetrics | null; // compare period
  // The worst individual waits in the period, worst first. Alex asked "which call was the
  // longest wait" (28 Aug) and the aggregates cannot answer it — an average never names a
  // caller. Capped at ten and computed here so the corpus, the board and anything later can
  // read it without carrying thousands of journeys around.
  longestWaits: LongestWait[];
  daily: { day: string; label: string; total: number; answered: number; missed: number }[];
  missedByHour: number[];           // indexed by hour-of-day (Europe/London)
  totalByHour: number[];            // ALL incoming calls per hour (Kim's all-calls heatmap)
  // Day-of-week breakdown. Hour-of-day alone answers "when are we busy" but NOT "which
  // shift should a new person work" - a Monday 9am problem and a Friday 4pm problem look
  // identical once you average them together. Index 0 = Monday ... 6 = Sunday.
  missedByDow: number[];            // 7
  totalByDow: number[];             // 7
  daysSeenByDow: number[];          // how many Mondays, Tuesdays... the range covers, so
                                    // a 10-day range does not make Mon/Tue look busier
  missedByDowHour: number[][];      // [7][24] - the grid Ask Insights reasons over
  totalByDowHour: number[][];       // [7][24]
  // The year-to-date mean for exactly these weekdays, and the day-shaped demand curve.
  baseline: RangeBaseline | null;   // null = not enough history yet, or cache not built
  curve: CurveHour[];               // one entry per business hour
  curveSummary: CurveSummary | null;
  // The YEAR pool — the same metrics over every day since January, not the dates on
  // screen. Null until the nightly cache has enough history for this site.
  year: YearSeries | null;
  // The year panels, as RATES. Each carries its own one-line observation, computed
  // from the cells and nothing else, so the chart never needs a human to interpret it.
  yearMissedByHour: RateCell[];
  yearMissedByDow: RateCell[];
  yearCallsByHour: RateCell[];
  yearAvgByHour: AvgCell[];
  yearNoteAvg: string;
  yearNoteHour: string;
  yearNoteDow: string;
  yearNoteCalls: string;
}

export interface OneBoardData {
  state: 'ok' | 'unlinked' | 'down';
  insName: string;
  sites: OneBoardSite[];
  hours: number[];                  // heatmap columns
  maxHeat: number;                  // max missed-per-hour cell across included sites
  maxHeatAll: number;               // max all-calls-per-hour cell across included sites
  compareNote: string | null;       // set when compare was requested but history can't support it
  // Baseline state for the whole board — the panels stay honest about which of these
  // three worlds they are in rather than drawing an average out of thin air.
  baselineState: 'ready' | 'building' | 'thin' | 'off';
  baselineNote: string | null;
  baselineName: string;             // "2026 average" / "12-month average"
  baselineFrom: string;
  baselineTo: string;
  target: number;                   // answer-rate target the demand curve is judged against
}

// Answer-rate target for the demand curve. Clamped: below 50% nothing is a target, and
// 100% would paint every hour red for one abandoned call.
export function parseTarget(q: Record<string, any>): number {
  const n = parseInt(String(q?.met ?? ''), 10);
  if (!Number.isFinite(n)) return CURVE_TARGET_DEFAULT;
  return Math.min(100, Math.max(50, n));
}

// Logic configs for a set of this customer's sites — used by /my/insights to apply the
// per-contact site layer to the Call Tracker and reverse-lookup tools.
export async function siteLogicsByIds(insCustomerId: number, ids: number[]): Promise<LogicConfig[]> {
  if (!insightsPool || !ids.length) return [];
  const r = await insightsPool.query(
    'SELECT business_hours, logic_config FROM sites WHERE customer_id=$1 AND id = ANY($2::int[])',
    [insCustomerId, ids]
  );
  return r.rows.map((row: any) => siteLogicOf(row)).filter(Boolean) as LogicConfig[];
}

async function fetchRows(insCustomerId: number, from: string, toExclusive: string) {
  return fetchRowsBetween(insCustomerId, from + ' 00:00:00', toExclusive + ' 00:00:00');
}

// ── Query parsing shared by the customer page (/my/oneboard), the staff page
// (/insights/oneboard) and both export routes — one source for range rules
// (default = last complete Mon–Sun week, 92-day cap, week/month selector lists).
export interface OneBoardRange {
  from: string; to: string; compare: boolean;
  weeks: { mon: string; label: string }[];
  months: { first: string; last: string; label: string }[];
  weekSel: string; monthSel: string;
  met: number;                      // answer-rate target for the demand curve
}

export function parseOneBoardRange(q: Record<string, any>): OneBoardRange {
  const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  const thisMon = new Date(now); thisMon.setUTCDate(thisMon.getUTCDate() - ((thisMon.getUTCDay() + 6) % 7));
  const lastMon = new Date(thisMon); lastMon.setUTCDate(lastMon.getUTCDate() - 7);
  let from = isDate(q.from) ? String(q.from) : iso(lastMon);
  let to = isDate(q.to) ? String(q.to) : iso(new Date(lastMon.getTime() + 6 * 86400000));
  if (to < from) { const t = from; from = to; to = t; }
  const span = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  if (span > 92) to = iso(new Date(new Date(from).getTime() + 91 * 86400000));

  const weeks: { mon: string; label: string }[] = [];
  for (let i = 1; i <= 12; i++) {
    const ms = new Date(thisMon); ms.setUTCDate(ms.getUTCDate() - i * 7);
    const su = new Date(ms); su.setUTCDate(su.getUTCDate() + 6);
    const fmt = (x: Date) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    weeks.push({ mon: iso(ms), label: fmt(ms) + ' – ' + fmt(su) + ' ' + su.getUTCFullYear() });
  }
  const months: { first: string; last: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const ms = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const me = new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 0));
    months.push({ first: iso(ms), last: iso(me), label: ms.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
  }
  const spanNow = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const weekSel = (spanNow === 7 && weeks.some((w) => w.mon === from)) ? from : '';
  const monthSel = months.find((m) => m.first === from && m.last === to)?.first || '';
  return { from, to, compare: q.cmp === '1', weeks, months, weekSel, monthSel, met: parseTarget(q) };
}

// Explicit ?sites= param → int list (possibly empty). Absent → null, so the caller
// can fall back to saved prefs (customer) or all sites (staff).
export function parseSiteIdsParam(q: Record<string, any>): number[] | null {
  if (q.sites === undefined) return null;
  const qs = q.sites;
  return (Array.isArray(qs) ? qs : [qs]).map((x) => parseInt(String(x), 10)).filter(Number.isInteger);
}

export async function buildOneBoard(
  portalCustomerId: number,
  opts: { from: string; to: string; siteIds: number[] | null; compare: boolean; allowedSiteIds?: number[] | null; target?: number }
): Promise<OneBoardData> {
  const target = opts.target || CURVE_TARGET_DEFAULT;
  const win = baselineWindow();
  const empty: OneBoardData = {
    state: 'down', insName: '', sites: [], hours: ONEBOARD_HOURS, maxHeat: 0, maxHeatAll: 0, compareNote: null,
    baselineState: 'off', baselineNote: null, baselineName: baselineLabel(win.from, win.to),
    baselineFrom: win.from, baselineTo: win.to, target,
  };
  if (!insightsPool) return empty;
  try {
    const ins = (await insightsPool.query(
      'SELECT id, name FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [portalCustomerId]
    )).rows[0];
    if (!ins) return { ...empty, state: 'unlinked' };

    let siteRows = (await insightsPool.query(
      'SELECT id, site_label, business_hours, logic_config FROM sites WHERE customer_id=$1 ORDER BY site_label', [ins.id]
    )).rows;
    // Site layer: a contact restricted to specific sites never sees the others AT ALL —
    // not even as unticked chips (the board behaves as if they don't exist).
    if (opts.allowedSiteIds?.length) siteRows = siteRows.filter((s: any) => opts.allowedSiteIds!.includes(Number(s.id)));
    if (!siteRows.length) return { ...empty, state: 'ok', insName: ins.name };

    // Site selection is validated against THIS customer's own sites — a forged id is ignored.
    const legal = new Set(siteRows.map((s: any) => Number(s.id)));
    const wanted = opts.siteIds ? new Set(opts.siteIds.filter((id) => legal.has(id))) : legal;

    const toEx = addDays(opts.to, 1);
    const rows = await fetchRows(ins.id, opts.from, toEx);
    const spanDays = Math.round((new Date(opts.to).getTime() - new Date(opts.from).getTime()) / 86400000) + 1;
    const prevFrom = addDays(opts.from, -spanDays);

    // Compare guard (universal): a previous-period window that starts before this customer's
    // call history begins UNDERCOUNTS, which reads as fake growth on every scorecard at once
    // (the Larkmead lesson, 2026-07-15). If history can't cover the whole window, say so
    // instead of showing misleading deltas.
    let compare = opts.compare;
    let compareNote: string | null = null;
    if (compare) {
      const floorRow = (await insightsPool.query(
        `SELECT to_char(MIN(event_datetime), 'YYYY-MM-DD') AS floor FROM call_events
          WHERE customer_id = $1
            AND (source_file ILIKE 'ContactGroupDetail%' OR source_file = 'tollring-sync')`, [ins.id]
      )).rows[0];
      // asDay(), not String().slice() — see the note on asDay in oneboard-core.ts. Read
      // the wrong way, this guard compared "2026-08-10" against "Thu Jan 01" and so
      // suppressed EVERY comparison from the day it shipped.
      const floor = asDay(floorRow?.floor);
      if (floor && prevFrom < floor) {
        compare = false;
        compareNote = `Comparison unavailable: the previous period would start ${prevFrom}, but call history only begins ${floor}.`;
      }
    }
    const prevRows = compare ? await fetchRowsBetween(ins.id, prevFrom + ' 00:00:00', opts.from + ' 00:00:00') : [];

    // The cached year, for the sites actually on the board. Rows built under different
    // site logic are dropped by loadSiteBaselines, so a retuned site shows no average
    // until the next nightly rebuild rather than a mean of two different definitions.
    const includedRows = siteRows.filter((s: any) => wanted.has(Number(s.id)) && siteLogicOf(s));
    const yearStats = await loadSiteBaselines(
      includedRows.map((s: any) => ({ id: Number(s.id), fingerprint: logicFingerprint(s) })), win
    );

    const days = dayList(opts.from, opts.to);
    const sites: OneBoardSite[] = [];
    let maxHeat = 0;
    let maxHeatAll = 0;

    for (const s of siteRows) {
      const included = wanted.has(Number(s.id));
      const logic = siteLogicOf(s);
      if (!logic || !included) {
        sites.push({ id: Number(s.id), label: s.site_label, configured: !!logic, included, metrics: null, prev: null, longestWaits: [],
          daily: [], missedByHour: [], totalByHour: [],
          missedByDow: [], totalByDow: [], daysSeenByDow: [], missedByDowHour: [], totalByDowHour: [],
          baseline: null, curve: [], curveSummary: null, year: null,
          yearMissedByHour: [], yearMissedByDow: [], yearCallsByHour: [], yearAvgByHour: [], yearNoteAvg: '',
          yearNoteHour: '', yearNoteDow: '', yearNoteCalls: '' });
        continue;
      }
      const journeys = buildJourneys(rows, logic);
      const prevJourneys = compare ? buildJourneys(prevRows, logic) : [];

      const byDay = new Map<string, { total: number; answered: number; missed: number }>();
      const heat: number[] = Array(24).fill(0);
      const heatAll: number[] = Array(24).fill(0);
      const missedByDow: number[] = Array(7).fill(0);
      const totalByDow: number[] = Array(7).fill(0);
      const missedByDowHour: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      const totalByDowHour: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      for (const j of journeys) {
        const p = ldn(j.datetime);
        if (!byDay.has(p.day)) byDay.set(p.day, { total: 0, answered: 0, missed: 0 });
        const b = byDay.get(p.day)!;
        const dw = dowIndex(p.day);
        b.total++;
        heatAll[p.hour]++;
        totalByDow[dw]++;
        totalByDowHour[dw][p.hour]++;
        if (j.status === 'Answered') b.answered++;
        else {
          b.missed++; heat[p.hour]++;
          missedByDow[dw]++;
          missedByDowHour[dw][p.hour]++;
        }
      }
      // How many of each weekday the range actually covers. Without this, "Monday is our
      // worst day" can just mean the range happened to contain three Mondays and two Fridays.
      const daysSeenByDow: number[] = Array(7).fill(0);
      for (const d of days) daysSeenByDow[dowIndex(d.day)]++;
      for (const h of ONEBOARD_HOURS) { maxHeat = Math.max(maxHeat, heat[h]); maxHeatAll = Math.max(maxHeatAll, heatAll[h]); }

      const stats = yearStats.get(Number(s.id));
      const baseline = stats && stats.daysCovered >= BASELINE_MIN_DAYS ? baselineForRange(stats, daysSeenByDow) : null;
      const curve = buildCurve({ totalByHour: heatAll, missedByHour: heat, days: days.length, baseline, target });
      const year = stats && stats.daysCovered >= BASELINE_MIN_DAYS ? yearSeries(stats) : null;
      const yHour = year ? yearMissedRateByHour(year, ONEBOARD_HOURS) : [];
      const yDow = year ? yearMissedRateByDow(year) : [];
      const yCalls = year ? yearShareByHour(year, ONEBOARD_HOURS) : [];
      // Alex Cumiskey's ask: the COUNT, not the share — a percentage cannot be staffed against.
      const yAvg = year ? yearAvgCallsByHour(year, ONEBOARD_HOURS) : [];
      const yearPanels = {
        yearMissedByHour: yHour, yearMissedByDow: yDow, yearCallsByHour: yCalls,
        yearAvgByHour: yAvg, yearNoteAvg: year ? observeAvgCallsByHour(yAvg) : '',
        yearNoteHour: year ? observeMissedByHour(yHour) : '',
        yearNoteDow: year ? observeMissedByDow(yDow) : '',
        yearNoteCalls: year ? observeCallShare(yCalls) : '',
      };

      // Worst waits, worst first. Ten is enough to see a pattern and short enough to sit in
      // the Ask Insights corpus without spoiling the prompt cache.
      const longestWaits: LongestWait[] = journeys
        .slice()
        .sort((a, b) => (b.wait_secs || 0) - (a.wait_secs || 0))
        .slice(0, 10)
        .map((j) => ({
          datetime: j.datetime, number: j.number, waitSecs: j.wait_secs || 0,
          wait: formatWait(j.wait_secs || 0), status: j.status, answeredBy: j.answered_by,
        }));

      sites.push({
        id: Number(s.id), label: s.site_label, configured: true, included: true,
        metrics: metricsOf(journeys),
        longestWaits,
        prev: compare ? metricsOf(prevJourneys) : null,
        daily: days.map((d) => ({ ...d, ...(byDay.get(d.day) || { total: 0, answered: 0, missed: 0 }) })),
        missedByHour: heat,
        totalByHour: heatAll,
        missedByDow, totalByDow, daysSeenByDow, missedByDowHour, totalByDowHour,
        baseline, curve, curveSummary: summariseCurve(curve),
        year, ...yearPanels,
      });
    }

    // Say which of the three baseline worlds we are in, once, for the whole board.
    let baselineState: OneBoardData['baselineState'] = 'ready';
    let baselineNote: string | null = null;
    const shown = sites.filter((s) => s.included && s.configured);
    const withBase = shown.filter((s) => s.baseline);
    if (!shown.length) {
      baselineState = 'off';
    } else if (!withBase.length) {
      if (isBaselineBuilding(ins.id)) {
        baselineState = 'building';
        baselineNote = 'The year-to-date average is being calculated for the first time. It will appear here within a few minutes — reload then.';
      } else if (yearStats.size) {
        baselineState = 'thin';
        baselineNote = `Not enough history yet for a ${baselineLabel(win.from, win.to).toLowerCase()} — it needs at least ${BASELINE_MIN_DAYS} days per site.`;
      } else {
        baselineState = 'building';
        baselineNote = 'The year-to-date average has not been calculated for this customer yet. It is being built now — reload in a few minutes.';
        kickBaselineBuild(ins.id);
      }
    } else if (withBase.length < shown.length) {
      baselineNote = `${shown.length - withBase.length} of ${shown.length} sites have no ${baselineLabel(win.from, win.to).toLowerCase()} yet (new site, or their call logic changed recently).`;
    }

    return {
      state: 'ok', insName: ins.name, sites, hours: ONEBOARD_HOURS, maxHeat, maxHeatAll, compareNote,
      baselineState, baselineNote, baselineName: baselineLabel(win.from, win.to),
      baselineFrom: win.from, baselineTo: win.to, target,
    };
  } catch (e: any) {
    console.error('[oneboard] build failed:', e?.message || e);
    return empty;
  }
}
