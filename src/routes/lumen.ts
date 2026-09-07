import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { getSetting, setSetting } from '../lib/settings';
import { logActivity } from '../lib/activity';

// ── Lumen launcher (Terry, 7 Sep 2026) ─────────────────────────────────────────
// Lumen is a SEPARATE app (D:\LITS\LumenMSP - Lumen, port 3800, lumen.lumenmsp.co.uk) so it
// can be changed all day without redeploying the Portal. This file is the Portal's whole share
// of it: mint a short-lived hand-off token for the signed-in user, and keep the beta list.
//
//   GET  /lumen/token   → { ok, token, url }   (only for users in settings lumen/beta_user_ids)
//   GET  /lumen/admin   → beta list + Lumen URL (admin)
//   POST /lumen/admin
//
// The token is base64url(JSON{uid, iat, exp}) + '.' + HMAC-SHA256(secret, payload). The secret
// is a settings row (group 'lumen', key 'handoff_secret'), made here on first use; Lumen reads
// the same row from the same database to verify. Twelve hours, matching the Portal session.
// The person's role and boxes are NOT in the token — Lumen reads them live from users.

const router = Router();

export async function lumenBetaIds(): Promise<Set<number>> {
  return new Set(String((await getSetting('lumen', 'beta_user_ids')) || '').split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => n > 0));
}
export async function lumenUrl(): Promise<string> {
  return (((await getSetting('lumen', 'url')) || '').trim() || 'https://lumen.lumenmsp.co.uk').replace(/\/$/, '');
}

async function secret(): Promise<string> {
  let s = ((await getSetting('lumen', 'handoff_secret')) || '').trim();
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await setSetting('lumen', 'handoff_secret', s); }
  return s;
}

router.get('/lumen/token', requireAuth, async (req: Request, res: Response) => {
  const u = req.session.user!;
  if (!(await lumenBetaIds()).has(u.id)) { res.status(404).json({ ok: false }); return; }
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ uid: u.id, iat: now, exp: now + 12 * 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', await secret()).update(payload).digest('hex');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, token: `${payload}.${sig}`, url: await lumenUrl() });
});

router.get('/lumen/admin', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  res.render('lumen-admin', {
    user: req.session.user!, csrfToken: (req.session as any).csrfToken,
    ids: (await getSetting('lumen', 'beta_user_ids')) || '', url: await lumenUrl(),
    notice: req.query.msg || null,
  });
});

router.post('/lumen/admin', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const ids = String(req.body.beta_user_ids || '').split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
  await setSetting('lumen', 'beta_user_ids', ids.join(','));
  const url = String(req.body.url || '').trim();
  if (/^https:\/\/[a-z0-9.-]+$/i.test(url)) await setSetting('lumen', 'url', url);
  await logActivity(req.session.user!.id, 'lumen_admin', null, null, `Lumen beta users: ${ids.join(',') || 'none'}`);
  res.redirect('/lumen/admin?msg=' + encodeURIComponent('Saved. Takes effect on the next page load.'));
});

export default router;
