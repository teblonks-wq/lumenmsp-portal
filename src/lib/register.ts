import { pool } from '../db/pool';
import { SEAT_RE, REC_RE, COMPONENT_RE } from './comms-billing';

// ── The Customer Register — Phase 1 of the billing register rebuild ─────────────
// (design: 02 Projects/[C] Billing Register Rebuild - Design & Build Plan.md)
//
// One durable rate card per customer. Every line has a SOURCE ('comms-feed' |
// 'cloud-feed' | 'lumen') and a stable identity within it (source_key):
//   comms-feed : '<cli>|p<catalogue id>'  (or '<cli>|d:<normalised description>')
//   cloud-feed : lowercased Giacom product code
//   lumen      : 'L<row id>' — Lumen's own services; NO reconciler ever touches them.
// The feed imports stay exactly as they are. The reconcilers below run AFTER each
// import/sync and UPDATE the register: new key → added (amber/unpriced unless a price
// resolves), qty/cost/description change → updated + change row, key missing → CEASED
// (history kept — never deleted; cloud ceases carry a 30-day notice in
// cease_effective, clock = the sync-drop date per the signed-off design).
// Feeds NEVER touch sale_price on an existing line — pricing changes are human.
// Every mutation writes a register_changes row (the customer-facing Service History).
//
// Phase 1 is WRITE-ONLY bookkeeping: nothing reads the register for billing yet.
// The Phase 2 cutover (behind billing/register_enabled) renders bills from it.

const NOTICE_DAYS = 30; // cloud cease bills through this notice window

type Client = any;

export interface ReconcileResult { added: number; updated: number; ceased: number; reinstated: number; unchanged: number; }
const zero = (): ReconcileResult => ({ added: 0, updated: 0, ceased: 0, reinstated: 0, unchanged: 0 });

async function logChange(client: Client, a: { lineId: number | null; customerId: number; type: string; old?: any; next?: any; actor: string }): Promise<void> {
  await client.query(
    `INSERT INTO register_changes (register_line_id, customer_id, change_type, old, new, actor)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [a.lineId, a.customerId, a.type, a.old ? JSON.stringify(a.old) : null, a.next ? JSON.stringify(a.next) : null, a.actor]
  );
}

const near = (a: any, b: any) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;

interface FeedLine {
  customerId: number; key: string; description: string; qty: number; unitCost: number;
  salePrice: number | null; cli?: string | null; productId?: number | null; location?: string | null;
}

// Shared diff core. `feed` is the current truth for ONE source. An empty feed is a
// no-op by design — a failed import/sync must never cease the estate.
async function reconcileSource(source: 'comms-feed' | 'cloud-feed', feed: FeedLine[], actor: string, opts: { noticeDays?: number } = {}): Promise<ReconcileResult> {
  const res = zero();
  if (!feed.length) return res;

  const feedCustomers = Array.from(new Set(feed.map((f) => f.customerId)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      'SELECT * FROM customer_register_lines WHERE source=$1 AND customer_id = ANY($2)',
      [source, feedCustomers]
    )).rows;
    const byKey = new Map<string, any>();
    for (const r of existing) byKey.set(r.customer_id + '|' + r.source_key, r);

    const seen = new Set<string>();
    for (const f of feed) {
      const mapKey = f.customerId + '|' + f.key;
      seen.add(mapKey);
      const ex = byKey.get(mapKey);
      if (!ex) {
        const status = f.salePrice === null ? 'unpriced' : 'active';
        const ins = await client.query(
          `INSERT INTO customer_register_lines (customer_id, source, source_key, cli, product_id, description, location, qty, unit_cost, sale_price, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [f.customerId, source, f.key, f.cli || null, f.productId || null, f.description, f.location || null, f.qty, f.unitCost, f.salePrice, status]
        );
        await logChange(client, { lineId: ins.rows[0].id, customerId: f.customerId, type: 'added',
          next: { key: f.key, description: f.description, qty: f.qty, unitCost: f.unitCost, salePrice: f.salePrice, status }, actor });
        res.added++;
        continue;
      }
      let changed = false;
      if (ex.status === 'ceased') {
        await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'reinstated', old: { ceasedAt: ex.ceased_at }, next: { qty: f.qty }, actor });
        res.reinstated++; changed = true;
      }
      if (!near(ex.qty, f.qty)) { await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'qty', old: { qty: Number(ex.qty) }, next: { qty: f.qty }, actor }); changed = true; }
      if (!near(ex.unit_cost, f.unitCost)) { await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'cost', old: { unitCost: Number(ex.unit_cost) }, next: { unitCost: f.unitCost }, actor }); changed = true; }
      if (String(ex.description) !== f.description) { await logChange(client, { lineId: ex.id, customerId: f.customerId, type: 'desc', old: { description: ex.description }, next: { description: f.description }, actor }); changed = true; }
      if (changed) {
        // Feeds never overwrite a human-set price; an unpriced line may pick one up.
        await client.query(
          `UPDATE customer_register_lines SET qty=$1, unit_cost=$2, description=$3,
             sale_price = COALESCE(sale_price, $4),
             status = CASE WHEN COALESCE(sale_price, $4) IS NULL THEN 'unpriced' ELSE 'active' END,
             ceased_at=NULL, cease_effective=NULL, last_seen=NOW(), updated_at=NOW()
           WHERE id=$5`,
          [f.qty, f.unitCost, f.description, f.salePrice, ex.id]
        );
        res.updated++;
      } else {
        await client.query('UPDATE customer_register_lines SET last_seen=NOW() WHERE id=$1', [ex.id]);
        res.unchanged++;
      }
    }

    // Keys that vanished from the feed → ceased (history kept; never deleted).
    for (const r of existing) {
      if (seen.has(r.customer_id + '|' + r.source_key) || r.status === 'ceased') continue;
      const notice = opts.noticeDays || 0;
      await client.query(
        `UPDATE customer_register_lines SET status='ceased', ceased_at=NOW(),
           cease_effective = NOW() + ($1 || ' days')::interval, updated_at=NOW() WHERE id=$2`,
        [String(notice), r.id]
      );
      await logChange(client, { lineId: r.id, customerId: r.customer_id, type: 'ceased',
        old: { qty: Number(r.qty), salePrice: r.sale_price === null ? null : Number(r.sale_price) },
        next: { noticeDays: notice }, actor });
      res.ceased++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return res;
}

