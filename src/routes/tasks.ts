import { Router, Request, Response } from 'express';
import cron from 'node-cron';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { notify } from '../lib/notifications';

const router = Router();
const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['open', 'in_progress', 'done', 'cancelled'];

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/tasks', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const scope = ((req.query.scope as string) || 'mine').trim();
  const status = ((req.query.status as string) || '').trim();

  const where: string[] = [];
  const params: any[] = [];
  if (scope === 'mine') { params.push(user.id); where.push('t.assigned_to_user_id = $' + params.length); }
  if (status && STATUSES.includes(status)) { params.push(status); where.push('t.status = $' + params.length); }
  else if (!status) where.push("t.status IN ('open','in_progress')");
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS assigned_name, c.name AS customer_name
     FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to_user_id LEFT JOIN customers c ON c.id=t.related_customer_id
     ${whereSql} ORDER BY (t.due_date IS NULL), t.due_date ASC, t.priority DESC, t.id DESC`, params
  );
  res.render('tasks/list', { user, tasks: rows, scope, status });
});

async function formData() {
  const [users, customers] = await Promise.all([
    pool.query('SELECT id, display_name FROM users WHERE is_active=true ORDER BY display_name'),
    pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`),
  ]);
  return { users: users.rows, customers: customers.rows };
}

router.get('/tasks/new', requireAuth, async (req: Request, res: Response) => {
  const fd = await formData();
  res.render('tasks/form', { user: req.session.user!, task: null, ...fd, error: null });
});

router.get('/tasks/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM tasks WHERE id=$1 LIMIT 1', [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'Task not found.' }); return; }
  const fd = await formData();
  res.render('tasks/form', { user: req.session.user!, task: r.rows[0], ...fd, error: null });
});

function readBody(b: any, userId: number) {
  return {
    title: (b.title || '').trim(),
    description: nz(b.description),
    assignedToUserId: b.assigned_to_user_id ? parseInt(b.assigned_to_user_id, 10) : userId,
    priority: PRIORITIES.includes(b.priority) ? b.priority : 'medium',
    status: STATUSES.includes(b.status) ? b.status : 'open',
    dueDate: nz(b.due_date),
    dueTime: nz(b.due_time),
    relatedCustomerId: b.related_customer_id ? parseInt(b.related_customer_id, 10) : null,
  };
}

router.post('/tasks', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const d = readBody(req.body, user.id);
  if (!d.title) { const fd = await formData(); res.render('tasks/form', { user, task: req.body, ...fd, error: 'Title is required.' }); return; }
  await pool.query(
    `INSERT INTO tasks (title, description, assigned_to_user_id, created_by_user_id, priority, status, due_date, due_time, related_customer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [d.title, d.description, d.assignedToUserId, user.id, d.priority, d.status, d.dueDate, d.dueTime, d.relatedCustomerId]
  );
  res.redirect('/tasks');
});

router.post('/tasks/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const d = readBody(req.body, user.id);
  await pool.query(
    `UPDATE tasks SET title=$1, description=$2, assigned_to_user_id=$3, priority=$4, status=$5, due_date=$6, due_time=$7, related_customer_id=$8, updated_at=NOW()
     WHERE id=$9`,
    [d.title, d.description, d.assignedToUserId, d.priority, d.status, d.dueDate, d.dueTime, d.relatedCustomerId, id]
  );
  res.redirect('/tasks');
});

router.post('/tasks/:id/done', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query(`UPDATE tasks SET status='done', completed_at=NOW(), completed_by_user_id=$1, updated_at=NOW() WHERE id=$2`, [user.id, id]);
  res.redirect(req.get('referer') || '/tasks');
});

router.post('/tasks/:id/reopen', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query(`UPDATE tasks SET status='open', completed_at=NULL, completed_by_user_id=NULL, updated_at=NOW() WHERE id=$1`, [id]);
  res.redirect(req.get('referer') || '/tasks');
});

router.post('/tasks/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('DELETE FROM tasks WHERE id=$1', [id]);
  res.redirect('/tasks');
});

// Daily 08:00 — notify owners of tasks due today or overdue (once, via reminder_sent).
export function startTaskReminders(): void {
  cron.schedule('0 8 * * *', async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, assigned_to_user_id, due_date FROM tasks
          WHERE status IN ('open','in_progress') AND assigned_to_user_id IS NOT NULL
            AND reminder_sent = false AND due_date IS NOT NULL AND due_date <= CURRENT_DATE`
      );
      for (const t of rows) {
        const overdue = new Date(t.due_date) < new Date(new Date().toDateString());
        await notify(t.assigned_to_user_id, `${overdue ? 'Overdue' : 'Due today'}: ${t.title}`,
          { type: 'task', link: '/tasks/edit?id=' + t.id });
        await pool.query('UPDATE tasks SET reminder_sent=true WHERE id=$1', [t.id]);
      }
      if (rows.length) console.log(`[tasks] sent ${rows.length} due-task reminder(s)`);
    } catch (e) { console.error('[tasks] reminder error:', (e as Error).message); }
  });
  console.log('[tasks] due-task reminders scheduled (08:00)');
}

export default router;
