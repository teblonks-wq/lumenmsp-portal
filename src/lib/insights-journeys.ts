/**
 * Journey Builder (ported from Insights) — converts raw call_events rows into CallJourney objects.
 * Pure logic, no DB. A "journey" = one customer call, potentially touching multiple hunt groups.
 */

export interface LogicConfig {
  source_of_truth_group?:      string[];
  source_of_truth_extensions?: string[];
  staff_extensions?:           string[];
  call_flow?:                  { group: string; label: string }[];
  overflow_label?:             string;
  business_hours?:             any;
  business_hours_only?:        boolean;
  journey_window_seconds?:     number;
  min_wait_seconds?:           number;
  emergency_ddi?:              string[];
  ivr_options?:                { group: string; label: string }[];
  ivr_counts_as_answered?:     boolean;
}

export interface CallEventRow {
  id:                bigint | number;
  site_id:           number;
  event_datetime:    Date | string;
  group_name:        string;
  outcome:           string;
  number_raw:        string;
  number_normalised: string;
  ddi:               string | null;
  wait_seconds:      number;
  source_file:       string;
  call_id?:          string | null;
  extno?:            string | null;
  direction?:        string | null;
}

export interface JourneyStep { group: string; outcome: string; label?: string; }

export interface CallJourney {
  datetime:    string;
  number:      string;
  ddi:         string;
  status:      'Answered' | 'Missed' | 'Abandoned' | 'Overflowed' | 'Voicemail';
  overflowed:  boolean;
  in_hours:    boolean;
  wait:        string;
  wait_secs:   number;
  answered_by: string | null;
  steps:       JourneyStep[];
  ivr_label:   string | null;
  is_emergency:          boolean;
  is_voicemail:          boolean;
  is_ivr_voicemail:      boolean;
  is_overflow_voicemail: boolean;
}

