import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;

  const blank = { tickets: {}, quotes: {}, invoices: {}, customers: {} } as any;
  try {
    const [tk, qt, inv, cu] = await Promise.all([
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE status IN ('open','in_progress'))::int AS live,
          COUNT(*) FILTER (WHERE status='new')::int AS new,
          COUNT(*) FILTER (WHERE status='open')::int AS open,
          COUNT(*) FILTER (WHERE status='pending')::int AS pending,
          COUNT(*) FILTER (WHERE assigned_user_id IS NULL AND status NOT IN ('resolved','closed'))::int AS unassigned,
          COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND closed_at::date = CURRENT_DATE)::int AS resolved_today
        FROM inbox_tickets WHERE deleted_at IS NULL AND is_spam = false`),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE status='draft')::int AS draft,
          COUNT(*) FILTER (WHERE status='sent')::int AS sent,
          COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
          COUNT(*) FILTER (WHERE status='lost')::int AS lost,
          COALESCE(SUM(total) FILTER (WHERE status IN ('draft','sent')),0) AS pipeline,
          COALESCE(SUM(total) FILTER (WHERE status='accepted'),0) AS won
        FROM quotes WHERE deleted_at IS NULL`),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE status='draft')::int AS draft,
          COUNT(*) FILTER (WHERE status='issued')::int AS issued,
          COUNT(*) FILTER (WHERE status='paid')::int AS paid,
          COUNT(*) FILTER (WHERE status='void')::int AS void,
          COALESCE(SUM(total) FILTER (WHERE status IN ('issued','paid')),0) AS billed,
          COALESCE(SUM(total) FILTER (WHERE payment_status='paid'),0) AS collected
        FROM invoices WHERE deleted_at IS NULL`),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE status='active')::int AS active,
          COUNT(*) FILTER (WHERE status='lead')::int AS leads
        FROM customers WHERE deleted_at IS NULL AND is_placeholder = false`),
    ]);
    blank.tickets = tk.rows[0]; blank.quotes = qt.rows[0]; blank.invoices = inv.rows[0]; blank.customers = cu.rows[0];
  } catch (e) {
    console.error('Dashboard stats error:', e);
  }

  let myTasks: any[] = [];
  try {
    const r = await pool.query(
      `SELECT id, title, priority, due_date FROM tasks
       WHERE assigned_to_user_id=$1 AND status IN ('open','in_progress')
       ORDER BY (due_date IS NULL), due_date ASC, priority DESC LIMIT 6`, [user.id]
    );
    myTasks = r.rows;
  } catch { /* tasks table may not exist yet */ }

  res.render('dashboard', { user, stats: blank, myTasks });
});

export default router;
