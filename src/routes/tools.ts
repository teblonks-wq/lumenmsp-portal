import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getSetting } from '../lib/settings';
import { pool } from '../db/pool';

const router = Router();

// ── Bookmarks — shared staff quick-links (sidebar dropdown; managed in Settings) ──
// Raw-SQL table; mirrored in prisma/schema.prisma so `prisma db push` keeps it.
let _bmEnsured = false;
async function ensureBookmarks(): Promise<void> {
  if (_bmEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id         SERIAL PRIMARY KEY,
      label      TEXT NOT NULL,
      url        TEXT NOT NULL,
      sort       INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  _bmEnsured = true;
}

router.get('/bookmarks.json', requireAuth, async (_req: Request, res: Response) => {
  try {
    await ensureBookmarks();
    const r = await pool.query('SELECT id, label, url FROM bookmarks ORDER BY sort, lower(label)');
    res.json(r.rows);
  } catch { res.json([]); }
});

router.get('/settings/bookmarks', requireAuth, async (req: Request, res: Response) => {
  await ensureBookmarks();
  const r = await pool.query('SELECT id, label, url, sort FROM bookmarks ORDER BY sort, lower(label)');
  res.render('bookmarks', { user: req.session.user, bookmarks: r.rows, saved: req.query.saved === '1', err: req.query.err || null });
});

router.post('/settings/bookmarks', requireAuth, async (req: Request, res: Response) => {
  await ensureBookmarks();
  const label = String(req.body.label || '').trim().slice(0, 80);
  const url = String(req.body.url || '').trim();
  if (!label || !/^https?:\/\//i.test(url)) {
    res.redirect('/settings/bookmarks?err=' + encodeURIComponent('Label required, and the URL must start with http(s)://')); return;
  }
  const id = req.body.id ? parseInt(String(req.body.id), 10) : null;
  const sort = parseInt(String(req.body.sort || '0'), 10) || 0;
  if (id) await pool.query('UPDATE bookmarks SET label=$2, url=$3, sort=$4 WHERE id=$1', [id, label, url, sort]);
  else await pool.query('INSERT INTO bookmarks (label, url, sort) VALUES ($1,$2,$3)', [label, url, sort]);
  res.redirect('/settings/bookmarks?saved=1');
});

router.post('/settings/bookmarks/:id/delete', requireAuth, async (req: Request, res: Response) => {
  await ensureBookmarks();
  await pool.query('DELETE FROM bookmarks WHERE id=$1', [parseInt(String(req.params.id), 10)]);
  res.redirect('/settings/bookmarks?saved=1');
});

// Insights is a NATIVE Portal section now (2026-07-07) — its views render inside the Portal
// chrome via insights/_layout.ejs, so the iframe embed shell is retired. Keep the old URL
// working for bookmarks with a redirect. (Learn still opens in a new tab — Microsoft SSO
// refuses to render in a frame, and it's a separate app.)
router.get('/tools/insights', requireAuth, (_req: Request, res: Response) => {
  res.redirect('/insights');
});

// Proxy to a LanguageTool server (self-hosted) for spell + grammar checking.
// URL configured in Admin → Integrations (e.g. http://localhost:8081/v2/check).
// Returns { matches: [] } (empty) when not configured or unreachable.
router.post('/tools/grammar.json', requireAuth, async (req: Request, res: Response) => {
  const url = (await getSetting('integrations', 'languagetool_url')) || '';
  if (!url) { res.json({ matches: [] }); return; }
  const text = String((req.body && (req.body as any).text) || '').slice(0, 20000);
  if (!text.trim()) { res.json({ matches: [] }); return; }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: 'en-GB', level: 'picky' }),
    });
    const d: any = await r.json();
    res.json({ matches: d.matches || [] });
  } catch (e) {
    res.json({ matches: [], error: 'unavailable' });
  }
});

export default router;
