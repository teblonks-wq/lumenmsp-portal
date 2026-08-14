import { pool } from '../db/pool';

// ── Register migration: templates/sentinels/notices/lumen-items → the register ──
// (design §6: one script, DRY-RUN FIRST, per-customer report)
//
//   npm run migrate-register            ← dry run: full report, writes NOTHING
//   npm run migrate-register -- --apply ← does it, every write also in register_changes
//
// Four steps, in dependency order. Fuzzy matches are REPORTED and skipped, never
// auto-dropped — a human closes every ambiguity. Idempotent: rows already migrated
// (matched by source_key) are left alone, so a re-run after fixing reports is safe.

const APPLY = process.argv.includes('--apply');
const report: string[] = [];
const say = (s: string) => { report.push(s); console.log(s); };

async function logChange(client: any, lineId: number | null, customerId: number, type: string, next: any): Promise<void> {
  await client.query(
    `INSERT INTO register_changes (register_line_id, customer_id, change_type, old, new, actor)
     VALUES ($1,$2,$3,NULL,$4::jsonb,'migration')`,
    [lineId, customerId, type, JSON.stringify(next)]);
}

// Step 1 — sentinel prices (SEAT / REC / FEATURE_PACK) → explicit DERIVED register rows.
// The qty auto-counts at render (distinct HV-Select CLIs etc.); the price becomes a visible
// line on the rate card. Magic strings die at cutover; until then both mechanisms agree
// because the price is copied, not moved.
async function migrateSentinels(client: any): Promise<void> {
  const LABELS: Record<string, string> = { SEAT: 'Simply VoIP Seat', REC: 'Call Recording', FEATURE_PACK: 'Feature Pack' };
  const rows = (await client.query(
    `SELECT customer_id, product_reference AS k, MAX(sale_price)::numeric AS price
       FROM service_pricing
      WHERE source='comms' AND customer_id IS NOT NULL AND product_reference IN ('SEAT','REC','FEATURE_PACK')
      GROUP BY customer_id, product_reference`)).rows;
  let made = 0, kept = 0;
  for (const r of rows) {
    const key = 'derived:' + r.k;
    const ex = (await client.query(
      `SELECT id FROM customer_register_lines WHERE customer_id=$1 AND source='comms-feed' AND source_key=$2`,
      [r.customer_id, key])).rows[0];
    if (ex) { kept++; continue; }
    if (APPLY) {
      const ins = await client.query(
        `INSERT INTO customer_register_lines (customer_id, source, source_key, description, qty, qty_mode, unit_cost, sale_price, status)
         VALUES ($1,'comms-feed',$2,$3,0,'derived',0,$4,'active') RETURNING id`,
        [r.customer_id, key, LABELS[r.k] || r.k, Number(r.price)]);
      await logChange(client, ins.rows[0].id, r.customer_id, 'added',
        { migrated: 'sentinel', key: r.k, salePrice: Number(r.price) });
    }
    made++;
  }
  say(`Step 1 sentinels → derived rows: ${made} to create, ${kept} already present.`);
}

// Step 2 — recurring TEMPLATES → the register.
//   manual/contract items → lumen rows (contract_line_id preserved; the contract push
//   upserts by it forever after). giacom items → price CONFIRMATION onto the matching
//   cloud-feed line (exact case-insensitive description match only; anything fuzzier is
//   reported for a human). Templates are NOT deactivated here — that is the Phase 2
//   cutover's job, once the shadow is green.
async function migrateTemplates(client: any): Promise<void> {
  const tpls = (await client.query(
    `SELECT i.id, i.customer_id, i.invoice_scheme, i.title, c.name
       FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.is_recurring=true AND i.deleted_at IS NULL AND i.customer_id IS NOT NULL
      ORDER BY c.name`)).rows;
  let lumenMade = 0, lumenKept = 0, priced = 0, fuzzy = 0;
  for (const t of tpls) {
    const items = (await client.query(
      `SELECT id, source, description, quantity, unit_price, line_total, invoice_category, contract_line_id
         FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id`, [t.id])).rows;
    for (const it of items) {
      const src = String(it.source || 'manual');
      if (src === 'giacom') {
        // price confirmation → cloud-feed line, exact description match, only fills NULL
        const m = (await client.query(
          `SELECT id, sale_price FROM customer_register_lines
            WHERE customer_id=$1 AND source='cloud-feed' AND lower(description)=lower($2)`,
          [t.customer_id, String(it.description || '')])).rows;
        if (m.length === 1) {
          if (m[0].sale_price === null && Number(it.unit_price) > 0) {
            if (APPLY) {
              await client.query(
                `UPDATE customer_register_lines SET sale_price=$1, status='active', updated_at=NOW() WHERE id=$2`,
                [Number(it.unit_price), m[0].id]);
              await logChange(client, m[0].id, t.customer_id, 'price',
                { migrated: 'template-price', templateId: t.id, salePrice: Number(it.unit_price) });
            }
            priced++;
          }
        } else {
          fuzzy++;
          say(`  REPORT [${t.name}] template #${t.id} giacom item "${String(it.description).slice(0, 60)}" → ${m.length} cloud-feed matches — resolve by hand.`);
        }
        continue;
      }
      if (src === 'calls') continue; // arrears calls never live on the register
      // manual/contract → lumen row
      const key = 'm:' + it.id;
      const ex = (await client.query(
        `SELECT id FROM customer_register_lines WHERE customer_id=$1 AND source='lumen' AND source_key=$2`,
        [t.customer_id, key])).rows[0];
      if (ex) { lumenKept++; continue; }
      const qty = Number(it.quantity) || 1;
      if (APPLY) {
        const ins = await client.query(
          `INSERT INTO customer_register_lines (customer_id, source, source_key, description, invoice_category, qty, unit_cost, sale_price, status, contract_line_id)
           VALUES ($1,'lumen',$2,$3,$4,$5,0,$6,'active',$7) RETURNING id`,
          [t.customer_id, key, String(it.description || 'Service'), it.invoice_category || null,
           qty, Number(it.unit_price) || (qty ? (Number(it.line_total) || 0) / qty : 0), it.contract_line_id || null]);
        await logChange(client, ins.rows[0].id, t.customer_id, 'added',
          { migrated: 'template', templateId: t.id, scheme: t.invoice_scheme, description: it.description, qty });
      }
      lumenMade++;
    }
  }
  say(`Step 2 templates (${tpls.length}): ${lumenMade} lumen rows to create, ${lumenKept} already present, ${priced} cloud prices confirmed, ${fuzzy} REPORTED for a human.`);
}