// ── comms-feed reconcile — run after the monthly PKL import ─────────────────────
// The file's newest month's recurring, allocated, non-manual lines are the truth.
export async function reconcileCommsRegister(periods: string[], actor = 'comms-import'): Promise<ReconcileResult> {
  const period = [...periods].sort().pop();
  if (!period) return zero();
  const rows = (await pool.query(
    `SELECT si.customer_id, si.product_reference AS cli, si.product_id, si.description,
            SUM(si.quantity)::numeric AS qty, MAX(si.unit_cost)::numeric AS unit_cost,
            MAX(si.external_customer_id) AS site, MAX(sp.sale_price)::numeric AS sale_price
       FROM service_items si
       LEFT JOIN service_pricing sp
              ON sp.source='comms' AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.billing_period=$1
        AND COALESCE(si.is_prorata,false)=false AND COALESCE(si.is_one_off,false)=false
        AND COALESCE(si.is_manual,false)=false AND COALESCE(si.is_projected,false)=false
      GROUP BY si.customer_id, si.product_reference, si.product_id, si.description`,
    [period]
  )).rows;
  const feed: FeedLine[] = rows.map((r: any) => ({
    customerId: r.customer_id,
    key: String(r.cli || '') + '|' + (r.product_id ? 'p' + r.product_id : 'd:' + String(r.description || '').toLowerCase().trim()),
    cli: r.cli || null,
    productId: r.product_id && /^\d+$/.test(String(r.product_id)) ? parseInt(String(r.product_id), 10) : null,
    description: String(r.description || '(unnamed)'),
    qty: Number(r.qty) || 1,
    unitCost: Number(r.unit_cost) || 0,
    salePrice: r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price),
    location: r.site || null,
  }));
  return reconcileSource('comms-feed', feed, actor);
}

