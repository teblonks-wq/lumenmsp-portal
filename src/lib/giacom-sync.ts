import cron from 'node-cron';
import { pool } from '../db/pool';
import { GiacomBilling, giacomBillingConfigured } from './giacom';
import { getSetting, setSetting } from './settings';

const num = (v: any): number => { const x = parseFloat((v ?? '').toString()); return isNaN(x) ? 0 : x; };

// Pulls Giacom AccountTotals, maps each Giacom account to a portal customer
// (auto-matching unique name matches, recorded in customer_external_ids), and
// fully refreshes the 'giacom' rows in service_items. Safe to re-run.
export async function syncGiacomBilling(): Promise<{ fetched: number; matched: number; unmatched: number; customers: number }> {
  if (!(await giacomBillingConfigured())) return { fetched: 0, matched: 0, unmatched: 0, customers: 0 };

  const resp = await GiacomBilling.accountTotals({ pageSize: 5000 });
  const rows: any[] = (resp && resp.data) || [];

  // Existing Giacom → portal customer mappings
  const ext = await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='giacom'");
  const map = new Map<string, number>();
  ext.rows.forEach((r: any) => map.set(String(r.external_id), r.customer_id));

  // Unique portal customer names (for auto-match)
  const cust = await pool.query("SELECT id, lower(name) AS lname FROM customers WHERE deleted_at IS NULL AND is_placeholder=false");
  const nameCount = new Map<string, number>(), nameId = new Map<string, number>();
  cust.rows.forEach((c: any) => { nameCount.set(c.lname, (nameCount.get(c.lname) || 0) + 1); nameId.set(c.lname, c.id); });

  // Distinct Giacom accounts in this pull
  const giacomCustomers = new Map<string, string>();
  for (const r of rows) if (r.customerId) giacomCustomers.set(String(r.customerId), r.customerName || '');

  // Auto-match by unique name → create the mapping
  for (const [gid, gname] of giacomCustomers) {
    if (map.has(gid)) continue;
    const ln = (gname || '').toLowerCase().trim();
    if (ln && nameCount.get(ln) === 1) {
      const cid = nameId.get(ln)!;
      await pool.query(
        `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'giacom',$2)
         ON CONFLICT (source_system, external_id) DO NOTHING`, [cid, gid]
      );
      map.set(gid, cid);
    }
  }

  // Suppressed (deleted-in-Bureau) Giacom accounts — skip on full refresh unless a cost
  // reappears, so a deleted zero-cost account doesn't keep coming back.
  const suppressed = new Set(
    ((await getSetting('bureau', 'suppressed')) || '').split(',').map((s) => s.trim()).filter(Boolean)
  );

  // Full refresh of the Giacom service items
  const client = await pool.connect();
  let matched = 0, unmatched = 0;
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM service_items WHERE source='giacom'");
    for (const r of rows) {
      const gid = r.customerId ? String(r.customerId) : null;
      const cid = gid && map.has(gid) ? map.get(gid)! : null;
      if (!cid && num(r.totalCost) <= 0 && suppressed.has('giacom|' + (gid || ''))) continue; // deleted & still no cost
      if (cid) matched++; else unmatched++;
      await client.query(
        `INSERT INTO service_items (source, customer_id, external_customer_id, external_customer_name, product_id, product_reference, description, quantity, unit_cost, total_cost, billing_date, synced_at)
         VALUES ('giacom',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [cid, gid, r.customerName || null, r.productId || null, r.productReference || null,
         r.productReference || r.productId || null, num(r.quantity), num(r.costPerSeat), num(r.totalCost),
         r.created ? new Date(r.created) : null]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await setSetting('giacom', 'last_sync', new Date().toISOString());
  return { fetched: rows.length, matched, unmatched, customers: giacomCustomers.size };
}

let _started = false;
export function startGiacomSync(): void {
  if (_started) return;
  _started = true;
  // Nightly at 05:00. No-ops if Giacom isn't configured.
  cron.schedule('0 5 * * *', () => {
    syncGiacomBilling()
      .then(async (r) => {
        if (r.fetched) console.log(`[giacom] nightly sync: ${r.fetched} items, ${r.matched} matched, ${r.unmatched} unmatched`);
        // IT & Cloud delta engine: record adds (upfront) + removals (30-day notice) off the fresh state.
        try { const { syncItCloudDeltas } = await import('./it-cloud-deltas'); await syncItCloudDeltas(); }
        catch (e) { console.error('[itcloud-deltas] post-sync failed:', (e as Error).message); }
      })
      .catch((e) => console.error('[giacom] sync error:', e.message));
  });
  console.log('[giacom] nightly billing sync scheduled (05:00)');
}
