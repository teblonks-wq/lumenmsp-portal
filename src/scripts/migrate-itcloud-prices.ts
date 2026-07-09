import 'dotenv/config';
import { Pool } from 'pg';

// Migrate the sell prices that are trapped on each customer's TEMPLATE (manual Giacom lines) into the
// unified price list: GLOBAL catalogue price (asset_products.unit_price, the modal sell per product)
// + per-customer override (service_pricing) where a customer differs. Optionally removes the now-
// duplicate manual Giacom line from the template (Giacom auto-attaches it from the feed instead).
//
//   DRY-RUN (default): prints every proposed match + price + action.
//   APPLY:           node dist/scripts/migrate-itcloud-prices.js --apply
//   APPLY + remove:  node dist/scripts/migrate-itcloud-prices.js --apply --remove-template-lines

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove-template-lines');

const norm = (s: any): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
// A template line matches a Giacom service item if one normalised description contains the other
// (and the shorter is reasonably distinctive — ≥ 8 chars), so "Microsoft 365 Business Premium"
// matches the feed line for that SKU but not a generic "support" line.
function matches(tplDesc: string, siDesc: string): boolean {
  const a = norm(tplDesc), b = norm(siDesc);
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 8 && longer.includes(shorter);
}

(async () => {
  const tpls = (await pool.query(
    `SELECT id, customer_id FROM invoices WHERE is_recurring=true AND deleted_at IS NULL AND invoice_scheme IN ('IT','IC') ORDER BY customer_id`
  )).rows;

  type Hit = { customer_id: number; product_reference: string; unit_cost: number; sell: number; tplItemId: number; siDesc: string };
  const hits: Hit[] = [];

  for (const t of tpls) {
    const lines = (await pool.query("SELECT id, description, quantity, unit_price FROM invoice_items WHERE invoice_id=$1 AND source<>'giacom' AND COALESCE(is_one_off,false)=false", [t.id])).rows;
    const sis = (await pool.query(
      `SELECT product_reference, MIN(description) AS description, unit_cost
         FROM service_items WHERE customer_id=$1 AND source='giacom' AND COALESCE(product_reference,'')<>''
         GROUP BY product_reference, unit_cost`, [t.customer_id]
    )).rows;
    for (const ln of lines) {
      const si = sis.find((s: any) => matches(ln.description, s.description));
      if (si) hits.push({ customer_id: t.customer_id, product_reference: si.product_reference, unit_cost: Number(si.unit_cost) || 0, sell: Number(ln.unit_price) || 0, tplItemId: ln.id, siDesc: si.description });
    }
  }

  // Global standard = modal sell per (product_reference, unit_cost).
  const byProduct = new Map<string, Map<number, number>>(); // key -> sell -> count
  for (const h of hits) {
    const k = `${h.product_reference}|${h.unit_cost.toFixed(4)}`;
    if (!byProduct.has(k)) byProduct.set(k, new Map());
    const m = byProduct.get(k)!; m.set(h.sell, (m.get(h.sell) || 0) + 1);
  }
  const globalSell = new Map<string, number>();
  for (const [k, m] of byProduct) { let best = 0, bestN = -1; for (const [sell, n] of m) if (n > bestN) { bestN = n; best = sell; } globalSell.set(k, best); }

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}${REMOVE ? ' +remove template lines' : ''} — ${hits.length} matched line(s), ${globalSell.size} distinct product(s)\n`);
  console.log('GLOBAL standard prices (catalogue):');
  for (const [k, sell] of globalSell) console.log(`   [${k}] -> £${sell.toFixed(2)}`);
  console.log('');

  let cat = 0, ovr = 0, removed = 0;
  for (const h of hits) {
    const k = `${h.product_reference}|${h.unit_cost.toFixed(4)}`;
    const g = globalSell.get(k) || 0;
    const isOverride = Math.abs(h.sell - g) > 0.005;
    console.log(`cust ${h.customer_id} [${h.product_reference}] £${h.sell.toFixed(2)} ${isOverride ? '(OVERRIDE — differs from std £' + g.toFixed(2) + ')' : '(= std)'}  ~ ${h.siDesc.slice(0, 40)}`);
    if (!APPLY) continue;
    if (isOverride) {
      await pool.query(
        `INSERT INTO service_pricing (source, customer_id, product_reference, unit_cost, sale_price, updated_at)
         VALUES ('giacom',$1,$2,$3,$4,NOW())
         ON CONFLICT (source, customer_id, product_reference, unit_cost) DO UPDATE SET sale_price=EXCLUDED.sale_price, updated_at=NOW()`,
        [h.customer_id, h.product_reference, h.unit_cost, h.sell]
      );
      ovr++;
    }
    if (REMOVE) { await pool.query('DELETE FROM invoice_items WHERE id=$1', [h.tplItemId]); removed++; }
  }
  if (APPLY) {
    for (const [k, sell] of globalSell) {
      const [ref] = k.split('|');
      const r = await pool.query("UPDATE asset_products SET unit_price=$1, updated_at=NOW() WHERE source_tag='giacom' AND lower(code)=lower($2) AND COALESCE(unit_price,0)=0", [sell, ref]);
      cat += r.rowCount || 0;
    }
  }
  console.log(`\nSummary: ${APPLY ? `set ${cat} catalogue global price(s), ${ovr} customer override(s)${REMOVE ? `, removed ${removed} template line(s)` : ''}.` : 'Dry-run only — review, then --apply (add --remove-template-lines once happy).'}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
