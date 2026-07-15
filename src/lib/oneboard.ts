import { insightsPool } from '../db/pool';
import { buildJourneys, type CallEventRow, type CallJourney, type LogicConfig } from './insights-journeys';

// ── OneBoard — "Dashboard for the whole company" ─────────────────────────────────
// One customer-facing dashboard that brings a customer's SITES together WITHOUT
// contaminating: every panel is built from journeys filtered by THAT site's own call
// logic (the same boundary discipline as the reports — see insights-journeys.ts).
// A site with no logic configured renders as "not set up" and contributes NOTHING,
// never a whole-customer bleed. Data is fetched once per range and re-filtered per
// site, so a 4-site customer costs one query, not four.

export interface OneBoardSite {
  id: number;
  label: string;
  configured: boolean;              // has groups/staff in its logic — only then does it show data
  included: boolean;                // ticked onto the dashboard by this user
  metrics: { total: number; answered: number; missed: number; rate: number } | null;
  prev:    { total: number; answered: number; missed: number; rate: number } | null; // compare period
  daily: { day: string; label: string; total: number; answered: number; missed: number }[];
  missedByHour: number[];           // indexed by hour-of-day (Europe/London)
  totalByHour: number[];            // ALL incoming calls per hour (Kim's all-calls heatmap)
}

export interface OneBoardData {
  state: 'ok' | 'unlinked' | 'down';
  insName: string;
  sites: OneBoardSite[];
  hours: number[];                  // heatmap columns
  maxHeat: number;                  // max missed-per-hour cell across included sites
  maxHeatAll: number;               // max all-calls-per-hour cell across included sites
}

export const ONEBOARD_HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 07:00–19:00

// Europe/London wall-clock parts for an ISO timestamp — the same clock the customer reads.
const LDN_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});
function ldn(iso: string): { day: string; hour: number } {
  const parts = LDN_FMT.formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: parseInt(g('hour'), 10) || 0 };
}

function siteLogicOf(row: any): LogicConfig | null {
  const logic: LogicConfig = row.logic_config || {};
  if (!logic.source_of_truth_group?.length && !logic.staff_extensions?.length) return null; // unconfigured
  if (row.business_hours) logic.business_hours = row.business_hours;
  return logic;
}

function metricsOf(journeys: CallJourney[]): { total: number; answered: number; missed: number; rate: number } {
  const total = journeys.length;
  const answered = journeys.filter((j) => j.status === 'Answered').length;
  const missed = total - answered; // Missed + Abandoned + anything not answered — "missed includes abandoned"
  return { total, answered, missed, rate: total ? Math.round((answered / total) * 100) : 0 };
}

async function fetchRows(insCustomerId: number, from: string, toExclusive: string): Promise<CallEventRow[]> {
  if (!insightsPool) return [];
  const r = await insightsPool.query(
    `SELECT id, customer_id AS site_id, event_datetime, group_name, outcome,
            number_raw, number_normalised, ddi, wait_seconds, source_file, call_id, extno, direction
       FROM call_events
      WHERE customer_id = $1
        AND event_datetime >= $2 AND event_datetime < $3
        AND (source_file ILIKE 'ContactGroupDetail%' OR source_file = 'tollring-sync')
      ORDER BY event_datetime ASC LIMIT 2000000`,
    [insCustomerId, from + ' 00:00:00', toExclusive + ' 00:00:00']
  );
  return r.rows as CallEventRow[];
}

// Every calendar day in [from, to] so quiet days still show as zero rows, not gaps.
function dayList(from: string, to: string): { day: string; label: string }[] {
  const out: { day: string; label: string }[] = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end && out.length < 120) {
    out.push({
      day: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Query parsing shared by the customer page (/my/oneboard), the staff page
// (/insights/oneboard) and both export routes — one source for range rules
// (default = last complete Mon–Sun week, 92-day cap, week/month selector lists).
export interface OneBoardRange {
  from: string; to: string; compare: boolean;
  weeks: { mon: string; label: string }[];
  months: { first: string; last: string; label: string }[];
  weekSel: string; monthSel: string;
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
  return { from, to, compare: q.cmp === '1', weeks, months, weekSel, monthSel };
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
  opts: { from: string; to: string; siteIds: number[] | null; compare: boolean }
): Promise<OneBoardData> {
  const empty: OneBoardData = { state: 'down', insName: '', sites: [], hours: ONEBOARD_HOURS, maxHeat: 0, maxHeatAll: 0 };
  if (!insightsPool) return empty;
  try {
    const ins = (await insightsPool.query(
      'SELECT id, name FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [portalCustomerId]
    )).rows[0];
    if (!ins) return { ...empty, state: 'unlinked' };

    const siteRows = (await insightsPool.query(
      'SELECT id, site_label, business_hours, logic_config FROM sites WHERE customer_id=$1 ORDER BY site_label', [ins.id]
    )).rows;
    if (!siteRows.length) return { ...empty, state: 'ok', insName: ins.name };

    // Site selection is validated against THIS customer's own sites — a forged id is ignored.
    const legal = new Set(siteRows.map((s: any) => Number(s.id)));
    const wanted = opts.siteIds ? new Set(opts.siteIds.filter((id) => legal.has(id))) : legal;

    const toEx = addDays(opts.to, 1);
    const rows = await fetchRows(ins.id, opts.from, toEx);
    const spanDays = Math.round((new Date(opts.to).getTime() - new Date(opts.from).getTime()) / 86400000) + 1;
    const prevFrom = addDays(opts.from, -spanDays);
    const prevRows = opts.compare ? await fetchRows(ins.id, prevFrom, opts.from) : [];

    const days = dayList(opts.from, opts.to);
    const sites: OneBoardSite[] = [];
    let maxHeat = 0;
    let maxHeatAll = 0;

    for (const s of siteRows) {
      const included = wanted.has(Number(s.id));
      const logic = siteLogicOf(s);
      if (!logic || !included) {
        sites.push({ id: Number(s.id), label: s.site_label, configured: !!logic, included, metrics: null, prev: null, daily: [], missedByHour: [], totalByHour: [] });
        continue;
      }
      const journeys = buildJourneys(rows, logic);
      const prevJourneys = opts.compare ? buildJourneys(prevRows, logic) : [];

      const byDay = new Map<string, { total: number; answered: number; missed: number }>();
      const heat: number[] = Array(24).fill(0);
      const heatAll: number[] = Array(24).fill(0);
      for (const j of journeys) {
        const p = ldn(j.datetime);
        if (!byDay.has(p.day)) byDay.set(p.day, { total: 0, answered: 0, missed: 0 });
        const b = byDay.get(p.day)!;
        b.total++;
        heatAll[p.hour]++;
        if (j.status === 'Answered') b.answered++;
        else { b.missed++; heat[p.hour]++; }
      }
      for (const h of ONEBOARD_HOURS) { maxHeat = Math.max(maxHeat, heat[h]); maxHeatAll = Math.max(maxHeatAll, heatAll[h]); }

      sites.push({
        id: Number(s.id), label: s.site_label, configured: true, included: true,
        metrics: metricsOf(journeys),
        prev: opts.compare ? metricsOf(prevJourneys) : null,
        daily: days.map((d) => ({ ...d, ...(byDay.get(d.day) || { total: 0, answered: 0, missed: 0 }) })),
        missedByHour: heat,
        totalByHour: heatAll,
      });
    }
    return { state: 'ok', insName: ins.name, sites, hours: ONEBOARD_HOURS, maxHeat, maxHeatAll };
  } catch (e: any) {
    console.error('[oneboard] build failed:', e?.message || e);
    return empty;
  }
}
