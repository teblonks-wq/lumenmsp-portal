import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { logActivity } from '../lib/activity';

// ─────────────────────────────────────────────────────────────────────────────────
// Admin → Self-registered contacts.
//
// The other half of public sign-up, and the half that makes it honest. Sign-up
// deliberately matches nobody against our data, which means somebody has to look at the
// name, decide whether this person really works for the company they claim, and link
// them. Without this screen the accounts pile up in a placeholder company and the
// promise ("we'll get you to the right place") is never kept.
//
// Linking is the ONE privileged act in the whole feature: it is the moment a stranger
// becomes a customer's user and can see that customer's records. Admin only, logged, and
// it refuses to link into a company whose portal access is switched off rather than
// leaving the person staring at "portal access is not enabled".
// ─────────────────────────────────────────────────────────────────────────────────

const router = Router();
const rows = async (sql: string, p: any[] = []): Promise<any[]> =>
  (await pool.query(sql, p).catch(() => ({ rows: [] as any[] }))).rows;

router.use('/admin/self-registered', requireAuth, requireAdmin);

router.get('/admin/self-registered', async (req: Request, res: Response) => {
  // Everyone who came in through the public form, whether or not they are still parked in
  // the placeholder company - once linked they stay listed, so the screen also answers
  // "who did we let in, and where did they go?"
  const people = await rows(
    `SELECT u.id, u.email, u.display_name, u.company_claimed, u.email_verified,
            u.signup_source, u.signup_at, u.signup_ip, u.last_login_at,
            c.id AS customer_id, c.name AS customer_name, c.is_placeholder,
            (SELECT COUNT(*)::int FROM inbox_tickets t
               JOIN customer_contacts cc ON cc.id = t.contact_id
              WHERE lower(cc.email) = lower(u.email) AND t.deleted_at IS NULL) AS tickets
       FROM users u
       LEFT JOIN customers c ON c.id = u.customer_id
      WHERE u.signup_source IS NOT NULL
      ORDER BY c.is_placeholder DESC NULLS FIRST, u.signup_at DESC NULLS LAST
      LIMIT 500`);

  // Only companies a link could actually work for: real, live, portal switched on.
  const customers = await rows(
    `SELECT id, name FROM customers
      WHERE deleted_at IS NULL AND is_placeholder = false AND status <> 'inactive'
        AND portal_enabled = true
      ORDER BY name`);

  res.render('admin/self-registered', {
    user: req.session.user, people, customers,
    notice: req.query.ok ? String(req.query.ok) : null,
    error: req.query.err ? String(req.query.err) : null,
  });
});

/**
 * Link a self-registered account to a real customer.
 *
 * Moves three things together, because moving any two of them leaves a person who can log
 * in but cannot see the ticket they raised:
 *   1. the login            (users.customer_id)
 *   2. the contact record   (customer_contacts, or their existing one at that customer)
 *   3. their tickets        (inbox_tickets.customer_id + contact_id)
 *
 * Access level is deliberately left at 'tickets' - their own tickets and nothing more.
 * Widening it is a separate, visible decision on the contact record, not a side effect of
 * being recognised.
 */
router.post('/admin/self-registered/:id/link', async (req: Request, res: Response) => {
  const userId = parseInt(String(req.params.id), 10);
  const customerId = parseInt(String((req.body as any).customerId || ''), 10);
  const back = (q: string) => res.redirect('/admin/self-registered?' + q);

  if (!Number.isInteger(userId) || !Number.isInteger(customerId)) return back('err=' + encodeURIComponent('Pick a customer.'));

  const u = (await rows('SELECT id, email, display_name, customer_id FROM users WHERE id=$1 AND signup_source IS NOT NULL', [userId]))[0];
  if (!u) return back('err=' + encodeURIComponent('That is not a self-registered account.'));

  const cust = (await rows(
    `SELECT id, name, portal_enabled FROM customers
      WHERE id=$1 AND deleted_at IS NULL AND is_placeholder=false`, [customerId]))[0];
  if (!cust) return back('err=' + encodeURIComponent('That customer no longer exists.'));
  if (!cust.portal_enabled) {
    // Caught here as well as filtered from the list: a stale page could still post it, and
    // the person would be linked into a company that then refuses them at the door.
    return back('err=' + encodeURIComponent(
      `Portal access is not switched on for ${cust.name}. Enable it on the customer first, then link them.`));
  }

  const oldCustomerId = u.customer_id;

  // Their contact row under the placeholder, and any contact they may ALREADY have at the
  // real customer (the common case: we emailed them once, so they are already on file).
  const mine = (await rows(
    'SELECT id FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1',
    [oldCustomerId, u.email]))[0];
  const theirs = (await rows(
    'SELECT id FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1',
    [customerId, u.email]))[0];

  let contactId: number | null = theirs?.id ?? null;
  if (!contactId && mine) {
    await pool.query(
      `UPDATE customer_contacts
          SET customer_id=$1,
              job_title = CASE WHEN job_title LIKE 'Self-registered%' THEN NULL ELSE job_title END,
              portal_access_level = COALESCE(portal_access_level,'tickets')
        WHERE id=$2`, [customerId, mine.id]);
    contactId = mine.id;
  } else if (contactId && mine) {
    // They already existed at the real customer: keep that record as the real one and retire
    // the placeholder duplicate rather than leaving two rows with the same address.
    await pool.query("UPDATE customer_contacts SET archived=true WHERE id=$1", [mine.id]);
    await pool.query(
      "UPDATE customer_contacts SET portal_access_level = COALESCE(portal_access_level,'tickets') WHERE id=$1",
      [contactId]);
  }

  // The tickets follow the person. Scoped to the ones raised under the placeholder, so this
  // can never sweep up a ticket that belongs to somebody else.
  const moved = await pool.query(
    `UPDATE inbox_tickets SET customer_id=$1, contact_id=COALESCE($2, contact_id)
      WHERE customer_id=$3 AND contact_id = ANY($4::int[])`,
    [customerId, contactId, oldCustomerId, [mine?.id, theirs?.id].filter(Boolean)]);

  await pool.query('UPDATE users SET customer_id=$1 WHERE id=$2', [customerId, userId]);

  await logActivity(req.session.user!.id, 'self_signup_link', 'customers', customerId,
    `Linked self-registered account ${u.email} to ${cust.name}`
    + (moved.rowCount ? ` (${moved.rowCount} ticket${moved.rowCount === 1 ? '' : 's'} moved)` : ''));

  return back('ok=' + encodeURIComponent(
    `${u.email} linked to ${cust.name}` + (moved.rowCount ? `, ${moved.rowCount} ticket(s) moved.` : '.')));
});

/** Turn one off without deleting anything — the tickets and the audit trail stay put. */
router.post('/admin/self-registered/:id/disable', async (req: Request, res: Response) => {
  const userId = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(userId)) return res.redirect('/admin/self-registered');
  const u = (await rows("SELECT email FROM users WHERE id=$1 AND signup_source IS NOT NULL", [userId]))[0];
  if (!u) return res.redirect('/admin/self-registered?err=' + encodeURIComponent('That is not a self-registered account.'));
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [userId]);
  await logActivity(req.session.user!.id, 'self_signup_disable', 'users', userId,
    `Disabled self-registered account ${u.email}`);
  res.redirect('/admin/self-registered?ok=' + encodeURIComponent(u.email + ' can no longer sign in.'));
});

export default router;
