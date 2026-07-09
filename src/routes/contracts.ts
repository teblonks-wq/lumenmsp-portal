import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';

const router = Router();
const STATUSES = ['draft', 'active', 'expired', 'cancelled'];
const SERVICE_TYPES = ['IT', 'Cloud', 'Comms', 'Hardware'];
const PAY_METHODS = ['upfront', 'delivery', 'direct_debit'];
const FREQS = ['monthly', 'annual', 'one_off'];

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const num = (v: any): number => { const x = parseFloat((v ?? '').toString()); return isNaN(x) ? 0 : x; };
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

async function nextContractNumber(): Promise<string> {
  const { rows } = await pool.query('SELECT contract_number FROM contracts');
  let max = 0;
  for (const r of rows) { const m = String(r.contract_number).match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return 'CON-' + String(max + 1).padStart(4, '0');
}

async function saveLines(client: any, contractId: number, body: any): Promise<void> {
  const desc = asArray(body['desc']);
  const qty = asArray(body['qty']);
  const price = asArray(body['price']);
  const freq = asArray(body['freq']);
  const prodId = asArray(body['product_id']);
  await client.query('DELETE FROM contract_lines WHERE contract_id = $1', [contractId]);
  let sort = 1;
  for (let i = 0; i < desc.length; i++) {
    const d = (desc[i] || '').toString().trim();
    if (!d) continue;
    const q = num(qty[i]) || 1, p = num(price[i]);
    const f = FREQS.includes(freq[i]) ? freq[i] : 'monthly';
    const pid = prodId[i] ? (parseInt(prodId[i], 10) || null) : null;
    await client.query(
      `INSERT INTO contract_lines (contract_id, product_id, description, quantity, unit_price, billing_frequency, line_total, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [contractId, pid, d, q, p, f, q * p, sort++]
    );
  }
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/contracts', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const status = ((req.query.status as string) || '').trim();
  const search = ((req.query.search as string) || '').trim();
  const where: string[] = ['ct.deleted_at IS NULL'];
  const params: any[] = [];
  if (status && STATUSES.includes(status)) { params.push(status); where.push('ct.status = $' + params.length); }
  if (search) { params.push('%' + search + '%'); where.push(`(ct.contract_number ILIKE $${params.length} OR ct.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }
  const { rows } = await pool.query(
    `SELECT ct.id, ct.contract_number, ct.title, ct.status, ct.service_type, ct.start_date, ct.end_date,
            c.name AS customer_name, c.id AS customer_id,
            (SELECT COALESCE(SUM(line_total),0) FROM contract_lines cl WHERE cl.contract_id=ct.id AND cl.billing_frequency='monthly') AS monthly_total
     FROM contracts ct LEFT JOIN customers c ON c.id = ct.customer_id
     WHERE ${where.join(' AND ')} ORDER BY ct.id DESC`, params
  );
  const stat = await pool.query(`SELECT status, COUNT(*)::int n FROM contracts WHERE deleted_at IS NULL GROUP BY status`);
  const statusCounts: Record<string, number> = {};
  stat.rows.forEach((r: any) => { statusCounts[r.status] = r.n; });
  res.render('contracts/list', { user, contracts: rows, status, search, statusCounts });
});

// ── New ──────────────────────────────────────────────────────────────────────────
router.get('/contracts/new', requireAuth, async (req: Request, res: Response) => {
  const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
  const preselectCustomer = req.query.customer ? parseInt(String(req.query.customer), 10) : null;
  res.render('contracts/form', { user: req.session.user!, contract: null, lines: [], customers: customers.rows, preselectCustomer, error: null });
});

// ── Create ──────────────────────────────────────────────────────────────────────
router.post('/contracts', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  const title = (b.title || '').trim();
  if (!title) {
    const customers = await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`);
    res.render('contracts/form', { user, contract: b, lines: [], customers: customers.rows, preselectCustomer: null, error: 'Title is required.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cn = await nextContractNumber();
    const { rows } = await client.query(
      `INSERT INTO contracts (customer_id, contract_number, title, status, service_type, start_date, end_date, notice_days, auto_renew, payment_method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, cn, title,
        STATUSES.includes(b.status) ? b.status : 'draft',
        SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'IT',
        nz(b.start_date), nz(b.end_date), parseInt(b.notice_days, 10) || 30,
        b.auto_renew === 'on' || b.auto_renew === '1', PAY_METHODS.includes(b.payment_method) ? b.payment_method : 'upfront',
        nz(b.notes), user.id,
      ]
    );
    await saveLines(client, rows[0].id, b);
    await client.query('COMMIT');
    res.redirect('/contracts/' + rows[0].id);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ── Detail ────────────────────────────────────────────────────────────────────
router.get('/contracts/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const r = await pool.query(
    `SELECT ct.*, c.name AS customer_name FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
     WHERE ct.id=$1 AND ct.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const lines = await pool.query('SELECT * FROM contract_lines WHERE contract_id=$1 ORDER BY sort_order, id', [id]);
  res.render('contracts/detail', { user, contract: r.rows[0], lines: lines.rows });
});

// ── Edit ──────────────────────────────────────────────────────────────────────
router.get('/contracts/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM contracts WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'Contract not found.' }); return; }
  const [lines, customers] = await Promise.all([
    pool.query('SELECT * FROM contract_lines WHERE contract_id=$1 ORDER BY sort_order, id', [id]),
    pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`),
  ]);
  res.render('contracts/form', { user: req.session.user!, contract: r.rows[0], lines: lines.rows, customers: customers.rows, preselectCustomer: null, error: null });
});

// ── Update ──────────────────────────────────────────────────────────────────────
router.post('/contracts/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE contracts SET customer_id=$1, title=$2, status=$3, service_type=$4, start_date=$5, end_date=$6,
         notice_days=$7, auto_renew=$8, payment_method=$9, notes=$10, updated_at=NOW()
       WHERE id=$11 AND deleted_at IS NULL`,
      [
        b.customer_id ? parseInt(b.customer_id, 10) : null, (b.title || '').trim(),
        STATUSES.includes(b.status) ? b.status : 'draft',
        SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'IT',
        nz(b.start_date), nz(b.end_date), parseInt(b.notice_days, 10) || 30,
        b.auto_renew === 'on' || b.auto_renew === '1', PAY_METHODS.includes(b.payment_method) ? b.payment_method : 'upfront',
        nz(b.notes), id,
      ]
    );
    await saveLines(client, id, b);
    await client.query('COMMIT');
    res.redirect('/contracts/' + id);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

router.post('/contracts/:id/status', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const status = String(req.body.status || '');
  if (STATUSES.includes(status)) await pool.query('UPDATE contracts SET status=$1 WHERE id=$2', [status, id]);
  res.redirect('/contracts/' + id);
});

router.post('/contracts/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE contracts SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id=$2', [user.id, id]);
  await logActivity(user.id, 'deleted', 'contracts', id, 'Deleted contract #' + id);
  res.redirect('/contracts');
});

export default router;
