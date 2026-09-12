import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import { gateDownload, claimDownload, downloadUrl } from '../lib/guides';

// ── PUBLIC, unauthenticated guide gate ──────────────────────────────────────────
// Two endpoints, both reached from the static landing page on www.lumenmsp.co.uk:
//   POST /api/guide-lead   name + email  ->  { ok, url }   (creates the Portal lead)
//   GET  /g/:token         the PDF itself, streamed from the Portal's private store
// No session and no CSRF token: the global CSRF guard only applies to logged-in requests,
// and a cross-origin fetch carries no cookies anyway. CORS is open because the page that
// calls it is on a different host to the Portal.

const router = Router();

router.use('/api/guide-lead', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Crude per-IP throttle. A guide form is a free write into the leads table, so it is exactly
// the kind of endpoint a bot enjoys; 12 an hour is far more than any real visitor needs.
const hits = new Map<string, { n: number; at: number }>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 3600_000) { hits.set(ip, { n: 1, at: now }); return false; }
  h.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.at > 3600_000) hits.delete(k);
  return h.n > 12;
}

const clientIp = (req: Request): string =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

router.post('/api/guide-lead', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    // Honeypot: a real person never fills a field they cannot see. Answer as if it worked -
    // a bot that is told it failed simply tries again with the field left blank.
    if (String(b.website || '').trim()) { res.json({ ok: true, url: '' }); return; }

    const slug = String(b.slug || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    if (!slug) { res.status(400).json({ ok: false, error: 'Missing guide.' }); return; }
    if (!name) { res.status(400).json({ ok: false, error: 'Please tell us your name.' }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { res.status(400).json({ ok: false, error: 'That email address does not look right.' }); return; }
    if (throttled(clientIp(req))) { res.status(429).json({ ok: false, error: 'Too many requests from this connection — try again shortly.' }); return; }

    const r = await gateDownload({
      slug, name, email,
      company: String(b.company || ''), phone: String(b.phone || ''),
      optIn: b.optin === true || b.optin === 'true' || b.optin === 'on',
      ip: clientIp(req), userAgent: String(req.headers['user-agent'] || ''),
    });
    res.json({ ok: true, url: downloadUrl(r.token), title: r.title });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Could not fetch that guide.' });
  }
});

const gonePage = (msg: string) =>
  `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<title>Guide not found — Lumen IT Solutions</title></head>`
  + `<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f1f5f9;margin:0;">`
  + `<div style="max-width:480px;margin:12vh auto;background:#fff;border-radius:16px;padding:36px 32px;box-shadow:0 12px 30px rgba(2,6,23,.12);text-align:center;">`
  + `<h1 style="font-size:22px;margin:0 0 10px;color:#0f172a;">We couldn't find that guide</h1>`
  + `<div style="color:#475569;font-size:15px;line-height:1.5;">${msg}</div>`
  + `<p style="color:#94a3b8;font-size:13px;margin:24px 0 0;">Lumen IT Solutions</p>`
  + `</div></body></html>`;

router.get('/g/:token', async (req: Request, res: Response) => {
  const f = await claimDownload(String(req.params.token || '')).catch(() => null);
  if (!f) {
    res.status(404).send(gonePage('This download link is not valid, or the guide has been withdrawn. Email <a href="mailto:hello@lumenmsp.co.uk">hello@lumenmsp.co.uk</a> and we will send it straight over.'));
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + f.name.replace(/"/g, '') + '"');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(f.path).pipe(res);
});

export default router;
