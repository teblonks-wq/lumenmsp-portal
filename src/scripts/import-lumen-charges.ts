import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Imports Lumen billing-system exports (the "SalesCheck" charges export and the
// "SDR_Rejects" charge-queries export). Column names differ between exports, so we
// match by header alias. Seeds:
//   • service_items (source='lumen') — each customer's current charges (full mode)
//   • customer_external_ids — CLI/Ref → customer ('cli') and Account → customer ('lumen')
// Customer resolved by account_number (AMR-001 / SiteRef), manual 'lumen' link, then unique name.
// "revo-it" accounts are Lumen/LITS themselves. Unmatched rows keep customer_id NULL
// and appear on the service-account matching screen.
//
// Usage:  node dist/scripts/import-lumen-charges.js "<file.csv>" [directory]
//   directory = seed the CLI/account directory only (don't load service_items)

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };
const freqMap = (f: any): string => {
  const s = String(f || '').toLowerCase();
  if (s.startsWith('month')) return 'monthly';
  if (s.startsWith('ann') || s.startsWith('year')) return 'annual';
  if (s.includes('one')) return 'one_off';
  return 'monthly';
};
const pick = (r: any, names: string[]): string => {
  for (const n of names) { const v = r[n]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); }
  return '';
};
const toDate = (v: any): Date | null => { const s = String(v ?? '').trim(); if (!s) return null; const d = new Date(s.replace(' ', 'T')); return isNaN(d.getTime()) ? null : d; };

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set (check .env).'); process.exit(1); }
  const file = process.argv[2];
  const directoryOnly = (process.argv[3] || '').toLowerCase().startsWith('directory');
  if (!file || !fs.existsSync(file)) { console.error('CSV not found. Usage: import-lumen-charges.js "<file.csv>" [directory]'); process.exit(1); }

  const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const cust = (await pool.query("SELECT id, account_number, lower(name) AS lname FROM customers WHERE deleted_at IS NULL AND is_placeholder=false")).rows;
  const byAcct = new Map<string, number>(); const byName = new Map<string, number>(); const nameCount = new Map<string, number>();
  for (const c of cust) {
    if (c.account_number) byAcct.set(String(c.account_number).toLowerCase(), c.id);
    nameCount.set(c.lname, (nameCount.get(c.lname) || 0) + 1); byName.set(c.lname, c.id);
  }
  // Manual account links from the matching screen (source 'lumen').
  for (const l of (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='lumen'")).rows) {
    byAcct.set(String(l.external_id).toLowerCase(), l.customer_id);
  }
  // CLI directory (seeded from the reference files) — DWS bill runs key on CLI, not account.
  const cliDir = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='cli'")).rows
    .forEach((r: any) => cliDir.set(String(r.external_id).replace(/\s+/g, ''), r.customer_id));

  // Suppressed (deleted-in-Bureau) accounts — don't re-create their unallocated lines
  // unless a cost reappears (then we want to know about it again).
  const suppressed = new Set(
    ((await pool.query("SELECT value FROM settings WHERE \"group\"='bureau' AND key='suppressed'")).rows[0]?.value || '')
      .split(',').map((s: string) => s.trim()).filter(Boolean)
  );

  const resolve = (account: string, company: string, cli: string): number | null => {
    if (account && byAcct.has(account.toLowerCase())) return byAcct.get(account.toLowerCase())!;
    const c = (cli || '').replace(/\s+/g, '');
    if (c && cliDir.has(c)) return cliDir.get(c)!;
    const ln = company.toLowerCase();
    if (ln && nameCount.get(ln) === 1) return byName.get(ln) ?? null;
    return null;
  };

  const client = await pool.connect();
  let matched = 0, unmatched = 0, cliSeeded = 0, internal = 0;
  const unmatchedAccts = new Set<string>();
  // REVO / "REVO IT" = Lumen/LITS' own lines (marked DO NOT BILL) — never a customer charge.
  const isInternal = (account: string, company: string) => /^revo/i.test(account) || /revo\s*it|do not bill/i.test(company);
  try {
    await client.query('BEGIN');
    // Accumulate across months (no wipe): upsert by account + CLI/ref + description so
    // every distinct line is collected once. Manual allocation (customer_id) and any
    // hand-set sell price are preserved on re-import; synced_at tracks recency ("live").
    const existing = new Map<string, any>();
    if (!directoryOnly) {
      const ex = await client.query("SELECT id, external_customer_id, product_reference, description, customer_id, total_cost FROM service_items WHERE source='lumen'");
      ex.rows.forEach((r: any) => existing.set([(r.product_reference || r.external_customer_id || ''), (r.description || '')].join('§'), r));
    }
    for (const r of recs) {
      const company = pick(r, ['Company']);
      const account = pick(r, ['Account', 'SiteRef', 'Site']);
      const cli = pick(r, ['Billing ID', 'CLI']);
      const desc = pick(r, ['Description', 'Charge Type', 'Carrier Description']);
      const qty = num(pick(r, ['Quantity'])) || 1;
      const sell = num(pick(r, ['Sell Price', 'Price']));
      const cost = num(pick(r, ['Carrier Unit Cost', 'Unit Cost', 'Carrier Total Cost', 'Total Cost']));
      const billFrom = toDate(pick(r, ['Billed From', 'Service Start', 'From Date']));
      const billTo = toDate(pick(r, ['Billed To', 'To Date']));
      if (!company && !account && !cli) continue;
      if (isInternal(account, company)) { internal++; continue; } // Lumen's own — do not bill

      const resolved = resolve(account, company, cli);

      // Deleted-in-Bureau & still nothing to bill → stay gone (resurface only on a cost).
      if (resolved == null && cost <= 0 && sell <= 0 && suppressed.has('lumen|' + (account || ''))) { unmatched++; continue; }

      if (!directoryOnly) {
        const key = [(cli || account || ''), desc || ''].join('§');
        const prev = existing.get(key);
        if (prev) {
          const keepCid = prev.customer_id != null ? prev.customer_id : resolved;     // keep manual allocation
          const keepSell = (Number(prev.total_cost) || 0) > 0 ? prev.total_cost : sell; // keep hand-set price
          await client.query(
            `UPDATE service_items SET customer_id=$1, external_customer_name=$2, quantity=$3, unit_cost=$4, total_cost=$5, billing_from=$6, billing_to=$7, synced_at=NOW() WHERE id=$8`,
            [keepCid, company || null, qty, cost, keepSell, billFrom, billTo, prev.id]
          );
          if (keepCid) matched++; else { unmatched++; if (account) unmatchedAccts.add(account); }
        } else {
          await client.query(
            `INSERT INTO service_items (source, customer_id, external_customer_id, external_customer_name, product_reference, description, quantity, unit_cost, total_cost, billing_from, billing_to, synced_at)
             VALUES ('lumen',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
            [resolved, account || null, company || null, cli || null, desc || null, qty, cost, sell, billFrom, billTo]
          );
          if (resolved) matched++; else { unmatched++; if (account) unmatchedAccts.add(account); }
        }
      } else {
        if (resolved) matched++; else { unmatched++; if (account) unmatchedAccts.add(account); }
      }

      if (resolved) {
        if (account) await client.query(
          `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'lumen',$2)
           ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [resolved, account]);
        if (cli) { await client.query(
          `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
           ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [resolved, cli]); cliSeeded++; }
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  console.log(`✓ Lumen import (${directoryOnly ? 'directory-only' : 'full'}): ${recs.length} rows — ${matched} matched, ${unmatched} unmatched, ${internal} internal/REVO skipped. CLI directory +${cliSeeded}.`);
  if (unmatchedAccts.size) console.log('  Unmatched accounts → matching screen:', [...unmatchedAccts].join(', '));
  await pool.end();
}

main().catch((e) => { console.error('Lumen import failed:', e); process.exit(1); });
