import { pool } from '../db/pool';
import { getSetting, setSetting } from './settings';
import { resolveCliPackages } from './packages';

// Product role classification (by Giacom description). Seat-core defines a Simply VoIP seat;
// broadband/mobile are standalone; everything else on a seat CLI is included in the seat.
const SEAT_RE = /hv select/i;
const BB_RE = /fttp|sogea|fttc|adsl|ethernet|internet access|broadband|fibre|leased/i;
const REC_RE = /voice recording|call recording/i;
const MOBILE_RE = /everyway|vodashare|gprs|data optimiser|\bee\d|mobile/i;
// Included package components — handsets (often on their own device-ID "CLI", not the seat's),
// Webex, CRM connectors. Cost is absorbed into the Simply VoIP package; never billed as their
// own line or counted as a seat.
export const COMPONENT_RE = /yealink|polycom|\bpoly\b|grandstream|\bsnom\b|\bt4\d|\bt5\d|\bw5\d|\bw73|\bedge e\d|handset|cisco webex|softphone|gointegrator|crmconnect|collaboration/i;
// PHYSICAL handsets only (for the device register, keyed on the device MAC/ID) — excludes
// softphone/Webex/CRM which aren't a physical device.
export const HANDSET_RE = /yealink|polycom|\bpoly\b|grandstream|\bsnom\b|\bt4\d|\bt5\d|\bw5\d|\bw73|\bedge e\d|handset|\bdect\b/i;

// Comms billing model: the Giacom feed (service_items source='comms') is the source of truth.
// The customer's recurring monthly = the DISTINCT CLIs per product in the current full month;
// prorata/part-period lines are one-off adjustments, never counted into the recurring qty.
// CLI = a phone number OR a broadband circuit ref (same field).

// Latest full-month period present in the comms feed (e.g. '2026-06').
// The CURRENT OPEN comms period — the month we're billing now. It's a managed value (setting
// comms/current_period), NOT chosen by the user and NOT just the latest import: it only advances
// when a period is CLOSED (bill run completed) via advanceCommsPeriod(). Falls back to the latest
// imported period until the first close establishes the setting.
export async function currentCommsPeriod(): Promise<string | null> {
  const set = (await getSetting('comms', 'current_period')) || '';
  if (/^\d{4}-\d{2}$/.test(set)) return set;
  const r = await pool.query(
    "SELECT MAX(billing_period) AS p FROM service_items WHERE source='comms' AND is_prorata=false AND billing_period IS NOT NULL"
  );
  return r.rows[0]?.p || null;
}

// Next month after a YYYY-MM period.
export function nextCommsPeriod(p: string): string {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m, 1); // m is 1-based; new Date(y, m, 1) = first of the NEXT month
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// Previous month before a YYYY-MM period (the CALL period billed in arrears alongside it).
export function prevCommsPeriod(p: string): string {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m - 2, 1); // m 1-based → m-2 = previous month
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// Close the current period → advance the managed current period to the next month.
export async function advanceCommsPeriod(): Promise<string | null> {
  const cur = await currentCommsPeriod();
  if (!cur) return null;
  const next = nextCommsPeriod(cur);
  await setSetting('comms', 'current_period', next);
  return next;
}

// Every comms period we know about, newest first. NOTE the services import is a FULL SNAPSHOT —
// each month's feed DELETEs the previous month's recurring rows — so service_items only ever
// holds the latest period. Closed months survive in the INVOICES produced for them (the durable
// record), so the picker unions both. The open period is always included even before its feed
// lands (e.g. just after a close rolls the period forward).
export async function commsPeriods(): Promise<string[]> {
  const r = await pool.query(
    `SELECT DISTINCT p FROM (
       SELECT billing_period AS p FROM service_items WHERE source='comms' AND is_prorata=false AND billing_period IS NOT NULL
       UNION
       SELECT billing_period FROM invoices WHERE invoice_scheme='CS' AND billing_period IS NOT NULL AND deleted_at IS NULL
     ) x ORDER BY p DESC`
  );
  const list: string[] = r.rows.map((x: any) => String(x.p));
  const cur = await currentCommsPeriod();
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list.filter((p) => /^\d{4}-\d{2}$/.test(p));
}

