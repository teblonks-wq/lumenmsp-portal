import { pool } from '../db/pool';
import { getSetting } from './settings';
import {
  SEAT_RE, REC_RE, BB_RE, MOBILE_RE, COMPONENT_RE,
  commsCategory, commsCallCharge, commsRateCard, currentCommsPeriod, CommsCat,
} from './comms-billing';
import { resolveCliPackages } from './packages';

// ── renderRegisterBill: the register-driven bill (design §5) ────────────────────
// One engine, two schemes. Reads ONLY the register for recurring lines; the transient
// adders (arrears calls, one-offs, prorata) come from the SAME functions the live
// engines use, so in the shadow report those cancel exactly and the diff measures the
// thing being changed: recurring billing moving from feed-side re-derivation to the
// durable register.
//
// PHASE 1b: this renders and returns lines — it writes NOTHING and no route creates
// invoices from it. Phase 2 (behind billing/register_enabled) points the bill runs here.

export interface RenderedLine {
  category: string;            // CS: the six comms categories · IC: 'it_services' | 'cloud'
  label: string;
  ref: string | null;
  qty: number;
  cost: number;
  sale: number | null;         // null = unpriced (never bills)
  transient?: boolean;         // one-off / prorata / calls — shared with the live engine
}

export interface RenderedBill {
  scheme: 'CS' | 'IC';
  period: string | null;
  lines: RenderedLine[];       // everything, priced or not
  billable: RenderedLine[];    // what the run would invoice (sale !== null && !== 0)
  unpriced: number;
  subtotal: number;            // billable sale sum (ex VAT) — the shadow's compare number
}

const LR_RE = /line rental/i;

function activeRows(rows: any[]): any[] {
  // active + unpriced bill-relevant now; ceased bills until cease_effective passes.
  const now = Date.now();
  return rows.filter((r) =>
    r.status === 'active' || r.status === 'unpriced' ||
    (r.status === 'ceased' && r.cease_effective && new Date(r.cease_effective).getTime() > now));
}

