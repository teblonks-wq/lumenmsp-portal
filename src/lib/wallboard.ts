import { insightsPool } from '../db/pool';
import { buildJourneys, formatWait, type CallEventRow, type CallJourney, type LogicConfig } from './insights-journeys';

// ── Wallboard — a LIVE, visual, single-site board for a TV ─────────────────────────
// Not a reporting tool: one site, today only, big numbers, driven entirely by call
// journeys (the same buildJourneys boundary discipline as reports and OneBoard).
// Freshness = the Tollring sync cadence; the payload carries lastEventAt so the
// board can say honestly how fresh it is.

export const WALLBOARD_MODULES: { key: string; label: string; desc: string }[] = [
  { key: 'total',         label: 'Total calls',            desc: 'All incoming calls today' },
  { key: 'answered',      label: 'Answered',               desc: 'Calls answered today' },
  { key: 'missed',        label: 'Missed',                 desc: 'Missed today — includes abandoned' },
  { key: 'rate',          label: 'Answer rate',            desc: 'Answered as % of total' },
  { key: 'callbacks',     label: 'Awaiting call-back',     desc: 'Missed callers not yet rung back (no answered call from them, no outbound to them)' },
  { key: 'callback_list', label: 'Call-back list',         desc: 'The actual numbers to ring back, oldest first' },
  { key: 'lasthour',      label: 'Last hour',              desc: 'Calls and missed in the last 60 minutes' },
  { key: 'avgwait',       label: 'Average wait',           desc: 'Average wait of answered calls today' },
  { key: 'longestwait',   label: 'Longest wait',           desc: 'Longest wait of any call today' },
  { key: 'byhour',        label: 'Today by hour',          desc: 'Answered v missed per hour, full width' },
];
export const WALLBOARD_DEFAULT = ['total', 'answered', 'missed', 'rate', 'callbacks', 'byhour'];

export interface WallboardData {
  state: 'ok' | 'unlinked' | 'nosite' | 'down';
  insName: string;
  siteId: number;
  siteLabel: string;
  updatedAt: string;               // when this payload was computed (ISO)
  lastEventAt: string | null;      // latest call event seen today — the honest freshness marker
  metrics: {
    total: number; answered: number; missed: number; rate: number;
    avgWait: string; longestWait: string;
    lastHourTotal: number; lastHourMissed: number;
    callbacks: number;
  };
  callbackList: { number: string; time: string; waited: string }[];
  byHour: { hour: number; answered: number; missed: number }[];
}

const LDN_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function ldnParts(d: Date): { day: string; hour: number; hm: string } {
  const parts = LDN_FMT.formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: parseInt(g('hour'), 10) || 0, hm: `${g('hour')}:${g('minute')}` };
}

const isOutbound = (dir?: string | null) => /^o/i.test(String(dir || '').trim());
const numOf = (n?: string | null) => String(n || '').replace(/\s+/g, '');

// The customer's sites (via the lumenmsp bridge) for the picker — configured flag
// so the UI can grey out sites whose call logic isn't set up yet.
export async function wallboardSites(portalCustomerId: number): Promise<{ id: number; label: string; configured: boolean }[]> {
  if (!insightsPool) return [];
  const ins = (await insightsPool.query(
    'SELECT id FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [portalCustomerId]
  )).rows[0];
  if (!ins) return [];
  const rows = (await insightsPool.query(
    'SELECT id, site_label, logic_config FROM sites WHERE customer_id=$1 ORDER BY site_label', [ins.id]
  )).rows;
  return rows.map((s: any) => ({
    id: Number(s.id), label: s.site_label,
    configured: Boolean(s.logic_config && (s.logic_config.source_of_truth_group?.length || s.logic_config.staff_extensions?.length)),
  }));
}

