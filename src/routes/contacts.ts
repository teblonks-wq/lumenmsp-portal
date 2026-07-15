import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool, insightsPool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { sendWelcomeEmail } from '../lib/emails';

const router = Router();

// Search contacts (for the merge picker).
router.get('/contacts/search.json', requireAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const exclude = parseInt(String(req.query.exclude || '0'), 10) || 0;
  if (!q) { res.json([]); return; }
  const like = '%' + q + '%';
  const { rows } = await pool.query(
    `SELECT cc.id, cc.full_name, cc.email, c.name AS customer_name
     FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
     WHERE c.deleted_at IS NULL AND cc.id <> $2 AND (cc.full_name ILIKE $1 OR cc.email ILIKE $1)
     ORDER BY cc.full_name LIMIT 15`, [like, exclude]
  );
  res.json(rows);
});

// Merge contact :id (source) INTO target_id (master): fold blanks, repoint refs, delete source.
router.post('/contacts/:id/merge', requireAuth, async (req: Request, res: Response) => {
  const sourceId = parseInt(String(req.params.id), 10);
  const targetId = parseInt(String(req.body.target_id), 10);
  if (!targetId || targetId === sourceId) { res.redirect('/contacts'); return; }
  const src = await pool.query('SELECT * FROM customer_contacts WHERE id=$1', [sourceId]);
  const tgt = await pool.query('SELECT id, full_name FROM customer_contacts WHERE id=$1', [targetId]);
  if (!src.rows.length || !tgt.rows.length) { res.redirect('/contacts'); return; }
  const s = src.rows[0];

  await pool.query(
    `UPDATE customer_contacts SET
       email = COALESCE(NULLIF(email,''), $2),
       phone = COALESCE(NULLIF(phone,''), $3),
       mobile_phone = COALESCE(NULLIF(mobile_phone,''), $4),
       job_title = COALESCE(NULLIF(job_title,''), $5)
     WHERE id=$1`,
    [targetId, s.email, s.phone, s.mobile_phone, s.job_title]
  );
  await pool.query('UPDATE inbox_tickets SET contact_id=$1 WHERE contact_id=$2', [targetId, sourceId]);
  await pool.query('UPDATE tasks SET related_contact_id=$1 WHERE related_contact_id=$2', [targetId, sourceId]);
  await pool.query(
    `UPDATE customers SET
       principal_contact_id = CASE WHEN principal_contact_id=$2 THEN $1 ELSE principal_contact_id END,
       billing_contact_id   = CASE WHEN billing_contact_id=$2   THEN $1 ELSE billing_contact_id   END,
       service_contact_id   = CASE WHEN service_contact_id=$2   THEN $1 ELSE service_contact_id   END`,
    [targetId, sourceId]
  );
  await pool.query('DELETE FROM customer_contacts WHERE id=$1', [sourceId]);
  await logActivity(req.session.user!.id, 'merged', 'contact', targetId, `Merged ${s.full_name} into ${tgt.rows[0].full_name}`);
  res.redirect(req.get('referer') || '/contacts');
});