export function formatWait(secs: number): string {
  if (secs === 0) return '0s';
  if (secs < 60)  return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function toTs(dt: Date | string): number { return new Date(dt).getTime(); }

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DowKey = typeof DOW_KEYS[number];
export interface DayHours { open?: string; close?: string; closed?: boolean; }
export type BusinessHours = { start: string; end: string } | Partial<Record<DowKey, DayHours>>;

export const DEFAULT_HOURS: Partial<Record<DowKey, DayHours>> = {
  mon: { open: '08:00', close: '18:30' }, tue: { open: '08:00', close: '18:30' },
  wed: { open: '08:00', close: '18:30' }, thu: { open: '08:00', close: '18:30' },
  fri: { open: '08:00', close: '18:30' }, sat: { closed: true }, sun: { closed: true },
};

export function isInHours(dt: Date | string, hours?: BusinessHours): boolean {
  const d = new Date(dt);
  // Evaluate the time-of-day in UK LOCAL time (Europe/London) so business hours like 08:00–18:30
  // mean the local clock, correct year-round through GMT and BST. (Previously used raw UTC, which
  // shifted the window by an hour during British Summer Time — letting after-hours evening calls in
  // and dropping genuine early-morning calls.)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const part = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const dowMap: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[part('weekday')] ?? (d.getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6);
  const h = parseInt(part('hour'), 10) || 0;
  const m = parseInt(part('minute'), 10) || 0;
  const timeNum = h * 100 + m;
  const bh = hours || DEFAULT_HOURS;
  if ('start' in bh && 'end' in bh) {
    if (dow === 0 || dow === 6) return false;
    const [sh, sm2] = (bh as any).start.split(':').map(Number);
    const [eh, em2] = (bh as any).end.split(':').map(Number);
    return timeNum >= sh * 100 + sm2 && timeNum < eh * 100 + em2;
  }
  const key = DOW_KEYS[dow];
  const day = (bh as Partial<Record<DowKey, DayHours>>)[key];
  if (!day || day.closed) return false;
  if (!day.open || !day.close) return false;
  const [oh, om] = day.open.split(':').map(Number);
  const [ch, cm] = day.close.split(':').map(Number);
  return timeNum >= oh * 100 + om && timeNum < ch * 100 + cm;
}

function labelStep(group: string, callFlow: { group: string; label: string }[] = []): string | undefined {
  return callFlow.find((cf) => cf.group === group)?.label;
}

export function shortGroupName(group: string, config: LogicConfig = {}): string {
  const cf = config.call_flow?.find((c) => c.group === group)?.label;
  if (cf) return cf;
  const ivr = config.ivr_options?.find((o) => o.group === group)?.label;
  if (ivr) return ivr;
  return group.replace(/@.*$/, '').replace(/^Hunt Group\s*/i, '').replace(/^Auto Attendant\s*/i, '').trim() || group;
}

export function formatRoute(j: CallJourney, config: LogicConfig = {}): string {
  return j.steps.map((s) => shortGroupName(s.group, config))
    .filter((v, i, a) => i === 0 || v !== a[i - 1]).join(' → ');
}

export function resolveIvrOption(steps: JourneyStep[], config: LogicConfig): string | null {
  if (!config.ivr_options?.length) return null;
  for (const step of steps) {
    const opt = config.ivr_options.find((o) => o.group && step.group.trim().toLowerCase() === o.group.trim().toLowerCase());
    if (opt) return opt.label;
  }
  return null;
}

export function buildJourneys(rows: CallEventRow[], config: LogicConfig = {}): CallJourney[] {
  const WINDOW = config.journey_window_seconds ?? 180;
  let filtered = rows;
  if (config.source_of_truth_group?.length || config.ivr_options?.length) {
    const stgPatterns = config.source_of_truth_group || [];
    const ivrPatterns = (config.ivr_options || []).map((o) => o.group).filter(Boolean);
    const allPatterns = [...stgPatterns, ...ivrPatterns].map((p) => p.trim().toLowerCase());
    filtered = rows.filter((r) => allPatterns.includes(r.group_name.trim().toLowerCase()));
  }
  if (filtered.length === 0) return [];
  filtered.sort((a, b) => toTs(a.event_datetime) - toTs(b.event_datetime));

  const journeyGroups: CallEventRow[][] = [];
  const withId = filtered.filter((r) => r.call_id);
  const withoutId = filtered.filter((r) => !r.call_id);
  const byCallId = new Map<string, CallEventRow[]>();
  for (const row of withId) {
    const k = row.call_id as string;
    if (!byCallId.has(k)) byCallId.set(k, []);
    byCallId.get(k)!.push(row);
  }
  for (const legs of byCallId.values()) {
    legs.sort((a, b) => toTs(a.event_datetime) - toTs(b.event_datetime));
    journeyGroups.push(legs);
  }
  if (withoutId.length) {
    const byNumber = new Map<string, CallEventRow[]>();
    for (const row of withoutId) {
      const num = row.number_normalised || row.number_raw || 'unknown';
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num)!.push(row);
    }
    for (const [, numRows] of byNumber) {
      let current: CallEventRow[] = [numRows[0]];
      for (let i = 1; i < numRows.length; i++) {
        const gap = (toTs(numRows[i].event_datetime) - toTs(numRows[i - 1].event_datetime)) / 1000;
        if (gap <= WINDOW) current.push(numRows[i]);
        else { journeyGroups.push(current); current = [numRows[i]]; }
      }
      journeyGroups.push(current);
    }
  }

  const businessHours = config.business_hours || { start: '08:00', end: '18:30' };
  const minWait = Number(config.min_wait_seconds) || 0;

  const built = journeyGroups.map((group) => {
    const first = group[0];
    const steps: JourneyStep[] = group.map((r) => ({ group: r.group_name, outcome: r.outcome, label: labelStep(r.group_name, config.call_flow) }));
    const answeredReal = steps.some((s) => s.outcome.toLowerCase() === 'answered');
    const ivr_label = resolveIvrOption(steps, config);
    let status: CallJourney['status'];
    if (answeredReal || (config.ivr_counts_as_answered && !!ivr_label)) status = 'Answered';
    else if (steps.some((s) => s.outcome.toLowerCase() === 'abandoned')) status = 'Abandoned';
    else status = 'Missed';
    const overflowed = false;
    const in_hours = isInHours(first.event_datetime, businessHours);
    const startMs = Math.min(...group.map((r) => toTs(r.event_datetime)));
    const endMs = Math.max(...group.map((r) => toTs(r.event_datetime) + (Number(r.wait_seconds) || 0) * 1000));
    const wait_secs = Math.max(0, Math.round((endMs - startMs) / 1000));
    return {
      datetime: new Date(first.event_datetime).toISOString(),
      number: first.number_normalised || first.number_raw,
      ddi: first.ddi || '',
      status, overflowed, in_hours,
      wait: formatWait(wait_secs), wait_secs,
      answered_by: (() => {
        // The end result: the PERSON's extension who answered — never a hunt group / pilot. If no
        // person took it but the call was answered by voicemail, report "Voicemail".
        const groupNames = new Set(group.map((r) => (r.group_name || '').replace(/@.*$/, '').trim().toLowerCase()).filter(Boolean));
        const isVm = (r: CallEventRow) => /voice\s*mail/i.test((r.group_name || '') + ' ' + (r.extno || ''));
        const person = group.find((r) => {
          if ((r.outcome || '').toLowerCase() !== 'answered') return false;
          if (isVm(r)) return false;
          const e = (r.extno || '').replace(/@.*$/, '').trim();
          return !!e && !groupNames.has(e.toLowerCase());
        });
        if (person) return (person.extno || '').replace(/@.*$/, '').trim();
        const vm = group.find((r) => (r.outcome || '').toLowerCase() === 'answered' && isVm(r));
        return vm ? 'Voicemail' : null;
      })(),
      steps, ivr_label,
      is_emergency: false, is_voicemail: false, is_ivr_voicemail: false, is_overflow_voicemail: false,
    } as CallJourney;
  });

  const businessHoursOnly = config.business_hours_only !== false;
  const kept = built.filter((j) => {
    const isIvrOptionCall = !!j.ivr_label;
    // STRICT business hours: a call outside the site's configured hours is excluded from EVERY
    // module, including IVR-option calls and the all-calls list. (Previously IVR-option calls were
    // kept regardless of hours, which leaked out-of-hours calls into the report.)
    if (businessHoursOnly && !j.in_hours) return false;
    if (minWait > 0 && !(j.status === 'Answered' || isIvrOptionCall || j.wait_secs >= minWait)) return false;
    return true;
  });
  return kept.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
}