// Last calendar day of a YYYY-MM period, as YYYY-MM-DD.
function lastDayOf(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ── Advance billing: roll the register forward ──────────────────────────────────
// We bill customers for services IN ADVANCE, but Giacom invoices in ARREARS (a month's file
// lands ~the 1st of the next month) — so the month being billed never has supplier data yet.
// The bill therefore comes from the REGISTER (the latest known month's lines), not the import:
// clone the newest ACTUAL month's full recurring lines into `target` as PROJECTED lines.
// When the supplier file for that month eventually lands, the per-period import replaces the
// projection with actuals and the true-up report surfaces every difference.
// Manual lines roll forward too (still is_manual, so imports never touch them) — a hand-added
// recurring service keeps billing month after month instead of silently stopping.
export async function rollForwardCommsPeriod(target: string): Promise<{ from: string | null; cloned: number }> {
  if (!/^\d{4}-\d{2}$/.test(target)) return { from: null, cloned: 0 };
  // Never clone into a month that already has recurring lines (actuals or an earlier projection).
  const has = await pool.query(
    "SELECT 1 FROM service_items WHERE source='comms' AND billing_period=$1 AND is_prorata=false AND is_one_off=false LIMIT 1", [target]
  );
  if (has.rows.length) return { from: null, cloned: 0 };
  const src = (await pool.query(
    `SELECT MAX(billing_period) AS p FROM service_items
      WHERE source='comms' AND is_prorata=false AND is_one_off=false
        AND COALESCE(is_projected,false)=false AND billing_period < $1`, [target]
  )).rows[0]?.p as string | null;
  if (!src) return { from: null, cloned: 0 };
  const ins = await pool.query(
    `INSERT INTO service_items (source, customer_id, external_customer_id, external_customer_name, product_id, product_reference,
        description, quantity, unit_cost, total_cost, location, billing_from, billing_to, billing_period,
        is_prorata, is_one_off, is_manual, is_projected, vat_status, synced_at)
     SELECT source, customer_id, external_customer_id, external_customer_name, product_id, product_reference,
        description, quantity, unit_cost, total_cost, location, $2::date, $3::date, $1,
        false, false, is_manual, true, vat_status, NOW()
       FROM service_items
      WHERE source='comms' AND billing_period=$4 AND is_prorata=false AND is_one_off=false`,
    [target, target + '-01', lastDayOf(target), src]
  );
  return { from: src, cloned: ins.rowCount || 0 };
}

// After actuals land for `fromPeriod`, re-project any LATER months that are purely projected
// and not yet invoiced, so the next run always bills from the newest known state.
export async function refreshCommsProjections(fromPeriod: string): Promise<string[]> {
  const later = (await pool.query(
    `SELECT DISTINCT billing_period AS p FROM service_items
      WHERE source='comms' AND billing_period > $1 AND is_prorata=false AND is_one_off=false
        AND COALESCE(is_projected,false)=true ORDER BY 1`, [fromPeriod]
  )).rows.map((r: any) => String(r.p));
  const refreshed: string[] = [];
  for (const p of later) {
    // Untouchable once the month has actual lines or has been invoiced.
    const actual = await pool.query(
      "SELECT 1 FROM service_items WHERE source='comms' AND billing_period=$1 AND is_prorata=false AND is_one_off=false AND COALESCE(is_projected,false)=false LIMIT 1", [p]);
    if (actual.rows.length) continue;
    const inv = await pool.query(
      "SELECT 1 FROM invoices WHERE invoice_scheme='CS' AND billing_period=$1 AND deleted_at IS NULL LIMIT 1", [p]);
    if (inv.rows.length) continue;
    await pool.query("DELETE FROM service_items WHERE source='comms' AND billing_period=$1 AND COALESCE(is_projected,false)=true", [p]);
    const r = await rollForwardCommsPeriod(p);
    if (r.cloned) refreshed.push(p);
  }
  return refreshed;
}

// Is this CLI a phone number or a broadband/connectivity circuit ref?
export function cliType(cli: string | null): 'voice' | 'circuit' {
  const s = String(cli || '').replace(/\s+/g, '');
  return /^0\d{9,10}$/.test(s) ? 'voice' : 'circuit';
}

export interface AccountTotalRow {
  description: string; unit_cost: number; users: number; cost: number;
  sale_price: number | null; sell: number | null; profit: number | null;
}

// Account totals for a customer: per product + buy-price tier, distinct CLIs in the current
// recurring month, with cost and (durable) sell/profit. Excludes prorata one-offs.
export async function accountTotals(customerId: number, period?: string): Promise<{ period: string | null; rows: AccountTotalRow[]; cost: number; sell: number; profit: number }> {
  const per = period || (await currentCommsPeriod());
  if (!per) return { period: null, rows: [], cost: 0, sell: 0, profit: 0 };
  const { rows } = await pool.query(
    `SELECT si.description, si.unit_cost,
            COUNT(DISTINCT si.product_reference)::int AS users,
            SUM(si.total_cost)::numeric AS cost,
            sp.sale_price
       FROM service_items si
       LEFT JOIN service_pricing sp
              ON sp.source='comms' AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.source='comms' AND si.customer_id=$1 AND si.is_prorata=false AND si.billing_period=$2
      GROUP BY si.description, si.unit_cost, sp.sale_price
      ORDER BY SUM(si.total_cost) DESC, si.description`,
    [customerId, per]
  );
  let cost = 0, sell = 0, profit = 0;
  const out: AccountTotalRow[] = rows.map((r: any) => {
    const users = Number(r.users) || 0, buy = Number(r.unit_cost) || 0, lineCost = Number(r.cost) || 0;
    const salePrice = r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price);
    const lineSell = salePrice === null ? null : salePrice * users;
    const lineProfit = lineSell === null ? null : lineSell - lineCost;
    cost += lineCost; if (lineSell !== null) { sell += lineSell; profit += lineProfit as number; }
    return { description: r.description || '(unnamed)', unit_cost: buy, users, cost: lineCost, sale_price: salePrice, sell: lineSell, profit: lineProfit };
  });
  return { period: per, rows: out, cost, sell, profit };
}

// ── Simply VoIP package account: the customer's monthly bill, derived live from the Giacom
// feed. Seats auto-count from distinct HV Select CLIs (so qty just follows reality each month);
// each carries the seat price (per-customer override else standard). Broadband bills per
// circuit (buy/sale). Add-ons: Call Recording (per recording user) + Feature Pack. Cost comes
// from the live Giacom lines, so margin is always real.
export interface CommsBroadband { cli: string; service: string; location: string | null; buy: number; sale: number | null; margin: number | null; }
export interface CommsAccount {
  period: string | null;
  seats: { count: number; unitPrice: number; sell: number; cost: number; margin: number };
  callRecording: { count: number; unitPrice: number; sell: number; cost: number };
  featurePack: number;
  broadband: CommsBroadband[];
  lineRental: CommsBroadband[];
  other: { cli: string; service: string; buy: number; sale: number | null; category?: string }[];
  totals: { sell: number; cost: number; margin: number };
}

