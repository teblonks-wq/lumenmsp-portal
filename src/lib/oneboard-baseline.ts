import cron from 'node-cron';
import { insightsPool } from '../db/pool';
import { buildJourneys, type CallEventRow, type LogicConfig } from './insights-journeys';
import {
  addDays, asDay, dayList, dowIndex, ldn, logicFingerprint, siteLogicOf,
  BASELINE_FLOOR, BASELINE_MIN_DAYS, BASELINE_WINDOW_DAYS, baselineLabel, baselineWindow, londonToday,
} from './oneboard-core';

export { BASELINE_FLOOR, BASELINE_MIN_DAYS, BASELINE_WINDOW_DAYS, baselineLabel, baselineWindow, londonToday };

// ── OneBoard baseline — "what does a typical day look like this year?" ────────────
// The board's scorecards compare a week against the week before it. That answers
// "are we up or down", never "is this normal". This module keeps the other half: a
// per-site, per-day, per-hour roll-up of EVERY day of the year so far, from which the
// board derives a mean.
//
// It is a CACHE, not a second source of truth. Every figure in it is produced by the
// same buildJourneys() the board and the locked reports use, over the same call_events
// rows — so a baseline day and an on-screen day are the same number by construction.
//
// Why cache at all: a year of one busy customer is ~2m call_events rows. Rebuilding
// that per page load is not a slow page, it is an outage. Rebuilt nightly, and rows
// carry the fingerprint of the site logic that produced them, so retuning a site's
// groups invalidates its history instead of averaging two definitions together.

const REFRESH_TAIL_DAYS = 14;                   // always recompute the trailing fortnight (late sync, backfills)
const CHUNK_DAYS = 7;                           // rows are fetched a week at a time
const CHUNK_PAD_HOURS = 3;                      // …with a pad, so a call that straddles midnight is whole

/** The one call_events read, shared by the board and this cache. Timestamps are passed
 *  through verbatim (the insights pool is NOT the Portal pool and is deliberately
 *  untouched by src/db/pg-utc.ts — see [[pg-utc-timestamps]]), so callers must build the
 *  same 'YYYY-MM-DD HH:MM:SS' strings the board has always used or the two disagree by
 *  an hour and the baseline stops matching the board it is meant to explain. */
export async function fetchRowsBetween(insCustomerId: number, fromTs: string, toTs: string): Promise<CallEventRow[]> {
  if (!insightsPool) return [];
  const r = await insightsPool.query(
    `SELECT id, customer_id AS site_id, event_datetime, group_name, outcome,
            number_raw, number_normalised, ddi, wait_seconds, source_file, call_id, extno, direction,
            duration_secs
       FROM call_events
      WHERE customer_id = $1
        AND event_datetime >= $2 AND event_datetime < $3
        AND (source_file ILIKE 'ContactGroupDetail%' OR source_file = 'tollring-sync')
      ORDER BY event_datetime ASC LIMIT 2000000`,
    [insCustomerId, fromTs, toTs]
  );
  return r.rows as CallEventRow[];
}

export interface DowBucket {
  days: number; total: number; answered: number; missed: number;
  hourTotal: number[];     // 24
  hourAnswered: number[];  // 24
}

export interface SiteYearStats {
  siteId: number;
  daysCovered: number;
  firstDay: string | null;
  lastDay: string | null;
  byDow: DowBucket[];      // 7, Monday-first
}

function emptyDow(): DowBucket {
  return { days: 0, total: 0, answered: 0, missed: 0, hourTotal: Array(24).fill(0), hourAnswered: Array(24).fill(0) };
}

// ── Storage ───────────────────────────────────────────────────────────────────────