// Step 3 — pending cloud notices (it_cloud_service_state.removed_at) → cease_effective on
// the matching cloud-feed line, so a notice already running keeps its original clock.
async function migrateNotices(client: any): Promise<void> {
  const rows = (await client.query(
    `SELECT customer_id, description, removed_at FROM it_cloud_service_state
      WHERE removed_at IS NOT NULL AND removed_at > NOW() - INTERVAL '30 days'`)).rows;
  let set = 0, miss = 0;
  for (const r of rows) {
    const m = (await client.query(
      `SELECT id, status FROM customer_register_lines
        WHERE customer_id=$1 AND source='cloud-feed' AND lower(description)=lower($2)`,
      [r.customer_id, String(r.description || '')])).rows;
    if (m.length !== 1) { miss++; say(`  REPORT notice "${String(r.description).slice(0, 60)}" (customer ${r.customer_id}) → ${m.length} matches — set the cease by hand.`); continue; }
    if (APPLY) {
      await client.query(
        `UPDATE customer_register_lines SET status='ceased', ceased_at=$1,
           cease_effective=$1::timestamptz + INTERVAL '30 days', updated_at=NOW() WHERE id=$2`,
        [r.removed_at, m[0].id]);
      await logChange(client, m[0].id, r.customer_id, 'ceased',
        { migrated: 'notice', removedAt: r.removed_at, noticeDays: 30 });
    }
    set++;
  }
  say(`Step 3 pending notices: ${set} carried over, ${miss} REPORTED.`);
}

// Step 4 — lumen service_items: landmine B — total_cost holds the SELL. Maps to
// sale_price; cost left NULL for Terry to fill at leisure.
async function migrateLumenItems(client: any): Promise<void> {
  const rows = (await client.query(
    `SELECT id, customer_id, description, quantity, total_cost, location
       FROM service_items WHERE source='lumen' AND customer_id IS NOT NULL`)).rows;
  let made = 0, kept = 0;
  for (const r of rows) {
    const key = 'si:' + r.id;
    const ex = (await client.query(
      `SELECT id FROM customer_register_lines WHERE customer_id=$1 AND source='lumen' AND source_key=$2`,
      [r.customer_id, key])).rows[0];
    if (ex) { kept++; continue; }
    const qty = Number(r.quantity) || 1;
    const sellEach = qty ? (Number(r.total_cost) || 0) / qty : Number(r.total_cost) || 0;
    if (APPLY) {
      const ins = await client.query(
        `INSERT INTO customer_register_lines (customer_id, source, source_key, description, location, qty, unit_cost, sale_price, status)
         VALUES ($1,'lumen',$2,$3,$4,$5,0,$6,'active') RETURNING id`,
        [r.customer_id, key, String(r.description || 'Lumen service'), r.location || null, qty, sellEach]);
      await logChange(client, ins.rows[0].id, r.customer_id, 'added',
        { migrated: 'lumen-item', serviceItemId: r.id, note: 'total_cost WAS the sell (landmine B); cost left null' });
    }
    made++;
  }
  say(`Step 4 lumen items: ${made} to create, ${kept} already present. (Costs left NULL — fill when known.)`);
}

async function main(): Promise<void> {
  say(`Register migration — ${APPLY ? '*** APPLY ***' : 'DRY RUN (nothing will be written)'} — ${new Date().toISOString()}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await migrateSentinels(client);
    await migrateTemplates(client);
    await migrateNotices(client);
    await migrateLumenItems(client);
    if (APPLY) { await client.query('COMMIT'); say('APPLIED — all four steps in one transaction.'); }
    else { await client.query('ROLLBACK'); say('Dry run complete — rolled back, nothing written. Re-run with --apply when the REPORT lines are resolved (or accepted).'); }
  } catch (e: any) {
    await client.query('ROLLBACK');
    say('FAILED, rolled back: ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