// ── CS: comms-feed + lumen(comms categories), seat/package bundling preserved ──
async function renderCS(customerId: number, period: string | null): Promise<RenderedBill> {
  const rows = (await pool.query(
    `SELECT * FROM customer_register_lines WHERE customer_id=$1 AND source IN ('comms-feed','lumen')`,
    [customerId])).rows;
  const live = activeRows(rows);

  // Derived rows carry the package prices (migrated sentinels). Fall back exactly as
  // commsAccount does: service_pricing sentinel → settings default.
  const derived = new Map<string, number>();
  for (const r of live) {
    if (r.source === 'comms-feed' && String(r.source_key || '').startsWith('derived:') && r.sale_price !== null) {
      derived.set(String(r.source_key).slice(8), Number(r.sale_price));
    }
  }
  const sent = (await pool.query(
    `SELECT product_reference AS k, MAX(sale_price)::numeric AS p FROM service_pricing
      WHERE source='comms' AND customer_id=$1 AND product_reference IN ('SEAT','REC','FEATURE_PACK') GROUP BY 1`,
    [customerId])).rows;
  for (const s of sent) if (!derived.has(String(s.k))) derived.set(String(s.k), Number(s.p));
  const seatUnit = derived.get('SEAT') ?? (Number(await getSetting('comms', 'seat_price')) || 16.5);
  const recUnit = derived.get('REC') ?? (Number(await getSetting('comms', 'call_recording_price')) || 3.0);
  const featurePack = derived.get('FEATURE_PACK') ?? 0;

  // Group comms-feed rows by CLI, same classification as commsAccount.
  type C = { cli: string; total: number; hasSeat: boolean; recCost: number; bbCost: number; bbService: string;
             lrCost: number; mobileCost: number; componentCost: number; location: string | null;
             others: { description: string; sale: number | null; cost: number }[] };
  const byCli = new Map<string, C>();
  const lumenComms: RenderedLine[] = [];
  for (const r of live) {
    if (r.source === 'lumen') {
      const cat = String(r.invoice_category || '');
      const isComms = ['internet', 'voice', 'mobile', 'additional', 'call', 'oneoff'].includes(cat)
        || (!cat && commsCategory(r.description) !== 'additional' && false); // uncategorised lumen rows default to IC
      if (isComms) {
        lumenComms.push({ category: cat || commsCategory(r.description), label: String(r.description),
          ref: null, qty: Number(r.qty) || 1, cost: (Number(r.unit_cost) || 0) * (Number(r.qty) || 1),
          sale: r.sale_price === null ? null : Number(r.sale_price) * (Number(r.qty) || 1) });
      }
      continue;
    }
    if (String(r.source_key || '').startsWith('derived:')) continue; // priced above, counted below
    const cli = String(r.cli || '(none)');
    const d = String(r.description || '');
    const cost = (Number(r.unit_cost) || 0) * (Number(r.qty) || 1);
    let c = byCli.get(cli);
    if (!c) { c = { cli, total: 0, hasSeat: false, recCost: 0, bbCost: 0, bbService: '', lrCost: 0, mobileCost: 0, componentCost: 0, location: r.location || null, others: [] }; byCli.set(cli, c); }
    c.total += cost;
    if (SEAT_RE.test(d)) c.hasSeat = true;
    if (REC_RE.test(d)) c.recCost += cost;
    if (LR_RE.test(d)) c.lrCost += cost;
    else if (BB_RE.test(d)) { c.bbCost += cost; if (!c.bbService && !/care/i.test(d)) c.bbService = d; }
    else if (MOBILE_RE.test(d)) c.mobileCost += cost;
    else if (COMPONENT_RE.test(d)) c.componentCost += cost;
    else if (!SEAT_RE.test(d) && !REC_RE.test(d)) {
      c.others.push({ description: d, cost, sale: r.sale_price === null ? null : Number(r.sale_price) * (Number(r.qty) || 1) });
    }
    if (r.location) c.location = r.location;
  }

  const cliPkgs = await resolveCliPackages(customerId,
    live.filter((r) => r.source === 'comms-feed' && r.cli).map((r) => ({ cli: r.cli, description: r.description })));

  // Per-CLI register prices (the non-sentinel service_pricing equivalents now live ON the rows).
  const rowSale = new Map<string, number>(); // cli → summed sale of priced rows on that cli
  for (const r of live) {
    if (r.source !== 'comms-feed' || !r.cli || r.sale_price === null) continue;
    if (String(r.source_key || '').startsWith('derived:')) continue;
    const k = String(r.cli);
    rowSale.set(k, (rowSale.get(k) || 0) + Number(r.sale_price) * (Number(r.qty) || 1));
  }

  let seatCount = 0, seatCost = 0, recCount = 0, recCost = 0, componentCost = 0;
  const lines: RenderedLine[] = [];
  const pkgAgg = new Map<string, { service: string; category: string; count: number; buy: number; saleEach: number | null }>();
  for (const c of byCli.values()) {
    if (c.recCost > 0) { recCount++; recCost += c.recCost; }
    if (c.hasSeat) { seatCount++; seatCost += c.total - c.recCost; continue; }
    if (c.bbCost > 0) lines.push({ category: 'internet', label: c.bbService || 'Broadband', ref: c.cli, qty: 1, cost: c.bbCost, sale: rowSale.has(c.cli) ? rowSale.get(c.cli)! : null });
    if (c.lrCost > 0) lines.push({ category: 'voice', label: 'Line Rental', ref: c.cli, qty: 1, cost: c.lrCost, sale: null });
    if (c.mobileCost > 0) {
      const pk = cliPkgs.get(c.cli);
      if (pk) { const a = pkgAgg.get(pk.name) || { service: pk.name, category: pk.category || 'mobile', count: 0, buy: 0, saleEach: pk.sale }; a.count++; a.buy += c.mobileCost; pkgAgg.set(pk.name, a); }
      else lines.push({ category: 'mobile', label: 'Mobile / data', ref: c.cli, qty: 1, cost: c.mobileCost, sale: rowSale.has(c.cli) ? rowSale.get(c.cli)! : null });
    }
    if (c.componentCost > 0) componentCost += c.componentCost;
    for (const op of c.others) lines.push({ category: commsCategory(op.description), label: op.description || 'Other', ref: c.cli, qty: 1, cost: op.cost, sale: op.sale });
  }
  seatCost += componentCost;
  for (const a of Array.from(pkgAgg.values()).sort((x, y) => y.count - x.count)) {
    lines.push({ category: a.category, label: a.service, ref: a.count + ' × CLI' + (a.count === 1 ? '' : 's'), qty: a.count, cost: a.buy, sale: a.saleEach === null ? null : a.saleEach * a.count });
  }
  if (seatCount) lines.unshift({ category: 'voice', label: 'Simply VoIP Seat', ref: null, qty: seatCount, cost: seatCost, sale: seatCount * seatUnit });
  if (recCount) lines.push({ category: 'additional', label: 'Call Recording', ref: null, qty: recCount, cost: recCost, sale: recCount * recUnit });
  if (featurePack) lines.push({ category: 'additional', label: 'Feature Pack', ref: null, qty: 1, cost: 0, sale: featurePack });
  lines.push(...lumenComms);

  // Transient adders — IDENTICAL code to the live run: one-offs + prorata from the rate
  // card (they never enter the register) and the arrears calls line.
  const per = period || (await currentCommsPeriod());
  const rc = await commsRateCard(customerId, per || undefined);
  for (const l of [...rc.oneOffs, ...rc.prorata]) {
    lines.push({ category: l.category, label: l.label, ref: l.ref, qty: l.qty || 1, cost: l.cost, sale: l.sale, transient: true });
  }
  const cc = await commsCallCharge(customerId, per || undefined);
  if (cc.sell > 0) lines.push({ category: 'call', label: 'Call Charges — ' + (cc.period || '') + ' (prev month)', ref: null, qty: 1, cost: cc.cost, sale: Math.round(cc.sell * 100) / 100, transient: true });

  const billable = lines.filter((l) => l.sale !== null && Number(l.sale) !== 0);
  return {
    scheme: 'CS', period: per, lines, billable,
    unpriced: lines.filter((l) => l.sale === null).length,
    subtotal: Math.round(billable.reduce((s, l) => s + (l.sale || 0), 0) * 100) / 100,
  };
}

