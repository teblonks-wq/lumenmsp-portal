import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Seeds Simply VoIP pricing: standard seat £16.50 + Call Recording £3 (settings), the per-customer
// overrides (Larkmead seat £14.50), Feature Packs, and the per-circuit broadband sell prices from
// the reviewed broadband sheet. Idempotent.
// Usage: node dist/scripts/seed-comms-pricing.js "<broadband_review.csv>"

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Standards (catalogue defaults).
  for (const [g, k, v] of [['comms', 'seat_price', '16.50'], ['comms', 'call_recording_price', '3.00']] as const) {
    await pool.query(`INSERT INTO settings ("group", key, value, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT ("group", key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [g, k, v]);
  }

  const byName = new Map<string, number>();
  for (const c of (await pool.query("SELECT id, lower(trim(name)) AS n FROM customers WHERE deleted_at IS NULL")).rows) byName.set(c.n, c.id);
  const litsId = byName.get('lits') ?? byName.get('lumen it solutions') ?? null;
  const cid = (name: string): number | null => {
    const n = (name || '').toLowerCase().trim();
    if (/^lits$|lumen it/.test(n)) return litsId;
    return byName.get(n) ?? null;
  };
  const setPrice = async (customerId: number, ref: string, unitCost: number, sale: number) => {
    await pool.query(
      `INSERT INTO service_pricing (source, customer_id, product_reference, unit_cost, sale_price, updated_at)
       VALUES ('comms',$1,$2,$3,$4,NOW())
       ON CONFLICT (source, customer_id, product_reference, unit_cost) DO UPDATE SET sale_price=EXCLUDED.sale_price, updated_at=NOW()`,
      [customerId, ref, unitCost, sale]
    );
  };

  // Resolve a customer by a distinctive name fragment (robust to exact-name variations).
  const findCust = (frag: string): number | null => {
    const f = frag.toLowerCase();
    if (byName.has(f)) return byName.get(f)!;
    for (const [n, id] of byName) { if (n.indexOf(f) >= 0) return id; }
    return null;
  };

  // Per-customer SEAT overrides — each customer keeps the seat price on their current invoice.
  // Larkmead = £14.50 across ALL seats (new deal). £16.50 stays the new-customer standard.
  const seatOverrides: [string, number][] = [
    ['amr sheet', 17.50], ['crowmarsh', 16.50],
    ['dynamic support', 17.50], ['godfrey', 16.50], ['purely recruitment', 17.50],
    ['steve benson', 13.00], ['tlc installation', 17.50], ['uzi', 17.50],
    ['larkmead veterinary', 14.50],
  ];
  for (const [frag, price] of seatOverrides) { const id = findCust(frag); if (id) await setPrice(id, 'SEAT', 0, price); }

  // Voice/Call Recording — Larkmead bills £3.00 per recording user.
  { const id = findCust('larkmead veterinary'); if (id) await setPrice(id, 'REC', 0, 3.00); }

  // Feature Packs (not a Giacom line — sell only).
  const fp: [string, number][] = [['amr sheet', 10], ['dynamic support', 15], ['tlc installation', 15], ['larkmead veterinary', 20]];
  for (const [frag, amt] of fp) { const id = findCust(frag); if (id) await setPrice(id, 'FEATURE_PACK', 0, amt); }

  // Line rentals (separate billable product, keyed LR:<cli>) — all sell at £16.99.
  // 01793490243 is NOT Larkmead (Swindon code) — owner TBC, seed once allocated.
  const lr: [string, string][] = [
    ['amr sheet', '01367718084'],
    ['larkmead veterinary', '01235847900'],
    ['larkmead veterinary', '01235847920'],
  ];
  for (const [frag, cli] of lr) { const id = findCust(frag); if (id) await setPrice(id, 'LR:' + cli, 0, 16.99); }

  // Broadband per-circuit sells — defaults to the bundled sheet shipped with the app.
  const file = process.argv[2] || path.join(process.cwd(), 'seed-data', 'broadband_review.csv');
  let bb = 0; const unknown = new Set<string>();
  if (fs.existsSync(file)) {
    const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
    for (const r of recs) {
      const sale = String(r.sale_price ?? '').trim(); if (sale === '') continue;
      const id = cid(r.customer || '');
      if (!id) { unknown.add(r.customer || '?'); continue; }
      await setPrice(id, (r.circuit_ref || '').trim(), num(r.buy_price), num(sale));
      bb++;
    }
  } else { console.log('  (no broadband CSV passed — seeded standards + overrides only)'); }

  console.log(`✓ Comms pricing seeded: standard seat £16.50 / call rec £3; Larkmead seat £14.50; ${fp.length} feature pack(s); ${bb} broadband circuit price(s).`);
  if (unknown.size) { console.log(`  ⚠ ${unknown.size} customer name(s) not found:`); Array.from(unknown).slice(0, 10).forEach((u) => console.log('    -', u)); }
  await pool.end();
}

main().catch((e) => { console.error('seed-comms-pricing failed:', e); process.exit(1); });