let tableReady: Promise<boolean> | null = null;
export function ensureDayStatsTable(): Promise<boolean> {
  if (!insightsPool) return Promise.resolve(false);
  if (!tableReady) {
    tableReady = insightsPool.query(`
      CREATE TABLE IF NOT EXISTS oneboard_day_stats (
        site_id       INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        day           DATE        NOT NULL,
        total         INTEGER     NOT NULL DEFAULT 0,
        answered      INTEGER     NOT NULL DEFAULT 0,
        missed        INTEGER     NOT NULL DEFAULT 0,
        hour_total    INTEGER[]   NOT NULL,
        hour_answered INTEGER[]   NOT NULL,
        fingerprint   TEXT        NOT NULL,
        computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (site_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_oneboard_day_stats_day ON oneboard_day_stats (day);
    `).then(() => true).catch((e: any) => {
      // A board that cannot cache is a board without a baseline, never a broken board.
      console.error('[oneboard-baseline] could not create oneboard_day_stats:', e?.message || e);
      return false;
    });
  }
  return tableReady;
}

/** Read the cached year for a set of sites. Rows whose fingerprint no longer matches the
 *  site's current logic are IGNORED, not shown — a stale average is worse than none. */
export async function loadSiteBaselines(
  sites: { id: number; fingerprint: string }[],
  window: { from: string; to: string } = baselineWindow()
): Promise<Map<number, SiteYearStats>> {
  const out = new Map<number, SiteYearStats>();
  if (!insightsPool || !sites.length) return out;
  if (!(await ensureDayStatsTable())) return out;

  const ids = sites.map((s) => s.id);
  const fpOf = new Map(sites.map((s) => [s.id, s.fingerprint]));
  const r = await insightsPool.query(
    `SELECT site_id, to_char(day, 'YYYY-MM-DD') AS day, total, answered, missed, hour_total, hour_answered, fingerprint
       FROM oneboard_day_stats
      WHERE site_id = ANY($1::int[]) AND day >= $2::date AND day <= $3::date
      ORDER BY site_id, day`,
    [ids, window.from, window.to]
  ).catch((e: any) => { console.error('[oneboard-baseline] read failed:', e?.message || e); return { rows: [] as any[] }; });

  const bySite = new Map<number, any[]>();
  for (const row of r.rows) {
    if (fpOf.get(Number(row.site_id)) !== row.fingerprint) continue; // logic changed since this day was computed
    const k = Number(row.site_id);
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k)!.push(row);
  }

  for (const [siteId, rows] of bySite) {
    // Days before this site's first real call are dropped: a site that came online in
    // March must not carry January's zeroes into its "typical Monday".
    const firstLive = rows.findIndex((x) => Number(x.total) > 0);
    const live = firstLive < 0 ? [] : rows.slice(firstLive);
    if (!live.length) continue;
    const byDow = Array.from({ length: 7 }, emptyDow);
    for (const row of live) {
      const b = byDow[dowIndex(row.day)];
      b.days++;
      b.total += Number(row.total) || 0;
      b.answered += Number(row.answered) || 0;
      b.missed += Number(row.missed) || 0;
      const ht = row.hour_total || [], ha = row.hour_answered || [];
      for (let h = 0; h < 24; h++) { b.hourTotal[h] += Number(ht[h]) || 0; b.hourAnswered[h] += Number(ha[h]) || 0; }
    }
    out.set(siteId, {
      siteId, daysCovered: live.length,
      firstDay: live[0].day, lastDay: live[live.length - 1].day, byDow,
    });
  }
  return out;
}

// ── Build ─────────────────────────────────────────────────────────────────────────

const running = new Set<number>();

/** Rebuild the cached year for one insights customer. Missing days are filled, the
 *  trailing fortnight is always recomputed (the 10-minute Tollring sync keeps changing
 *  it), and a site whose logic fingerprint moved is rebuilt from scratch. */
