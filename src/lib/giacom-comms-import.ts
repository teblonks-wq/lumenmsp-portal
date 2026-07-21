import { pool } from '../db/pool';
import { applyAllCustomerRanges, refreshCommsProjections } from './comms-billing';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// ── Giacom comms SERVICES import (shared core) ──────────────────────────────────
// Parses a PKL…_Services.CSV (Site, CLI, From Date, To Date, Quantity, Unit Cost, Total Cost,
// Description, User, Department, VAT Status) and loads it into service_items. Used by BOTH the
// CLI script (src/scripts/import-giacom-services.ts) and the daily DWS SFTP sync, so a new
// month's file imports itself the morning it lands.
//
// PER-PERIOD replace, NOT a full snapshot (changed 2026-07): only the month(s) actually present
// in the file (keyed off From Date — the From dates ARE the period) are deleted and re-inserted,
// so past months coexist with the current one and a file can never clobber another month.
// Projected lines (rolled forward for advance billing) for those months are replaced by the
// actuals; later purely-projected months are then re-projected from this newest state.
// Manual lines are never touched. Unbilled imported one-offs for the file's months are replaced
// too (re-import safe); billed one-offs are history and stay.

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };
const pick = (r: any, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); } return ''; };
const toDate = (v: any): string | null => { const s = String(v || '').trim(); const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); return null; };
const normCli = (v: any): string => String(v ?? '').replace(/\s+/g, '');

// A line is "recurring" only if it spans a whole calendar month (1st → last day); anything
// part-period (mid-month start/end) is prorata = a one-off, not a recurring charge.
function periodInfo(from: string | null, to: string | null): { period: string | null; prorata: boolean } {
  if (!from) return { period: null, prorata: false };
  const period = from.slice(0, 7);
  const d = new Date(from + 'T00:00:00Z');
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const prorata = !(from === period + '-01' && to === lastDay);
  return { period, prorata };
}

export interface CommsServicesImportResult {
  inserted: number; matched: number; productsCreated: number; skippedNoCli: number;
  periods: string[]; refreshedProjections: string[];
}

// Quick sniff: is this buffer a Giacom services CSV? (header carries CLI + From Date + Description)
export function looksLikeServicesCsv(buf: Buffer): boolean {
  const head = buf.toString('utf8', 0, 600).split(/\r?\n/)[0] || '';
  return /\bCLI\b/i.test(head) && /From Date/i.test(head) && /Description/i.test(head) && /Total Cost/i.test(head);
}

export async function importGiacomServicesCsv(buf: Buffer): Promise<CommsServicesImportResult> {
  const recs: any[] = parse(buf, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });

  // Pre-parse every row so we know the file's period(s) BEFORE touching the DB.
  const lines: any[] = []; let skippedNoCli = 0;
  const periodSet = new Set<string>();
  for (const r of recs) {
    const cli = normCli(pick(r, ['CLI']));
    const desc = pick(r, ['Description']) || '(unnamed)';
    if (!cli) { skippedNoCli++; continue; } // every real line has a CLI; skip stragglers
    const from = toDate(pick(r, ['From Date']));
    const to = toDate(pick(r, ['To Date']));
    const { period, prorata } = periodInfo(from, to);
    if (period) periodSet.add(period);
    lines.push({
      cli, desc, site: pick(r, ['Site']),
      qty: num(pick(r, ['Quantity'])) || 1,
      unitCost: num(pick(r, ['Unit Cost'])),
      totalCost: num(pick(r, ['Total Cost'])),
      vat: pick(r, ['VAT Status']) || null,
      from, to, period, prorata,
      oneOff: !from || from === to, // no service span = device purchase / install / cease fee
    });
  }
  const periods = Array.from(periodSet).sort();

  // CLI → customer directory + existing catalogue products.
  const dir = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='cli'")).rows
    .forEach((r: any) => dir.set(normCli(r.external_id), r.customer_id));
  const prod = new Map<string, number>();
  (await pool.query("SELECT id, lower(trim(name)) AS n FROM asset_products")).rows.forEach((r: any) => prod.set(r.n, r.id));

  const client = await pool.connect();
  let inserted = 0, matched = 0, productsCreated = 0;
  try {
    await client.query('BEGIN');
    if (periods.length) {
      // Replace ONLY the file's month(s): recurring + prorata lines (including projections),
      // and this importer's own unbilled one-offs for those months (safe re-import). Manual
      // lines and billed history are never touched.
      await client.query(
        `DELETE FROM service_items WHERE source='comms' AND COALESCE(is_manual,false)=false
           AND COALESCE(is_one_off,false)=false AND billing_period = ANY($1)`, [periods]);
      await client.query(
        `DELETE FROM service_items WHERE source='comms' AND COALESCE(is_manual,false)=false
           AND is_one_off=true AND billed_at IS NULL AND (billing_period = ANY($1) OR billing_period IS NULL)`, [periods]);
    }
    for (const l of lines) {
      const cid = dir.get(l.cli) ?? null;
      if (cid) matched++;
      const key = l.desc.toLowerCase().trim();
      if (!prod.has(key)) {
        const ins = await client.query(
          "INSERT INTO asset_products (name, item_type, billing_frequency, vat_rate, is_active, source_tag) VALUES ($1,'service','monthly',20,true,'giacom-comms') RETURNING id", [l.desc]);
        prod.set(key, ins.rows[0].id); productsCreated++;
      }
      await client.query(
        `INSERT INTO service_items (source, customer_id, external_customer_id, external_customer_name, product_id, product_reference,
            description, quantity, unit_cost, total_cost, billing_from, billing_to, billing_period, is_prorata, is_one_off, is_projected, vat_status, synced_at)
         VALUES ('comms',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,$15,NOW())`,
        [cid, l.site || null, null, prod.get(key) ?? null, l.cli, l.desc, l.qty, l.unitCost, l.totalCost, l.from, l.to, l.period, l.prorata, l.oneOff, l.vat]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  // Auto-allocate any newly-imported CLIs that fall in a customer's stored number range.
  try { await applyAllCustomerRanges(); } catch (e) { console.error('[comms-import] range auto-allocate failed:', (e as Error).message); }

  // Newest actuals in → re-project any later, purely-projected months from this state.
  let refreshedProjections: string[] = [];
  if (periods.length) {
    try { refreshedProjections = await refreshCommsProjections(periods[periods.length - 1]); }
    catch (e) { console.error('[comms-import] projection refresh failed:', (e as Error).message); }
  }

  return { inserted, matched, productsCreated, skippedNoCli, periods, refreshedProjections };
}