export async function commsAccount(customerId: number, period?: string): Promise<CommsAccount> {
  const empty: CommsAccount = { period: null, seats: { count: 0, unitPrice: 0, sell: 0, cost: 0, margin: 0 }, callRecording: { count: 0, unitPrice: 0, sell: 0, cost: 0 }, featurePack: 0, broadband: [], lineRental: [], other: [], totals: { sell: 0, cost: 0, margin: 0 } };
  const per = period || (await currentCommsPeriod());
  if (!per) return empty;
  const seatStd = Number(await getSetting('comms', 'seat_price')) || 16.5;
  const recStd = Number(await getSetting('comms', 'call_recording_price')) || 3.0;

  const lines = (await pool.query(
    `SELECT product_reference AS cli, description, total_cost::numeric AS cost, unit_cost::numeric AS unit_cost, location, COALESCE(is_manual,false) AS is_manual
       FROM service_items WHERE source='comms' AND customer_id=$1 AND is_prorata=false AND billing_period=$2`,
    [customerId, per]
  )).rows;
  // Per-customer prices keyed by product_reference. `price` = last-wins (overrides, broadband per
  // circuit). `priceSum` = SUM per ref — used for mobiles, where ONE CLI can carry several priced
  // products (tariff + bolt-on) so their sells add up.
  const price = new Map<string, number>(); const priceSum = new Map<string, number>();
  // Distinct products can share one reference (e.g. iCS analytics seats on an iCS account ref) — each
  // has its own buy price, so prices are also keyed by (ref + unit_cost) to price them individually.
  const priceByRefUnit = new Map<string, number>();
  (await pool.query("SELECT product_reference, unit_cost, sale_price FROM service_pricing WHERE source='comms' AND customer_id=$1", [customerId])).rows
    .forEach((r: any) => { const k = String(r.product_reference || ''); const v = Number(r.sale_price); price.set(k, v); priceSum.set(k, (priceSum.get(k) || 0) + v); priceByRefUnit.set(k + '|' + (Number(r.unit_cost) || 0).toFixed(4), v); });

  // Group lines by CLI, but track each standalone product separately — a single CLI can carry
  // a broadband circuit AND a line rental (two distinct billable products). Broadband + its £0
  // care line fold into one item; line rental and mobile are their own items.
  const LR_RE = /line rental/i;
  type C = { cli: string; total: number; hasSeat: boolean; hasRec: boolean; recCost: number; bbCost: number; bbService: string; lrCost: number; mobileCost: number; componentCost: number; location: string | null; others: { description: string; unitCost: number; cost: number }[] };
  const byCli = new Map<string, C>();
  // Manually-added charges are billed as their own priced line (e.g. a SITE-LEVEL "Business Call
  // Recording" service charge that sits ON TOP of the per-user recording fee). Keep them out of the
  // seat/recording/broadband auto-classification so their own sell price isn't absorbed/lost.
  const manualLines: any[] = [];
  for (const l of lines) {
    if (l.is_manual) { manualLines.push(l); continue; }
    const cli = String(l.cli || '(none)'); const d = String(l.description || ''); const cost = Number(l.cost) || 0;
    let c = byCli.get(cli);
    if (!c) { c = { cli, total: 0, hasSeat: false, hasRec: false, recCost: 0, bbCost: 0, bbService: '', lrCost: 0, mobileCost: 0, componentCost: 0, location: l.location || null, others: [] }; byCli.set(cli, c); }
    c.total += cost;
    if (SEAT_RE.test(d)) c.hasSeat = true;
    if (REC_RE.test(d)) { c.hasRec = true; c.recCost += cost; } // recording = separate billable, cost tracked apart from the seat
    if (LR_RE.test(d)) c.lrCost += cost;
    else if (BB_RE.test(d)) { c.bbCost += cost; if (!c.bbService && !/care/i.test(d)) c.bbService = d; }
    else if (MOBILE_RE.test(d)) c.mobileCost += cost;
    else if (COMPONENT_RE.test(d)) c.componentCost += cost; // handset/Webex/CRM — included in the package
    else if (!SEAT_RE.test(d) && !REC_RE.test(d)) c.others.push({ description: d, unitCost: Number(l.unit_cost) || 0, cost }); // standalone product (e.g. iCS analytics seat) — priced on its own line
    if (l.location) c.location = l.location;
  }

  // Package Manager: which CLIs resolve to a package (mobile etc.) — used to name + price the line.
  const cliPkgs = await resolveCliPackages(customerId, lines.map((l: any) => ({ cli: l.cli, description: l.description })));

  let seatCount = 0, seatCost = 0, recCount = 0;
  const broadband: CommsBroadband[] = []; const lineRental: CommsBroadband[] = []; const other: any[] = [];
  // Matched packages collapse to ONE line per package (qty = number of CLIs) so we don't show
  // a row per CLI — e.g. "Simply Mobile — Unlimited (EE) 12m × 3".
  const pkgAgg = new Map<string, { service: string; category: string; count: number; buy: number; saleEach: number | null }>();
  const item = (into: CommsBroadband[], ref: string, cli: string, service: string, buy: number, location: string | null) => {
    const sale = price.has(ref) ? price.get(ref)! : null;
    into.push({ cli, service, location, buy, sale, margin: sale === null ? null : sale - buy });
  };
  let componentCost = 0; // handsets/Webex/CRM on their own CLI — absorbed into the package
  let recCost = 0;       // Voice/Call Recording — separate billable, cost kept out of the seat
  for (const c of byCli.values()) {
    if (c.hasRec) { recCount++; recCost += c.recCost; }
    if (c.hasSeat) { seatCount++; seatCost += c.total - c.recCost; continue; } // seat cost excludes recording (it's separate)
    if (c.bbCost > 0) item(broadband, c.cli, c.cli, c.bbService || 'Broadband', c.bbCost, c.location);
    if (c.lrCost > 0) item(lineRental, 'LR:' + c.cli, c.cli, 'Line Rental', c.lrCost, c.location);
    if (c.mobileCost > 0) {
      const pk = cliPkgs.get(c.cli);
      if (pk) { const a = pkgAgg.get(pk.name) || { service: pk.name, category: pk.category || 'mobile', count: 0, buy: 0, saleEach: pk.sale }; a.count++; a.buy += c.mobileCost; pkgAgg.set(pk.name, a); }
      else { const sale = priceSum.has(c.cli) ? priceSum.get(c.cli)! : null; other.push({ cli: c.cli, service: 'Mobile / data', buy: c.mobileCost, sale, category: 'mobile', priceRef: c.cli, priceUnit: c.mobileCost }); }
    }
    if (c.componentCost > 0) componentCost += c.componentCost; // included handset/Webex/CRM (own CLI)
    if (c.others.length) {
      // Each standalone product (iCS analytics seat, etc.) bills as its own line, priced by its own
      // buy price (ref + unit_cost) so several products sharing one reference are itemised separately.
      for (const op of c.others) {
        const sale = priceByRefUnit.has(c.cli + '|' + op.unitCost.toFixed(4)) ? priceByRefUnit.get(c.cli + '|' + op.unitCost.toFixed(4))!
          : (price.has(c.cli) ? price.get(c.cli)! : null);
        other.push({ cli: c.cli, service: op.description || 'Other', buy: op.cost, sale, category: commsCategory(op.description), priceRef: c.cli, priceUnit: op.unitCost });
      }
    } else {
      const leftover = c.total - c.bbCost - c.lrCost - c.mobileCost - c.componentCost - c.recCost;
      if (leftover > 0.005) { const sale = price.has(c.cli) ? price.get(c.cli)! : null; other.push({ cli: c.cli, service: 'Other', buy: leftover, sale, category: 'additional', priceRef: c.cli, priceUnit: leftover }); }
    }
  }
  seatCost += componentCost; // absorb standalone handset/component cost into the package cost pool
  // Emit one grouped line per matched package (qty × unit), most-used first.
  for (const a of Array.from(pkgAgg.values()).sort((x, y) => y.count - x.count)) {
    const sale = a.saleEach === null ? null : a.saleEach * a.count;
    other.push({ cli: a.count + ' × CLI' + (a.count === 1 ? '' : 's'), service: a.service, buy: a.buy, sale, category: a.category, qty: a.count, unit: a.saleEach, priceRef: null });
  }
  // Manual charges → their own line at their own sell price (kept separate from the package buckets).
  for (const l of manualLines) {
    const ref = String(l.cli || '');
    const sale = price.has(ref) ? price.get(ref)! : null;
    other.push({ cli: l.cli || '(manual)', service: l.description || 'Manual charge', buy: Number(l.cost) || 0, sale, category: commsCategory(l.description), priceRef: ref, priceUnit: Number(l.cost) || 0 });
  }
  const seatUnit = price.get('SEAT') ?? seatStd;
  const seatSell = seatCount * seatUnit;
  const recUnit = price.get('REC') ?? recStd;
  const recSell = recCount * recUnit;
  const featurePack = price.get('FEATURE_PACK') ?? 0;
  const sumSell = (a: CommsBroadband[]) => a.reduce((s, b) => s + (b.sale || 0), 0);
  const sumCost = (a: CommsBroadband[]) => a.reduce((s, b) => s + b.buy, 0);
  const otherSell = other.reduce((a, b) => a + (b.sale || 0), 0);
  const otherCost = other.reduce((a, b) => a + b.buy, 0);
  const sell = seatSell + recSell + featurePack + sumSell(broadband) + sumSell(lineRental) + otherSell;
  const cost = seatCost + recCost + sumCost(broadband) + sumCost(lineRental) + otherCost; // recording cost is its own (out of seat)
  return {
    period: per,
    seats: { count: seatCount, unitPrice: seatUnit, sell: seatSell, cost: seatCost, margin: seatSell - seatCost },
    callRecording: { count: recCount, unitPrice: recUnit, sell: recSell, cost: recCost },
    featurePack,
    broadband, lineRental, other,
    totals: { sell, cost, margin: sell - cost },
  };
}

