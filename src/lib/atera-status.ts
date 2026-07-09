import { getSetting, setSetting } from './settings';

// Atera ticket status → portal status/stage/department. Keys are lower-cased Atera
// statuses. Defaults are seeded from Lumen's known Atera statuses (incl. the custom
// RC/CS ones) and can be edited in Settings → Integrations → Atera → Status MAP.
export interface StatusTarget { status: string; stage: string; department: string }

export const PORTAL_STATUSES = ['new', 'open', 'awaiting_customer', 'awaiting_3rd_party', 'awaiting_engineer', 'awaiting_installation', 'postponed', 'resolved', 'closed'];
export const PORTAL_DEPARTMENTS = ['support', 'sales', 'repair_center', 'comms', 'quotes', 'invoices', 'leads', 'general'];

export const DEFAULT_STATUS_MAP: Record<string, StatusTarget> = {
  'open':                    { status: 'open',              stage: 'in_progress',           department: 'support' },
  'pending':                 { status: 'awaiting_customer', stage: 'waiting_on_customer',    department: 'support' },
  'waiting for customer':    { status: 'awaiting_customer', stage: 'waiting_on_customer',    department: 'support' },
  'waiting for third party': { status: 'awaiting_3rd_party',stage: 'waiting_on_third_party', department: 'support' },
  'in progress':             { status: 'open',              stage: 'in_progress',           department: 'support' },
  'reopened':                { status: 'open',              stage: 'in_progress',           department: 'support' },
  'onsite booked':           { status: 'open',              stage: 'onsite_booked',         department: 'support' },
  'cs - ordered - booked':   { status: 'open',              stage: 'ordered',               department: 'comms' },
  'rc - in progress':        { status: 'open',              stage: 'in_progress',           department: 'repair_center' },
  'rc - awaiting parts':     { status: 'awaiting_3rd_party',stage: 'awaiting_parts',        department: 'repair_center' },
  'rc - delivered required': { status: 'open',              stage: 'not_started',           department: 'repair_center' },
  'resolved':                { status: 'resolved',          stage: 'resolved',              department: 'support' },
  'closed':                  { status: 'closed',            stage: 'closed',                department: 'support' },
};

export async function loadStatusMap(): Promise<Record<string, StatusTarget>> {
  const raw = await getSetting('atera', 'status_map');
  if (!raw) return { ...DEFAULT_STATUS_MAP };
  try { return { ...DEFAULT_STATUS_MAP, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_STATUS_MAP }; }
}

export async function saveStatusMap(map: Record<string, StatusTarget>): Promise<void> {
  await setSetting('atera', 'status_map', JSON.stringify(map));
}

export function mapStatus(map: Record<string, StatusTarget>, ateraStatus: string): StatusTarget {
  const k = (ateraStatus || '').toLowerCase().trim();
  return map[k] || { status: 'open', stage: 'in_progress', department: 'support' };
}
