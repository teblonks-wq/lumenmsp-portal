import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { getSetting, setSetting } from '../lib/settings';
import { subscriptionsOverview, syncMsSubscriptions } from '../lib/ms-subscriptions';

const router = Router();

// Microsoft / NCE subscriptions — estate-wide view + exposure report. Admin only.
router.get('/settings/subscriptions', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const overview = await subscriptionsOverview();
  const customers = (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name")).rows;
  res.render('settings/subscriptions', {
    user: req.session.user!, overview, customers,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Pull the SubscriptionsManagementReport and full-refresh the mirror.
router.post('/settings/subscriptions/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await syncMsSubscriptions();
    const back = typeof req.body.return === 'string' && req.body.return.startsWith('/') ? req.body.return : '/settings/subscriptions';
    const sep = back.includes('?') ? '&' : '?';
    res.redirect(back + sep + 'msg=' + encodeURIComponent(
      `Synced ${r.fetched} subscriptions — ${r.matched} matched, ${r.unmatched} unmatched${r.ignored ? `, ${r.ignored} ignored` : ''}.`));
  } catch (e: any) {
    const back = typeof req.body.return === 'string' && req.body.return.startsWith('/') ? req.body.return : '/settings/subscriptions';
    const sep = back.includes('?') ? '&' : '?';
    res.redirect(back + sep + 'err=' + encodeURIComponent('Subscription sync failed: ' + (e.message || 'unknown')));
  }
});

// Link an unmatched subscription account to a portal customer. Records the Giacom mapping
// (so the billing feed matches too) and stamps the tenant on the customer when missing.
router.post('/settings/subscriptions/link', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as any;
  const customerId = parseInt(String(b.customer_id || ''), 10);
  const mexId = (b.mex_id || '').toString().trim() || null;
  const tenantId = (b.tenant_id || '').toString().trim() || null;
  if (!customerId || (!mexId && !tenantId)) { res.redirect('/settings/subscriptions?err=' + encodeURIComponent('Pick a customer to link to.')); return; }
  if (mexId) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'giacom',$2)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [customerId, mexId]);
  }
  if (tenantId) {
    await pool.query("UPDATE customers SET entra_tenant_id=$1 WHERE id=$2 AND (entra_tenant_id IS NULL OR entra_tenant_id='')", [tenantId, customerId]);
  }
  await pool.query(
    "UPDATE ms_subscription SET customer_id=$1 WHERE ($2::text IS NOT NULL AND mex_id=$2) OR ($3::text IS NOT NULL AND tenant_id=$3)",
    [customerId, mexId, tenantId]);
  res.redirect('/settings/subscriptions?msg=' + encodeURIComponent('Linked.'));
});

// Ignore a demo/internal account — hides it from the report and drops its rows.
router.post('/settings/subscriptions/ignore', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as any;
  const mexId = (b.mex_id || '').toString().trim() || null;
  const tenantId = (b.tenant_id || '').toString().trim() || null;
  const keyToAdd = mexId || tenantId;
  if (keyToAdd) {
    const cur = ((await getSetting('subscriptions', 'ignored')) || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!cur.includes(keyToAdd)) cur.push(keyToAdd);
    await setSetting('subscriptions', 'ignored', cur.join(','));
    await pool.query("DELETE FROM ms_subscription WHERE ($1::text IS NOT NULL AND mex_id=$1) OR ($2::text IS NOT NULL AND tenant_id=$2)", [mexId, tenantId]);
  }
  res.redirect('/settings/subscriptions?msg=' + encodeURIComponent('Account ignored.'));
});

export default router;