// ── IC: cloud-feed (active + in-notice) + lumen(IT/cloud) + shared adjustments ──
async function renderIC(customerId: number, period: string | null): Promise<RenderedBill> {
  const rows = (await pool.query(
    `SELECT * FROM customer_register_lines WHERE customer_id=$1 AND source IN ('cloud-feed','lumen')`,
    [customerId])).rows;
  const live = activeRows(rows);
  const lines: RenderedLine[] = [];
  for (const r of live) {
    const qty = Number(r.qty) || 1;
    if (r.source === 'cloud-feed') {
      lines.push({ category: 'cloud', label: String(r.description)
          + (r.status === 'ceased' ? ' (ceasing — bills to ' + String(r.cease_effective).slice(0, 10) + ')' : ''),
        ref: String(r.source_key), qty, cost: (Number(r.unit_cost) || 0) * qty,
        sale: r.sale_price === null ? null : Number(r.sale_price) * qty });
    } else {
      const cat = String(r.invoice_category || '');
      const isComms = ['internet', 'voice', 'mobile', 'additional', 'call', 'oneoff'].includes(cat);
      if (isComms) continue; // rendered on CS
      lines.push({ category: cat || 'it_services', label: String(r.description), ref: null, qty,
        cost: (Number(r.unit_cost) || 0) * qty, sale: r.sale_price === null ? null : Number(r.sale_price) * qty });
    }
  }
  // Shared transients: the delta engine's upfront/notice adjustments — same module the
  // live itCloudAccount uses, so the shadow cancels them exactly.
  try {
    const { itCloudAdjustments } = await import('./it-cloud-deltas');
    for (const a of await itCloudAdjustments(customerId)) {
      lines.push({ category: 'cloud', label: a.description, ref: a.ref, qty: a.qty, cost: a.cost, sale: a.sale, transient: true });
    }
  } catch { /* delta ledger absent */ }

  const billable = lines.filter((l) => l.sale !== null && Number(l.sale) !== 0);
  return {
    scheme: 'IC', period, lines, billable,
    unpriced: lines.filter((l) => l.sale === null).length,
    subtotal: Math.round(billable.reduce((s, l) => s + (l.sale || 0), 0) * 100) / 100,
  };
}

export async function renderRegisterBill(customerId: number, scheme: 'CS' | 'IC', period?: string | null): Promise<RenderedBill> {
  return scheme === 'CS' ? renderCS(customerId, period || null) : renderIC(customerId, period || null);
}
