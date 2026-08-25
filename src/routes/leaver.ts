import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { scheduleLeaver, runLeaver, LEAVER_CHECKLIST } from '../lib/leaver';

const router = Router();

// ── Leavers ─────────────────────────────────────────────────────────────────────
// Schedule the moment someone's access is cut, and see what happened when it was.

router.get('/leavers', requireAuth, async (req: Request, res: Response) => {
  const [plans, customers] = await Promise.all([
    pool.query(
      `SELECT lp.*, c.name AS customer_name, c.entra_tenant_id, u.display_name AS created_name,
              EXTRACT(EPOCH FROM lp.effective_at)::bigint AS eff,
              (SELECT hostname FROM agent_devices
                WHERE customer_id=lp.customer_id AND is_ad_agent=true AND revoked=false
                ORDER BY last_seen_at DESC NULLS LAST LIMIT 1) AS ad_agent
         FROM leaver_plans lp
         JOIN customers c ON c.id = lp.customer_id
         LEFT JOIN users u ON u.id = lp.created_by
        ORDER BY (lp.status='scheduled') DESC, lp.effective_at DESC LIMIT 200`),
    pool.query(`SELECT id, name, entra_tenant_id FROM customers
                 WHERE deleted_at IS NULL AND is_placeholder=false AND status <> 'inactive' ORDER BY name`),
  ]);
  res.render('leaver/index', {
    user: req.session.user!, plans: plans.rows, customers: customers.rows,
    checklist: LEAVER_CHECKLIST,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

/** Contacts for the picker — used by the customer dropdown to prefill the name and sign-in. */
router.get('/leavers/contacts/:customerId', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.customerId), 10);
  if (!id) { res.json({ contacts: [] }); return; }
  const r = await pool.query(
    `SELECT id, full_name, email FROM customer_contacts
      WHERE customer_id=$1 AND archived=false ORDER BY full_name`, [id]);
  res.json({ contacts: r.rows.map((x: any) => ({ id: Number(x.id), name: x.full_name, email: x.email || '' })) });
});

router.post('/leavers', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const customerId = parseInt(String(b.customer_id || ''), 10);
  if (!customerId) { res.redirect('/leavers?err=' + encodeURIComponent('Pick the customer.')); return; }

  // The browser sends local wall-clock; store the instant.
  const effectiveAt = new Date(String(b.effective_at || ''));
  const r = await scheduleLeaver({
    customerId,
    contactId: parseInt(String(b.contact_id || ''), 10) || null,
    displayName: String(b.display_name || ''),
    upn: String(b.upn || '').trim() || null,
    samAccountName: String(b.sam || '').trim() || null,
    effectiveAt,
    disableAd: b.disable_ad === '1',
    blockM365: b.block_m365 === '1',
    revokeSessions: b.revoke_sessions === '1',
    notes: String(b.notes || '').trim() || null,
    createdBy: req.session.user!.id,
  });
  if (!r.ok) { res.redirect('/leavers?err=' + encodeURIComponent(r.error || 'Could not schedule that.')); return; }
  await logActivity(req.session.user!.id, 'leaver_scheduled', 'leaver_plans', r.id!,
    `${b.display_name} — access cut ${effectiveAt.toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
  res.redirect('/leavers?msg=' + encodeURIComponent(
    `Scheduled — ${String(b.display_name)}'s access is cut at ${effectiveAt.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })}, and the leavers task is raised then.`));
});

// Cancelling only ever applies to something that has NOT run — a leaver already processed
// is a record of what happened, not a plan to be edited.
router.post('/leavers/:id/cancel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `UPDATE leaver_plans SET status='cancelled', updated_at=NOW()
      WHERE id=$1 AND status='scheduled' RETURNING display_name`, [id]);
  if (!r.rowCount) { res.redirect('/leavers?err=' + encodeURIComponent('That one has already run — it cannot be cancelled, only recorded.')); return; }
  await logActivity(req.session.user!.id, 'leaver_cancelled', 'leaver_plans', id, `Cancelled: ${r.rows[0].display_name}`);
  res.redirect('/leavers?msg=' + encodeURIComponent('Cancelled — nothing will be cut.'));
});

// "Do it now" — the same path the sweep takes, for a walk-out.
router.post('/leavers/:id/run', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await runLeaver(id);
  const msg = r.status === 'done'
    ? 'Access cut and the leavers task raised.'
    : `Ran with problems (${r.status}) — read the log on the row; the task lists what still needs doing by hand.`;
  res.redirect('/leavers?' + (r.status === 'done' ? 'msg=' : 'err=') + encodeURIComponent(msg));
});

export default router;
