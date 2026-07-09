// Reusable date-range presets for list filters. UK conventions: weeks start Monday,
// financial year runs 1 Apr → 31 Mar. resolvePeriod() returns inclusive ISO dates
// (YYYY-MM-DD) suitable for a `col >= from AND col <= to` filter, or nulls for "all".

export interface Period { key: string; from: string | null; to: string | null; label: string }

const iso = (d: Date): string => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Monday of the week containing `d`.
function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  return addDays(x, -dow);
}

// UK financial year start (1 Apr) for the year containing `d`.
function fyStart(d: Date): Date {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // Apr = month index 3
  return new Date(y, 3, 1);
}

// Options shown in the period dropdown (in order).
export const PERIOD_OPTIONS: { key: string; label: string }[] = [
  { key: '', label: 'All time' },
  { key: 'this_week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_year', label: 'This year' },
  { key: 'last_year', label: 'Last year' },
  { key: 'this_fy', label: 'This financial year' },
  { key: 'last_fy', label: 'Last financial year' },
  { key: 'custom', label: 'Custom range' },
];

export function resolvePeriod(key: string, customFrom?: string, customTo?: string, now: Date = new Date()): Period {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const label = (PERIOD_OPTIONS.find((o) => o.key === key)?.label) || 'All time';
  switch (key) {
    case 'this_week': { const s = weekStart(today); return { key, from: iso(s), to: iso(addDays(s, 6)), label }; }
    case 'last_week': { const s = addDays(weekStart(today), -7); return { key, from: iso(s), to: iso(addDays(s, 6)), label }; }
    case 'this_month': { const s = new Date(today.getFullYear(), today.getMonth(), 1); return { key, from: iso(s), to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)), label }; }
    case 'last_month': { const s = new Date(today.getFullYear(), today.getMonth() - 1, 1); return { key, from: iso(s), to: iso(new Date(today.getFullYear(), today.getMonth(), 0)), label }; }
    case 'this_year': return { key, from: iso(new Date(today.getFullYear(), 0, 1)), to: iso(new Date(today.getFullYear(), 11, 31)), label };
    case 'last_year': return { key, from: iso(new Date(today.getFullYear() - 1, 0, 1)), to: iso(new Date(today.getFullYear() - 1, 11, 31)), label };
    case 'this_fy': { const s = fyStart(today); return { key, from: iso(s), to: iso(addDays(new Date(s.getFullYear() + 1, 3, 1), -1)), label }; }
    case 'last_fy': { const s = new Date(fyStart(today).getFullYear() - 1, 3, 1); return { key, from: iso(s), to: iso(addDays(new Date(s.getFullYear() + 1, 3, 1), -1)), label }; }
    case 'custom': {
      const f = (customFrom || '').trim() || null, t = (customTo || '').trim() || null;
      return { key, from: f, to: t, label: f || t ? `${f || '…'} → ${t || '…'}` : 'Custom range' };
    }
    default: return { key: '', from: null, to: null, label: 'All time' };
  }
}