// Global contacts list (across all customers)
router.get('/contacts', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const search = ((req.query.search as string) || '').trim();
  const filter = ((req.query.filter as string) || '').trim();

  const where: string[] = ['c.deleted_at IS NULL', 'c.is_placeholder = false'];
  const params: any[] = [];
  if (search) {
    params.push('%' + search + '%');
    where.push(`(cc.full_name ILIKE $${params.length} OR cc.email ILIKE $${params.length} OR cc.phone ILIKE $${params.length} OR cc.mobile_phone ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (filter === 'primary') where.push('cc.is_primary = true');
  if (filter === 'third_party') where.push('cc.is_third_party = true');
  const showArchived = (req.query.archived as string) === '1';
  if (!showArchived) where.push('cc.archived = false');

  const { rows } = await pool.query(
    `SELECT cc.id, cc.full_name, cc.email, cc.phone, cc.mobile_phone, cc.job_title, cc.is_primary, cc.is_third_party, cc.archived,
            c.id AS customer_id, c.name AS customer_name
     FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY cc.full_name ASC LIMIT 1000`, params
  );
  const total = await pool.query(
    `SELECT COUNT(*)::int n FROM customer_contacts cc JOIN customers c ON c.id=cc.customer_id WHERE c.deleted_at IS NULL AND c.is_placeholder=false`
  );

  res.render('contacts/list', { user, contacts: rows, search, filter, total: total.rows[0].n, showArchived });
});

// Contact card — open a single contact with their details, tickets (and devices, later).
router.get('/contacts/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(404).render('error', { message: 'Contact not found.' }); return; }
  const r = await pool.query(
    `SELECT cc.*, c.id AS customer_id, c.name AS customer_name, c.portal_enabled
     FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
     WHERE cc.id = $1 AND c.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contact not found.' }); return; }
  const tickets = (await pool.query(
    `SELECT id, ticket_number, subject, status, created_at, updated_at FROM inbox_tickets
     WHERE contact_id = $1 AND deleted_at IS NULL AND is_spam = false
     ORDER BY (status NOT IN ('resolved','closed')) DESC, created_at DESC LIMIT 200`, [id]
  )).rows;
  // Insights sites for the per-contact site layer picker (empty = customer not linked to Insights).
  let insightsSites: { id: number; label: string }[] = [];
  try {
    if (insightsPool) {
      const insRow = (await insightsPool.query(
        'SELECT id FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [r.rows[0].customer_id])).rows[0];
      if (insRow) insightsSites = (await insightsPool.query(
        'SELECT id, site_label AS label FROM sites WHERE customer_id=$1 ORDER BY site_label', [insRow.id])).rows;
    }
  } catch { /* insights DB optional here */ }
  res.render('contacts/detail', {
    user, contact: r.rows[0], tickets, insightsSites,
    msg: req.query.msg || null, err: req.query.err || null,
  });
});

// ── Customer-portal access (per contact) ────────────────────────────────────────
const ACCESS_LEVELS = ['none', 'tickets', 'tickets_insights', 'support_insights', 'finance', 'service', 'full'];

// Set this contact's portal access level. The "enable" tick gates it: unticked ⇒ none.
router.post('/contacts/:id/portal-access', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.redirect('/contacts'); return; }
  let level = String(req.body.portal_access_level || 'none').toLowerCase();
  if (!ACCESS_LEVELS.includes(level)) level = 'none';
  if (!req.body.portal_on) level = 'none';           // the "Allow portal sign-in" tick is the master gate
  // Site layer: 'all' (or an empty selection) stores NULL = every site; otherwise a JSON
  // array of insights site ids. Enforced in /my (OneBoard, Wallboard, Insights tools).
  let sitesJson: string | null = null;
  if (String(req.body.insights_scope || 'all') === 'sites') {
    const raw = req.body.insights_sites;
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((x: any) => parseInt(String(x), 10)).filter(Number.isInteger).slice(0, 50);
    if (ids.length) sitesJson = JSON.stringify(ids);
  }
  await pool.query('UPDATE customer_contacts SET portal_access_level = $1, insights_sites = $2::jsonb WHERE id = $3', [level, sitesJson, id]).catch(() => {});
  await logActivity(req.session.user!.id, 'updated', 'customer_contacts', id, `Portal access set to ${level}${sitesJson ? ' (sites ' + sitesJson + ')' : ' (all sites)'}`).catch(() => {});
  res.redirect('/contacts/' + id + '?msg=' + encodeURIComponent('Portal access updated.') + '#portal');
});

// Send the portal welcome / invite email (Microsoft sign-in instructions) to this contact.
router.post('/contacts/:id/portal-invite', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.redirect('/contacts'); return; }
  const ct = (await pool.query('SELECT full_name, email, portal_access_level FROM customer_contacts WHERE id = $1 LIMIT 1', [id])).rows[0];
  if (!ct || !ct.email) { res.redirect('/contacts/' + id + '?err=' + encodeURIComponent('This contact has no email address to invite.') + '#portal'); return; }
  if (!ct.portal_access_level || ct.portal_access_level === 'none') {
    res.redirect('/contacts/' + id + '?err=' + encodeURIComponent('Give this contact an access level before sending an invite.') + '#portal'); return;
  }
  try {
    await sendWelcomeEmail(ct.email, ct.full_name, user.displayName);
    await logActivity(user.id, 'updated', 'customer_contacts', id, `Portal invite sent to ${ct.email}`).catch(() => {});
    res.redirect('/contacts/' + id + '?msg=' + encodeURIComponent('Invite sent to ' + ct.email) + '#portal');
  } catch (e: any) {
    res.redirect('/contacts/' + id + '?err=' + encodeURIComponent('Could not send invite: ' + (e.message || 'unknown error')) + '#portal');
  }
});

export default router;
