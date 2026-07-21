import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { getSetting, setSetting } from '../lib/settings';
import { pricedServiceLines, setSalePrice } from '../lib/service-pricing';
import { unallocatedClis, unaccountedClis, suppressedClis, currentCommsPeriod, prevCommsPeriod, commsPeriods, commsRateCard, COMMS_CATS, commsCategory, ONEOFF_RE, COMPONENT_RE, HANDSET_RE, cliType, classifyCall, getCallMarkups, CALL_TYPES, commsCallCharge, advanceCommsPeriod, rollForwardCommsPeriod } from '../lib/comms-billing';
import { recycleRow } from '../lib/recycle';
import { QuickBooks } from '../lib/quickbooks';
import { generateCommsBillRun, finaliseCommsBillRun, generateItCloudBillRun } from '../lib/recurring-billing';
import { detectPackage } from '../lib/packages';
import { itCloudAccount, itCloudMissingBillingContact } from '../lib/it-cloud-billing';
import { generateItCloudFromTemplate, syncItCloudInvoice, itCloudPeriod, completeItCloudRun, itCloudStagedAudit } from '../lib/it-cloud-sync';
import { renderCommsInvoiceHtml, customerBillingIdentity } from '../lib/invoice-pdf';
import { labelClisFromInsights } from '../lib/insights/ext-labels';
import { backfillDwsCalls } from '../lib/dws-sftp';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse: csvParseSync } = require('csv-parse/sync');

const ignoreKey = (source: string, gid: string) => `${source}|${gid}`;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const router = Router();
router.use('/bureau', requireAuth, requireAdmin);