// ── Invoice categories ─────────────────────────────────────────────────────────
// Every comms line rolls up into one of six invoice buckets (page-1 summary).
// Terry's mapping: line rental = Voice, call recording = Additional.
export type CommsCat = 'internet' | 'voice' | 'mobile' | 'additional' | 'oneoff' | 'call';
export const COMMS_CATS: { key: CommsCat; label: string }[] = [
  { key: 'internet', label: 'Internet Services' },
  { key: 'voice', label: 'Voice Services' },
  { key: 'mobile', label: 'Mobile Services' },
  { key: 'additional', label: 'Additional Services' },
  { key: 'oneoff', label: 'One-off Charges' },
  { key: 'call', label: 'Call Charges' },
];
// One-off / non-recurring charges. Includes additional-handset PURCHASES (W73P Addl, W73H DECT,
// "additional handset") — but NOT the recurring handset-finance line ("Yealink W73P", "… Recurring").
export const ONEOFF_RE = /disconnection|reconnection|\binstall|connection fee|set[\s-]?up|activation|cease|ceasing|migrat|admin fee|one[\s-]?off|\bfee\b|new geographic|geographic number|number or ddi|\baddl\b|additional handset|\bw73h\b|handset purchase/i;
const ADDITIONAL_RE = /feature pack|recording|gointegrator|crmconnect|\bcrm\b|insight|collaboration/i;

