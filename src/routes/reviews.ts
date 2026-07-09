import { Router, Request, Response } from 'express';
import cron from 'node-cron';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { alertGroup } from '../lib/notifications';
import { config } from '../config';

const router = Router();
const SECTIONS = ['concern', 'service', 'future', 'current', 'note'];

// ── Global A-Z overview ──────────────────────────────────────────────────────────
router.get('/a-z', requireAuth, async (req: Request, res: Response) => {
  const cust = await pool.query(
    `SELECT c.id, c.name, c.last_reviewed_at,
            (c.last_reviewed_at IS NULL OR c.last_reviewed_at < NOW() - INTERVAL '6 months') AS overdue
     FROM customers c
     WHERE c.deleted_at IS NULL AND c.is_placeholder=false AND c.status='active'
     ORDER BY c.name ASC`
  );
  const items = await pool.query(
    `SELECT ri.id, ri.customer_id, ri.section, ri.body, ri.due_date
     FROM customer_review_items ri JOIN customers c ON c.id=ri.customer_id
     WHERE c.deleted_at IS NULL AND ri.status='open'
     ORDER BY ri.section, ri.id`
  );
  const byCust: Record<number, any[]> = {};
  items.rows.forEach((r: any) => { (byCust[r.customer_id] = byCust[r.customer_id] || []).push(r); });
  res.render('a-z', { user: req.session.user!, customers: cust.rows, byCust });
});

// Add a review item to a customer
router.post('/customers/:id/review-items', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body as any;
  const section = SECTIONS.includes(b.section) ? b.section : 'note';
  const body = (b.body || '').trim();
  const due = (b.due_date || '').trim() || null;
  if (body) {
    await pool.query(
      'INSERT INTO customer_review_items (customer_id, section, body, due_date, created_by_user_id) VALUES ($1,$2,$3,$4,$5)',
      [id, section, body, due, req.session.user!.id]
    );
  }
  res.redirect('/customers/' + id + '#review');
});

router.post('/review-items/:id/toggle', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query(
    `UPDATE customer_review_items
     SET status = CASE WHEN status='open' THEN 'done' ELSE 'open' END,
         completed_at = CASE WHEN status='open' THEN NOW() ELSE NULL END, updated_at=NOW()
     WHERE id=$1`, [id]
  );
  res.redirect(req.get('referer') || '/a-z');
});

router.post('/review-items/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('DELETE FROM customer_review_items WHERE id=$1', [id]);
  res.redirect(req.get('referer') || '/a-z');
});

router.post('/customers/:id/mark-reviewed', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE customers SET last_reviewed_at=NOW() WHERE id=$1', [id]);
  res.redirect('/customers/' + id + '#review');
});

export default router;

// Daily 08:00 — remind the sales/support group of review action items that are due.
let _started = false;
export function startReviewReminders(): void {
  if (_started) return;
  _started = true;
  cron.schedule('0 8 * * *', async () => {
    try {
      const due = await pool.query(
        `SELECT ri.id, ri.body, ri.customer_id, c.name AS customer_name
         FROM customer_review_items ri JOIN customers c ON c.id=ri.customer_id
         WHERE ri.status='open' AND ri.reminder_sent=false AND ri.due_date IS NOT NULL AND ri.due_date <= CURRENT_DATE
           AND c.deleted_at IS NULL`
      );
      for (const r of due.rows) {
        await alertGroup('sales', 'Review action due — ' + r.customer_name, r.body.slice(0, 140), '/customers/' + r.customer_id + '#review');
        await pool.query('UPDATE customer_review_items SET reminder_sent=true WHERE id=$1', [r.id]);
      }
      if (due.rows.length) console.log(`[reviews] ${due.rows.length} review reminders sent`);
    } catch (e) { console.error('[reviews] reminder error:', (e as Error).message); }
  });
  console.log('[reviews] daily review reminders scheduled (08:00)');
}