// ── Bureau: allocation cockpit for imported supplier services (Giacom cloud + comms /
// Lumen) that aren't yet allocated to a customer. Replaces the bureau's rejects sheet:
// set the customer (allocate) and the sell price here, in one place.
router.get('/bureau', async (req: Request, res: Response) => {
  const ignored = new Set(((await getSetting('bureau', 'ignored')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  const suppressed = new Set(((await getSetting('bureau', 'suppressed')) || '').split(',').map((s) => s.trim()).filter(Boolean));

  // Unallocated accounts. `live` = seen in a recent import (so an ignored account
  // that's still being billed is flagged, not silently hidden).
  const accountsAll = (await pool.query(
    `SELECT source, external_customer_id AS gid, MAX(external_customer_name) AS gname,
            COUNT(*)::int AS items, SUM(total_cost)::numeric AS total,
            SUM(unit_cost * quantity)::numeric AS cost_total,
            MAX(synced_at) AS last_seen, (MAX(synced_at) > NOW() - INTERVAL '35 days') AS live
     FROM service_items WHERE customer_id IS NULL AND external_customer_id IS NOT NULL
     GROUP BY source, external_customer_id ORDER BY source, MAX(external_customer_name)`
  )).rows;
  const accounts = accountsAll.filter((a: any) => !ignored.has(ignoreKey(a.source, a.gid)));
  const ignoredAccounts = accountsAll.filter((a: any) => ignored.has(ignoreKey(a.source, a.gid)));

  // Unallocated individual lines (excluding ignored accounts).
  const items = (await pool.query(
    `SELECT id, source, external_customer_id, external_customer_name, product_reference, description, quantity, unit_cost, total_cost
     FROM service_items WHERE customer_id IS NULL ORDER BY source, external_customer_name, description LIMIT 1000`
  )).rows.filter((it: any) => !ignored.has(ignoreKey(it.source, it.external_customer_id || '')));

  const customers = (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name")).rows;
  const counts = (await pool.query("SELECT source, COUNT(*)::int AS n, SUM(total_cost)::numeric AS total FROM service_items WHERE customer_id IS NULL GROUP BY source")).rows;

  // ── Itemized calls (cost + markup) ──
  const markupPct = Number((await getSetting('bureau', 'call_markup_pct')) || '50') || 50;
  const selCustomer = parseInt(String(req.query.customer || ''), 10) || null;
  let periods: string[] = [];
  let selPeriod = req.query.period != null ? String(req.query.period) : '';
  let calls: any[] = [];
  let callTotals = { count: 0, cost: 0, sell: 0 };
  try {
    periods = (await pool.query("SELECT DISTINCT billing_period AS p FROM call_records WHERE billing_period IS NOT NULL ORDER BY billing_period DESC")).rows.map((r: any) => r.p);
    if (req.query.period == null) selPeriod = periods[0] || '';
    if (selCustomer) {
      calls = (await pool.query(
        `SELECT call_at, dialled, description, duration_sec, cost FROM call_records
         WHERE customer_id=$1 AND ($2='' OR billing_period=$2) ORDER BY call_at LIMIT 5000`,
        [selCustomer, selPeriod]
      )).rows;
      const cost = calls.reduce((s: number, c: any) => s + Number(c.cost || 0), 0);
      callTotals = { count: calls.length, cost, sell: cost * (1 + markupPct / 100) };
    }
  } catch { /* call_records not migrated yet */ }

  // Last call-backfill result (for the Itemized Calls panel).
  let callBackfill: any = null;
  try { const raw = await getSetting('dws', 'backfill_status'); if (raw) callBackfill = JSON.parse(raw); } catch { /* ignore */ }

  // Comms reconciliation — CLIs/refs supplied by Giacom but not yet allocated to a customer.
  let unmatchedClis: any[] = [];
  try { unmatchedClis = await unallocatedClis(); } catch { /* comms not imported yet */ }

  // ── Bouncebacks: allocated lines that fell out of the latest import for their
  // source (service ceased) → stop billing the customer.
  let bouncebacks: any[] = [];
  try {
    bouncebacks = (await pool.query(
      `WITH last AS (SELECT source, MAX(synced_at) AS last_sync FROM service_items GROUP BY source)
       SELECT si.id, si.source, si.description, si.product_reference, si.quantity, si.total_cost,
              si.synced_at, si.billing_to, c.id AS customer_id, c.name AS customer_name
         FROM service_items si JOIN last l ON l.source = si.source
         LEFT JOIN customers c ON c.id = si.customer_id
        WHERE si.customer_id IS NOT NULL AND si.synced_at < l.last_sync - INTERVAL '1 day'
        ORDER BY c.name, si.source, si.description`
    )).rows;
  } catch { /* service_items not migrated yet */ }

  // ── Invoice bouncebacks: supplier-derived lines you're billing on a RECURRING
  // contract template that have no matching live service_item for that customer+source
  // (billing for something not in the latest import). Matches giacom/lumen lines by
  // description; calls lines are usage-based so excluded.
  let invoiceBouncebacks: any[] = [];
  try {
    invoiceBouncebacks = (await pool.query(
      `WITH last AS (SELECT source, MAX(synced_at) AS last_sync FROM service_items GROUP BY source),
            live AS (
              SELECT si.customer_id, si.source, lower(trim(si.description)) AS d
                FROM service_items si JOIN last l ON l.source = si.source
               WHERE si.customer_id IS NOT NULL AND si.synced_at >= l.last_sync - INTERVAL '1 day'
            )
       SELECT i.id AS invoice_id, i.invoice_number, i.contract_type, i.customer_id, c.name AS customer_name,
              ii.id AS item_id, ii.description, ii.line_total, ii.source
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id AND i.deleted_at IS NULL AND i.is_recurring = true
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE ii.source IN ('giacom','lumen','comms')
          AND NOT EXISTS (
            SELECT 1 FROM live lv
             WHERE lv.customer_id = i.customer_id AND lv.source = ii.source
               AND lv.d = lower(trim(ii.description))
          )
        ORDER BY c.name, i.invoice_number, ii.description`
    )).rows;
  } catch { /* invoice_items.source / is_recurring may not exist until deploy */ }

  // Deleted (suppressed) accounts — kept so they can be restored. Flag any that have
  // resurfaced (an import re-created them because a cost reappeared).
  const liveKeys = new Set(accountsAll.map((a: any) => ignoreKey(a.source, a.gid)));
  const deletedAccounts = Array.from(suppressed).map((k) => {
    const [source, gid] = k.split('|');
    return { key: k, source, gid, resurfaced: liveKeys.has(k) };
  });

  // Recurring invoice templates (managed here; reviewed on the 20th, auto-run on send day).
  let recurringTemplates: any[] = [];
  try {
    recurringTemplates = (await pool.query(
      `SELECT i.id, i.invoice_number, i.title, i.total, i.send_day, i.due_day, i.auto_send, i.auto_qb, i.auto_gc,
              i.recurring_active, i.contract_type, i.last_generated_at, c.name AS customer_name
         FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id
        WHERE i.is_recurring=true AND i.deleted_at IS NULL ORDER BY i.recurring_active DESC, c.name, i.invoice_number`
    )).rows;
  } catch { /* columns may not exist until deploy */ }

  res.render('bureau', {
    user: req.session.user!, accounts, ignoredAccounts, items, customers, counts,
    periods, selCustomer, selPeriod, calls, callTotals, markupPct, bouncebacks, invoiceBouncebacks,
    deletedAccounts, recurringTemplates, callBackfill, unmatchedClis,
    commsCliCount: (unmatchedClis || []).length, cloudAcctCount: (accounts || []).filter((a: any) => a.source === 'giacom').length,
    notice: req.query.msg || null,
  });
});

// Delete an ignored account: remove its unallocated lines and suppress it so imports
// don't re-create it — unless a real cost reappears (then it resurfaces for attention).
router.post('/bureau/delete', async (req: Request, res: Response) => {
  const source = (req.body.source || '').trim();
  const gid = (req.body.gid || '').trim();
  if (source && gid) {
    const r = await pool.query(
      'DELETE FROM service_items WHERE customer_id IS NULL AND source=$1 AND external_customer_id=$2',
      [source, gid]
    );
    const ign = new Set(((await getSetting('bureau', 'ignored')) || '').split(',').map((s) => s.trim()).filter(Boolean));
    ign.delete(ignoreKey(source, gid));
    await setSetting('bureau', 'ignored', Array.from(ign).join(','));
    const sup = new Set(((await getSetting('bureau', 'suppressed')) || '').split(',').map((s) => s.trim()).filter(Boolean));
    sup.add(ignoreKey(source, gid));
    await setSetting('bureau', 'suppressed', Array.from(sup).join(','));
    await logActivity(req.session.user!.id, 'deleted', 'service_items', null, `Bureau: deleted account ${source}/${gid} (${r.rowCount} lines) — suppressed`);
  }
  res.redirect('/bureau?msg=' + encodeURIComponent('Account deleted'));
});

// Restore a deleted account: lift suppression so the next import brings it back.
router.post('/bureau/restore', async (req: Request, res: Response) => {
  const key = (req.body.key || '').trim();
  const sup = new Set(((await getSetting('bureau', 'suppressed')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  sup.delete(key);
  await setSetting('bureau', 'suppressed', Array.from(sup).join(','));
  res.redirect('/bureau?msg=' + encodeURIComponent('Account restored — will return on next import'));
});

// Stop billing a line (cancelled service) — removes it from the customer.
router.post('/bureau/item/:id/stop', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await recycleCommsLine(id, 'Stopped billing (bounceback)', req.session.user!.id);
  res.redirect('/bureau?msg=' + encodeURIComponent('Billing stopped — line moved to recycle bin') + '#bouncebacks');
});

// Ignore / un-ignore an account (kept out of the to-do list but still shown if it
// reappears in imports, with a "live" flag).
router.post('/bureau/ignore', async (req: Request, res: Response) => {
  const key = ignoreKey((req.body.source || '').trim(), (req.body.gid || '').trim());
  const set = new Set(((await getSetting('bureau', 'ignored')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  set.add(key);
  await setSetting('bureau', 'ignored', Array.from(set).join(','));
  res.redirect('/bureau?msg=' + encodeURIComponent('Account ignored'));
});
router.post('/bureau/unignore', async (req: Request, res: Response) => {
  const key = ignoreKey((req.body.source || '').trim(), (req.body.gid || '').trim());
  const set = new Set(((await getSetting('bureau', 'ignored')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  set.delete(key);
  await setSetting('bureau', 'ignored', Array.from(set).join(','));
  res.redirect('/bureau?msg=' + encodeURIComponent('Account restored'));
});

// Allocate a whole supplier account → customer (sets all its lines + records the mapping).
router.post('/bureau/allocate', async (req: Request, res: Response) => {
  const source = ((req.body.source || '').trim()) || 'giacom';
  const gid = (req.body.gid || '').trim();
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  if (gid && customerId) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,$2,$3)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [customerId, source, gid]
    );
    const r = await pool.query("UPDATE service_items SET customer_id=$1 WHERE customer_id IS NULL AND source=$2 AND external_customer_id=$3", [customerId, source, gid]);
    await logActivity(req.session.user!.id, 'updated', 'customers', customerId, `Bureau: allocated ${r.rowCount} ${source} lines (${gid})`);
  }
  res.redirect('/bureau?msg=' + encodeURIComponent('Account allocated'));
});

// Allocate a CLI/ref → customer: writes the CLI directory and re-resolves every comms line
// and call carrying that CLI (now and future imports). The CLI is the single owner key.
router.post('/bureau/cli/allocate', async (req: Request, res: Response) => {
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  const start = String(req.body.billing_start || '').trim() || null; // YYYY-MM-DD — billing starts here
  const location = String(req.body.location || '').trim() || null;    // optional site/office label
  if (cli && customerId) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id, billing_start) VALUES ($1,'cli',$2,$3)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id, billing_start=COALESCE(EXCLUDED.billing_start, customer_external_ids.billing_start)`,
      [customerId, cli, start]
    );
    const s = await pool.query("UPDATE service_items SET customer_id=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2", [customerId, cli]);
    if (location) await pool.query("UPDATE service_items SET location=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2", [location, cli]);
    try { await pool.query("UPDATE call_records SET customer_id=$1 WHERE replace(cli,' ','')=$2", [customerId, cli]); } catch { /* ignore */ }
    await logActivity(req.session.user!.id, 'updated', 'customers', customerId, `Bureau: allocated CLI ${cli} (${s.rowCount} line(s))${start ? ', billing from ' + start : ''}${location ? ', location ' + location : ''}`);
  }
  const back = String(req.body.back || '/bureau/bill-run');
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=' + encodeURIComponent('CLI ' + cli + ' allocated'));
});

// Bulk-allocate many CLIs to one customer — either an explicit list (checkboxes) or a NUMBER
// RANGE (from–to). For a range, every comms CLI whose digits fall in [from,to] is allocated
// (handles DDI blocks in one go). Re-points comms lines + call records + the CLI directory.
router.post('/bureau/cli/bulk-allocate', async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  const back = String(req.body.back || '/bureau/bill-run');
  const sep = back.indexOf('?') >= 0 ? '&' : '?';
  if (!customerId) { res.redirect(back + sep + 'err=' + encodeURIComponent('Choose a customer first')); return; }
  const from = String(req.body.from || '').replace(/[^0-9]/g, '');
  const to = String(req.body.to || '').replace(/[^0-9]/g, '');
  let clis: string[] = [];
  if (from && to) {
    const lo = from <= to ? from : to; const hi = from <= to ? to : from;
    clis = (await pool.query(
      `SELECT DISTINCT product_reference AS cli FROM service_items
        WHERE source='comms' AND product_reference IS NOT NULL
          AND regexp_replace(product_reference,'[^0-9]','','g') <> ''
          AND length(regexp_replace(product_reference,'[^0-9]','','g')) <= 15
          AND regexp_replace(product_reference,'[^0-9]','','g')::bigint BETWEEN $1::bigint AND $2::bigint`,
      [lo, hi]
    )).rows.map((r: any) => String(r.cli));
    // Claim ALL call traffic in the range too (per-DDI numbers with calls but no billing line).
    try {
      await pool.query(
        `UPDATE call_records SET customer_id=$1
          WHERE cli IS NOT NULL AND regexp_replace(cli,'[^0-9]','','g') <> ''
            AND length(regexp_replace(cli,'[^0-9]','','g')) <= 15
            AND regexp_replace(cli,'[^0-9]','','g')::bigint BETWEEN $2::bigint AND $3::bigint`,
        [customerId, lo, hi]
      );
    } catch { /* ignore */ }
  } else {
    const raw = (req.body as any).clis;
    clis = Array.isArray(raw) ? raw.map(String) : (raw ? [String(raw)] : []);
  }
  let n = 0;
  for (const cliRaw of clis) {
    const cli = String(cliRaw).replace(/\s+/g, '');
    if (!cli) continue;
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [customerId, cli]
    );
    await pool.query("UPDATE service_items SET customer_id=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2", [customerId, cli]);
    try { await pool.query("UPDATE call_records SET customer_id=$1 WHERE replace(cli,' ','')=$2", [customerId, cli]); } catch { /* ignore */ }
    n++;
  }
  await logActivity(req.session.user!.id, 'updated', 'customers', customerId, `Bureau: bulk-allocated ${n} CLI(s)`);
  res.redirect(back + sep + 'msg=' + encodeURIComponent(`Allocated ${n} CLI(s) to customer`));
});

// Drop a CLI's allocation — unallocate it so it returns to the unallocated list (Stage 1).
// Use when a CLI has been allocated to the wrong customer. Redirects back to the bill run.
router.post('/bureau/cli/release', async (req: Request, res: Response) => {
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  const back = String(req.body.back || '/bureau/bill-run');
  if (cli) {
    await pool.query("DELETE FROM customer_external_ids WHERE source_system='cli' AND replace(external_id,' ','')=$1", [cli]);
    const s = await pool.query("UPDATE service_items SET customer_id=NULL WHERE source='comms' AND replace(product_reference,' ','')=$1", [cli]);
    try { await pool.query("UPDATE call_records SET customer_id=NULL WHERE replace(cli,' ','')=$1", [cli]); } catch { /* ignore */ }
    await logActivity(req.session.user!.id, 'updated', 'customers', 0, `Bureau: dropped allocation of CLI ${cli} (${s.rowCount} line(s)) — now unallocated`);
  }
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: !!cli, cli }); return; }
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=' + encodeURIComponent('CLI ' + cli + ' dropped — re-allocate it in stage 1'));
});

// Suppress a CLI (e.g. an asset for a customer that went under): drops it off the Stage-1
// "to allocate" list and keeps it off across future imports. Reversible via unsuppress.
router.post('/bureau/cli/suppress', async (req: Request, res: Response) => {
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  if (cli) {
    const set = new Set(((await getSetting('bureau', 'comms_suppressed_clis')) || '').split(',').map((s) => s.trim()).filter(Boolean));
    set.add(cli);
    await setSetting('bureau', 'comms_suppressed_clis', Array.from(set).join(','));
    await logActivity(req.session.user!.id, 'updated', 'customers', 0, `Bureau: suppressed CLI ${cli} (dead asset — hidden from bill run)`);
  }
  res.redirect('/bureau/bill-run?msg=' + encodeURIComponent('CLI ' + cli + ' suppressed'));
});
router.post('/bureau/cli/unsuppress', async (req: Request, res: Response) => {
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  if (cli) {
    const set = new Set(((await getSetting('bureau', 'comms_suppressed_clis')) || '').split(',').map((s) => s.trim()).filter(Boolean));
    set.delete(cli);
    await setSetting('bureau', 'comms_suppressed_clis', Array.from(set).join(','));
    await logActivity(req.session.user!.id, 'updated', 'customers', 0, `Bureau: restored suppressed CLI ${cli}`);
  }
  res.redirect('/bureau/bill-run?msg=' + encodeURIComponent('CLI ' + cli + ' restored'));
});

// Allocate a single line → customer.
router.post('/bureau/item/:id/allocate', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  if (id && customerId) await pool.query("UPDATE service_items SET customer_id=$1 WHERE id=$2", [customerId, id]);
  res.redirect('/bureau?msg=' + encodeURIComponent('Line allocated'));
});

// Set the sell price on a line (the "sales price" the bureau used to fill in).
router.post('/bureau/item/:id/price', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const price = parseFloat(String(req.body.price || '').replace(/[^0-9.\-]/g, ''));
  if (id && !isNaN(price)) await pool.query("UPDATE service_items SET total_cost=$1 WHERE id=$2", [price, id]);
  res.redirect('/bureau?msg=' + encodeURIComponent('Price updated'));
});

// ── Backfill the full call history from DWS (runs in the background) ──────────────
let _callBackfillRunning = false;
router.post('/bureau/calls/backfill', async (req: Request, res: Response) => {
  if (_callBackfillRunning) { res.redirect('/bureau?err=' + encodeURIComponent('A call backfill is already running.') + '#calls'); return; }
  _callBackfillRunning = true;
  await setSetting('dws', 'backfill_status', JSON.stringify({ running: true, startedAt: new Date().toISOString() }));
  // Fire and forget — walking the whole SFTP tree can take a while.
  (async () => {
    try {
      const r = await backfillDwsCalls();
      await setSetting('dws', 'backfill_status', JSON.stringify({ running: false, finishedAt: new Date().toISOString(), ...r }));
    } catch (e: any) {
      await setSetting('dws', 'backfill_status', JSON.stringify({ running: false, finishedAt: new Date().toISOString(), error: e.message }));
    } finally { _callBackfillRunning = false; }
  })();
  await logActivity(req.session.user!.id, 'updated', 'service_items', null, 'Bureau: started full call backfill');
  res.redirect('/bureau?msg=' + encodeURIComponent('Call backfill started — pulling the full history from DWS. Refresh in a minute.') + '#calls');
});

// ── Pricing & profit: durable sale prices on mapped supplier services ────────────
// Each row = a distinct (customer, product, BUY PRICE) — same product at a different buy
// price is its own line. Shows buy/sale/profit/qty, an inline "new sale price", a profit
// report and a needs-attention queue (uncosted = no durable sale price yet).
router.get('/bureau/pricing', async (req: Request, res: Response) => {
  const source = String(req.query.source || '').trim(); // '' | giacom | lumen | comms
  const lines = await pricedServiceLines({ sources: source ? [source] : undefined });
  res.render('bureau-pricing', {
    user: req.session.user!, lines, source,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── Comms Bill Run — the staged monthly cockpit (start the 20th). One screen, four stages:
// 1 Allocate CLIs · 2 Cost services · 3 Review invoices (by category) · 4 Complete (close period).
// ?period=YYYY-MM views a CLOSED period READ-ONLY: the review numbers render for that month but
// every action (allocate / price / complete) is hidden and the POST routes refuse it anyway.
router.get('/bureau/bill-run', async (req: Request, res: Response) => {
  const current = await currentCommsPeriod();
  const periods = await commsPeriods();
  const reqPeriod = String(req.query.period || '').trim();
  const period = /^\d{4}-\d{2}$/.test(reqPeriod) ? reqPeriod : current;
  const readOnly = !!(period && current && period !== current);
  // Stage 1 — CLIs discovered by import with no customer yet. (Open period only — a closed
  // month is history; its allocation/pricing work is done and must not be re-editable.)
  const clis = readOnly ? [] : await unallocatedClis();
  // PROTECTION — CLIs that fall through the unallocated net: deleted owner, or live in call
  // records with no billed line. Surfaced so every CLI is accounted for before completing.
  let unaccounted: any[] = [];
  if (!readOnly) { try { unaccounted = await unaccountedClis(); } catch { /* call_records/service_items not ready */ } }
  // Suppressed CLIs (dead assets) — shown in a collapsed list with a Restore button.
  const suppSet = readOnly ? new Set<string>() : await suppressedClis();
  let suppressed: any[] = [];
  if (suppSet.size) {
    suppressed = (await pool.query(
      `SELECT product_reference AS cli, array_agg(DISTINCT description) AS services, SUM(total_cost)::numeric AS cost, COUNT(*)::int AS lines
         FROM service_items
        WHERE source='comms' AND is_prorata=false AND product_reference IS NOT NULL AND replace(product_reference,' ','') = ANY($1)
        GROUP BY product_reference ORDER BY product_reference`, [Array.from(suppSet)]
    )).rows.map((r: any) => ({ cli: r.cli, services: (r.services || []).filter(Boolean), cost: Number(r.cost) || 0, lines: Number(r.lines) || 0 }));
  }
  // Stage 2 — ONE row per allocated CLI that needs a decision: a package was detected (confirm it)
  // or its line(s) have no price yet. CLIs already confirmed (have a package override) drop off.
  const priced = await pricedServiceLines({ sources: ['comms'] });
  // A line only counts as "needs pricing" if it actually has a cost — £0 lines (Webex, care)
  // don't need a sale price and shouldn't keep a CLI on the review list.
  const unpricedClis = new Set(priced.filter((l) => l.sale_price === null && l.product_reference && Number(l.unit_cost) > 0).map((l) => String(l.product_reference).replace(/\s+/g, '')));
  const confirmed = new Set((await pool.query("SELECT replace(cli,' ','') AS cli FROM package_cli_overrides")).rows.map((r: any) => r.cli));
  const allPkgs = (await pool.query("SELECT id, name, standard_price FROM packages WHERE is_active=true ORDER BY sort_order, name")).rows;
  const pkgStd = new Map<number, number>(); allPkgs.forEach((p: any) => pkgStd.set(p.id, Number(p.standard_price) || 0));
  const pkgOverride = new Map<string, number>();
  (await pool.query('SELECT package_id, customer_id, sale_price FROM package_prices')).rows
    .forEach((r: any) => pkgOverride.set(r.customer_id + ':' + r.package_id, Number(r.sale_price)));
  const cliRows = (period && !readOnly) ? (await pool.query(
    `SELECT si.customer_id AS cid, c.name AS customer, si.product_reference AS cli,
            array_agg(DISTINCT si.description) AS descs,
            COALESCE(SUM(si.total_cost) FILTER (WHERE si.description !~* 'voice recording|call recording'),0)::numeric AS cost,
            COALESCE(SUM(si.quantity) FILTER (WHERE si.description !~* 'voice recording|call recording'),0)::numeric AS units,
            MAX(si.unit_cost) AS unit_cost,
            (SELECT MIN(s2.billing_from) FROM service_items s2 WHERE s2.source='comms' AND s2.customer_id=si.customer_id AND s2.product_reference=si.product_reference) AS service_from,
            (SELECT bool_or(s2.is_prorata) FROM service_items s2 WHERE s2.source='comms' AND s2.customer_id=si.customer_id AND s2.product_reference=si.product_reference) AS has_prorata
       FROM service_items si JOIN customers c ON c.id=si.customer_id
      WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.is_prorata=false AND si.billing_period=$1 AND si.product_reference IS NOT NULL
      GROUP BY si.customer_id, c.name, si.product_reference ORDER BY c.name, si.product_reference`, [period]
  )).rows : [];
  const uncosted: any[] = [];
  for (const r of cliRows) {
    const cli = String(r.cli).replace(/\s+/g, '');
    if (confirmed.has(cli)) continue;
    const descs = (r.descs || []).filter(Boolean);
    // Component-only CLIs (a handset/Webex on its own device ID) are included in the package —
    // nothing to price or confirm here, so skip them.
    if (descs.length && descs.every((d: string) => COMPONENT_RE.test(d))) continue;
    const detected = await detectPackage(descs);
    const isUnpriced = unpricedClis.has(cli);
    if (!detected && !isUnpriced) continue; // already resolved (priced, no package needed)
    const detPrice = detected ? (pkgOverride.get(r.cid + ':' + detected.id) ?? pkgStd.get(detected.id) ?? 0) : null;
    if (detected) {
      // A detected seat package bills as ONE confirmable line.
      // Strip recording from the seat's product text — it bills as its own line below.
      const prodDisplay = (r.descs || []).filter(Boolean).filter((d: string) => !/voice recording|call recording/i.test(d));
      uncosted.push({
        customer_id: r.cid, customer_name: r.customer, cli: r.cli, products: prodDisplay.join(', '),
        cost: Number(r.cost) || 0, units: Number(r.units) || 0, unit_cost: Number(r.unit_cost) || 0, detected, detectedPrice: detPrice,
        service_from: r.service_from ? new Date(r.service_from).toISOString().slice(0, 10) : null,
        has_prorata: !!r.has_prorata,
      });
    } else {
      // No seat package — the reference carries standalone products (e.g. iCS Report analytics seats:
      // Console/Monitored/Supervisor sharing one iCS account ref, each with its own buy price). Price
      // each distinct product (description + buy price) on its own row so they bill separately. The
      // sell price keys on (reference + unit_cost), which the rate card already bills line-by-line.
      const lines = (await pool.query(
        `SELECT si.description, si.unit_cost, SUM(si.total_cost)::numeric AS cost,
                COALESCE(SUM(si.quantity),0)::numeric AS units, sp.sale_price
           FROM service_items si
           LEFT JOIN service_pricing sp ON sp.source='comms' AND sp.customer_id=si.customer_id
                 AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
          WHERE si.source='comms' AND si.customer_id=$1 AND replace(si.product_reference,' ','')=$2
            AND si.billing_period=$3 AND si.is_prorata=false
            AND si.description !~* 'voice recording|call recording' AND si.total_cost <> 0
          GROUP BY si.description, si.unit_cost, sp.sale_price ORDER BY si.description`,
        [r.cid, cli, period]
      )).rows;
      for (const ln of lines) {
        if (ln.sale_price !== null && ln.sale_price !== undefined) continue; // already priced — drop off
        uncosted.push({
          customer_id: r.cid, customer_name: r.customer, cli: r.cli, products: ln.description || '(service)',
          cost: Number(ln.cost) || 0, units: Number(ln.units) || 0, unit_cost: Number(ln.unit_cost) || 0, detected: null, detectedPrice: null,
          service_from: r.service_from ? new Date(r.service_from).toISOString().slice(0, 10) : null,
          has_prorata: !!r.has_prorata,
        });
      }
    }
  }
  // Call Recording is a SEPARATE billable add-on that lives on the seat's CLI, so it needs its own
  // priceable row here. One row per customer that has recording users (priced via the 'REC' key).
  if (period && !readOnly) {
    const recStd = Number(await getSetting('comms', 'call_recording_price')) || 3.0;
    const recOv = new Map<number, number>();
    (await pool.query("SELECT customer_id, sale_price FROM service_pricing WHERE source='comms' AND product_reference='REC'")).rows
      .forEach((r: any) => recOv.set(r.customer_id, Number(r.sale_price)));
    // One recording row PER CLI (CLI replicated — these are services), priced via the per-customer
    // REC key. Cost = that CLI's recording line; sell = the customer's recording price.
    const recRows = (await pool.query(
      `SELECT si.customer_id AS cid, c.name AS customer, si.product_reference AS cli, SUM(si.total_cost)::numeric AS cost, COALESCE(SUM(si.quantity),0)::numeric AS units
         FROM service_items si JOIN customers c ON c.id=si.customer_id
        WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.is_prorata=false AND si.billing_period=$1 AND si.description ~* 'voice recording|call recording'
        GROUP BY si.customer_id, c.name, si.product_reference ORDER BY c.name, si.product_reference`, [period]
    )).rows;
    for (const r of recRows) {
      if (recOv.has(r.cid)) continue; // recording price already set for this customer → don't keep nagging
      uncosted.push({
        customer_id: r.cid, customer_name: r.customer, cli: r.cli, priceRef: 'REC', products: 'Voice Recording',
        cost: Number(r.cost) || 0, units: Number(r.units) || 0, unit_cost: 0, detected: null,
        currentPrice: recStd, isAddon: true,
      });
    }
  }
  // Stage 3 — per-customer draft, grouped into the six invoice categories.
  const custRows = period ? (await pool.query(
    `SELECT DISTINCT si.customer_id AS id, c.name
       FROM service_items si JOIN customers c ON c.id=si.customer_id
      WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.is_prorata=false AND si.billing_period=$1
      ORDER BY c.name`, [period]
  )).rows : [];
  const review: any[] = [];
  for (const cu of custRows) {
    const rc = await commsRateCard(cu.id, period || undefined);
    // Fold call charges into the 'call' category + totals so the review matches the invoice.
    const cc = await commsCallCharge(cu.id, period || undefined);
    if (cc.sell > 0 && rc.byCategory.call) {
      rc.byCategory.call.count += cc.calls; rc.byCategory.call.cost += cc.cost; rc.byCategory.call.sale += cc.sell; rc.byCategory.call.profit += (cc.sell - cc.cost);
      rc.totals.cost += cc.cost; rc.totals.sale += cc.sell; rc.totals.profit += (cc.sell - cc.cost);
    }
    review.push({ id: cu.id, name: cu.name, byCategory: rc.byCategory, totals: rc.totals, hasUnpriced: rc.lines.some((l) => l.sale === null) });
  }
  const grand = { cost: 0, sale: 0, profit: 0 };
  review.forEach((r) => { grand.cost += r.totals.cost; grand.sale += r.totals.sale; grand.profit += r.totals.profit; });
  // Last month's bills per customer, from the PREVIOUS period's CS INVOICES (durable — works
  // even for months whose feed lines are gone). Powers the "compare to last month" tick on the
  // review stage: per-category billed £ + up/down % under every column.
  const prevPeriod = period ? prevCommsPeriod(period) : null;
  const lastMonth: Record<string, { name: string; byCat: Record<string, number>; total: number }> = {};
  if (prevPeriod) {
    (await pool.query(
      `SELECT i.customer_id AS cid, c.name, COALESCE(ii.invoice_category,'additional') AS cat, SUM(ii.line_total)::numeric AS sale
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id JOIN customers c ON c.id=i.customer_id
        WHERE i.invoice_scheme='CS' AND i.billing_period=$1 AND i.deleted_at IS NULL
        GROUP BY 1,2,3`, [prevPeriod]
    )).rows.forEach((r: any) => {
      const m = lastMonth[r.cid] || (lastMonth[r.cid] = { name: r.name, byCat: {}, total: 0 });
      m.byCat[r.cat] = (m.byCat[r.cat] || 0) + (Number(r.sale) || 0);
      m.total += Number(r.sale) || 0;
    });
  }
  // The period's produced invoices — for a CLOSED period this is the record (the snapshot
  // import wipes past service lines, so the live review above may be empty for old months).
  const periodInvoices = period ? (await pool.query(
    `SELECT i.id, i.invoice_number, i.title, i.total, i.status, i.payment_status, i.emailed_at, i.due_date, c.name AS customer
       FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.invoice_scheme='CS' AND i.billing_period=$1 AND i.deleted_at IS NULL
      ORDER BY c.name`, [period]
  )).rows : [];
  // Is this month billing from PROJECTED lines (rolled forward, awaiting the supplier file)?
  let projected = false;
  if (period) {
    try {
      projected = ((await pool.query(
        "SELECT 1 FROM service_items WHERE source='comms' AND billing_period=$1 AND COALESCE(is_projected,false)=true LIMIT 1", [period]
      )).rows.length > 0);
    } catch { /* column lands with the deploy migration */ }
  }
  res.render('bureau-bill-run', {
    user: req.session.user!, period, current, periods, readOnly, periodInvoices, projected, prevPeriod, lastMonth, cats: COMMS_CATS, allPkgs,
    clis, suppressed, unaccounted, uncosted, customers: (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY name")).rows,
    review, grand, notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── Asset List — every comms asset (CLI/circuit) and the products on it. Search, drill into a
// CLI, edit/delete/cost-override lines, add manual (non-Giacom) services, and a duplicate finder.
router.get('/bureau/assets', async (req: Request, res: Response) => {
  const rows = (await pool.query(
    `SELECT si.id, si.source, si.product_reference AS cli, si.customer_id, c.name AS customer, si.description,
            si.quantity, si.unit_cost, si.total_cost, si.billing_period, si.billing_from, si.billing_to,
            si.is_manual, si.is_one_off, si.is_prorata, si.location, si.vat_status, si.billed_at,
            sp.sale_price
       FROM service_items si
       LEFT JOIN customers c ON c.id=si.customer_id
       LEFT JOIN service_pricing sp ON sp.source=si.source AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.source='comms'
      ORDER BY si.product_reference, si.description`
  )).rows;
  // Group by source + CLI/ref (cloud lines may have no CLI — key on description then).
  const map = new Map<string, any>();
  let totCost = 0, totSale = 0, totProfit = 0;
  for (const r of rows) {
    const domain = r.source === 'giacom' ? 'cloud' : 'comms';
    const ref = String(r.cli || r.description || '(none)');
    const key = domain + '|' + ref;
    if (!map.has(key)) map.set(key, { cli: ref, domain, type: domain === 'cloud' ? 'cloud' : cliType(ref), customer_id: r.customer_id, customer: r.customer, manual: false, lines: [], cost: 0, sale: 0, allocated: !!r.customer_id });
    const g = map.get(key);
    const cost = Number(r.total_cost) || 0; const qty = Number(r.quantity) || 0;
    const sale = r.sale_price == null ? null : Number(r.sale_price) * qty;
    r._lineCost = cost; r._lineSale = sale; r._lineProfit = sale == null ? null : sale - cost;
    g.lines.push(r); g.cost += cost; if (sale != null) g.sale += sale; if (r.is_manual) g.manual = true;
    if (!g.customer && r.customer) { g.customer = r.customer; g.customer_id = r.customer_id; }
    totCost += cost; if (sale != null) { totSale += sale; totProfit += sale - cost; }
  }
  const clis = Array.from(map.values()).map((g: any) => { g.profit = g.sale - g.cost; return g; });
  // Duplicate finder: same CLI + description + period appearing more than once.
  const seen = new Map<string, any[]>();
  for (const r of rows) { const k = (r.cli || '') + '|' + (r.description || '') + '|' + (r.billing_period || ''); if (!seen.has(k)) seen.set(k, []); seen.get(k)!.push(r); }
  const duplicates = Array.from(seen.values()).filter((a) => a.length > 1).map((a) => ({ cli: a[0].cli, description: a[0].description, period: a[0].billing_period, count: a.length, ids: a.map((x) => x.id) }));
  // CLIs on more than one customer (mis-allocation).
  const custByCli = new Map<string, Set<string>>();
  for (const r of rows) { if (!r.customer) continue; const k = String(r.cli); if (!custByCli.has(k)) custByCli.set(k, new Set()); custByCli.get(k)!.add(r.customer); }
  const conflicts = Array.from(custByCli.entries()).filter(([, s]) => s.size > 1).map(([cli, s]) => ({ cli, customers: Array.from(s) }));
  // Handset register — physical devices keyed on their MAC/ID (product_reference), with the
  // customer they're registered to. Deduped to one row per device.
  const hsMap = new Map<string, any>();
  for (const r of rows) {
    if (!HANDSET_RE.test(String(r.description || ''))) continue;
    const mac = String(r.cli || '');
    if (!hsMap.has(mac)) hsMap.set(mac, { mac, model: r.description, customer: r.customer, customer_id: r.customer_id, location: r.location });
  }
  const handsets = Array.from(hsMap.values());
  res.render('bureau-assets', {
    user: req.session.user!, clis, duplicates, conflicts, handsets,
    totals: { cost: totCost, sale: totSale, profit: totProfit },
    customers: (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY name")).rows,
    period: await currentCommsPeriod(), notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Refresh CLI extension-name labels from Insights now (also runs nightly at 04:30).
router.post('/bureau/ext-labels/refresh', async (_req: Request, res: Response) => {
  const r = await labelClisFromInsights();
  res.redirect('/bureau/assets?msg=' + encodeURIComponent(`Extension names refreshed — ${r.labelled} CLI(s) labelled from Insights.`));
});

// IT & Cloud bill-run cockpit — customers with IT contracts and/or Giacom cloud, each customer's
// consolidated total + billing-contact status, and a Generate button.
router.get('/bureau/itcloud', async (req: Request, res: Response) => {
  const period = await itCloudPeriod();
  const custs = (await pool.query(
    `SELECT c.id, c.name FROM customers c
      WHERE c.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM service_items si WHERE si.customer_id=c.id AND si.source='giacom')
        OR EXISTS (SELECT 1 FROM contracts ct WHERE ct.customer_id=c.id AND ct.service_type='IT' AND ct.status='active' AND ct.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM invoices iv WHERE iv.customer_id=c.id AND iv.is_recurring=true AND iv.invoice_scheme IN ('IT','IC') AND iv.deleted_at IS NULL))
      ORDER BY c.name`
  )).rows;
  // Pre-completion audit: which staged invoices have Giacom lines not matching the DB catalogue / QB.
  let auditRows: any[] = [];
  try { auditRows = await itCloudStagedAudit(period); } catch { /* nothing staged yet */ }
  const auditByInv = new Map<number, any>(); for (const a of auditRows) auditByInv.set(a.invoiceId, a);
  const rows: any[] = []; const grand = { it: 0, cloud: 0, sale: 0, cost: 0, net: 0, billed: 0 };
  for (const c of custs) {
    const a = await itCloudAccount(c.id);
    // Hybrid status: does this customer have a template, and a synced invoice for the period?
    const tpl = (await pool.query(
      `SELECT id FROM invoices WHERE customer_id=$1 AND is_recurring=true AND deleted_at IS NULL
         AND invoice_scheme IN ('IT','IC') ORDER BY id DESC LIMIT 1`, [c.id]
    )).rows[0];
    const pinv = period ? (await pool.query(
      "SELECT id, status, synced_at, subtotal, tax_total, total FROM invoices WHERE customer_id=$1 AND invoice_scheme='IC' AND billing_period=$2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [c.id, period]
    )).rows[0] : null;
    // IT Services vs Cloud split from the ACTUAL bill: base/manual lines = IT, giacom = Cloud.
    // Also the PREDICTED next bill = recurring lines only (drop one-offs + part-month catch-ups,
    // which are specific to this period) so a closed run shows what the customer recurs at next time.
    let itSale = 0, cloudSale = 0, predNet = 0, predBilled = 0;
    if (pinv) {
      const sp = (await pool.query(
        `SELECT COALESCE(SUM(line_total) FILTER (WHERE source<>'giacom'),0) AS it,
                COALESCE(SUM(line_total) FILTER (WHERE source='giacom'),0) AS cloud,
                COALESCE(SUM(line_total) FILTER (WHERE COALESCE(is_one_off,false)=false AND description NOT ILIKE '%part-month%'),0) AS rec_net,
                COALESCE(SUM(line_total*tax_rate/100) FILTER (WHERE COALESCE(is_one_off,false)=false AND description NOT ILIKE '%part-month%'),0) AS rec_vat
           FROM invoice_items WHERE invoice_id=$1`, [pinv.id]
      )).rows[0];
      itSale = Number(sp.it) || 0; cloudSale = Number(sp.cloud) || 0;
      predNet = Number(sp.rec_net) || 0;
      predBilled = Math.round((predNet + Number(sp.rec_vat || 0)) * 100) / 100;
    }
    const drift = pinv ? (await pool.query("SELECT COUNT(*)::int n FROM invoice_items WHERE invoice_id=$1 AND sync_drift IS NOT NULL", [pinv.id])).rows[0].n : 0;
    rows.push({
      id: c.id, name: c.name, it: itSale, cloud: cloudSale, sale: a.totals.sale, cost: a.totals.cost,
      hasBillingContact: a.hasBillingContact, unpriced: a.unpriced, unmatched: a.unmatched, giacomLinked: a.giacomLinked,
      templateId: tpl ? tpl.id : null, periodInvoiceId: pinv ? pinv.id : null,
      periodStatus: pinv ? pinv.status : null, syncedAt: pinv ? pinv.synced_at : null, drift,
      net: pinv ? Number(pinv.subtotal) || 0 : null, vat: pinv ? Number(pinv.tax_total) || 0 : null,
      billed: pinv ? Number(pinv.total) || 0 : null,
      predictedNet: pinv ? predNet : null, predictedBilled: pinv ? predBilled : null,
      audit: pinv ? (auditByInv.get(pinv.id) || null) : null,
    });
    grand.it += itSale; grand.cloud += cloudSale; grand.sale += a.totals.sale; grand.cost += a.totals.cost;
    grand.net += pinv ? Number(pinv.subtotal) || 0 : 0;
    grand.billed += pinv ? Number(pinv.total) || 0 : 0;
  }
  // Last month's IC bills (previous period's invoices, templates excluded) — powers the
  // "compare to last month" tick: IT vs Cloud split, net, gross, and customer count.
  const icPrevPeriod = period ? prevCommsPeriod(period) : null;
  const icLastMonth: Record<string, { name: string; it: number; cloud: number; net: number; billed: number }> = {};
  if (icPrevPeriod) {
    (await pool.query(
      `SELECT i.id, i.customer_id AS cid, c.name, i.subtotal, i.total,
              COALESCE(SUM(ii.line_total) FILTER (WHERE ii.source='giacom'),0) AS cloud,
              COALESCE(SUM(ii.line_total) FILTER (WHERE ii.source IS DISTINCT FROM 'giacom'),0) AS it
         FROM invoices i JOIN customers c ON c.id=i.customer_id
         LEFT JOIN invoice_items ii ON ii.invoice_id=i.id
        WHERE i.invoice_scheme='IC' AND i.billing_period=$1 AND i.deleted_at IS NULL
          AND COALESCE(i.is_recurring,false)=false
        GROUP BY i.id, c.name`, [icPrevPeriod]
    )).rows.forEach((r: any) => {
      const m = icLastMonth[r.cid] || (icLastMonth[r.cid] = { name: r.name, it: 0, cloud: 0, net: 0, billed: 0 });
      m.it += Number(r.it) || 0; m.cloud += Number(r.cloud) || 0;
      m.net += Number(r.subtotal) || 0; m.billed += Number(r.total) || 0;
    });
  }
  res.render('bureau-itcloud', { user: req.session.user!, period, rows, grand, audit: auditRows, prevPeriod: icPrevPeriod, lastMonth: icLastMonth, notice: req.query.msg || null, error: req.query.err || null });
});

// Generate the IT & Cloud drafts for the current period (review in Invoices, then Complete & send).
router.post('/bureau/itcloud/generate', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim() || (await itCloudPeriod());
  if (!period) { res.redirect('/bureau/itcloud?err=' + encodeURIComponent('No period.')); return; }
  const r = await generateItCloudBillRun(period, req.session.user!.id);
  const tail = r.blocked.length ? ` ⚠ ${r.blocked.length} blocked (no billing contact): ${r.blocked.slice(0, 5).join(', ')}${r.blocked.length > 5 ? '…' : ''}` : '';
  res.redirect('/bureau/itcloud?' + (r.blocked.length ? 'err' : 'msg') + '=' + encodeURIComponent(`IT & Cloud ${period}: ${r.created} draft invoice(s), ${r.skipped} skipped.${tail}`));
});

// HYBRID Run Sync: for every IT&Cloud customer that has a template (is_recurring IC invoice),
// generate this period's invoice from it (clone base lines) then layer the live Giacom lines on
// top. Idempotent — re-running just re-syncs the existing period invoice.
router.post('/bureau/itcloud/run-sync', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim() || (await itCloudPeriod());
  if (!period) { res.redirect('/bureau/itcloud?err=' + encodeURIComponent('No period.')); return; }
  const onlyId = req.body.customer_id ? parseInt(String(req.body.customer_id), 10) : null;
  const tpls = (await pool.query(
    `SELECT id, customer_id FROM invoices WHERE is_recurring=true AND deleted_at IS NULL
       AND invoice_scheme IN ('IT','IC')
       ${onlyId ? 'AND customer_id=$1' : ''} ORDER BY customer_id`, onlyId ? [onlyId] : []
  )).rows;
  let done = 0, drift = 0; const issues: string[] = [];
  for (const t of tpls) {
    try { const r = await generateItCloudFromTemplate(t.id, period, req.session.user!.id); done++; if (r) { /* count drift below */ } }
    catch (e: any) { issues.push(`cust ${t.customer_id}: ${e.message}`); }
  }
  drift = (await pool.query(
    "SELECT COUNT(*)::int n FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.invoice_scheme='IC' AND i.billing_period=$1 AND i.deleted_at IS NULL AND ii.sync_drift IS NOT NULL", [period]
  )).rows[0].n;
  const tail = (issues.length ? ` · ${issues.length} issue(s)` : '') + (drift ? ` · ⚠ ${drift} line(s) with drift` : '');
  res.redirect('/bureau/itcloud?' + (issues.length ? 'err' : 'msg') + '=' + encodeURIComponent(`Sync ${period}: ${done} customer invoice(s) built from template + Giacom${tail}`));
});

// Complete the IT&Cloud run for the period: allocate real invoice numbers to the staged drafts +
// mark them issued (they move into the Invoices list). Emailing/QB/DD is per-invoice from there.
router.post('/bureau/itcloud/complete', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim() || (await itCloudPeriod());
  if (!period) { res.redirect('/bureau/itcloud?err=' + encodeURIComponent('No period.')); return; }
  const issueDate = String(req.body.issue_date || '').trim() || null;
  const dueDate = String(req.body.due_date || '').trim() || null;
  // Block completion if any staged invoice has Giacom lines that don't match the DB catalogue / QB,
  // unless the user explicitly overrides (confirm box). Those lines wouldn't map to a QB item / report.
  if (String(req.body.override_unmatched || '') !== '1') {
    try {
      const audit = await itCloudStagedAudit(period);
      if (audit.length) {
        const names = audit.map((a) => `${a.name}${a.notInDb.length ? ` (${a.notInDb.length} not in product list)` : ''}${a.noQbItem.length ? ` (${a.noQbItem.length} no QB item)` : ''}`);
        res.redirect('/bureau/itcloud?err=' + encodeURIComponent(`Blocked — ${audit.length} invoice(s) have services not matched to the product list / QuickBooks: ${names.slice(0, 6).join(' · ')}${names.length > 6 ? '…' : ''}. Add them to the product list (with a QB item), or tick "complete anyway".`));
        return;
      }
    } catch { /* audit unavailable — fall through */ }
  }
  try {
    const r = await completeItCloudRun(period, req.session.user!.id, issueDate, dueDate);
    const tail = r.issues.length ? ` ⚠ ${r.issues.length} issue(s): ${r.issues.slice(0, 4).join(' · ')}${r.issues.length > 4 ? '…' : ''}` : '';
    res.redirect('/bureau/itcloud?' + (r.issues.length ? 'err' : 'msg') + '=' + encodeURIComponent(`Run ${period} completed — ${r.numbered} numbered & issued, ${r.sent} emailed/QB/DD.${tail}`));
  } catch (e: any) { res.redirect('/bureau/itcloud?err=' + encodeURIComponent('Complete failed: ' + (e.message || 'error'))); }
});

// ONE-CLICK fix for the cockpit audit flags — action the problem from the row, not a trek to
// the Products page. For the period's staged Giacom lines (one invoice, or all):
//  1) any line whose Giacom code has NO product-list entry → create it (source_tag='giacom',
//     code from sync_ref, name + billed price from the line, cost from the live Giacom feed);
//  2) any matched product still missing its QuickBooks item → create + link the QB Service item
//     (skipped gracefully when QB isn't connected).
// The audit re-runs on redirect, so the flags clear — anything left genuinely needs a human
// (e.g. a line with no Giacom code at all).
router.post('/bureau/itcloud/fix-flags', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim() || (await itCloudPeriod());
  const onlyInv = req.body.invoice_id ? parseInt(String(req.body.invoice_id), 10) : null;
  const lines = (await pool.query(
    `SELECT split_part(COALESCE(ii.sync_ref,''),'|',1) AS code,
            MIN(ii.description) AS description, MAX(ii.unit_price)::numeric AS unit_price,
            MIN(ap.id) AS ap_id
       FROM invoices i
       JOIN invoice_items ii ON ii.invoice_id=i.id AND ii.source='giacom'
       LEFT JOIN asset_products ap ON ap.source_tag='giacom' AND ap.is_active=true
              AND lower(ap.code)=lower(split_part(COALESCE(ii.sync_ref,''),'|',1))
      WHERE i.invoice_scheme='IC' AND COALESCE(i.staged,false)=true AND i.deleted_at IS NULL
        AND i.billing_period=$1 ${onlyInv ? 'AND i.id=$2' : ''}
      GROUP BY 1`, onlyInv ? [period, onlyInv] : [period]
  )).rows;
  let created = 0, noCode = 0; const seen = new Set<string>();
  for (const l of lines) {
    const code = String(l.code || '').trim();
    if (!code) { noCode++; continue; }
    if (l.ap_id != null || seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase());
    const cost = Number((await pool.query(
      "SELECT MAX(unit_cost)::numeric AS c FROM service_items WHERE source='giacom' AND lower(product_id)=lower($1)", [code]
    )).rows[0]?.c) || 0;
    await pool.query(
      `INSERT INTO asset_products (name, code, item_type, billing_frequency, unit_price, cost_price, supplier, source_tag, vat_rate, is_active)
       VALUES ($1,$2,'service','monthly',$3,$4,'Giacom','giacom',20,true)`,
      [String(l.description || code).trim(), code, Number(l.unit_price) || 0, cost]
    );
    created++;
  }
  // QB items for anything giacom-tagged still unmapped (covers the rows just created too).
  let qbLinked = 0; const qbFailed: string[] = [];
  try {
    const qb = await QuickBooks.load();
    if (qb.isConnected()) {
      const accounts = await qb.getIncomeAccounts();
      if (accounts.length) {
        const missing = (await pool.query(
          "SELECT id, name FROM asset_products WHERE source_tag='giacom' AND is_active=true AND quickbooks_item_id IS NULL AND name IS NOT NULL AND name<>'' ORDER BY name"
        )).rows;
        for (const p of missing) {
          try { const qbId = await qb.createItem(p.name, accounts[0].Id); await pool.query('UPDATE asset_products SET quickbooks_item_id=$1 WHERE id=$2', [qbId, p.id]); qbLinked++; }
          catch (e: any) { qbFailed.push(p.name + ' (' + (e.message || 'error').slice(0, 50) + ')'); }
        }
      }
    }
  } catch { /* QB optional — product-list creation alone already clears the hard block */ }
  await logActivity(req.session.user!.id, 'updated', 'customers', 0, `IT&Cloud fix-flags ${period}${onlyInv ? ' (invoice ' + onlyInv + ')' : ''}: ${created} product(s) added, ${qbLinked} QB item(s) linked`);
  const bits = [`${created} product(s) added to the list`, `${qbLinked} QuickBooks item(s) created/linked`];
  if (noCode) bits.push(`${noCode} line(s) have no Giacom code — need a manual look`);
  if (qbFailed.length) bits.push(`QB failed for ${qbFailed.length}: ${qbFailed.slice(0, 3).join(', ')}${qbFailed.length > 3 ? '…' : ''}`);
  res.redirect('/bureau/itcloud?' + ((noCode || qbFailed.length) ? 'err' : 'msg') + '=' + encodeURIComponent('Fix flags — ' + bits.join(' · ')));
});

// IT & Cloud live invoice preview — read-only, recomputed every view. Shows exactly what the
// next consolidated IT & Cloud invoice would contain (IT contract lines + live Giacom cloud
// lines) before anything is generated. Blocked from generation if no billing contact.
router.get('/bureau/itcloud/:id/preview', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/bureau'); return; }
  const cust = (await pool.query('SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!cust) { res.redirect('/bureau?err=' + encodeURIComponent('Customer not found')); return; }
  const account = await itCloudAccount(id);
  res.render('bureau-itcloud-preview', {
    user: req.session.user!, customer: cust, account,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Comms invoice preview — the FULLY BRANDED invoice the customer will receive, built live from
// the rate card (no DB write). Comms-specific layout: account-summary breakdown + per-category
// sections + labels. Hardware (handset/device lines) is never output on invoices.
router.get('/bureau/comms/:id/preview', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/bureau'); return; }
  const period = String(req.query.period || '') || (await currentCommsPeriod()) || undefined;
  const rc = await commsRateCard(id, period);
  const ident = await customerBillingIdentity(id);
  const billable = [...rc.lines, ...rc.oneOffs, ...rc.prorata]
    .filter((l) => l.sale !== null && Number(l.sale) !== 0)
    .filter((l) => !HANDSET_RE.test(String(l.label || ''))); // hardware never appears on invoices
  const sections: any[] = [];
  let sub = 0;
  for (const cat of COMMS_CATS) {
    const lines = billable.filter((l) => l.category === cat.key).map((l) => {
      const qty = l.qty || 1; const lineTotal = Number(l.sale) || 0; const unit = qty ? lineTotal / qty : lineTotal;
      return { description: l.label, ref: l.ref, location: l.location, quantity: qty, unit_price: unit, line_total: lineTotal };
    });
    if (!lines.length) continue;
    const secSub = lines.reduce((a, l) => a + l.line_total, 0);
    sub += secSub;
    sections.push({ label: cat.label, lines, subtotal: secSub });
  }
  // Call charges for the period — per-type markup (chargeable calls only) — as its own category.
  try {
    const cc = await commsCallCharge(id, period || undefined);
    if (cc.sell > 0) {
      sections.push({ label: 'Call Charges', lines: [{ description: 'Call Charges' + (cc.period ? ' — ' + cc.period : '') + ' (prev month)', ref: null, location: null, quantity: 1, unit_price: cc.sell, line_total: cc.sell }], subtotal: cc.sell });
      sub += cc.sell;
    }
  } catch { /* call_records absent */ }
  const summary = sections.map((s) => ({ label: s.label, count: s.lines.length, amount: s.subtotal }));
  const tax = sub * 0.20;
  const due = new Date(); due.setMonth(due.getMonth() + 1); due.setDate(1);
  const invoice = {
    ...ident, is_preview: true, invoice_number: 'PREVIEW', billing_period: period,
    issue_date: due, due_date: due, // comms invoices are dated AND due the 1st of next month
    subtotal: sub.toFixed(2), tax_total: tax.toFixed(2), total: (sub + tax).toFixed(2),
  };
  const html = await renderCommsInvoiceHtml({ invoice, sections, summary });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Per-CLI charges report — ALL charges on one CLI for a period: service/rental lines + itemised
// call charges (classified, with the customer's effective markup). Enter a CLI + period.
router.get('/bureau/cli-report', async (req: Request, res: Response) => {
  const cli = String(req.query.cli || '').replace(/\s+/g, '');
  const period = req.query.period != null ? String(req.query.period) : '';
  if (!cli) { res.render('bureau-cli-report', { user: req.session.user!, cli: '', period, customer: null, periods: [], serviceLines: [], calls: [], byType: [], totals: null }); return; }

  // Resolve the owning customer (directory → service line → call record).
  let customer: any = (await pool.query(
    `SELECT c.id, c.name FROM customer_external_ids e JOIN customers c ON c.id=e.customer_id
      WHERE e.source_system='cli' AND replace(e.external_id,' ','')=$1 AND c.deleted_at IS NULL LIMIT 1`, [cli]
  )).rows[0] || null;
  if (!customer) customer = (await pool.query(
    `SELECT c.id, c.name FROM service_items si JOIN customers c ON c.id=si.customer_id
      WHERE si.source='comms' AND replace(si.product_reference,' ','')=$1 AND c.deleted_at IS NULL LIMIT 1`, [cli]
  )).rows[0] || null;

  const periods = (await pool.query(
    `SELECT DISTINCT billing_period AS p FROM (
        SELECT billing_period FROM service_items WHERE source='comms' AND replace(product_reference,' ','')=$1 AND billing_period IS NOT NULL
        UNION SELECT billing_period FROM call_records WHERE replace(cli,' ','')=$1 AND billing_period IS NOT NULL
     ) x ORDER BY p DESC`, [cli]
  )).rows.map((r: any) => r.p);

  const serviceLines = (await pool.query(
    `SELECT description, quantity, unit_cost, total_cost, billing_period, is_one_off, is_prorata
       FROM service_items WHERE source='comms' AND replace(product_reference,' ','')=$1 AND ($2='' OR billing_period=$2)
      ORDER BY billing_period DESC, description`, [cli, period]
  )).rows;

  const markups = customer ? await getCallMarkups(customer.id) : await getCallMarkups();
  const callRows = (await pool.query(
    `SELECT call_at, dialled, description, duration_sec, cost, source
       FROM call_records WHERE replace(cli,' ','')=$1 AND ($2='' OR billing_period=$2)
      ORDER BY cost DESC, call_at DESC LIMIT 10000`, [cli, period]
  )).rows;
  const typeLabel: Record<string, string> = {}; CALL_TYPES.forEach((t) => { typeLabel[t.key] = t.label; });
  const agg: Record<string, { label: string; calls: number; secs: number; cost: number; sell: number; pct: number }> = {};
  for (const c of callRows) {
    const t = classifyCall(c.description, c.dialled, { cli, source: c.source });
    const cost = Number(c.cost) || 0; const pct = markups.effective[t] || 0;
    const sell = cost > 0 ? cost * (1 + pct / 100) : 0;
    c.call_type_label = typeLabel[t]; c.sell = sell;
    if (!agg[t]) agg[t] = { label: typeLabel[t], calls: 0, secs: 0, cost: 0, sell: 0, pct };
    agg[t].calls++; agg[t].secs += Number(c.duration_sec) || 0; agg[t].cost += cost; agg[t].sell += sell;
  }
  const byType = CALL_TYPES.map((t) => agg[t.key]).filter(Boolean);
  const svcSell = serviceLines.reduce((a: number, l: any) => a + (Number(l.total_cost) || 0), 0); // cost shown; sell handled in pricing
  const callCost = callRows.reduce((a: number, c: any) => a + (Number(c.cost) || 0), 0);
  const callSell = callRows.reduce((a: number, c: any) => a + (Number(c.sell) || 0), 0);
  const totals = { svcCost: svcSell, callCost, callSell, calls: callRows.length };

  res.render('bureau-cli-report', { user: req.session.user!, cli, period, customer, periods, serviceLines, calls: callRows, byType, totals });
});

// One-row-per-CLI register export: every comms CLI asset with its CURRENT allocation, the
// authoritative CLI directory mapping (customer_external_ids), live/suppressed status, line
// count, monthly cost & sale, billing-start date and detected package. Built for offline
// comparison against a supplier feed — spot missing, unallocated or mis-allocated numbers.
router.get('/bureau/assets.csv', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `WITH latest AS (SELECT MAX(synced_at) AS ls FROM service_items WHERE source='comms'),
     agg AS (
       SELECT replace(si.product_reference,' ','') AS cli_key,
              MIN(si.product_reference) AS cli,
              COUNT(*)::int AS lines,
              COUNT(DISTINCT si.customer_id)::int AS cust_count,
              MAX(si.customer_id) AS any_customer_id,
              SUM(si.total_cost)::numeric AS cost,
              BOOL_OR(si.synced_at >= (SELECT ls FROM latest) - INTERVAL '1 day') AS live
         FROM service_items si
        WHERE si.source='comms' AND si.product_reference IS NOT NULL AND COALESCE(si.is_prorata,false)=false
        GROUP BY replace(si.product_reference,' ','')
     ),
     sale AS (
       SELECT replace(si.product_reference,' ','') AS cli_key,
              SUM(COALESCE(sp.sale_price,0)*si.quantity)::numeric AS sale,
              BOOL_AND(sp.sale_price IS NOT NULL) AS fully_priced
         FROM service_items si
         LEFT JOIN service_pricing sp ON sp.source=si.source AND sp.customer_id=si.customer_id
               AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
        WHERE si.source='comms' AND si.product_reference IS NOT NULL AND COALESCE(si.is_prorata,false)=false
        GROUP BY replace(si.product_reference,' ','')
     )
     SELECT a.cli, a.cli_key, a.lines, a.cust_count, a.any_customer_id, a.cost, a.live,
            c.name AS customer, eid.billing_start, ec.name AS directory_customer,
            (eid.customer_id IS NOT NULL) AS in_directory,
            pkg.name AS package, s.sale, s.fully_priced
       FROM agg a
       LEFT JOIN customers c ON c.id = a.any_customer_id
       LEFT JOIN customer_external_ids eid ON eid.source_system='cli' AND replace(eid.external_id,' ','')=a.cli_key
       LEFT JOIN customers ec ON ec.id = eid.customer_id
       LEFT JOIN package_cli_overrides ov ON replace(ov.cli,' ','')=a.cli_key
       LEFT JOIN packages pkg ON pkg.id = ov.package_id
       LEFT JOIN sale s ON s.cli_key = a.cli_key
      ORDER BY (a.any_customer_id IS NULL) DESC, c.name NULLS FIRST, a.cli`
  );
  const suppressed = await suppressedClis();
  const cols = ['cli', 'type', 'allocated', 'customer', 'customer_id', 'multi_customer', 'suppressed',
    'in_directory', 'directory_customer', 'live_in_latest_import', 'lines', 'monthly_cost', 'monthly_sale',
    'fully_priced', 'billing_start', 'package'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const d = (v: any): string => (v ? new Date(v).toISOString().slice(0, 10) : '');
  const out = [cols.join(',')];
  for (const r of rows) {
    const isSup = suppressed.has(String(r.cli_key));
    out.push([
      r.cli, cliType(r.cli), r.any_customer_id ? 'yes' : 'no', r.customer || '', r.any_customer_id || '',
      r.cust_count > 1 ? 'yes' : 'no', isSup ? 'yes' : 'no', r.in_directory ? 'yes' : 'no', r.directory_customer || '',
      r.live ? 'yes' : 'no', r.lines, (Number(r.cost) || 0).toFixed(2), (Number(r.sale) || 0).toFixed(2),
      r.fully_priced ? 'yes' : 'no', d(r.billing_start), r.package || '',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cli_assets_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Edit an asset line (description, qty, cost override, location, dates) + optional sale price.
router.post('/bureau/assets/line/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); const b = req.body;
  if (!id) { res.redirect('/bureau/assets'); return; }
  const num = (v: any): number => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const row = (await pool.query('SELECT customer_id, product_reference, source FROM service_items WHERE id=$1', [id])).rows[0];
  await pool.query(
    `UPDATE service_items SET description=$1, quantity=$2, unit_cost=$3, total_cost=$4, location=$5, vat_status=$6 WHERE id=$7`,
    [(b.description || '').trim(), num(b.quantity) || 1, num(b.unit_cost), num(b.total_cost), (b.location || '').trim() || null, (b.vat_status || '').trim() || null, id]
  );
  // Optional sale price → durable service_pricing for this (customer, product, buy).
  const sale = String(b.sale_price ?? '').trim();
  if (sale !== '' && row && row.customer_id) {
    await setSalePrice({ source: row.source || 'comms', customerId: row.customer_id, productReference: row.product_reference, description: (b.description || '').trim() || null, unitCost: num(b.unit_cost), salePrice: num(sale) });
  }
  await logActivity(req.session.user!.id, 'updated', 'service_items', id, `Asset edited: ${b.description || id}`);
  res.redirect('/bureau/assets?msg=' + encodeURIComponent('Asset updated'));
});

// Recycle a comms service line (never hard-delete) and, for a Giacom-sourced line, suppress its CLI so
// the nightly import won't resurrect it. Returns true if a row was recycled.
async function recycleCommsLine(id: number, reason: string, userId: number): Promise<boolean> {
  const row = (await pool.query('SELECT description, product_reference, source, is_manual FROM service_items WHERE id=$1', [id])).rows[0];
  if (!row) return false;
  await recycleRow('service_items', id, {
    entityType: 'comms_line',
    label: row.product_reference || row.description || 'Comms line',
    sublabel: row.description || null,
    reason, userId,
  });
  if (row.source === 'comms' && !row.is_manual && row.product_reference) {
    const cli = String(row.product_reference).replace(/\s+/g, '');
    const set = new Set(((await getSetting('bureau', 'comms_suppressed_clis')) || '').split(',').map((s) => s.trim()).filter(Boolean));
    set.add(cli);
    await setSetting('bureau', 'comms_suppressed_clis', Array.from(set).join(','));
  }
  await logActivity(userId, 'deleted', 'service_items', id, reason + ' (recycled)');
  return true;
}

router.post('/bureau/assets/line/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await recycleCommsLine(id, 'Asset line deleted', req.session.user!.id);
  res.redirect('/bureau/assets?msg=' + encodeURIComponent('Line moved to recycle bin'));
});

// Add a manual (non-Giacom) service — all the same fields we take from Giacom. is_manual=true so
// it survives the nightly Giacom wipe. Allocates the CLI to the customer too.
router.post('/bureau/assets/add', async (req: Request, res: Response) => {
  const b = req.body;
  const num = (v: any): number => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const cli = String(b.cli || '').replace(/\s+/g, '');
  const customerId = parseInt(String(b.customer_id || ''), 10) || null;
  const desc = (b.description || '').trim();
  if (!cli || !desc) { res.redirect('/bureau/assets?err=' + encodeURIComponent('CLI and description are required.')); return; }
  const from = (b.billing_from || '').trim() || null;
  const to = (b.billing_to || '').trim() || null;
  const period = from ? String(from).slice(0, 7) : (await currentCommsPeriod());
  const qty = num(b.quantity) || 1; const unit = num(b.unit_cost); const total = b.total_cost ? num(b.total_cost) : unit * qty;
  await pool.query(
    `INSERT INTO service_items (source, customer_id, product_reference, description, quantity, unit_cost, total_cost,
        billing_from, billing_to, billing_period, is_prorata, is_manual, location, vat_status, synced_at)
     VALUES ('comms',$1,$2,$3,$4,$5,$6,$7,$8,$9,false,true,$10,$11,NOW())`,
    [customerId, cli, desc, qty, unit, total, from, to, period, (b.location || '').trim() || null, (b.vat_status || '').trim() || 'VAT 20%']
  );
  if (customerId) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [customerId, cli]
    );
  }
  const sale = String(b.sale_price ?? '').trim();
  if (sale !== '' && customerId) await setSalePrice({ source: 'comms', customerId, productReference: cli, description: desc, unitCost: unit, salePrice: num(sale) });
  await logActivity(req.session.user!.id, 'created', 'service_items', null, `Manual asset added: ${cli} ${desc}`);
  res.redirect('/bureau/assets?msg=' + encodeURIComponent('Manual service added for ' + cli));
});

// ── Bureau Reports — profit by customer, profit by product/category, the money-leak
// watchlist (unallocated/uncosted/one-offs), and a link to the CLI/service register.
router.get('/bureau/reports', async (req: Request, res: Response) => {
  const lines = await pricedServiceLines({}); // all sources, with comms sentinel-key resolution
  // Profit by customer.
  const byCust = new Map<string, { name: string; sale: number; cost: number; profit: number; uncosted: number }>();
  // Profit by product/category.
  const byCat = new Map<string, { sale: number; cost: number; profit: number }>();
  const catLabel = (l: any): string => {
    if (l.source === 'giacom') return 'Cloud';
    return ({ internet: 'Internet', voice: 'Voice', mobile: 'Mobile', additional: 'Additional', oneoff: 'One-off', call: 'Call' } as any)[commsCategory(l.description)] || 'Other';
  };
  for (const l of lines) {
    const qty = l.quantity || 0, buy = l.unit_cost || 0;
    const lineCost = buy * qty;
    const lineSale = l.sale_price === null ? null : Number(l.sale_price) * qty;
    const key = String(l.customer_id || '0');
    if (!byCust.has(key)) byCust.set(key, { name: l.customer_name || '—', sale: 0, cost: 0, profit: 0, uncosted: 0 });
    const c = byCust.get(key)!;
    c.cost += lineCost;
    if (lineSale === null) c.uncosted++; else { c.sale += lineSale; c.profit += lineSale - lineCost; }
    const ck = catLabel(l);
    if (!byCat.has(ck)) byCat.set(ck, { sale: 0, cost: 0, profit: 0 });
    const cc = byCat.get(ck)!; cc.cost += lineCost; if (lineSale !== null) { cc.sale += lineSale; cc.profit += lineSale - lineCost; }
  }
  const profitByCustomer = Array.from(byCust.values()).sort((a, b) => b.profit - a.profit);
  const profitByCategory = Array.from(byCat.entries()).map(([label, v]) => ({ label, ...v })).sort((a, b) => b.profit - a.profit);
  // Watchlist.
  const unalloc = await unallocatedClis();
  const uncostedLines = lines.filter((l) => l.sale_price === null);
  const oneOffs = (await pool.query(
    `SELECT c.name AS customer, si.description, SUM(si.total_cost)::numeric AS cost
       FROM service_items si LEFT JOIN customers c ON c.id=si.customer_id
      WHERE si.source='comms' AND si.billed_at IS NULL
        AND (si.is_one_off=true OR si.description ~* $1 OR (si.billing_from IS NOT NULL AND si.billing_from=si.billing_to))
      GROUP BY c.name, si.description ORDER BY c.name`, [ONEOFF_RE.source]
  )).rows;
  const totals = {
    sale: profitByCustomer.reduce((a, c) => a + c.sale, 0),
    cost: profitByCustomer.reduce((a, c) => a + c.cost, 0),
    profit: profitByCustomer.reduce((a, c) => a + c.profit, 0),
  };
  res.render('bureau-reports', {
    user: req.session.user!, profitByCustomer, profitByCategory, totals,
    unallocCount: unalloc.length, unallocCost: unalloc.reduce((a, c) => a + c.cost, 0),
    uncosted: uncostedLines, oneOffs,
  });
});

// Confirm (or change) the package on a CLI from the bill run — locks the choice via an override
// so the resolver uses it and the CLI drops off the Stage-2 review list.
router.post('/bureau/cli/confirm-package', async (req: Request, res: Response) => {
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  const raw = String(req.body.package_id || '').trim();
  const packageId = raw === '' || raw === 'none' ? null : parseInt(raw, 10);
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  const price = parseFloat(String(req.body.price || '').replace(/[^0-9.\-]/g, ''));
  if (cli) {
    await pool.query(
      `INSERT INTO package_cli_overrides (cli, package_id) VALUES ($1,$2)
       ON CONFLICT (cli) DO UPDATE SET package_id=EXCLUDED.package_id`, [cli, packageId]
    );
    // Save the price as a per-customer package override (so the seen price sticks for this customer).
    if (packageId && customerId && !isNaN(price)) {
      await pool.query(
        `INSERT INTO package_prices (package_id, customer_id, sale_price) VALUES ($1,$2,$3)
         ON CONFLICT (package_id, customer_id) DO UPDATE SET sale_price=EXCLUDED.sale_price, updated_at=NOW()`,
        [packageId, customerId, price]
      );
    }
    await logActivity(req.session.user!.id, 'updated', 'customers', 0, `Bill run: confirmed package ${packageId ?? 'none'} for CLI ${cli}`);
  }
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok: !!cli }); return; }
  res.redirect('/bureau/bill-run');
});

// Complete the bill run — produce the draft invoices and close the period.
// NOTE: draft-invoice generation (rate card → invoice lines by category, prorata, due-1st) is
// the next stage; for now this records the close intent so the wizard flows end-to-end.
router.post('/bureau/bill-run/complete', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim();
  if (!period) { res.redirect('/bureau/bill-run?err=' + encodeURIComponent('No period to run.')); return; }
  // PROTECTION — only the OPEN period can be run; a closed month viewed read-only stays read-only.
  const open = await currentCommsPeriod();
  if (period !== open) { res.redirect('/bureau/bill-run?err=' + encodeURIComponent(`${period} is not the open period (${open || 'none'}) — closed periods are read-only.`)); return; }
  // PROTECTION — hard block: every CLI must be accounted for (reassigned or suppressed) before
  // the run can complete, so a deleted-owner / live-but-unbilled CLI can't silently slip through.
  const blocked = await unaccountedClis();
  if (blocked.length) {
    res.redirect('/bureau/bill-run?err=' + encodeURIComponent(
      `${blocked.length} unaccounted CLI(s) must be reassigned or suppressed before completing: ` +
      blocked.slice(0, 6).map((b) => b.cli).join(', ') + (blocked.length > 6 ? '…' : '')
    ));
    return;
  }
  const result = await generateCommsBillRun(period, req.session.user!.id);
  res.redirect('/bureau/bill-run?msg=' + encodeURIComponent(
    `Bill run for ${period}: ${result.created} draft invoice(s) staged, ${result.skipped} skipped. Review them in stage 4 (they stay out of the Invoices list, no numbers yet), then press Complete & send to number, email, push to QuickBooks and collect/invite Direct Debit.`
  ));
});

// Complete & send the run: email each draft (with PDF) + push to QuickBooks + GoCardless
// (collect if mandate, else invite). THEN close the period (roll it forward). The deliberate
// money-moving step — produce drafts first, eyeball, then Complete.
router.post('/bureau/bill-run/finalise', async (req: Request, res: Response) => {
  const period = String(req.body.period || '').trim();
  if (!period) { res.redirect('/bureau/bill-run?err=' + encodeURIComponent('No period to complete.')); return; }
  // PROTECTION — only the OPEN period can be completed (a stale/read-only form can't close a month).
  const open = await currentCommsPeriod();
  if (period !== open) { res.redirect('/bureau/bill-run?err=' + encodeURIComponent(`${period} is not the open period (${open || 'none'}) — closed periods are read-only.`)); return; }
  const r = await finaliseCommsBillRun(period, req.session.user!.id);
  // PROTECTION — a mis-click with NO drafts must not close the month (this happened 2026-07:
  // Complete & send with 0 drafts rolled the period to 2026-08). Nothing sent → nothing closes.
  if (!r.count) {
    res.redirect('/bureau/bill-run?err=' + encodeURIComponent(`No draft invoices exist for ${period} — nothing was sent and the period has NOT been closed. Press "1 · Run month" to produce the drafts first.`));
    return;
  }
  await setSetting('comms', 'billrun_done_' + period, new Date().toISOString()); // stops the 4-hourly reminders
  const advanced = await advanceCommsPeriod(); // closing the period rolls the current period forward
  // ADVANCE BILLING — the moment a month closes, project the next one from the register so it
  // is billable immediately (the supplier file for it won't exist until after we've billed it).
  let rolled = 0;
  if (advanced) { try { rolled = (await rollForwardCommsPeriod(advanced)).cloned; } catch (e) { console.error('[bill-run] roll-forward failed:', (e as Error).message); } }
  const summary = `Completed ${period}: ${r.emailed} emailed, ${r.qbPushed} → QuickBooks, ${r.collected} DD collected, ${r.invited} DD invite(s).${advanced ? ' Period rolled forward to ' + advanced + (rolled ? ` (${rolled} service line(s) projected — actuals will correct them when the Giacom file lands).` : '.') : ''}`;
  const tail = r.issues.length ? ' ⚠ ' + r.issues.length + ' issue(s): ' + r.issues.slice(0, 4).join('; ') + (r.issues.length > 4 ? '…' : '') : '';
  res.redirect('/bureau/bill-run?' + (r.issues.length ? 'err' : 'msg') + '=' + encodeURIComponent(summary + tail));
});

// Admin correction: set the OPEN comms period directly — e.g. roll back after an accidental
// close moved it forward. Clears the target period's billrun_done marker (so the reminders and
// a genuine re-close work again) and logs the change. /bureau is already admin-only.
router.post('/bureau/bill-run/set-period', async (req: Request, res: Response) => {
  const target = String(req.body.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(target)) { res.redirect('/bureau/bill-run?err=' + encodeURIComponent('Period must be YYYY-MM.')); return; }
  const before = await currentCommsPeriod();
  await setSetting('comms', 'current_period', target);
  await pool.query('DELETE FROM settings WHERE "group"=$1 AND key=$2', ['comms', 'billrun_done_' + target]);
  await logActivity(req.session.user!.id, 'updated', 'settings', 0, `Comms open period set to ${target}${before && before !== target ? ' (was ' + before + ')' : ''}`);
  res.redirect('/bureau/bill-run?msg=' + encodeURIComponent(`Open period set to ${target}${before && before !== target ? ' (was ' + before + ')' : ''}.`));
});

// True-up report — month-to-month changes made visible. When a month's supplier file lands
// AFTER that month was billed (advance billing), this compares the register's actuals against
// the RECURRING lines on each customer's sent invoice: added services (charge next run),
// removed (credit), and price/qty changes. One-offs, prorata and calls are excluded — they
// legitimately differ (billed once, then drop). Report-only: adjustments stay a human decision.
router.get('/bureau/bill-run/true-up', async (req: Request, res: Response) => {
  const q = String(req.query.period || '').trim();
  let period: string | null = /^\d{4}-\d{2}$/.test(q) ? q : null;
  if (!period) {
    // Default: newest billed month whose ACTUAL (non-projected) lines have landed.
    period = (await pool.query(
      `SELECT MAX(i.billing_period) AS p FROM invoices i
        WHERE i.invoice_scheme='CS' AND i.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM service_items s
                       WHERE s.source='comms' AND s.billing_period=i.billing_period
                         AND s.is_prorata=false AND s.is_one_off=false AND COALESCE(s.is_projected,false)=false)`
    )).rows[0]?.p || null;
  }
  const rows: any[] = [];
  let totInvoiced = 0, totActual = 0, projectedOnly = false;
  if (period) {
    projectedOnly = ((await pool.query(
      `SELECT 1 FROM service_items WHERE source='comms' AND billing_period=$1 AND is_prorata=false AND is_one_off=false
        AND COALESCE(is_projected,false)=false LIMIT 1`, [period])).rows.length === 0);
    const invCusts = (await pool.query(
      `SELECT i.id AS invoice_id, i.invoice_number, i.customer_id, c.name
         FROM invoices i JOIN customers c ON c.id=i.customer_id
        WHERE i.invoice_scheme='CS' AND i.billing_period=$1 AND i.deleted_at IS NULL ORDER BY c.name`, [period])).rows;
    const svcCusts = (await pool.query(
      `SELECT DISTINCT si.customer_id AS id, c.name FROM service_items si JOIN customers c ON c.id=si.customer_id
        WHERE si.source='comms' AND si.customer_id IS NOT NULL AND si.billing_period=$1
          AND si.is_prorata=false AND si.is_one_off=false`, [period])).rows;
    const byCust = new Map<number, any>();
    invCusts.forEach((r: any) => byCust.set(r.customer_id, { id: r.customer_id, name: r.name, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number }));
    svcCusts.forEach((r: any) => { if (!byCust.has(r.id)) byCust.set(r.id, { id: r.id, name: r.name, invoiceId: null, invoiceNumber: null }); });
    for (const cu of Array.from(byCust.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const items = cu.invoiceId ? (await pool.query(
        `SELECT description, quantity, line_total FROM invoice_items
          WHERE invoice_id=$1 AND source='comms' AND COALESCE(invoice_category,'') <> 'oneoff'
            AND description NOT LIKE '%(part month)%'`, [cu.invoiceId])).rows : [];
      const rc = await commsRateCard(cu.id, period);
      const nowLines = rc.lines.map((l) => ({ desc: l.label + (l.ref ? ' (' + l.ref + ')' : '') + (l.location ? ' — ' + l.location : ''), qty: l.qty || 1, sale: l.sale }));
      const invMap = new Map<string, any>(); items.forEach((i: any) => invMap.set(String(i.description), i));
      const nowMap = new Map<string, any>(); nowLines.forEach((l) => nowMap.set(l.desc, l));
      const added = nowLines.filter((l) => !invMap.has(l.desc));
      const removed = items.filter((i: any) => !nowMap.has(String(i.description)));
      const changed: any[] = [];
      for (const l of nowLines) {
        const i = invMap.get(l.desc); if (!i) continue;
        const invTot = Number(i.line_total) || 0; const nowTot = Number(l.sale) || 0;
        if (Math.abs(invTot - nowTot) > 0.005 || Number(i.quantity) !== Number(l.qty)) {
          changed.push({ desc: l.desc, invoiced: invTot, now: nowTot, invQty: Number(i.quantity), nowQty: l.qty });
        }
      }
      const invoicedTotal = items.reduce((s: number, i: any) => s + (Number(i.line_total) || 0), 0);
      const actualTotal = nowLines.reduce((s, l) => s + (Number(l.sale) || 0), 0);
      totInvoiced += invoicedTotal; totActual += actualTotal;
      if (added.length || removed.length || changed.length || !cu.invoiceId) {
        rows.push({ ...cu, added, removed, changed, invoicedTotal, actualTotal, delta: actualTotal - invoicedTotal });
      }
    }
  }
  res.render('bureau-billrun-trueup', {
    user: req.session.user!, period, rows, totInvoiced, totActual, projectedOnly,
    periods: await commsPeriods(),
  });
});

// CSV export of all mapped service lines for offline pricing (with a New Sale Price box).
router.get('/bureau/pricing.csv', async (req: Request, res: Response) => {
  const source = String(req.query.source || '').trim();
  const lines = await pricedServiceLines({ sources: source ? [source] : undefined });
  const cols = ['source', 'customer_id', 'customer', 'product_reference', 'product_name', 'qty', 'buy_price', 'sale_price', 'profit', 'new_sale_price'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const out = [cols.join(',')];
  for (const l of lines) {
    const sale = l.sale_price ?? 0;
    const profit = (sale - l.unit_cost) * l.quantity;
    out.push([l.source, l.customer_id, l.customer_name, l.product_reference, l.description, l.quantity,
      l.unit_cost.toFixed(4), l.sale_price === null ? '' : l.sale_price.toFixed(4),
      l.sale_price === null ? '' : profit.toFixed(2), ''].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="service_pricing_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Detailed line-by-line export for review (comms especially): every service line with who
// we think the customer is, the CLI/Ref, buy price, service dates and the CURRENT sale price
// (durable price if set, else what the recurring template currently bills, else the stored
// sell on the line). Plus a blank new_sale_price box. Re-importable via /bureau/pricing/import.
router.get('/bureau/pricing-detail.csv', async (req: Request, res: Response) => {
  const source = String(req.query.source || '').trim();
  // ?bb=ex → exclude broadband/connectivity lines (the "non-BB products" extract);
  // ?bb=only → just broadband.
  const bb = String(req.query.bb || '').trim();
  const BB_SQL = "si.description ~* 'fttp|sogea|fttc|adsl|ethernet|internet access|broadband|fibre|leased'";
  const bbClause = bb === 'ex' ? ` AND NOT (${BB_SQL})` : bb === 'only' ? ` AND ${BB_SQL}` : '';
  const { rows } = await pool.query(
    `SELECT si.source, si.customer_id, COALESCE(c.name, si.external_customer_name) AS customer,
            si.product_reference, si.description, si.quantity, si.unit_cost, si.total_cost,
            si.billing_from, si.billing_to, si.billing_date,
            sp.sale_price AS durable_sale,
            (SELECT ii.unit_price FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
               WHERE i.customer_id=si.customer_id AND i.is_recurring=true AND ii.source=si.source
                 AND lower(trim(ii.description))=lower(trim(si.description))
               ORDER BY i.id DESC LIMIT 1) AS template_sale
       FROM service_items si
       LEFT JOIN customers c ON c.id=si.customer_id
       LEFT JOIN service_pricing sp ON sp.source=si.source AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE ($1='' OR si.source=$1)${bbClause}
      ORDER BY customer NULLS LAST, si.source, si.description`,
    [source]
  );
  const cols = ['delete', 'source', 'customer_id', 'customer', 'product_reference', 'description', 'qty', 'buy_price', 'current_sale_price', 'profit', 'new_sale_price', 'service_from', 'service_to', 'billing_date'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const d = (v: any): string => (v ? new Date(v).toISOString().slice(0, 10) : '');
  const out = [cols.join(',')];
  for (const r of rows) {
    // Current effective sale: durable wins, else current template price, else the line's stored sell (lumen).
    const current = r.durable_sale ?? r.template_sale ?? (r.source === 'lumen' ? r.total_cost : null);
    const buy = Number(r.unit_cost) || 0, qty = Number(r.quantity) || 0;
    const profit = current === null || current === undefined ? '' : ((Number(current) - buy) * qty).toFixed(2);
    out.push([
      '', r.source, r.customer_id, r.customer, r.product_reference, r.description, r.quantity,
      buy.toFixed(4), current === null || current === undefined ? '' : Number(current).toFixed(4), profit, '',
      d(r.billing_from), d(r.billing_to), d(r.billing_date),
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${source || 'all'}_lines_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Product-name summary export: one row per distinct product/service name from the imports,
// showing how many lines, how many matched to a customer, how many are LIVE (in the latest
// import) vs historical, totals, and whether the name exists in the catalogue. Lets you see
// the whole product-name universe and prune historical/fancy names.
router.get('/bureau/product-summary.csv', async (req: Request, res: Response) => {
  const source = String(req.query.source || '').trim();
  const { rows } = await pool.query(
    `WITH last AS (SELECT source, MAX(synced_at) AS ls FROM service_items GROUP BY source)
     SELECT si.source,
            COALESCE(NULLIF(trim(si.description),''),'(blank)') AS product_name,
            COUNT(*)::int AS lines,
            COUNT(*) FILTER (WHERE si.synced_at >= l.ls - INTERVAL '1 day')::int AS live_lines,
            COUNT(DISTINCT si.customer_id)::int AS customers_matched,
            COUNT(*) FILTER (WHERE si.customer_id IS NULL)::int AS unmatched_lines,
            SUM(si.quantity)::numeric AS qty,
            SUM(si.unit_cost * si.quantity)::numeric AS monthly_cost,
            SUM(si.total_cost)::numeric AS monthly_sell,
            MAX(si.synced_at) AS last_seen
       FROM service_items si JOIN last l ON l.source = si.source
      WHERE ($1='' OR si.source=$1)
      GROUP BY si.source, COALESCE(NULLIF(trim(si.description),''),'(blank)')
      ORDER BY si.source, lines DESC`,
    [source]
  );
  const catalogue = new Set<string>(
    (await pool.query("SELECT lower(trim(name)) AS n FROM asset_products")).rows.map((r: any) => r.n)
  );
  const cols = ['delete', 'source', 'product_name', 'in_catalogue', 'lines', 'live_lines', 'historical', 'customers_matched', 'unmatched_lines', 'qty', 'monthly_cost', 'monthly_sell', 'last_seen'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const out = [cols.join(',')];
  for (const r of rows) {
    const inCat = catalogue.has(String(r.product_name).toLowerCase().trim()) ? 'yes' : 'no';
    const historical = Number(r.live_lines) === 0 ? 'yes' : 'no';
    out.push([
      '', r.source, r.product_name, inCat, r.lines, r.live_lines, historical, r.customers_matched, r.unmatched_lines,
      Number(r.qty || 0), Number(r.monthly_cost || 0).toFixed(2), Number(r.monthly_sell || 0).toFixed(2),
      r.last_seen ? new Date(r.last_seen).toISOString().slice(0, 10) : '',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="product_summary_${source || 'all'}_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Raw Giacom charge sheet: every line from the latest Giacom sync exactly as the supplier
// bills us (cost), with which portal customer it's matched to. The "what are we being charged
// for" view, independent of our sale pricing.
router.get('/bureau/giacom-sheet.csv', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT si.external_customer_id AS giacom_account, si.external_customer_name AS giacom_customer,
            c.name AS matched_customer, si.product_id AS giacom_product_id, si.product_reference,
            si.description, si.quantity, si.unit_cost, si.total_cost, si.billing_date, si.synced_at
       FROM service_items si LEFT JOIN customers c ON c.id = si.customer_id
      WHERE si.source='giacom'
      ORDER BY si.external_customer_name NULLS LAST, si.description`
  );
  const lastSync = rows.reduce((m: any, r: any) => (r.synced_at && (!m || r.synced_at > m) ? r.synced_at : m), null);
  const cols = ['giacom_account', 'giacom_customer', 'matched_customer', 'giacom_product_id', 'product_reference', 'description', 'qty', 'unit_cost', 'total_cost', 'billing_date'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const out = [cols.join(',')];
  let totalCost = 0;
  for (const r of rows) {
    totalCost += Number(r.total_cost) || 0;
    out.push([
      r.giacom_account, r.giacom_customer, r.matched_customer, r.giacom_product_id, r.product_reference,
      r.description, Number(r.quantity || 0), Number(r.unit_cost || 0).toFixed(4), Number(r.total_cost || 0).toFixed(2),
      r.billing_date ? new Date(r.billing_date).toISOString().slice(0, 10) : '',
    ].map(esc).join(','));
  }
  out.push(['', '', '', '', '', 'TOTAL (' + rows.length + ' lines)', '', '', totalCost.toFixed(2), ''].map(esc).join(','));
  const stamp = lastSync ? new Date(lastSync).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="giacom_charge_sheet_${stamp}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Supplier Export (Comms): every comms line the carrier bills us for, per CLI/Ref — the cost
// side (unit_cost = carrier charge; for lumen, total_cost holds our sell so it's excluded here).
router.get('/bureau/supplier-comms.csv', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT si.external_customer_id AS account, si.external_customer_name AS supplier_customer,
            c.name AS matched_customer, si.product_reference AS cli_ref, si.description, si.quantity,
            si.unit_cost, (si.unit_cost * si.quantity) AS line_cost,
            si.billing_from, si.billing_to, si.billing_date, si.synced_at
       FROM service_items si LEFT JOIN customers c ON c.id = si.customer_id
      WHERE si.source IN ('comms','lumen')
      ORDER BY c.name NULLS LAST, si.product_reference, si.description`
  );
  const lastSync = rows.reduce((m: any, r: any) => (r.synced_at && (!m || r.synced_at > m) ? r.synced_at : m), null);
  const cols = ['cli_ref', 'matched_customer', 'supplier_customer', 'account', 'description', 'qty', 'unit_cost', 'line_cost', 'service_from', 'service_to', 'billing_date'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const d = (v: any): string => (v ? new Date(v).toISOString().slice(0, 10) : '');
  const out = [cols.join(',')];
  let total = 0;
  for (const r of rows) {
    total += Number(r.line_cost) || 0;
    out.push([
      r.cli_ref, r.matched_customer, r.supplier_customer, r.account, r.description, Number(r.quantity || 0),
      Number(r.unit_cost || 0).toFixed(4), Number(r.line_cost || 0).toFixed(2), d(r.billing_from), d(r.billing_to), d(r.billing_date),
    ].map(esc).join(','));
  }
  out.push(['TOTAL (' + rows.length + ' lines)', '', '', '', '', '', '', total.toFixed(2), '', '', ''].map(esc).join(','));
  const stamp = lastSync ? new Date(lastSync).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="supplier_comms_${stamp}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Customer Charges Export: every item we currently SELL — each service line allocated to a
// customer, across cloud + comms, with customer name, CLI/Ref, buy, current sale, profit and
// dates. The sale-side counterpart to the Supplier Export.
router.get('/bureau/customer-charges.csv', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `WITH last AS (SELECT source, MAX(synced_at) AS ls FROM service_items GROUP BY source)
     SELECT si.source, c.name AS customer, si.product_reference, si.description, si.quantity,
            si.unit_cost, si.total_cost, si.billing_from, si.billing_to, si.billing_date,
            (si.synced_at >= l.ls - INTERVAL '1 day') AS live,
            sp.sale_price AS durable_sale,
            (SELECT ii.unit_price FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
               WHERE i.customer_id=si.customer_id AND i.is_recurring=true AND ii.source=si.source
                 AND lower(trim(ii.description))=lower(trim(si.description)) ORDER BY i.id DESC LIMIT 1) AS template_sale
       FROM service_items si JOIN last l ON l.source = si.source
       LEFT JOIN customers c ON c.id = si.customer_id
       LEFT JOIN service_pricing sp ON sp.source=si.source AND sp.customer_id=si.customer_id
             AND COALESCE(sp.product_reference,'')=COALESCE(si.product_reference,'') AND sp.unit_cost=si.unit_cost
      WHERE si.customer_id IS NOT NULL
      ORDER BY c.name NULLS LAST, si.source, si.description`
  );
  const cols = ['customer', 'source', 'cli_ref', 'description', 'qty', 'buy_price', 'current_sale_price', 'profit', 'live', 'service_from', 'service_to', 'billing_date'];
  const esc = (v: any): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const d = (v: any): string => (v ? new Date(v).toISOString().slice(0, 10) : '');
  const out = [cols.join(',')];
  let totalSale = 0, totalProfit = 0;
  for (const r of rows) {
    const buy = Number(r.unit_cost) || 0, qty = Number(r.quantity) || 0;
    const current = r.durable_sale ?? r.template_sale ?? (r.source === 'lumen' ? r.total_cost : null);
    const sale = current === null || current === undefined ? null : Number(current);
    const profit = sale === null ? null : (sale - buy) * qty;
    if (sale !== null) { totalSale += sale * qty; totalProfit += profit as number; }
    out.push([
      r.customer, r.source, r.product_reference, r.description, r.quantity, buy.toFixed(4),
      sale === null ? '' : sale.toFixed(4), profit === null ? '' : profit.toFixed(2),
      r.live ? 'live' : 'historical', d(r.billing_from), d(r.billing_to), d(r.billing_date),
    ].map(esc).join(','));
  }
  out.push(['TOTAL (' + rows.length + ' lines)', '', '', '', '', '', totalSale.toFixed(2), totalProfit.toFixed(2), '', '', '', ''].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customer_charges_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + out.join('\r\n'));
});

// Set one sale price (inline form on the pricing page).
router.post('/bureau/pricing/set', async (req: Request, res: Response) => {
  const b = req.body;
  const customerId = parseInt(String(b.customer_id || ''), 10);
  const unitCost = parseFloat(String(b.unit_cost || '').replace(/[^0-9.\-]/g, ''));
  const salePrice = parseFloat(String(b.sale_price || '').replace(/[^0-9.\-]/g, ''));
  const ok = customerId && !isNaN(unitCost) && !isNaN(salePrice);
  if (ok) {
    await setSalePrice({ source: String(b.source || 'giacom'), customerId, productReference: (b.product_reference || '').trim() || null, description: (b.description || '').trim() || null, unitCost, salePrice });
    await logActivity(req.session.user!.id, 'updated', 'customers', customerId, `Bureau: set sale price ${salePrice} for ${b.product_reference || b.description || 'service'}`);
  }
  if (req.xhr || String(req.get('accept') || '').includes('application/json')) { res.json({ ok, salePrice }); return; }
  res.redirect('/bureau/pricing' + (b.source ? '?source=' + encodeURIComponent(b.source) : '') + (req.query.msg ? '' : '#r'));
});

// Batch set sale prices (the what-if pricing simulator). Submits parallel arrays — one entry
// per row the user changed. Only rows with a numeric new_sale that differs from the current
// sale are written, so re-submitting is cheap and idempotent.
router.post('/bureau/pricing/batch', async (req: Request, res: Response) => {
  const b = req.body;
  const arr = (v: any): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  const src = arr(b.row_source), cust = arr(b.row_customer_id), ref = arr(b.row_product_reference);
  const desc = arr(b.row_description), buy = arr(b.row_unit_cost), cur = arr(b.row_cur_sale), neu = arr(b.row_new_sale);
  let applied = 0;
  for (let i = 0; i < src.length; i++) {
    const customerId = parseInt(cust[i] || '', 10);
    const unitCost = parseFloat(String(buy[i] || '').replace(/[^0-9.\-]/g, ''));
    const newSale = parseFloat(String(neu[i] || '').replace(/[^0-9.\-]/g, ''));
    const curSale = cur[i] === '' || cur[i] === undefined ? NaN : parseFloat(String(cur[i]).replace(/[^0-9.\-]/g, ''));
    if (!customerId || isNaN(unitCost) || isNaN(newSale)) continue;
    if (!isNaN(curSale) && Math.abs(curSale - newSale) < 0.0001) continue; // unchanged
    await setSalePrice({ source: String(src[i] || 'giacom'), customerId, productReference: (ref[i] || '').trim() || null, description: (desc[i] || '').trim() || null, unitCost, salePrice: newSale });
    applied++;
  }
  await logActivity(req.session.user!.id, 'updated', 'customers', 0, `Bureau: batch-updated ${applied} sale price(s)`);
  const qs = new URLSearchParams({ msg: `Applied ${applied} price change(s).` });
  if (b.source) qs.set('source', String(b.source));
  res.redirect('/bureau/pricing?' + qs.toString());
});

// Is this row a delete instruction (D in the delete column)?
const isDelete = (r: any): boolean => /^d/i.test(String(r.delete ?? '').trim());
// Count the service_items a delete row would remove (preview, no change).
async function countDeleteImpact(r: any): Promise<number> {
  const src = String(r.source || '').trim();
  const hasLineKey = (r.customer_id && String(r.customer_id).trim()) || (r.buy_price && String(r.buy_price).trim());
  if (!hasLineKey && (r.product_name || r.description)) {
    return Number((await pool.query("SELECT COUNT(*)::int n FROM service_items WHERE source=$1 AND lower(trim(description))=lower($2)", [src, String(r.product_name || r.description).trim()])).rows[0].n);
  }
  const customerId = parseInt(String(r.customer_id || ''), 10) || null;
  const unitCost = parseFloat(String(r.buy_price || '').replace(/[^0-9.\-]/g, ''));
  return Number((await pool.query(
    `SELECT COUNT(*)::int n FROM service_items WHERE source=$1 AND customer_id IS NOT DISTINCT FROM $2
       AND COALESCE(product_reference,'')=COALESCE($3,'') AND unit_cost=$4`,
    [src, customerId, (r.product_reference || '').trim() || null, isNaN(unitCost) ? 0 : unitCost]
  )).rows[0].n);
}

// Shared apply: sets sale prices and processes deletes from parsed rows.
async function applyPricingRows(recs: any[], userId: number): Promise<{ applied: number; deleted: number; errs: string[] }> {
  let applied = 0, deleted = 0; const errs: string[] = [];
  for (const r of recs) {
    if (isDelete(r)) {
      try {
        const src = String(r.source || '').trim();
        const hasLineKey = (r.customer_id && String(r.customer_id).trim()) || (r.buy_price && String(r.buy_price).trim());
        if (!hasLineKey && (r.product_name || r.description)) {
          const res = await pool.query("DELETE FROM service_items WHERE source=$1 AND lower(trim(description))=lower($2)", [src, String(r.product_name || r.description).trim()]);
          deleted += res.rowCount || 0;
        } else {
          const customerId = parseInt(String(r.customer_id || ''), 10) || null;
          const unitCost = parseFloat(String(r.buy_price || '').replace(/[^0-9.\-]/g, ''));
          const res = await pool.query(
            `DELETE FROM service_items WHERE source=$1 AND customer_id IS NOT DISTINCT FROM $2
               AND COALESCE(product_reference,'')=COALESCE($3,'') AND unit_cost=$4`,
            [src, customerId, (r.product_reference || '').trim() || null, isNaN(unitCost) ? 0 : unitCost]
          );
          deleted += res.rowCount || 0;
        }
      } catch { errs.push('del:' + String(r.product_name || r.description || r.customer || '?')); }
      continue;
    }
    const newSale = String(r.new_sale_price ?? '').replace(/[^0-9.\-]/g, '');
    if (newSale === '') continue;
    const customerId = parseInt(String(r.customer_id || ''), 10);
    const unitCost = parseFloat(String(r.buy_price || '').replace(/[^0-9.\-]/g, ''));
    const salePrice = parseFloat(newSale);
    if (!customerId || isNaN(unitCost) || isNaN(salePrice)) { errs.push(String(r.customer || r.customer_id || '?')); continue; }
    try {
      await setSalePrice({ source: String(r.source || 'giacom'), customerId, productReference: (r.product_reference || '').trim() || null, description: (r.product_name || r.description || '').trim() || null, unitCost, salePrice });
      applied++;
    } catch { errs.push(String(r.customer || r.customer_id || '?')); }
  }
  return { applied, deleted, errs };
}

// Upload → PREVIEW. Parses the CSV, totals the price updates and the delete impact (how many
// lines each D removes), stashes the rows in the session, and shows a confirm page. Nothing
// changes until you confirm.
router.post('/bureau/pricing/import', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.redirect('/bureau/pricing?err=' + encodeURIComponent('No file uploaded.')); return; }
  let recs: any[] = [];
  try { recs = csvParseSync(req.file.buffer, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true }); }
  catch (e: any) { res.redirect('/bureau/pricing?err=' + encodeURIComponent('Could not parse CSV: ' + e.message)); return; }
  const priceUpdates = recs.filter((r) => !isDelete(r) && String(r.new_sale_price ?? '').replace(/[^0-9.\-]/g, '') !== '').length;
  const deleteRowsArr = recs.filter(isDelete);
  let linesToDelete = 0; const delPreview: { label: string; n: number }[] = [];
  for (const r of deleteRowsArr) {
    const n = await countDeleteImpact(r); linesToDelete += n;
    delPreview.push({ label: String(r.product_name || r.description || r.customer || '?') + (r.source ? ' (' + r.source + ')' : ''), n });
  }
  (req.session as any).pricingImport = recs;
  res.render('bureau-pricing-confirm', {
    user: req.session.user!, priceUpdates, deleteRows: deleteRowsArr.length, linesToDelete,
    delPreview: delPreview.slice(0, 100), totalRows: recs.length,
  });
});

// Confirm → APPLY (reads the stashed rows from the session).
router.post('/bureau/pricing/apply', async (req: Request, res: Response) => {
  const recs = (req.session as any).pricingImport as any[] | undefined;
  if (!recs) { res.redirect('/bureau/pricing?err=' + encodeURIComponent('Nothing to apply — upload the sheet again.')); return; }
  const { applied, deleted, errs } = await applyPricingRows(recs, req.session.user!.id);
  delete (req.session as any).pricingImport;
  await logActivity(req.session.user!.id, 'updated', 'service_items', null, `Bureau: applied ${applied} sale price(s), deleted ${deleted} line(s) from CSV`);
  res.redirect('/bureau/pricing?msg=' + encodeURIComponent(`Applied ${applied} new sale price(s)` + (deleted ? ` · deleted ${deleted} line(s)` : '') + (errs.length ? ` · ${errs.length} skipped` : '')));
});

export default router;