// Classify a service line into its invoice category. Order matters: one-offs first,
// then recording/feature-pack (additional) before voice (so "Voice Recording" → additional).
export function commsCategory(description: string | null): CommsCat {
  const d = String(description || '');
  if (ONEOFF_RE.test(d)) return 'oneoff';
  if (ADDITIONAL_RE.test(d)) return 'additional';
  if (MOBILE_RE.test(d)) return 'mobile';
  if (BB_RE.test(d)) return 'internet';
  if (/hv select|hosted|webex|softphone|line rental|\bsip\b|telephon|seat|\bddi\b|trunk|analogue|isdn|\bnumber\b|\bvoice\b/i.test(d)) return 'voice';
  return 'additional';
}

export interface RateCardLine { category: CommsCat; label: string; ref: string | null; location: string | null; qty: number; cost: number; sale: number | null; oneOff?: boolean; }
export interface CommsRateCard {
  period: string | null;
  lines: RateCardLine[];
  byCategory: Record<CommsCat, { label: string; count: number; cost: number; sale: number; profit: number }>;
  oneOffs: RateCardLine[];      // unbilled one-offs (bill once, then drop)
  prorata: RateCardLine[];      // unbilled part-month catch-ups (bill once) — Giacom's mid-month start
  totals: { cost: number; sale: number; profit: number };
}

// The customer's rate card grouped into the six invoice categories — built on top of the
// package account (so Simply VoIP seats stay bundled), plus any unbilled one-off charges.
export async function commsRateCard(customerId: number, period?: string): Promise<CommsRateCard> {
  const acct = await commsAccount(customerId, period);
  const per = acct.period;
  const lines: RateCardLine[] = [];
  if (acct.seats.count) lines.push({ category: 'voice', label: 'Simply VoIP Seat', ref: null, location: null, qty: acct.seats.count, cost: acct.seats.cost, sale: acct.seats.sell });
  if (acct.callRecording.count) lines.push({ category: 'additional', label: 'Call Recording', ref: null, location: null, qty: acct.callRecording.count, cost: acct.callRecording.cost, sale: acct.callRecording.sell });
  if (acct.featurePack) lines.push({ category: 'additional', label: 'Feature Pack', ref: null, location: null, qty: 1, cost: 0, sale: acct.featurePack });
  for (const b of acct.broadband) lines.push({ category: 'internet', label: b.service, ref: b.cli, location: b.location, qty: 1, cost: b.buy, sale: b.sale });
  for (const b of acct.lineRental) lines.push({ category: 'voice', label: b.service, ref: b.cli, location: b.location, qty: 1, cost: b.buy, sale: b.sale });
  for (const o of acct.other) lines.push({ category: (o.category as CommsCat) || ((o.service || '').indexOf('Mobile') === 0 ? 'mobile' : 'additional'), label: o.service, ref: o.cli, location: null, qty: 1, cost: o.buy, sale: o.sale });

  // Unbilled one-off charges (install/cease/connection fees) — bill once, then billed_at hides them.
  const oneOffs: RateCardLine[] = [];
  if (per) {
    const oo = await pool.query(
      `SELECT si.product_reference AS cli, si.description, si.unit_cost, SUM(si.total_cost)::numeric AS cost,
              sp.sale_price
         FROM service_items si
         LEFT JOIN service_pricing sp
                ON sp.source='comms' AND sp.customer_id=si.customer_id
               AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
        WHERE si.source='comms' AND si.customer_id=$1 AND si.billed_at IS NULL
          AND (si.is_one_off = true OR si.description ~* $2
               OR (si.billing_from IS NOT NULL AND si.billing_from = si.billing_to))
        GROUP BY si.product_reference, si.description, si.unit_cost, sp.sale_price`,
      [customerId, ONEOFF_RE.source]
    );
    for (const r of oo.rows) {
      const buy = Number(r.cost) || 0;
      const sale = r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price);
      oneOffs.push({ category: 'oneoff', label: r.description || 'One-off charge', ref: r.cli, location: null, qty: 1, cost: buy, sale, oneOff: true });
    }
  }

  // Part-month catch-ups: Giacom's mid-month-start prorata lines (is_prorata, multi-day — single-day
  // is a one-off, handled above). Sale = the product's full-month sale × Giacom's own day-fraction
  // (part_cost / unit_cost). Billed once in their natural category.
  const prorata: RateCardLine[] = [];
  if (per) {
    const pp = await pool.query(
      `SELECT si.product_reference AS cli, si.description, si.unit_cost, SUM(si.quantity)::numeric AS qty,
              SUM(si.total_cost)::numeric AS cost, sp.sale_price
         FROM service_items si
         LEFT JOIN service_pricing sp
                ON sp.source='comms' AND sp.customer_id=si.customer_id
               AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
        WHERE si.source='comms' AND si.customer_id=$1 AND si.is_prorata=true AND si.billed_at IS NULL
          AND NOT (si.billing_from IS NOT NULL AND si.billing_from = si.billing_to)
        GROUP BY si.product_reference, si.description, si.unit_cost, sp.sale_price`,
      [customerId]
    );
    for (const r of pp.rows) {
      const buy = Number(r.cost) || 0; const unit = Number(r.unit_cost) || 0;
      const salePerUnit = r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price);
      const sale = (salePerUnit === null || unit <= 0) ? null : Math.round(salePerUnit * (buy / unit) * 100) / 100;
      prorata.push({ category: commsCategory(r.description), label: (r.description || 'Service') + ' (part month)', ref: r.cli, location: null, qty: 1, cost: buy, sale, oneOff: true });
    }
  }

  const byCategory = {} as CommsRateCard['byCategory'];
  for (const c of COMMS_CATS) byCategory[c.key] = { label: c.label, count: 0, cost: 0, sale: 0, profit: 0 };
  for (const l of [...lines, ...oneOffs, ...prorata]) {
    const b = byCategory[l.category];
    b.count++; b.cost += l.cost; if (l.sale !== null) { b.sale += l.sale; b.profit += l.sale - l.cost; }
  }
  const totals = { cost: 0, sale: 0, profit: 0 };
  for (const c of COMMS_CATS) { totals.cost += byCategory[c.key].cost; totals.sale += byCategory[c.key].sale; totals.profit += byCategory[c.key].profit; }
  return { period: per, lines, byCategory, oneOffs, prorata, totals };
}

