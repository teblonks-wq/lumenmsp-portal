import cron from 'node-cron';
import { pool } from '../db/pool';
import { getSetting } from './settings';
import { saveEntry } from './diary';

// ── Renewal early warning ────────────────────────────────────────────────────────
//
// Every date this needs already existed — ms_subscription.renewal_date and
// cancellable_until_date have been mirrored from Giacom for months, and
// ms-subscriptions.ts already works out how many days away they are. What did not exist
// was anything that PUSHES. It was all pull: the numbers were correct and nobody saw
// them unless they went looking on the right page on the right week.
//
// The thing that makes this urgent rather than tidy: on an NCE annual term, the renewal
// date is TOO LATE TO ACT ON. Once it rolls, the seats are committed for another twelve
// months. The only useful warning is one that arrives with enough runway to count heads,
// talk to the customer and tell Giacom — hence 60 / 30 / 7 rather than a single notice,
// and hence the separate cancel-window flag, which is usually only days wide and is the
// one date nothing in the portal has ever surfaced.
//
// Two outputs, one source of truth:
//   • radar()        — read-only, for the dashboard panel and the estate page
//   • sweepRenewals()— nightly, writes ONE diary entry per (subscription, stage, renewal)
//
// The ledger (renewal_alerts) is what makes the sweep safe to run as often as we like.
// It records what was actually raised, keyed on the renewal date too — so next year's
// renewal warns again, and a diary entry someone has deliberately deleted stays deleted.

export const STAGES = [60, 30, 7] as const;
export type Stage = '60' | '30' | '7' | 'cancel';

export interface RenewalRow {
  subscriptionId: string;
  customerId: number | null;
  customerName: string;
  product: string;
  seats: number;
  term: string | null;
  committed: boolean;
  monthlyBuy: number | null;
  annualValue: number | null;
  renewalDate: Date | null;
  daysToRenewal: number | null;
  cancellableUntil: Date | null;
  daysToCancellable: number | null;
  cancellableOpen: boolean;
  stage: Stage | null;      // the warning band it currently sits in
  urgency: 'now' | 'soon' | 'ahead';
}

export interface Radar {
  rows: RenewalRow[];           // soonest first
  cancelWindows: RenewalRow[];  // penalty-free window still open — act today or never
  totals: { count: number; seats: number; annualValue: number; within30: number; within60: number };
  horizonDays: number;
}