// ── cloud-feed reconcile — run after the nightly Giacom sync ────────────────────
// The freshly-synced full state is the truth; a missing code starts the 30-day notice.
export async function reconcileCloudRegister(actor = 'cloud-sync'): Promise<ReconcileResult> {
  const rows = (await pool.query(
    `SELECT si.customer_id, lower(COALESCE(si.product_id::text,'')) AS code, MAX(si.description) AS description,
            SUM(si.quantity)::numeric AS qty, MAX(si.unit_cost)::numeric AS unit_cost, SUM(si.total_cost)::numeric AS total_cost,
            MAX(sp.sale_price)::numeric AS override, MAX(ap.unit_price)::numeric AS global_price
       FROM service_items si
       LEFT JOIN service_pricing sp ON sp.source='giacom' AND sp.customer_id=si.customer_id AND sp.product_reference=si.product_id::text
       LEFT JOIN asset_products ap ON ap.source_tag='giacom' AND lower(ap.code)=lower(si.product_id::text) AND ap.unit_price > 0
      WHERE si.source='giacom' AND si.customer_id IS NOT NULL AND COALESCE(si.product_id::text,'') <> ''
      GROUP BY si.customer_id, lower(COALESCE(si.product_id::text,''))`
  )).rows;
  const feed: FeedLine[] = rows.map((r: any) => {
    const qty = Number(r.qty) || 0;
    const unit = Number(r.unit_cost) || 0;
    const unitCost = unit > 0 ? unit : (qty > 0 ? (Number(r.total_cost) || 0) / qty : 0);
    const sale = r.override !== null && r.override !== undefined ? Number(r.override)
      : (r.global_price !== null && r.global_price !== undefined && Number(r.global_price) > 0 ? Number(r.global_price) : null);
    return { customerId: r.customer_id, key: String(r.code), description: String(r.description || '(unnamed)'),
      qty, unitCost: Math.round(unitCost * 10000) / 10000, salePrice: sale };
  }).filter((f) => f.qty > 0);
  return reconcileSource('cloud-feed', feed, actor, { noticeDays: NOTICE_DAYS });
}