// ── Metrics (used by the report generators) ────────────────────────────────────

export function pct(n: number, total: number, dp = 1): string {
  if (total === 0) return '0%';
  return (n / total * 100).toFixed(dp) + '%';
}

export interface ReportMetrics {
  total:            number;
  answered:         number;
  missed:           number;
  abandoned:        number;
  voicemail:        number;
  overflowed:       number;
  answerRate:       number;  // %
  overflowInHours:  number;
  overflowOutHours: number;
  avgWaitMissed:    number;  // seconds
  avgWaitAnswered:  number;  // seconds
}

export function calcMetrics(journeys: CallJourney[]): ReportMetrics {
  const total      = journeys.length;
  const answered   = journeys.filter((j) => j.status === 'Answered').length;
  const missed     = journeys.filter((j) => j.status === 'Missed' || j.status === 'Abandoned').length;
  const abandoned  = journeys.filter((j) => j.status === 'Abandoned').length;
  const voicemail  = journeys.filter((j) => j.status === 'Voicemail').length;
  const overflowed = journeys.filter((j) => j.overflowed).length;
  const ovInHours  = journeys.filter((j) => j.overflowed && j.in_hours).length;
  const ovOutHours = journeys.filter((j) => j.overflowed && !j.in_hours).length;
  const answerRate = total > 0 ? Math.round(answered / total * 100) : 0;

  const missedJourneys   = journeys.filter((j) => j.status === 'Missed' || j.status === 'Abandoned');
  const answeredJourneys = journeys.filter((j) => j.status === 'Answered');
  const avgWaitMissed   = missedJourneys.length
    ? Math.round(missedJourneys.reduce((s, j) => s + j.wait_secs, 0) / missedJourneys.length) : 0;
  const avgWaitAnswered = answeredJourneys.length
    ? Math.round(answeredJourneys.reduce((s, j) => s + j.wait_secs, 0) / answeredJourneys.length) : 0;

  return {
    total, answered, missed, abandoned, voicemail, overflowed,
    answerRate, overflowInHours: ovInHours, overflowOutHours: ovOutHours,
    avgWaitMissed, avgWaitAnswered,
  };
}

/** Group journeys by day (YYYY-MM-DD) */
export function groupByDay(journeys: CallJourney[]): Map<string, CallJourney[]> {
  const map = new Map<string, CallJourney[]>();
  for (const j of journeys) {
    const day = j.datetime.slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(j);
  }
  return map;
}

/** Group journeys by group name (first step) */
export function groupByGroup(journeys: CallJourney[]): Map<string, CallJourney[]> {
  const map = new Map<string, CallJourney[]>();
  for (const j of journeys) {
    const key = j.steps[0]?.group || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(j);
  }
  return map;
}