const num = (v: any): number => (v == null ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function daysBetween(from: Date, to: Date | null): number | null {
  if (!to) return null;
  // Whole days, floored to midnight on both ends: "7 days away" must not flicker to 6
  // because the sweep happens to run in the afternoon.
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

/**
 * Which warning band a subscription is in.
 *
 * Returns the TIGHTEST stage already crossed, so a row 12 days out reports '30' rather
 * than pretending it is still a 60-day heads-up. Anything already past its renewal, or
 * further out than the widest stage, is in no band at all.
 */
export function stageFor(daysToRenewal: number | null): Stage | null {
  if (daysToRenewal == null || daysToRenewal < 0) return null;
  for (const s of [...STAGES].sort((a, b) => a - b)) if (daysToRenewal <= s) return String(s) as Stage;
  return null;
}

function toRow(r: any, now: Date): RenewalRow {
  const renewalDate = r.renewal_date ? new Date(r.renewal_date) : null;
  const cancellableUntil = r.cancellable_until_date ? new Date(r.cancellable_until_date) : null;
  const seats = num(r.licences);
  const unit = r.price == null ? null : Number(r.price);
  const monthlyBuy = unit == null ? null : round2(unit * seats);
  const daysToRenewal = daysBetween(now, renewalDate);
  const daysToCancellable = daysBetween(now, cancellableUntil);
  const committed = String(r.term || '').toLowerCase() === 'annual';
  const stage = committed ? stageFor(daysToRenewal) : null;
  return {
    subscriptionId: r.subscription_id,
    customerId: r.customer_id == null ? null : Number(r.customer_id),
    customerName: r.portal_name || r.customer_name || '(unmatched account)',
    product: r.name,
    seats, term: r.term || null, committed,
    monthlyBuy,
    annualValue: monthlyBuy == null ? null : round2(monthlyBuy * 12),
    renewalDate, daysToRenewal,
    cancellableUntil, daysToCancellable,
    cancellableOpen: !!cancellableUntil && cancellableUntil.getTime() >= now.getTime(),
    stage,
    urgency: daysToRenewal == null ? 'ahead' : daysToRenewal <= 7 ? 'now' : daysToRenewal <= 30 ? 'soon' : 'ahead',
  };
}

/**
 * Everything renewing inside the horizon. Read-only and safe to call on every dashboard
 * render — one indexed query, no Graph, no Giacom API.
 *
 * Monthly terms are carried but never warned about: they can be cut any month, so a
 * countdown on one is noise that would bury the annual rows that actually matter.
 */
export async function radar(horizonDays = 90, now = new Date()): Promise<Radar> {
  const empty: Radar = { rows: [], cancelWindows: [], totals: { count: 0, seats: 0, annualValue: 0, within30: 0, within60: 0 }, horizonDays };
  let raw: any[] = [];
  try {
    raw = (await pool.query(
      `SELECT s.subscription_id, s.customer_id, s.customer_name, s.name, s.licences, s.term,
              s.price, s.renewal_date, s.cancellable_until_date, s.status,
              c.name AS portal_name
         FROM ms_subscription s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE COALESCE(s.status,'') NOT IN ('Deleted','Cancelled','Suspended')
          AND s.renewal_date IS NOT NULL
          AND s.renewal_date >= CURRENT_DATE
          AND s.renewal_date <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY s.renewal_date ASC, s.name ASC`, [String(horizonDays)])).rows;
  } catch { return empty; }

  const rows = raw.map((r) => toRow(r, now)).filter((r) => r.committed);

  // The cancel window is its own list, not a column. It is a different decision on a
  // different clock — "you can still get out of this one for free, but not for long" —
  // and burying it in a renewal table is how it stays unnoticed.
  let cancelWindows: RenewalRow[] = [];
  try {
    const c = (await pool.query(
      `SELECT s.subscription_id, s.customer_id, s.customer_name, s.name, s.licences, s.term,
              s.price, s.renewal_date, s.cancellable_until_date, s.status,
              c.name AS portal_name
         FROM ms_subscription s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE COALESCE(s.status,'') NOT IN ('Deleted','Cancelled','Suspended')
          AND s.cancellable_until_date IS NOT NULL
          AND s.cancellable_until_date >= CURRENT_DATE
        ORDER BY s.cancellable_until_date ASC`)).rows;
    cancelWindows = c.map((r) => toRow(r, now)).filter((r) => r.committed);
  } catch { /* leave empty */ }

  const totals = rows.reduce((t, r) => ({
    count: t.count + 1,
    seats: t.seats + r.seats,
    annualValue: t.annualValue + (r.annualValue || 0),
    within30: t.within30 + (r.daysToRenewal != null && r.daysToRenewal <= 30 ? 1 : 0),
    within60: t.within60 + (r.daysToRenewal != null && r.daysToRenewal <= 60 ? 1 : 0),
  }), { count: 0, seats: 0, annualValue: 0, within30: 0, within60: 0 });
  totals.annualValue = round2(totals.annualValue);

  return { rows, cancelWindows, totals, horizonDays };
}

// ── The diary sweep ──────────────────────────────────────────────────────────────

export async function ensureRenewalAlertsTable(): Promise<void> {
  // Mirrors prisma/schema.prisma model RenewalAlert. Created here too so a first run
  // before a db push still works rather than throwing on every sweep.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS renewal_alerts (
      id              SERIAL PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      customer_id     INTEGER,
      stage           TEXT NOT NULL,
      renewal_date    DATE NOT NULL,
      diary_entry_id  INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS renewal_alerts_key
      ON renewal_alerts (subscription_id, stage, renewal_date);
    CREATE INDEX IF NOT EXISTS renewal_alerts_customer ON renewal_alerts (customer_id);
  `);
}

/** 'YYYY-MM-DD' in Europe/London — the diary's day-lane key format. */
export function dayKeyOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Who these land on. Unset means the sweep writes nothing at all — see sweepRenewals. */
export async function renewalOwners(): Promise<number[]> {
  const raw = (await getSetting('subscriptions', 'renewal_diary_user_ids')) || '';
  const ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  const r = await pool.query(
    `SELECT id FROM users WHERE id = ANY($1::int[]) AND is_active = true AND role IN ('staff','admin')`, [ids]);
  return r.rows.map((x: any) => Number(x.id));
}

export interface SweepResult {
  created: number;
  skipped: number;
  owners: number;
  reason?: string;
}

/**
 * Raise a diary entry for every warning that has come due and has not been raised before.
 *
 * Deliberately does NOTHING when no owner is configured. A silent sweep that dumps
 * entries into everyone's diary would be worse than no sweep: it would be ignored within
 * a week, and then the one that mattered would be ignored too.
 */
export async function sweepRenewals(now = new Date()): Promise<SweepResult> {
  await ensureRenewalAlertsTable();
  const owners = await renewalOwners();
  if (!owners.length) {
    return { created: 0, skipped: 0, owners: 0,
      reason: 'No one is set to receive renewal entries — set that on Settings → Subscriptions and the sweep starts writing.' };
  }

  const r = await radar(Math.max(...STAGES) + 1, now);
  let created = 0, skipped = 0;

  for (const row of r.rows) {
    if (!row.stage || !row.renewalDate) continue;

    const already = await pool.query(
      `SELECT 1 FROM renewal_alerts WHERE subscription_id=$1 AND stage=$2 AND renewal_date=$3::date LIMIT 1`,
      [row.subscriptionId, row.stage, dayKeyOf(row.renewalDate)]);
    if (already.rows.length) { skipped++; continue; }

    const renews = row.renewalDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const value = row.annualValue != null ? ` · £${row.annualValue.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr buy` : '';
    const title = `Renewal check (${row.stage}d): ${row.customerName} — ${row.product}`;
    const notes =
      `${row.product} renews ${renews} — ${row.seats} seat${row.seats === 1 ? '' : 's'}${value}.\n\n` +
      `Annual NCE term: once it renews the seats are committed for another 12 months, so any reduction has to be agreed with Giacom BEFORE this date.\n\n` +
      `Check the licence allocation on the customer's Services page — spare seats and licences still sitting on disabled accounts are the easy wins.` +
      (row.customerId ? `\n\n/customers/${row.customerId}#subscriptions` : '') +
      `\n\n(Raised automatically by the renewal watch.)`;

    const saved = await saveEntry(null, {
      kind: 'task', title, notes,
      customerId: row.customerId, ticketId: null,
      personIds: owners,
      startEpoch: null, endEpoch: null,
      dayKey: dayKeyOf(now), endDayKey: null,
      bufferMins: 0,
      colour: row.stage === '7' ? 'rose' : row.stage === '30' ? 'amber' : 'blue',
      recurrence: 'none', recurrenceEnd: null,
      createdBy: null,
    });

    // Record the alert even when the diary write is refused, so a diary problem cannot
    // turn into the same entry being retried every night forever.
    await pool.query(
      `INSERT INTO renewal_alerts (subscription_id, customer_id, stage, renewal_date, diary_entry_id)
       VALUES ($1,$2,$3,$4::date,$5)
       ON CONFLICT (subscription_id, stage, renewal_date) DO NOTHING`,
      [row.subscriptionId, row.customerId, row.stage, dayKeyOf(row.renewalDate), saved.ok ? saved.id : null]);

    if (saved.ok) created++; else skipped++;
  }

  return { created, skipped, owners: owners.length };
}

// Nightly, early, before anyone opens their diary for the day.
export function startRenewalWatch(): void {
  cron.schedule('25 6 * * *', async () => {
    try {
      const r = await sweepRenewals();
      if (r.created || r.reason) console.log(`[renewals] ${r.created} raised, ${r.skipped} already known${r.reason ? ' — ' + r.reason : ''}`);
    } catch (e: any) {
      console.error('[renewals] sweep failed:', e.message);
    }
  }, { timezone: 'Europe/London' });
}
