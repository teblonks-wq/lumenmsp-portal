import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { listUsers, listSkus, listGroups, summarise } from '../lib/m365';

// ── Microsoft 365 panel (read-only) ─────────────────────────────────────────────
// One page per customer: who exists, what licences they hold, and what is being paid
// for and not used. Reads only — the write capabilities exist as separate consent packs
// and will get their own routes, so nothing on this page can change a customer's tenant.

const router = Router();

router.get('/customers/:id/m365', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Customer not found.' }); return; }

  const cust = (await pool.query(
    'SELECT id, name, entra_tenant_id FROM customers WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id])).rows[0];
  if (!cust) { res.status(404).render('error', { message: 'Customer not found.' }); return; }

  const base = {
    user: req.session.user!, customer: cust,
    users: [] as any[], skus: [] as any[], groups: [] as any[],
    summary: { users: 0, guests: 0, licensed: 0, disabled: 0, wasted: 0, spare: 0 },
    error: null as string | null,
  };

  if (!cust.entra_tenant_id) {
    res.render('customers/m365', { ...base,
      error: 'No Microsoft tenant is recorded for this customer. Add their Entra tenant ID on the customer record first.' });
    return;
  }

  try {
    // Users needs the SKU list to name licences, so fetch that first and reuse it.
    const skus = await listSkus(cust.entra_tenant_id);
    const [users, groups] = await Promise.all([
      listUsers(cust.entra_tenant_id),
      listGroups(cust.entra_tenant_id).catch(() => []),   // groups are a bonus, not a blocker
    ]);
    res.render('customers/m365', { ...base, users, skus, groups, summary: summarise(users, skus) });
  } catch (e: any) {
    // The common failures are honest and worth showing verbatim: consent not granted,
    // consent granted to the wrong app, or the tenant id being wrong.
    res.render('customers/m365', { ...base, error: e.message });
  }
});

export default router;
