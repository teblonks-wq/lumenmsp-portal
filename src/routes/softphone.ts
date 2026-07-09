import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { callHistory } from '../lib/callhub';

// Soft Phone page — WhatsApp call history + the call-backs that still need making
// (missed inbound calls whose 24h service window is still open).
const router = Router();

router.get('/softphone', requireAuth, async (req: Request, res: Response) => {
  let history: any[] = [];
  try { history = await callHistory(80); } catch { history = []; }

  // Most-recent row per peer (history is sorted newest-first). If a peer's latest call was a
  // missed inbound and the window's still open, it's a call-back to make.
  const seen = new Set<string>();
  const latestPerPeer: any[] = [];
  for (const h of history) { if (!seen.has(h.peer)) { seen.add(h.peer); latestPerPeer.push(h); } }
  const callbacks = latestPerPeer.filter(
    (h) => h.direction === 'inbound' && h.callable && !/completed/i.test(String(h.status || ''))
  );

  res.render('softphone', { user: req.session.user!, history, callbacks });
});

export default router;