// ── Contracts → register (lumen rows) ──────────────────────────────────────────
// The IT-contract half of the register. Mirrors itCloudAccount EXACTLY (active IT
// contracts, monthly lines) so the register's IC bill can match the live one line for
// line. Keyed by contract_line_id, so it is the single ongoing bridge: run it as a
// back-fill now, and again whenever a contract changes. Idempotent — a re-run updates
// what moved and ceases lines whose contract line has gone, never duplicates.
export async function backfillContractsToRegister(actor = 'contract-backfill'): Promise<{ added: number; updated: number; ceased: number; unchanged: number }> {
  const res = { added: 0, updated: 0, ceased: 0, unchanged: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = (await client.query(
      `SELECT ct.customer_id, cl.id AS line_id, cl.description, cl.quantity, cl.line_total
         FROM contracts ct JOIN contract_lines cl ON cl.contract_id = ct.id
        WHERE ct.service_type='IT' AND ct.status='active' AND ct.deleted_at IS NULL
          AND ct.customer_id IS NOT NULL AND cl.billing_frequency='monthly'`)).rows;

    const liveLineIds = new Set<number>();
    for (const r of rows) {
      liveLineIds.add(Number(r.line_id));
      const key = 'contract:' + r.line_id;
      const qty = Number(r.quantity) || 1;
      const total = Number(r.line_total) || 0;
      const saleEach = qty ? total / qty : total;   // render does sale_price × qty = line_total
      const ex = (await client.query(
        `SELECT id, qty, sale_price, description, status FROM customer_register_lines
          WHERE customer_id=$1 AND source='lumen' AND source_key=$2`, [r.customer_id, key])).rows[0];
      if (!ex) {
        const ins = await client.query(
          `INSERT INTO customer_register_lines (customer_id, source, source_key, description, invoice_category, qty, unit_cost, sale_price, status, contract_line_id)
           VALUES ($1,'lumen',$2,$3,'it_services',$4,0,$5,'active',$6) RETURNING id`,
          [r.customer_id, key, String(r.description || 'IT service'), qty, saleEach, Number(r.line_id)]);
        await logChange(client, { lineId: ins.rows[0].id, customerId: r.customer_id, type: 'added',
          next: { source: 'contract', contractLineId: r.line_id, description: r.description, qty, salePrice: saleEach }, actor });
        res.added++;
        continue;
      }
      const changed = Math.abs(Number(ex.qty) - qty) > 0.005 || Math.abs(Number(ex.sale_price ?? -1) - saleEach) > 0.005
        || String(ex.description) !== String(r.description || 'IT service') || ex.status === 'ceased';
      if (changed) {
        await client.query(
          `UPDATE customer_register_lines SET qty=$1, sale_price=$2, description=$3, status='active',
             ceased_at=NULL, cease_effective=NULL, updated_at=NOW() WHERE id=$4`,
          [qty, saleEach, String(r.description || 'IT service'), ex.id]);
        await logChange(client, { lineId: ex.id, customerId: r.customer_id, type: ex.status === 'ceased' ? 'reinstated' : 'price',
          old: { qty: Number(ex.qty), salePrice: ex.sale_price === null ? null : Number(ex.sale_price) },
          next: { qty, salePrice: saleEach }, actor });
        res.updated++;
      } else { res.unchanged++; }
    }

    // A lumen contract row whose contract line has gone (line deleted, contract ended/cancelled)
    // → cease it, so the register stops billing something the live engine already dropped.
    const orphans = (await client.query(
      `SELECT id, customer_id, source_key, qty, sale_price FROM customer_register_lines
        WHERE source='lumen' AND source_key LIKE 'contract:%' AND status <> 'ceased'`)).rows;
    for (const o of orphans) {
      const lineId = parseInt(String(o.source_key).slice('contract:'.length), 10);
      if (liveLineIds.has(lineId)) continue;
      await client.query(
        `UPDATE customer_register_lines SET status='ceased', ceased_at=NOW(), cease_effective=NOW(), updated_at=NOW() WHERE id=$1`, [o.id]);
      await logChange(client, { lineId: o.id, customerId: o.customer_id, type: 'ceased',
        old: { qty: Number(o.qty), salePrice: o.sale_price === null ? null : Number(o.sale_price) },
        next: { reason: 'contract line removed' }, actor });
      res.ceased++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return res;
}

// ── Read helpers for the Phase 1 view ───────────────────────────────────────────
export async function registerLines(customerId?: number | null): Promise<any[]> {
  return (await pool.query(
    `SELECT r.*, c.name AS customer_name FROM customer_register_lines r JOIN customers c ON c.id=r.customer_id
      WHERE ($1::int IS NULL OR r.customer_id=$1)
      ORDER BY c.name, r.source, r.status, r.description LIMIT 2000`, [customerId || null])).rows;
}

export async function registerRecentChanges(customerId?: number | null, limit = 120): Promise<any[]> {
  return (await pool.query(
    `SELECT g.*, c.name AS customer_name, r.description AS line_description
       FROM register_changes g JOIN customers c ON c.id=g.customer_id
       LEFT JOIN customer_register_lines r ON r.id=g.register_line_id
      WHERE ($1::int IS NULL OR g.customer_id=$1) ORDER BY g.created_at DESC LIMIT $2`, [customerId || null, limit])).rows;
}

// ── Price unpriced register lines from each customer's last invoice ─────────────
// Comms bills are PACKAGED: the invoice sells "Simply VoIP Seat" / "Call Recording"
// bundles plus standalone lines (internet circuits, line rental, iCS, static IP).
// So the register's seat/recording/handset components never carry a per-line price —
// they bill through the seat/recording package rate. Only the STANDALONE lines need a
// per-line sell, and those we can lift from the last invoice by matching the circuit /
// CLI ref (which sits inside the invoice line text). This routine therefore does two
// things, both conservative:
//   • price  — a standalone line matched to an invoice line → take its unit sell
//   • bundle — a seat/recording/handset component on a seat CLI → set £0 (active), so it
//              stops reading as "unpriced"; the seat/recording package already sells it
// Anything else is left untouched and reported as "unmatched" for manual pricing.
// Only ever touches 'unpriced' lines. apply=false = dry-run (rolls back).
export interface PriceFromInvoicesResult {
  priced: number;
  bundled: number;
  unmatched: number;
  customers: number;
  applied: boolean;
  samples: { customer: string; description: string; ref: string | null; via: string; unitPrice: number }[];
  misses: { customer: string; description: string; cli: string | null; source: string }[];
}

const SCHEME_FOR: Record<string, string[]> = { 'comms-feed': ['CS'], 'cloud-feed': ['IC', 'IT'], 'lumen': ['IC', 'IT'] };
const normDesc = (s: any) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[—–-].*$/, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const BUNDLED = (d: string) => SEAT_RE.test(d) || REC_RE.test(d) || COMPONENT_RE.test(d) || /busy lamp|\bblf\b|feature pack/i.test(d);

export async function priceRegisterFromInvoices(actor = 'invoice-backfill', apply = false): Promise<PriceFromInvoicesResult> {
  const res: PriceFromInvoicesResult = { priced: 0, bundled: 0, unmatched: 0, customers: 0, applied: apply, samples: [], misses: [] };
  const unpriced = (await pool.query(
    "SELECT id, customer_id, source, cli, product_id, description FROM customer_register_lines WHERE status='unpriced' AND customer_id IS NOT NULL"
  )).rows;
  if (!unpriced.length) return res;

  const byCust = new Map<number, any[]>();
  for (const r of unpriced) { if (!byCust.has(r.customer_id)) byCust.set(r.customer_id, []); byCust.get(r.customer_id)!.push(r); }
  const custName = new Map<number, string>();
  (await pool.query('SELECT id, name FROM customers WHERE id = ANY($1)', [[...byCust.keys()]]))
    .rows.forEach((c: any) => custName.set(c.id, c.name));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [cid, lines] of byCust) {
      res.customers++;
      const name = custName.get(cid) || String(cid);

      // Which CLIs are seats (carry an HV Select licence) — their components are all bundled.
      const seatClis = new Set<string>();
      (await client.query("SELECT cli, description FROM customer_register_lines WHERE customer_id=$1 AND source='comms-feed' AND cli IS NOT NULL", [cid]))
        .rows.forEach((r: any) => { if (SEAT_RE.test(String(r.description || ''))) seatClis.add(String(r.cli)); });

      // Invoice price index from the latest invoice per needed scheme (recurring template preferred).
      const schemes = Array.from(new Set(lines.flatMap((l: any) => SCHEME_FOR[l.source] || ['IC', 'IT'])));
      const items: { desc: string; nd: string; refs: string[]; price: number }[] = [];
      for (const scheme of schemes) {
        const inv = (await client.query(
          `SELECT id FROM invoices WHERE customer_id=$1 AND invoice_scheme=$2 AND deleted_at IS NULL
            ORDER BY is_recurring ASC, COALESCE(issue_date, created_at) DESC, id DESC LIMIT 1`, [cid, scheme]
        )).rows[0];
        if (!inv) continue;
        const rows = (await client.query(
          "SELECT description, unit_price FROM invoice_items WHERE invoice_id=$1 AND COALESCE(is_one_off,false)=false", [inv.id]
        )).rows;
        for (const it of rows) {
          const price = Number(it.unit_price);
          if (!(price > 0)) continue;
          const d = String(it.description || '');
          const refs = (d.match(/\(([^)]+)\)/g) || []).map((x) => x.replace(/[()]/g, '').trim().toLowerCase());
          items.push({ desc: d, nd: normDesc(d), refs, price });
        }
      }

      const findPrice = (l: any): { price: number; via: string } | null => {
        const cli = (l.cli || '').toString().trim().toLowerCase();
        if (cli) {
          const refHits = items.filter((it) => it.refs.some((r) => r === cli) || it.desc.toLowerCase().includes(cli));
          if (refHits.length) {
            const nd = normDesc(l.description).split(' ').filter(Boolean);
            const overlap = (it: any) => nd.reduce((n: number, w: string) => n + (it.nd.includes(w) ? 1 : 0), 0);
            const best = refHits.slice().sort((a, b) => overlap(b) - overlap(a))[0];
            return { price: best.price, via: 'ref' };
          }
        }
        const nd = normDesc(l.description);
        if (nd) {
          const byDesc = items.find((it) => it.nd === nd || it.nd.startsWith(nd) || nd.startsWith(it.nd));
          if (byDesc) return { price: byDesc.price, via: 'description' };
        }
        return null;
      };

      for (const l of lines) {
        const d = String(l.description || '');
        const onSeatCli = l.cli && seatClis.has(String(l.cli));
        // 1) Seat/recording/handset component that bills through a package → bundle at £0.
        if (l.source === 'comms-feed' && (REC_RE.test(d) || /\bcare\b/i.test(d) || ((SEAT_RE.test(d) || COMPONENT_RE.test(d) || /busy lamp|\bblf\b|feature pack/i.test(d)) && (onSeatCli || SEAT_RE.test(d))))) {
          res.bundled++;
          if (apply) {
            await client.query("UPDATE customer_register_lines SET sale_price=0, status='active', updated_at=NOW() WHERE id=$1", [l.id]);
            await logChange(client, { lineId: l.id, customerId: cid, type: 'price', old: { salePrice: null }, next: { salePrice: 0, bundled: true }, actor });
          }
          continue;
        }
        // 2) Standalone line → price from the matching invoice line.
        const hit = findPrice(l);
        if (hit) {
          res.priced++;
          if (res.samples.length < 60) res.samples.push({ customer: name, description: d, ref: l.cli || null, via: hit.via, unitPrice: hit.price });
          if (apply) {
            await client.query("UPDATE customer_register_lines SET sale_price=$1, status='active', updated_at=NOW() WHERE id=$2", [hit.price, l.id]);
            await logChange(client, { lineId: l.id, customerId: cid, type: 'price', old: { salePrice: null }, next: { salePrice: hit.price, via: hit.via, from: 'last-invoice' }, actor });
          }
          continue;
        }
        res.unmatched++;
        if (res.misses.length < 80) res.misses.push({ customer: name, description: d, cli: l.cli || null, source: l.source });
      }
    }
    if (apply) await client.query('COMMIT'); else await client.query('ROLLBACK');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return res;
}