export async function refreshBaselineForCustomer(
  insCustomerId: number,
  opts: { window?: { from: string; to: string }; log?: boolean } = {}
): Promise<{ sites: number; days: number }> {
  // A scheduled job that decides to do nothing MUST say why it decided that. Returning
  // {sites:0,days:0} in silence cost a whole afternoon of guessing (2026-08-25).
  const bail = (why: string) => {
    console.log(`[oneboard-baseline] customer ${insCustomerId}: nothing done — ${why}`);
    return { sites: 0, days: 0 };
  };
  if (!insightsPool) return bail('INSIGHTS_DATABASE_URL is not set, so there is no insights pool');
  if (!(await ensureDayStatsTable())) return bail('the oneboard_day_stats table could not be created or read');
  if (running.has(insCustomerId)) return bail('a build for this customer is already running');
  running.add(insCustomerId);
  const started = Date.now();
  try {
    const win = opts.window || baselineWindow();
    const siteRows = (await insightsPool.query(
      'SELECT id, site_label, business_hours, logic_config FROM sites WHERE customer_id=$1', [insCustomerId]
    )).rows;
    const targets = siteRows
      .map((s: any) => ({ id: Number(s.id), label: s.site_label, logic: siteLogicOf(s), fp: logicFingerprint(s) }))
      .filter((s: any) => s.logic) as { id: number; label: string; logic: LogicConfig; fp: string }[];
    if (!targets.length) return bail(`none of this customer's ${siteRows.length} site(s) have call logic configured`);

    // Never compute days the customer has no history for at all.
    // to_char, not ::date — belt and braces alongside asDay(), so this can never again
    // depend on how the driver feels about date columns.
    const floorRow = (await insightsPool.query(
      `SELECT to_char(MIN(event_datetime), 'YYYY-MM-DD') AS floor,
              to_char(MAX(event_datetime), 'YYYY-MM-DD') AS ceil FROM call_events
        WHERE customer_id=$1 AND (source_file ILIKE 'ContactGroupDetail%' OR source_file = 'tollring-sync')`,
      [insCustomerId]
    )).rows[0];
    const histFrom = asDay(floorRow?.floor);
    const histTo = asDay(floorRow?.ceil);
    if (!histFrom || !histTo) return bail('this customer has no call history at all');
    const from = win.from > histFrom ? win.from : histFrom;
    const to = win.to < histTo ? win.to : histTo;
    if (to < from) return bail(`the window ends before it starts (${from} → ${to}; history ${histFrom} → ${histTo})`);

    const allDays = dayList(from, to, 400).map((d) => d.day);
    const tailFrom = addDays(to, -(REFRESH_TAIL_DAYS - 1));

    // What each site is missing. A fingerprint change wipes that site's rows first, so
    // old and new definitions can never sit in the same average.
    const need = new Map<number, Set<string>>();
    for (const t of targets) {
      const have = (await insightsPool.query(
        `SELECT to_char(day,'YYYY-MM-DD') AS day FROM oneboard_day_stats
          WHERE site_id=$1 AND day >= $2::date AND day <= $3::date AND fingerprint=$4`,
        [t.id, from, to, t.fp]
      )).rows.map((x: any) => x.day);
      const stale = (await insightsPool.query(
        'SELECT COUNT(*)::int AS n FROM oneboard_day_stats WHERE site_id=$1 AND fingerprint<>$2', [t.id, t.fp]
      )).rows[0]?.n || 0;
      if (stale) {
        await insightsPool.query('DELETE FROM oneboard_day_stats WHERE site_id=$1 AND fingerprint<>$2', [t.id, t.fp]);
        if (opts.log !== false) console.log(`[oneboard-baseline] ${t.label}: site logic changed — ${stale} cached days dropped`);
      }
      const haveSet = new Set(have);
      const missing = new Set(allDays.filter((d) => !haveSet.has(d) || d >= tailFrom));
      if (missing.size) need.set(t.id, missing);
    }
    if (!need.size) {
      if (opts.log !== false) console.log(`[oneboard-baseline] customer ${insCustomerId}: already up to date (${allDays.length} days, ${targets.length} sites)`);
      return { sites: targets.length, days: 0 };
    }

    // Union of the days anyone needs, walked a week at a time. Rows are fetched ONCE per
    // week and re-filtered per site — a 5-site customer costs one query per week, not five.
    const union = new Set<string>();
    for (const set of need.values()) for (const d of set) union.add(d);
    const ordered = allDays.filter((d) => union.has(d));
    let written = 0;

    for (let i = 0; i < ordered.length; i += CHUNK_DAYS) {
      const chunk = ordered.slice(i, i + CHUNK_DAYS);
      const chunkSet = new Set(chunk);
      const pad = (n: number) => String(n).padStart(2, '0');
      const padStart = `${addDays(chunk[0], -1)} ${pad(24 - CHUNK_PAD_HOURS)}:00:00`;
      const padEnd = `${addDays(chunk[chunk.length - 1], 1)} ${pad(CHUNK_PAD_HOURS)}:00:00`;
      const rows = await fetchRowsBetween(insCustomerId, padStart, padEnd);

      for (const t of targets) {
        const wanted = need.get(t.id);
        if (!wanted) continue;
        const days = chunk.filter((d) => wanted.has(d));
        if (!days.length) continue;

        const acc = new Map<string, { total: number; answered: number; missed: number; ht: number[]; ha: number[] }>();
        for (const d of days) acc.set(d, { total: 0, answered: 0, missed: 0, ht: Array(24).fill(0), ha: Array(24).fill(0) });
        for (const j of buildJourneys(rows, t.logic)) {
          const p = ldn(j.datetime);
          const a = acc.get(p.day);
          if (!a) continue;                              // the pad, or a day this site already has
          a.total++; a.ht[p.hour]++;
          if (j.status === 'Answered') { a.answered++; a.ha[p.hour]++; } else a.missed++;
        }
        // Zero days are written, not skipped: a Sunday with no calls is a real Sunday and
        // has to pull the Sunday average down, or every closed day reads as "no data".
        const vals: string[] = [];
        const params: any[] = [];
        for (const d of days) {
          const a = acc.get(d)!;
          const b = params.length;
          vals.push(`($${b + 1},$${b + 2}::date,$${b + 3},$${b + 4},$${b + 5},$${b + 6}::int[],$${b + 7}::int[],$${b + 8})`);
          params.push(t.id, d, a.total, a.answered, a.missed, a.ht, a.ha, t.fp);
        }
        await insightsPool.query(
          `INSERT INTO oneboard_day_stats (site_id, day, total, answered, missed, hour_total, hour_answered, fingerprint)
           VALUES ${vals.join(',')}
           ON CONFLICT (site_id, day) DO UPDATE SET
             total=EXCLUDED.total, answered=EXCLUDED.answered, missed=EXCLUDED.missed,
             hour_total=EXCLUDED.hour_total, hour_answered=EXCLUDED.hour_answered,
             fingerprint=EXCLUDED.fingerprint, computed_at=NOW()`,
          params
        );
        written += days.length;
      }
    }
    if (opts.log !== false) {
      console.log(`[oneboard-baseline] customer ${insCustomerId}: ${written} site-days computed in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    return { sites: targets.length, days: written };
  } catch (e: any) {
    console.error('[oneboard-baseline] refresh failed:', e?.message || e);
    return { sites: 0, days: 0 };
  } finally {
    running.delete(insCustomerId);
  }
}

/** Start a build without waiting for it — used when a board is opened for a customer whose
 *  year has never been computed. The page renders now and says so; the average appears on
 *  the next load. Never awaited, never allowed to reject into a request. */
export function kickBaselineBuild(insCustomerId: number): boolean {
  if (running.has(insCustomerId)) return true;
  void refreshBaselineForCustomer(insCustomerId).catch(() => {});
  return true;
}

export function isBaselineBuilding(insCustomerId: number): boolean {
  return running.has(insCustomerId);
}

async function refreshAll(): Promise<void> {
  if (!insightsPool) return;
  try {
    const rows = (await insightsPool.query('SELECT id, name FROM customers WHERE is_active=true ORDER BY id')).rows;
    for (const c of rows) await refreshBaselineForCustomer(Number(c.id));
  } catch (e: any) {
    console.error('[oneboard-baseline] nightly refresh failed:', e?.message || e);
  }
}

export function startOneBoardBaseline(): void {
  if (!insightsPool) { console.log('• OneBoard baseline not started (INSIGHTS_DATABASE_URL not set)'); return; }
  // 02:25 — after the night's Tollring syncs, before anyone opens a board.
  cron.schedule('25 2 * * *', refreshAll);
  console.log('✓ OneBoard baseline scheduler started (nightly 02:25)');
}