// Unallocated CLIs/refs (needs an owner) — distinct comms CLIs not yet tied to a customer.
// CLIs the user has suppressed (e.g. an asset for a customer that went under) — kept out of the
// Stage-1 "to allocate" list and the unallocated-CLI warnings, and they stay suppressed across
// re-imports. Stored normalised (spaces stripped) in settings bureau/comms_suppressed_clis.
export async function suppressedClis(): Promise<Set<string>> {
  const raw = (await getSetting('bureau', 'comms_suppressed_clis')) || '';
  return new Set(raw.split(',').map((s) => s.trim().replace(/\s+/g, '')).filter(Boolean));
}

// Suppress is SOFT: a suppressed CLI is only hidden while it's dormant — no calls in the last 95
// days AND no current comms line with a cost. If it starts costing again (new calls or a charged
// line) it re-surfaces on the allocate/unaccounted lists, so every cost stays accounted for.
// Returns the subset of `suppressed` that should STILL be hidden (the dormant ones).
export async function dormantSuppressed(suppressed: Set<string>): Promise<Set<string>> {
  if (!suppressed.size) return suppressed;
  const arr = Array.from(suppressed);
  const active = new Set<string>();
  try {
    (await pool.query(
      `SELECT DISTINCT replace(cli,' ','') AS k FROM call_records
        WHERE call_at >= NOW() - INTERVAL '95 days' AND replace(cli,' ','') = ANY($1)`, [arr]
    )).rows.forEach((r: any) => active.add(String(r.k)));
  } catch { /* call_records absent */ }
  (await pool.query(
    `SELECT DISTINCT replace(product_reference,' ','') AS k FROM service_items
      WHERE source='comms' AND COALESCE(total_cost,0) > 0 AND replace(product_reference,' ','') = ANY($1)`, [arr]
  )).rows.forEach((r: any) => active.add(String(r.k)));
  return new Set(arr.filter((c) => !active.has(c)));
}

export async function unallocatedClis(): Promise<{ cli: string; type: 'voice' | 'circuit'; services: string[]; cost: number; lines: number }[]> {
  const { rows } = await pool.query(
    `SELECT product_reference AS cli, array_agg(DISTINCT description) AS services,
            SUM(total_cost)::numeric AS cost, COUNT(*)::int AS lines
       FROM service_items
      WHERE source='comms' AND customer_id IS NULL AND is_prorata=false AND product_reference IS NOT NULL
      GROUP BY product_reference ORDER BY product_reference`
  );
  const hide = await dormantSuppressed(await suppressedClis());
  return rows
    .filter((r: any) => !hide.has(String(r.cli).replace(/\s+/g, '')))
    .map((r: any) => ({ cli: r.cli, type: cliType(r.cli), services: (r.services || []).filter(Boolean), cost: Number(r.cost) || 0, lines: Number(r.lines) || 0 }));
}

// ── Call-type markup ───────────────────────────────────────────────────────────────
// Markup is applied per CALL TYPE, only to chargeable calls (cost > 0 — a £0 call sells at £0).
// Global defaults live in settings (comms/call_markup_<type>, falling back to the legacy flat
// comms/call_markup_pct); per-customer overrides live in customer_call_markups.
export const CALL_TYPES: { key: string; label: string }[] = [
  { key: 'on_net', label: 'On-net' },
  { key: 'uk_geo', label: 'UK Geographic (01/02)' },
  { key: 'uk_mobile', label: 'UK Mobile' },
  { key: 'nongeo_intl', label: 'Non-Geographic & International' },
];

// Classify a call/charge into one of the four bands. Uses the line's SOURCE and CLI first (a
// mobile-sourced line or an 07 CLI is mobile, regardless of the destination text), then the
// description / dialled number. opts.cli = the customer's line; opts.source = landline|mobile.
export function classifyCall(description: string | null, dialled?: string | null, opts?: { cli?: string | null; source?: string | null }): string {
  const d = String(description || '').toLowerCase();
  const n = String(dialled || '').replace(/[^0-9+]/g, '').replace(/^\+?44/, '0');
  const cli = String(opts?.cli || '').replace(/[^0-9+]/g, '').replace(/^\+?44/, '0');
  // Mobile by origin (the line itself is a mobile) — covers mobile data/roaming/CHARGE events
  // that carry no destination, which were wrongly falling into UK Geographic.
  if (String(opts?.source || '').toLowerCase() === 'mobile' || /^07[1-9]/.test(cli)) return 'uk_mobile';
  if (/on-?net/.test(d)) return 'on_net';
  if (/mobile/.test(d) || /^07[1-9]/.test(n)) return 'uk_mobile';
  if (/non[- ]?geo|international|\bintl\b|premium|\b00\b/.test(d) || /^0(0|80|84|87|83|30|55|70|76)/.test(n)) return 'nongeo_intl';
  return 'uk_geo';
}

export interface CallMarkups { global: Record<string, number>; customer: Record<string, number | null>; effective: Record<string, number>; }

