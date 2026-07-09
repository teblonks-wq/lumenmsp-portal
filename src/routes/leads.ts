import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { getComms } from './comms';
import { logActivity } from '../lib/activity';
import { notify } from '../lib/notifications';

const router = Router();
const STAGES = ['new', 'open', 'proposed', 'won', 'lost'];
const OPEN_STAGES = ['new', 'open', 'proposed'];

// Keep the customer's legacy lead_status / status in sync with the lead so the
// dashboard, customer card and quote-accept flow stay consistent.
async function syncCustomer(customerId: number, status: string): Promise<void> {
  if (status === 'won') {
    await pool.query("UPDATE customers SET lead_status='won', status='active', updated_at=NOW() WHERE id=$1", [customerId]);
  } else {
    await pool.query("UPDATE customers SET lead_status=$1, status='lead', updated_at=NOW() WHERE id=$2 AND status<>'active'", [status, customerId]);
  }
}

// ── Pipeline list ────────────────────────────────────────────────────────────────
router.get('/leads', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const stage = ((req.query.status as string) || '').trim();
  const search = ((req.query.search as string) || '').trim();

  const where: string[] = ['l.deleted_at IS NULL'];
  const params: any[] = [];
  if (stage === 'open') { where.push(`l.status = ANY($${params.push(OPEN_STAGES)})`); }
  else if (STAGES.includes(stage)) { params.push(stage); where.push(`l.status = $${params.length}`); }
  if (search) { params.push('%' + search + '%'); where.push(`(c.name ILIKE $${params.length} OR l.source ILIKE $${params.length})`); }

  const { rows } = await pool.query(
    `SELECT l.id, l.status, l.source, l.estimated_value, l.created_at, l.owner_user_id, l.follow_up_at, l.follow_up_note,
            c.id AS customer_id, c.name AS customer_name, c.phone,
            u.display_name AS owner_name,
            (SELECT cc.full_name FROM customer_contacts cc WHERE cc.customer_id=c.id ORDER BY cc.is_primary DESC, cc.id LIMIT 1) AS primary_contact_name,
            (SELECT cc.email     FROM customer_contacts cc WHERE cc.customer_id=c.id ORDER BY cc.is_primary DESC, cc.id LIMIT 1) AS primary_contact_email,
            (SELECT COUNT(*)::int FROM quotes q WHERE q.customer_id=c.id AND q.deleted_at IS NULL) AS quote_count,
            (SELECT COALESCE(SUM(total),0) FROM quotes q WHERE q.customer_id=c.id AND q.deleted_at IS NULL AND q.status IN ('draft','sent')) AS quote_pipeline
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       LEFT JOIN users u ON u.id = l.owner_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC`, params
  );

  const sc = await pool.query('SELECT status AS s, COUNT(*)::int n FROM leads WHERE deleted_at IS NULL GROUP BY status');
  const counts: Record<string, number> = {};
  sc.rows.forEach((r: any) => { counts[r.s] = r.n; });
  const won = counts.won || 0, lost = counts.lost || 0;
  const conversion = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;
  const pipelineValue = rows
    .filter((r: any) => OPEN_STAGES.includes(r.status))
    .reduce((s: number, r: any) => s + Number(r.estimated_value || r.quote_pipeline || 0), 0);

  res.render('leads/list', {
    user, leads: rows, stage, search, counts, STAGES,
    stats: { conversion, won, lost, pipelineValue, open: (counts.new || 0) + (counts.open || 0) + (counts.proposed || 0) },
  });
});

// ── New lead form ──────────────────────────────────────────────────────────────
router.get('/leads/new', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const presetCustomer = parseInt(String(req.query.customer || ''), 10) || null;
  const [customers, users] = await Promise.all([
    pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name"),
    pool.query("SELECT id, display_name FROM users WHERE is_active=true ORDER BY display_name"),
  ]);
  res.render('leads/form', {
    user, lead: null, customers: customers.rows, users: users.rows, presetCustomer, STAGES,
    error: req.query.err || null,
  });
});

