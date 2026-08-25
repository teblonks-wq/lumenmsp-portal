import { pool } from '../db/pool';

// ── Third parties — who a case is actually waiting on ───────────────────────────
// "Awaiting 3rd party" was a status with nothing behind it: no name, no reference, no
// date we said we would go back at them. Cases parked there aged quietly and the only
// way to find them was to remember. This module gives that status a subject.
//
// The list lives in `suppliers` (flagged is_third_party) rather than a new table. Most
// of the people we wait on we also buy from — Giacom, a carrier, a hardware vendor —
// and a second address book would mean two records for the same company drifting apart.
// The ones that are purely third parties (a landlord's IT, a customer's own web
// developer) simply never get a purchase against them.

export const THIRD_PARTY_CATEGORIES = [
  'Connectivity / Openreach',
  'Telecoms carrier',
  'Hardware vendor',
  'Software vendor',
  'Cloud / licensing',
  'Landlord / facilities',
  "Customer's own supplier",
  'Other',
];

export interface ThirdParty {
  id: number; name: string; category: string | null;
  contactName: string | null; email: string | null; supportEmail: string | null;
  phone: string | null; supportPhone: string | null; portalUrl: string | null;
  accountRef: string | null; typicalDays: number | null; escalationNote: string | null;
  notes: string | null; isActive: boolean;
  openCases?: number; oldestDays?: number | null;
}

const MAP = (x: any): ThirdParty => ({
  id: Number(x.id), name: String(x.name), category: x.category || null,
  contactName: x.contact_name || null, email: x.email || null, supportEmail: x.support_email || null,
  phone: x.phone || null, supportPhone: x.support_phone || null, portalUrl: x.portal_url || null,
  accountRef: x.account_ref || null,
  typicalDays: x.typical_days == null ? null : Number(x.typical_days),
  escalationNote: x.escalation_note || null, notes: x.notes || null, isActive: !!x.is_active,
  openCases: x.open_cases == null ? undefined : Number(x.open_cases),
  oldestDays: x.oldest_days == null ? null : Number(x.oldest_days),
});

/** The pickable list — active third parties, with how much is currently sitting on each. */
export async function listThirdParties(includeArchived = false): Promise<ThirdParty[]> {
  const r = await pool.query(
    `SELECT s.*,
            COUNT(t.id) FILTER (WHERE t.id IS NOT NULL)::int AS open_cases,
            MAX(EXTRACT(DAY FROM (NOW() - COALESCE(t.waiting_since, t.updated_at))))::int AS oldest_days
       FROM suppliers s
       LEFT JOIN inbox_tickets t
              ON t.third_party_id = s.id
             AND t.status = 'awaiting_3rd_party'
             AND t.deleted_at IS NULL AND t.is_spam = false
      WHERE s.is_third_party = true ${includeArchived ? '' : 'AND s.is_active = true'}
      GROUP BY s.id
      ORDER BY lower(s.name)`);
  return r.rows.map(MAP);
}

export async function getThirdParty(id: number): Promise<ThirdParty | null> {
  const r = await pool.query('SELECT * FROM suppliers WHERE id=$1 AND is_third_party = true', [id]);
  return r.rows.length ? MAP(r.rows[0]) : null;
}

export interface WaitingCase {
  id: number; ticketNumber: string; subject: string;
  customerId: number | null; customerName: string | null;
  assignedName: string | null;
  thirdPartyId: number | null; thirdPartyName: string | null;
  thirdPartyRef: string | null; chaseBy: string | null;
  daysWaiting: number; overdue: boolean; unnamed: boolean;
}

/**
 * Everything parked on a third party right now, oldest first. `unnamed` marks the cases
 * sitting at that status with nobody attached — the exact gap this list exists to close,
 * so they are surfaced at the top rather than filtered out of the report.
 */
export async function waitingOnThirdParties(): Promise<WaitingCase[]> {
  const r = await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, t.customer_id, c.name AS customer_name,
            u.display_name AS assigned_name, t.third_party_id, s.name AS tp_name,
            t.third_party_ref, t.chase_by,
            GREATEST(0, EXTRACT(DAY FROM (NOW() - COALESCE(t.waiting_since, t.updated_at))))::int AS days_waiting
       FROM inbox_tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN users u ON u.id = t.assigned_user_id
       LEFT JOIN suppliers s ON s.id = t.third_party_id
      WHERE t.status = 'awaiting_3rd_party' AND t.deleted_at IS NULL AND t.is_spam = false
      ORDER BY COALESCE(t.waiting_since, t.updated_at) ASC`);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  return r.rows.map((x: any) => ({
    id: Number(x.id), ticketNumber: String(x.ticket_number || x.id), subject: String(x.subject || ''),
    customerId: x.customer_id ? Number(x.customer_id) : null, customerName: x.customer_name || null,
    assignedName: x.assigned_name || null,
    thirdPartyId: x.third_party_id ? Number(x.third_party_id) : null, thirdPartyName: x.tp_name || null,
    thirdPartyRef: x.third_party_ref || null, chaseBy: x.chase_by || null,
    daysWaiting: Number(x.days_waiting || 0),
    overdue: !!(x.chase_by && String(x.chase_by) < today),
    unnamed: !x.third_party_id,
  }));
}

/** 'YYYY-MM-DD' n WORKING days from today — a chase-by date that never lands on a Sunday. */
export function chaseByDefault(days: number | null): string {
  let left = Math.max(1, days || 3);
  const d = new Date();
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/**
 * Park a case on a third party. Returns the chase-by day actually used so the caller can
 * say it out loud — silently choosing a date the engineer did not see is how a chase gets
 * missed. Returns null when the id is not a real third party (never park on a guess).
 */
export async function parkOnThirdParty(
  ticketId: number, thirdPartyId: number, ref: string | null, chaseBy: string | null,
): Promise<{ chaseBy: string; name: string } | null> {
  const tp = await getThirdParty(thirdPartyId);
  if (!tp || !tp.isActive) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(chaseBy || '')) ? String(chaseBy) : chaseByDefault(tp.typicalDays);
  await pool.query(
    `UPDATE inbox_tickets
        SET third_party_id=$2, third_party_ref=$3, chase_by=$4,
            waiting_since=COALESCE(waiting_since, NOW()), updated_at=NOW()
      WHERE id=$1`,
    [ticketId, thirdPartyId, ref && ref.trim() ? ref.trim().slice(0, 120) : null, day]);
  return { chaseBy: day, name: tp.name };
}

/** Moving off the status clears the attachment — a closed case must not still read as waiting. */
export async function clearThirdParty(ticketId: number): Promise<void> {
  await pool.query(
    `UPDATE inbox_tickets SET third_party_id=NULL, third_party_ref=NULL, chase_by=NULL,
            waiting_since=NULL, updated_at=NOW()
      WHERE id=$1 AND (third_party_id IS NOT NULL OR chase_by IS NOT NULL)`, [ticketId]);
}
