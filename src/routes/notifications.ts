import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

// Active notifications for the bell (not cleared, not currently snoozed).
router.get('/notifications.json', requireAuth, async (req: Request, res: Response) => {
  const uid = req.session.user!.id;
  const { rows } = await pool.query(
    `SELECT id, type, title, body, link, read_at, created_at FROM notifications
     WHERE user_id=$1 AND cleared_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= NOW())
     ORDER BY created_at DESC LIMIT 30`, [uid]
  );
  res.json({ items: rows, unread: rows.filter((r: any) => !r.read_at).length });
});

router.post('/notifications/:id/clear', requireAuth, async (req: Request, res: Response) => {
  await pool.query('UPDATE notifications SET cleared_at=NOW() WHERE id=$1 AND user_id=$2',
    [parseInt(String(req.params.id), 10), req.session.user!.id]);
  res.json({ ok: true });
});

router.post('/notifications/:id/snooze', requireAuth, async (req: Request, res: Response) => {
  const mins = parseInt(String((req.body && req.body.minutes) || '60'), 10) || 60;
  await pool.query(
    `UPDATE notifications SET snoozed_until = NOW() + ($3 || ' minutes')::interval, read_at = COALESCE(read_at, NOW())
     WHERE id=$1 AND user_id=$2`,
    [parseInt(String(req.params.id), 10), req.session.user!.id, String(mins)]
  );
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, async (req: Request, res: Response) => {
  await pool.query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [req.session.user!.id]);
  res.json({ ok: true });
});

// Full panel — everything, including cleared.
router.get('/notifications', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200', [req.session.user!.id]
  );
  res.render('notifications', { user: req.session.user!, items: rows });
});

export default router;