// Resolve the global default + per-customer override + effective markup % for every call type.
export async function getCallMarkups(customerId?: number): Promise<CallMarkups> {
  const legacy = Number((await getSetting('bureau', 'call_markup_pct')) || (await getSetting('comms', 'call_markup_pct')) || '50') || 50;
  const global: Record<string, number> = {}; const customer: Record<string, number | null> = {}; const effective: Record<string, number> = {};
  for (const t of CALL_TYPES) {
    const g = await getSetting('comms', 'call_markup_' + t.key);
    global[t.key] = g != null && g !== '' ? Number(g) : legacy;
  }
  if (customerId) {
    const rows = (await pool.query('SELECT call_type, markup_pct FROM customer_call_markups WHERE customer_id=$1', [customerId])).rows;
    const byType = new Map(rows.map((r: any) => [String(r.call_type), Number(r.markup_pct)]));
    for (const t of CALL_TYPES) { const o = byType.has(t.key) ? byType.get(t.key)! : null; customer[t.key] = o; effective[t.key] = o == null ? global[t.key] : o; }
  } else {
    for (const t of CALL_TYPES) { customer[t.key] = null; effective[t.key] = global[t.key]; }
  }
  return { global, customer, effective };
}

// Call-charge total for a customer + period (per-type markup, chargeable calls only). Single
// source of truth so the bill run, review screen, invoice preview and customer panel all agree.
export async function commsCallCharge(customerId: number, period?: string): Promise<{ cost: number; sell: number; calls: number; period: string | null }> {
  // Business rule: each comms bill = services for month P (ADVANCE) + calls up to P-1 (ARREARS).
  // LOCKDOWN (2026-07): selection is by the billed_at flag, NOT period arithmetic — every call
  // not yet on a sent invoice bills on the next run (window: newer than the floor, no later than
  // P-1). A skipped or rolled month can therefore never orphan a month of calls; they simply
  // ride the next invoice. comms/calls_billed_floor fences off history billed before the flag
  // existed. Default 2026-05 = May's calls, billed by June's run on the old logic; June's calls
  // bill with the July run (flagged at its finalise). If July was finalised on the OLD code
  // (calls unflagged), bump the setting to 2026-06 before the August run to avoid a double-bill.
  const sp = period || (await currentCommsPeriod());
  if (!sp) return { cost: 0, sell: 0, calls: 0, period: null };
  const per = prevCommsPeriod(sp);
  const floor = String((await getSetting('comms', 'calls_billed_floor')) || '2026-05');
  const cm = await getCallMarkups(customerId);
  const crs = (await pool.query(
    `SELECT description, dialled, cli, source, cost FROM call_records
      WHERE customer_id=$1 AND billed_at IS NULL AND billing_period > $2 AND billing_period <= $3`,
    [customerId, floor, per]
  )).rows;
  let cost = 0, sell = 0, calls = 0;
  for (const cr of crs) {
    const c = Number(cr.cost) || 0; if (c <= 0) continue;
    const t = classifyCall(cr.description, cr.dialled, { cli: cr.cli, source: cr.source });
    cost += c; sell += c * (1 + (cm.effective[t] || 0) / 100); calls++;
  }
  return { cost, sell, calls, period: per };
}

// ── Customer number ranges → allocation ─────────────────────────────────────────────
// Attribute every comms service line AND call record whose CLI digits fall in [from,to] to the
// customer (+ CLI directory). Used when a range is added on a customer and by the import hook.
// Returns counts. `from`/`to` are digit strings.
export async function allocateNumberRange(customerId: number, from: string, to: string): Promise<{ lines: number; calls: number }> {
  const lo = from <= to ? from : to; const hi = from <= to ? to : from;
  if (!lo || !hi) return { lines: 0, calls: 0 };
  const inRange = `regexp_replace($COL,'[^0-9]','','g') <> '' AND length(regexp_replace($COL,'[^0-9]','','g')) <= 15 AND regexp_replace($COL,'[^0-9]','','g')::bigint BETWEEN $1::bigint AND $2::bigint`;
  // CLI directory for the billed CLIs in range.
  const clis = (await pool.query(
    `SELECT DISTINCT product_reference AS cli FROM service_items
      WHERE source='comms' AND product_reference IS NOT NULL AND ${inRange.replace(/\$COL/g, 'product_reference')}`,
    [lo, hi]
  )).rows.map((r: any) => String(r.cli).replace(/\s+/g, ''));
  for (const cli of clis) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [customerId, cli]
    );
  }
  const sl = await pool.query(
    `UPDATE service_items SET customer_id=$1 WHERE source='comms' AND ${inRange.replace(/\$COL/g, 'product_reference')}`, [customerId, lo, hi]
  );
  let calls = 0;
  try {
    const cr = await pool.query(
      `UPDATE call_records SET customer_id=$1 WHERE cli IS NOT NULL AND ${inRange.replace(/\$COL/g, 'cli')}`, [customerId, lo, hi]
    );
    calls = cr.rowCount || 0;
  } catch { /* call_records absent */ }
  return { lines: sl.rowCount || 0, calls };
}

// Re-apply ALL stored customer number ranges (import hook / overnight). Newest range wins on
// overlap (processed last). Manual pins are not overridden here (they aren't in this table).
export async function applyAllCustomerRanges(): Promise<{ ranges: number; lines: number; calls: number }> {
  const rows = (await pool.query('SELECT customer_id, range_from, range_to FROM customer_number_ranges ORDER BY id')).rows;
  let lines = 0, calls = 0;
  for (const r of rows) { const res = await allocateNumberRange(r.customer_id, String(r.range_from), String(r.range_to)); lines += res.lines; calls += res.calls; }
  return { ranges: rows.length, lines, calls };
}