export async function buildWallboard(portalCustomerId: number, siteId: number): Promise<WallboardData> {
  const now = new Date();
  const empty: WallboardData = {
    state: 'down', insName: '', siteId, siteLabel: '', updatedAt: now.toISOString(), lastEventAt: null,
    metrics: { total: 0, answered: 0, missed: 0, rate: 0, avgWait: '0s', longestWait: '0s', lastHourTotal: 0, lastHourMissed: 0, callbacks: 0 },
    callbackList: [], byHour: [],
  };
  if (!insightsPool) return empty;
  try {
    const ins = (await insightsPool.query(
      'SELECT id, name FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [portalCustomerId]
    )).rows[0];
    if (!ins) return { ...empty, state: 'unlinked' };

    // Site must belong to THIS customer — a forged id is simply not found.
    const site = (await insightsPool.query(
      'SELECT id, site_label, business_hours, logic_config FROM sites WHERE id=$1 AND customer_id=$2 LIMIT 1', [siteId, ins.id]
    )).rows[0];
    if (!site) return { ...empty, state: 'nosite', insName: ins.name };
    const logic: LogicConfig = site.logic_config || {};
    if (!logic.source_of_truth_group?.length && !logic.staff_extensions?.length) {
      return { ...empty, state: 'nosite', insName: ins.name, siteLabel: site.site_label };
    }
    if (site.business_hours) logic.business_hours = site.business_hours;

    // Today in the customer's clock (Europe/London), midnight → now.
    const today = ldnParts(now).day;
    const r = await insightsPool.query(
      `SELECT id, customer_id AS site_id, event_datetime, group_name, outcome,
              number_raw, number_normalised, ddi, wait_seconds, source_file, call_id, extno, direction
         FROM call_events
        WHERE customer_id = $1 AND event_datetime >= $2
          AND (source_file ILIKE 'ContactGroupDetail%' OR source_file = 'tollring-sync')
        ORDER BY event_datetime ASC LIMIT 200000`,
      [ins.id, today + ' 00:00:00']
    );
    const rows = r.rows as CallEventRow[];
    const lastEventAt = rows.length ? String(rows[rows.length - 1].event_datetime) : null;

    const journeys: CallJourney[] = buildJourneys(rows, logic);
    const total = journeys.length;
    const answeredJ = journeys.filter((j) => j.status === 'Answered');
    const answered = answeredJ.length;
    const missed = total - answered;   // missed includes abandoned — same rule as everywhere

    // Reconnected = same semantics as the Missed Follow-up report module: an answered
    // call FROM that number today, or an outbound call TO it (any extension, raw rows).
    const reconnected = new Set<string>();
    for (const j of answeredJ) if (j.number) reconnected.add(numOf(j.number));
    for (const row of rows) if (isOutbound(row.direction)) reconnected.add(numOf(row.number_normalised || row.number_raw));

    const toChase = journeys
      .filter((j) => j.status !== 'Answered' && j.number && !reconnected.has(numOf(j.number)))
      .sort((a, b) => a.datetime < b.datetime ? -1 : 1);
    // Dedup by number — one entry per caller, keep their FIRST miss of the day.
    const seen = new Set<string>();
    const callbackList: { number: string; time: string; waited: string }[] = [];
    for (const j of toChase) {
      const n = numOf(j.number);
      if (seen.has(n)) continue;
      seen.add(n);
      callbackList.push({ number: j.number, time: ldnParts(new Date(j.datetime)).hm, waited: j.wait || formatWait(j.wait_secs || 0) });
    }

    const hourAgo = now.getTime() - 3600000;
    const lastHour = journeys.filter((j) => new Date(j.datetime).getTime() >= hourAgo);
    const waits = answeredJ.map((j) => j.wait_secs || 0);
    const avgWait = waits.length ? formatWait(Math.round(waits.reduce((a, b) => a + b, 0) / waits.length)) : '0s';
    const longestWait = journeys.length ? formatWait(Math.max(0, ...journeys.map((j) => j.wait_secs || 0))) : '0s';

    const byHourMap = new Map<number, { answered: number; missed: number }>();
    for (let h = 7; h <= 19; h++) byHourMap.set(h, { answered: 0, missed: 0 });
    for (const j of journeys) {
      const h = ldnParts(new Date(j.datetime)).hour;
      if (!byHourMap.has(h)) continue;
      const b = byHourMap.get(h)!;
      if (j.status === 'Answered') b.answered++; else b.missed++;
    }

    return {
      state: 'ok', insName: ins.name, siteId: Number(site.id), siteLabel: site.site_label,
      updatedAt: now.toISOString(), lastEventAt,
      metrics: {
        total, answered, missed, rate: total ? Math.round((answered / total) * 100) : 0,
        avgWait, longestWait,
        lastHourTotal: lastHour.length, lastHourMissed: lastHour.filter((j) => j.status !== 'Answered').length,
        callbacks: callbackList.length,
      },
      callbackList: callbackList.slice(0, 10),
      byHour: [...byHourMap.entries()].map(([hour, v]) => ({ hour, ...v })),
    };
  } catch (e: any) {
    console.error('[wallboard] build failed:', e?.message || e);
    return empty;
  }
}