// ── Create a lead (new prospect customer, or attach to an existing one) ──────────
router.post('/leads', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  let customerId = parseInt(String(b.customer_id || ''), 10) || null;

  // New prospect customer from the company name.
  if (!customerId) {
    const name = String(b.company_name || '').trim();
    if (!name) { res.redirect('/leads/new?err=' + encodeURIComponent('A company name (or existing customer) is required')); return; }
    const ins = await pool.query(
      "INSERT INTO customers (name, status, lead_source, phone, email, created_by) VALUES ($1,'lead',$2,$3,$4,$5) RETURNING id",
      [name, String(b.source || '').trim() || null, String(b.phone || '').trim() || null, String(b.email || '').trim() || null, user.id]
    );
    customerId = ins.rows[0].id;
    // Optional primary contact.
    const cname = String(b.contact_name || '').trim();
    if (cname) {
      await pool.query(
        "INSERT INTO customer_contacts (customer_id, full_name, email, phone, is_primary) VALUES ($1,$2,$3,$4,true)",
        [customerId, cname, String(b.email || '').trim() || null, String(b.phone || '').trim() || null]
      );
    }
  }

  const status = STAGES.includes(b.status) ? b.status : 'new';
  const value = parseFloat(String(b.estimated_value || '').replace(/[^0-9.\-]/g, ''));
  const ownerId = parseInt(String(b.owner_user_id || ''), 10) || user.id;
  const r = await pool.query(
    `INSERT INTO leads (customer_id, status, source, services_interested, details, estimated_value, owner_user_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [customerId, status, String(b.source || '').trim() || null, String(b.services_interested || '').trim() || null,
     String(b.details || '').trim() || null, isNaN(value) ? null : value, ownerId, user.id]
  );
  await syncCustomer(customerId as number, status);
  await logActivity(user.id, 'created', 'lead', r.rows[0].id, 'Lead created');
  res.redirect('/leads/' + r.rows[0].id);
});

// ── Lead detail (comms + history at the top) ──────────────────────────────────────
router.get('/leads/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT l.*, c.name AS customer_name, c.status AS customer_status, u.display_name AS owner_name
       FROM leads l JOIN customers c ON c.id = l.customer_id
       LEFT JOIN users u ON u.id = l.owner_user_id
      WHERE l.id=$1 AND l.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Lead not found.' }); return; }
  const lead = r.rows[0];
  const customerId = lead.customer_id;
  const [contacts, quotes, comms, users] = await Promise.all([
    pool.query('SELECT id, full_name, email, phone, mobile_phone, job_title, is_primary FROM customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, full_name', [customerId]),
    pool.query('SELECT id, quote_number, title, status, total FROM quotes WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY id DESC', [customerId]),
    getComms('customer', customerId),
    pool.query("SELECT id, display_name FROM users WHERE is_active=true ORDER BY display_name"),
  ]);
  const toContacts = contacts.rows.filter((c: any) => c.email);
  res.render('leads/detail', {
    user, lead, customerId, contacts: contacts.rows, quotes: quotes.rows, comms, users: users.rows,
    toContacts, commsTo: toContacts[0] ? toContacts[0].email : '', STAGES,
    notice: req.query.msg || null,
  });
});

// ── Move pipeline stage ───────────────────────────────────────────────────────────
router.post('/leads/:id/status', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const status = String(req.body.status || req.body.lead_status || '');
  if (!STAGES.includes(status)) { res.redirect('/leads/' + id); return; }
  const cur = await pool.query('SELECT customer_id FROM leads WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!cur.rows.length) { res.redirect('/leads'); return; }
  await pool.query(
    `UPDATE leads SET status=$1, won_at=CASE WHEN $1='won' THEN NOW() ELSE won_at END,
            lost_at=CASE WHEN $1='lost' THEN NOW() ELSE lost_at END,
            lost_reason=CASE WHEN $1='lost' THEN $2 ELSE lost_reason END, updated_at=NOW()
      WHERE id=$3`,
    [status, String(req.body.lost_reason || '').trim() || null, id]
  );
  await syncCustomer(cur.rows[0].customer_id, status);
  await logActivity(user.id, 'status_changed', 'lead', id, `Lead moved to ${status}`);
  if (status === 'won') {
    const l = (await pool.query('SELECT l.owner_user_id, c.name FROM leads l JOIN customers c ON c.id=l.customer_id WHERE l.id=$1', [id])).rows[0];
    if (l?.owner_user_id) await notify(l.owner_user_id, `Lead won — ${l.name}`, { type: 'lead', body: 'Converted to a customer', link: '/leads/' + id });
  }
  res.redirect('/leads/' + id);
});

// ── Edit lead properties ───────────────────────────────────────────────────────────
router.post('/leads/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const value = parseFloat(String(b.estimated_value || '').replace(/[^0-9.\-]/g, ''));
  const ownerId = parseInt(String(b.owner_user_id || ''), 10) || null;
  const followUpAt = String(b.follow_up_at || '').trim() || null;   // yyyy-mm-dd from the date input, or null to clear
  const followUpNote = String(b.follow_up_note || '').trim() || null;
  await pool.query(
    `UPDATE leads SET source=$1, services_interested=$2, details=$3, estimated_value=$4, owner_user_id=$5,
            follow_up_at=$6, follow_up_note=$7, updated_at=NOW()
      WHERE id=$8 AND deleted_at IS NULL`,
    [String(b.source || '').trim() || null, String(b.services_interested || '').trim() || null,
     String(b.details || '').trim() || null, isNaN(value) ? null : value, ownerId, followUpAt, followUpNote, id]
  );
  await logActivity(user.id, 'updated', 'lead', id, 'Lead details updated');
  res.redirect('/leads/' + id + '?msg=' + encodeURIComponent('Lead updated'));
});

// ── Soft-delete a lead (recoverable from the recycle bin) ──────────────────────────
router.post('/leads/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE leads SET deleted_at=NOW(), deleted_by_user_id=$2 WHERE id=$1 AND deleted_at IS NULL', [id, user.id]);
  await logActivity(user.id, 'deleted', 'lead', id, 'Lead deleted');
  res.redirect('/leads?msg=' + encodeURIComponent('Lead deleted'));
});

export default router;