// ── CLI accountability ─────────────────────────────────────────────────────────────
// PROTECTION: every CLI we've seen must be accounted for — allocated to a live customer or
// explicitly suppressed. This catches the gaps the unallocated/bounceback nets miss:
//  • orphaned_owner — a comms line whose customer_id points at a DELETED/missing customer
//    (e.g. a customer hard-deleted before the no-hard-delete rule). Not NULL → invisible to
//    unallocatedClis; not resolvable → invisible to bouncebacks. Silently stops billing.
//  • active_no_charge — a CLI that is LIVE in the call records but has no comms service line
//    allocated to a live customer (service dropped from the import, owner deleted, etc.).
// `unallocated` (customer_id NULL) is handled by unallocatedClis(); included here for a single
// "nothing slips through" list. Suppressed CLIs are excluded (a deliberate decision was made).
export interface UnaccountedCli { cli: string; reason: 'orphaned_owner' | 'active_no_charge'; detail: string; lastCustomerId: number | null; }

export async function unaccountedClis(): Promise<UnaccountedCli[]> {
  const suppressed = await dormantSuppressed(await suppressedClis());
  const out: UnaccountedCli[] = [];

  // Orphaned owner: comms line with a customer_id that no longer resolves to a live customer.
  const orphans = (await pool.query(
    `SELECT DISTINCT si.product_reference AS cli, si.customer_id,
            array_agg(DISTINCT si.description) AS services
       FROM service_items si
       LEFT JOIN customers c ON c.id = si.customer_id AND c.deleted_at IS NULL
      WHERE si.source='comms' AND si.product_reference IS NOT NULL
        AND si.customer_id IS NOT NULL AND c.id IS NULL
      GROUP BY si.product_reference, si.customer_id`
  )).rows;
  for (const r of orphans) {
    if (suppressed.has(String(r.cli).replace(/\s+/g, ''))) continue;
    out.push({ cli: r.cli, reason: 'orphaned_owner', lastCustomerId: r.customer_id,
      detail: 'Owning customer was deleted — ' + (r.services || []).filter(Boolean).slice(0, 3).join(', ') });
  }

  // Active but uncharged: CLI seen in call records with no comms service line on a live customer.
  let active: any[] = [];
  try {
    active = (await pool.query(
      `SELECT replace(cr.cli,' ','') AS cli, COUNT(*)::int AS calls, MAX(cr.customer_id) AS last_customer_id
         FROM call_records cr
        WHERE cr.cli IS NOT NULL AND cr.cli <> ''
          -- only RECENTLY active numbers: a CLI whose calls are all historical (e.g. 2025 imports
          -- for ceased/reassigned numbers) is not a current billing concern and shouldn't flag.
          AND cr.call_at >= (NOW() - INTERVAL '95 days')
          AND NOT EXISTS (
            SELECT 1 FROM service_items si
              JOIN customers c ON c.id = si.customer_id AND c.deleted_at IS NULL
             WHERE si.source='comms' AND replace(si.product_reference,' ','') = replace(cr.cli,' ',''))
          AND NOT EXISTS (
            SELECT 1 FROM call_records cr2
              JOIN customers c2 ON c2.id = cr2.customer_id AND c2.deleted_at IS NULL
             WHERE replace(cr2.cli,' ','') = replace(cr.cli,' ',''))
        GROUP BY replace(cr.cli,' ','')`
    )).rows;
  } catch { /* call_records not present */ }
  const seen = new Set(out.map((o) => o.cli.replace(/\s+/g, '')));
  for (const r of active) {
    const key = String(r.cli).replace(/\s+/g, '');
    if (!key || suppressed.has(key) || seen.has(key)) continue;
    out.push({ cli: r.cli, reason: 'active_no_charge', lastCustomerId: r.last_customer_id,
      detail: `${r.calls} call(s) in records, no billed service line` });
  }
  return out;
}

export interface CliRow { cli: string; type: 'voice' | 'circuit'; services: string[]; cost: number; sell: number | null; location: string | null; extName: string | null; }

// Searchable list of every CLI/Ref on the account (current month), with the services on each +
// the extension/user name from Insights (labelled overnight; matched on the canonical number).
export async function cliList(customerId: number, period?: string): Promise<CliRow[]> {
  const per = period || (await currentCommsPeriod());
  if (!per) return [];
  const { rows } = await pool.query(
    `SELECT si.product_reference AS cli, si.description, si.unit_cost, si.total_cost, si.location,
            sp.sale_price, el.ext_name
       FROM service_items si
       LEFT JOIN service_pricing sp
              ON sp.source='comms' AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
       LEFT JOIN cli_extension_labels el
              ON el.cli = regexp_replace(regexp_replace(si.product_reference,'[^0-9]','','g'),'^(44|0)','')
      WHERE si.source='comms' AND si.customer_id=$1 AND si.is_prorata=false AND si.billing_period=$2
      ORDER BY si.product_reference, si.description`,
    [customerId, per]
  );
  const byCli = new Map<string, CliRow>();
  for (const r of rows) {
    const cli = String(r.cli || '(none)');
    let row = byCli.get(cli);
    if (!row) { row = { cli, type: cliType(cli), services: [], cost: 0, sell: null, location: r.location || null, extName: r.ext_name || null }; byCli.set(cli, row); }
    if (r.location && !row.location) row.location = r.location;
    if (r.ext_name && !row.extName) row.extName = r.ext_name;
    if (r.description) row.services.push(r.description);
    row.cost += Number(r.total_cost) || 0;
    if (r.sale_price !== null && r.sale_price !== undefined) row.sell = (row.sell || 0) + Number(r.sale_price);
  }
  return Array.from(byCli.values());
}
