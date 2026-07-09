import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { listAlerts, resolveAlertById, createTicketForAlert } from '../lib/alerts';

// N3twrx — network tools hub (UniFi + Giacom/comms outages now; Azure & more to come).
const router = Router();

router.get('/n3twrx', requireAuth, async (req: Request, res: Response) => {
  const status = req.query.status === 'all' ? 'all' : 'open';
  let alerts: any[] = [];
  try { alerts = await listAlerts(status, 150); } catch { alerts = []; }
  res.render('network/index', { user: req.session.user!, alerts, status, notice: req.query.msg || null });
});

// Live poll for open alerts (the page refreshes the list without a full reload).
router.get('/n3twrx/alerts.json', requireAuth, async (_req: Request, res: Response) => {
  try { res.json(await listAlerts('open', 150)); } catch { res.json([]); }
});

router.post('/n3twrx/alert/:id/resolve', requireAuth, async (req: Request, res: Response) => {
  await resolveAlertById(parseInt(String(req.params.id), 10)).catch(() => {});
  res.redirect('/n3twrx?msg=' + encodeURIComponent('Alert resolved'));
});

// Manually raise a ticket for an alert (UniFi alerts don't auto-create one).
router.post('/n3twrx/alert/:id/ticket', requireAuth, async (req: Request, res: Response) => {
  const tid = await createTicketForAlert(parseInt(String(req.params.id), 10)).catch(() => null);
  if (tid) { res.redirect('/tickets/' + tid); return; }
  res.redirect('/n3twrx?msg=' + encodeURIComponent('Could not create ticket'));
});

export default router;
