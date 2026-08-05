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
    warnings: [] as string[],
  };

  if (!cust.entra_tenant_id) {
    res.render('customers/m365', { ...base,
      error: 'No Microsoft tenant is recorded for this customer. Add their Entra tenant ID on the customer record first.' });
    return;
  }

  // Each section is fetched independently. The scopes on the reporting app vary by what
  // has actually been granted, and one refused endpoint should cost you that section —
  // not the whole page. A missing licence read is a note; it is not an outage.
  const tenant = cust.entra_tenant_id;
  const warnings: string[] = [];

  const [skus, users, groups] = await Promise.all([
    listSkus(tenant).catch((e: any) => { warnings.push(`Licences unavailable — ${e.message}`); return []; }),
    listUsers(tenant).catch((e: any) => { warnings.push(`Users unavailable — ${e.message}`); return []; }),
    listGroups(tenant).catch((e: any) => { warnings.push(`Groups unavailable — ${e.message}`); return []; }),
  ]);

  if (!users.length && warnings.length === 3) {
    res.render('customers/m365', { ...base, error: warnings[1] || warnings[0] });
    return;
  }

  res.render('customers/m365', {
    ...base, users, skus, groups, warnings, summary: summarise(users, skus),
  });
});

export default router;
