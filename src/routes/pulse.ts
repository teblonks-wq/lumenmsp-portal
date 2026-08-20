import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { feed, dismiss, PULSE_KINDS, publish } from '../lib/pulse';
import { saveSubscription, removeSubscription, vapidPublicKey, pushConfigured, parsePrefs, sendToUser } from '../lib/webpush';

// ─────────────────────────────────────────────────────────────────────────────────
// The Pulse's own routes: the feed as JSON (pull-to-refresh polls it), dismissing a
// card, registering a phone for push, and the notification preferences screen.
//
// Staff only. Customer-scoped logins never see the Pulse: it is the ESTATE's briefing,
// and its cards routinely name other customers.
// ─────────────────────────────────────────────────────────────────────────────────

const router = Router();

function staffOnly(req: Request, res: Response): boolean {
  const u = req.session.user;
  if (!u) { res.status(401).json({ ok: false, error: 'signed out' }); return false; }
  if (u.role === 'customer' || u.role === 'bookkeeper') { res.status(403).json({ ok: false, error: 'staff only' }); return false; }
  return true;
}

/** The briefing, for the home screen's refresh without a full page load. */
router.get('/m/pulse.json', async (req: Request, res: Response) => {
  if (!staffOnly(req, res)) return;
  res.json({ ok: true, cards: await feed(), pushConfigured: pushConfigured() });
});

router.post('/m/pulse/:id/dismiss', async (req: Request, res: Response) => {
  if (!staffOnly(req, res)) return;
  await dismiss(parseInt(String(req.params.id), 10) || 0);
  res.json({ ok: true });
});

/** The public half of the VAPID pair - the browser needs it to subscribe. */
router.get('/m/push/key', (req: Request, res: Response) => {
  if (!staffOnly(req, res)) return;
  res.json({ ok: true, key: vapidPublicKey(), configured: pushConfigured() });
});

router.post('/m/push/subscribe', async (req: Request, res: Response) => {
  if (!staffOnly(req, res)) return;
  const ok = await saveSubscription(req.session.user!.id, (req.body || {}).subscription, req.get('user-agent') || undefined);
  res.json({ ok });
});

router.post('/m/push/unsubscribe', async (req: Request, res: Response) => {
  if (!staffOnly(req, res)) return;
  await removeSubscription(String((req.body || {}).endpoint || ''));
  res.json({ ok: true });
});

/**
 * "Send me a test push" - the button that proves the whole pipe in one tap. Sent only
 * to the PERSON WHO PRESSED IT: a test that pings the whole support group teaches
 * everyone that pushes can be noise, which is the covenant dying on day one.
 */
router.post('/m/push/test', async (req: Request, res: Response) => {
  if (!staffOnly(req, res)) return;
  const n = await sendToUser(req.session.user!.id, {
    title: '✅ Push is working', body: 'This is your test notification from the Lumen MSP Portal.', url: '/m',
  });
  res.json({ ok: n > 0, devices: n });
});

// ── Notification preferences ─────────────────────────────────────────────────────
router.get('/m/settings', async (req: Request, res: Response) => {
  const u = req.session.user;
  if (!u || u.role === 'customer' || u.role === 'bookkeeper') { res.redirect('/m'); return; }
  const row = (await pool.query('SELECT push_prefs FROM users WHERE id=$1', [u.id])).rows[0];
  const prefs = parsePrefs(row?.push_prefs);
  // Only kinds that CAN push appear in the mute list - muting a feed-only kind would
  // suggest the feed itself can be silenced, which it deliberately cannot.
  const kinds = Object.entries(PULSE_KINDS).filter(([, v]) => v.push)
    .map(([k, v]) => ({ key: k, label: v.label, icon: v.icon, muted: prefs.muted.includes(k) }));
  res.render('mobile/settings', {
    user: u, active: 'home', kinds, prefs,
    pushOn: pushConfigured(),
    notice: req.query.msg || null,
  });
});

router.post('/m/settings', async (req: Request, res: Response) => {
  const u = req.session.user;
  if (!u || u.role === 'customer' || u.role === 'bookkeeper') { res.redirect('/m'); return; }
  const b = req.body || {};
  const muted = Object.keys(PULSE_KINDS).filter((k) => PULSE_KINDS[k].push && b['mute_' + k] === 'on');
  const qs = String(b.quiet_start || '').trim(), qe = String(b.quiet_end || '').trim();
  const valid = /^\d{1,2}:\d{2}$/;
  const quiet = valid.test(qs) && valid.test(qe) && qs !== qe ? { start: qs, end: qe } : null;
  await pool.query('UPDATE users SET push_prefs=$1 WHERE id=$2', [JSON.stringify({ muted, quiet }), u.id]);
  res.redirect('/m/settings?msg=' + encodeURIComponent('Saved.'));
});

/** Admin smoke test: put a card in the feed without waiting for the estate to misbehave. */
router.post('/m/pulse/demo', async (req: Request, res: Response) => {
  const u = req.session.user;
  if (!u || u.role !== 'admin') { res.status(403).json({ ok: false }); return; }
  const r = await publish({
    kind: 'team', title: 'Pulse demo card — published by ' + u.displayName,
    body: 'If you can read this on the home screen, the feed pipeline works. Dismiss me.',
    link: '/m', dedupeKey: 'demo:' + Date.now(),
  });
  res.json({ ok: r.id > 0, id: r.id });
});

export default router;
