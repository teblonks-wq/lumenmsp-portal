import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { websiteStats, visitorList } from '../lib/chat';
import { getGroup, setSetting } from '../lib/settings';
import { bufferConfigured, getChannels, channelFor, createBufferPost } from '../lib/buffer';
import { aiMarketingPost, aiComposeConfigured } from '../lib/ai-compose';
import { publishNewsArticle, websitePublishConfigured, renderArticlePreview } from '../lib/news-publish';
import { searchFreeImages } from '../lib/images';

const router = Router();

// Marketing landing — reached from the Admin page's Marketing card.
router.get('/marketing', requireAdmin, async (req: Request, res: Response) => {
  res.render('marketing/index', { user: req.session.user! });
});

// Marketing → Chat Bot — enable/disable the website chat + set its hours (default 09:00–17:00 Mon–Fri).
router.get('/marketing/chatbot', requireAdmin, async (req: Request, res: Response) => {
  const g = await getGroup('chatbot').catch(() => ({} as Record<string, string>));
  res.render('marketing/chatbot', { user: req.session.user!, g, notice: req.query.msg || null });
});

router.post('/marketing/chatbot', requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as Record<string, string>;
  await setSetting('chatbot', 'enabled', (b.enabled === 'on' || b.enabled === 'true') ? 'true' : 'false');
  await setSetting('chatbot', 'open_time', b.open_time || '09:00');
  await setSetting('chatbot', 'close_time', b.close_time || '17:00');
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((d) => b['day_' + d]);
  await setSetting('chatbot', 'days', days.join(',') || 'mon,tue,wed,thu,fri');
  res.redirect('/marketing/chatbot?msg=' + encodeURIComponent('Chat Bot settings saved'));
});

// Marketing → Website Stats — page views, unique visitors, top pages/referrers, live now.
router.get('/marketing/website-stats', requireAdmin, async (req: Request, res: Response) => {
  const period = ['today', 'week', 'month'].includes(String(req.query.period)) ? String(req.query.period) : 'week';
  let stats: any = null, visitors: any[] = [];
  try { stats = await websiteStats(); } catch (e: any) { stats = { error: e.message }; }
  try { visitors = await visitorList(period); } catch { visitors = []; }
  res.render('marketing/website-stats', { user: req.session.user!, stats, visitors, period });
});

// ── Marketing → Socials studio (2026-07-09 rewrite) ──────────────────────────────
// STATELESS 4-step flow — nothing is stored in the Portal:
//   1. URLs + content notes + Lumen's take
//   2. Generate with Claude (one meaty end-user article + LinkedIn + Facebook copy)
//   3. Push to website (writes a static page into the live site's /news)
//   4. Push to Buffer (now, or pick a date/time)
router.get('/marketing/socials', requireAdmin, async (req: Request, res: Response) => {
  res.render('marketing/socials', {
    user: req.session.user!,
    aiReady: await aiComposeConfigured(),
    bufferReady: await bufferConfigured(),
    websiteReady: websitePublishConfigured(),
  });
});

// Fetch a page and strip it to readable-ish text (capped) for Claude's source material.
async function extractUrl(url: string): Promise<{ url: string; text: string } | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'LumenMSP-Portal-Studio/1.0' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    return text.length > 100 ? { url, text: text.slice(0, 5000) } : null;
  } catch { return null; }
}

router.post('/marketing/socials/generate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const urls: string[] = String(req.body.urls || '').split(/[\n,]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 4);
    const content = String(req.body.content || '').trim();
    const take = String(req.body.take || '').trim();
    if (!urls.length && !content) { res.status(400).json({ ok: false, error: 'Give me at least a URL or some content to work from.' }); return; }
    const sources = (await Promise.all(urls.map(extractUrl))).filter((s): s is { url: string; text: string } => !!s);
    const out = await aiMarketingPost({ sources, content, take });
    res.json({ ok: true, ...out, sourcesRead: sources.length, sourcesGiven: urls.length });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Generation failed' }); }
});

// Free stock-photo search (Pexels) — hero-image picker for the studio.
router.get('/marketing/socials/image-search', requireAdmin, async (req: Request, res: Response) => {
  try { res.json({ ok: true, images: await searchFreeImages(String(req.query.q || '')) }); }
  catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Image search failed' }); }
});

// Preview — the EXACT page the website publish would produce, rendered without writing anything.
router.post('/marketing/socials/preview-website', requireAdmin, async (req: Request, res: Response) => {
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: https:; img-src * data: https:; style-src 'unsafe-inline'");
  res.send(renderArticlePreview({
    title: String(req.body.title || ''), slug: String(req.body.slug || 'preview'),
    excerpt: String(req.body.excerpt || ''), articleHtml: String(req.body.articleHtml || ''),
    imageUrl: String(req.body.imageUrl || '').trim() || undefined,
  }));
});

router.post('/marketing/socials/publish-website', requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await publishNewsArticle({
      title: String(req.body.title || ''), slug: String(req.body.slug || ''),
      excerpt: String(req.body.excerpt || ''), articleHtml: String(req.body.articleHtml || ''),
      imageUrl: String(req.body.imageUrl || '').trim() || undefined,
    });
    res.json({ ok: true, url: r.url });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Publish failed' }); }
});

router.post('/marketing/socials/push-buffer', requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!(await bufferConfigured())) { res.status(400).json({ ok: false, error: 'Buffer API key not set — add it in Settings → Integrations.' }); return; }
    const mode = req.body.mode === 'schedule' ? 'schedule' : 'now';
    const dueAt = mode === 'schedule' ? String(req.body.dueAt || '') : undefined;
    if (mode === 'schedule' && !dueAt) { res.status(400).json({ ok: false, error: 'Pick a date and time, or choose Post now.' }); return; }
    const link = String(req.body.link || '').trim();
    const channels = await getChannels();
    const results: Record<string, string> = {};
    for (const network of ['linkedin', 'facebook'] as const) {
      const text = String(req.body[network] || '').trim();
      if (!text) continue;
      const ch = channelFor(channels, network);
      if (!ch) { results[network] = `no ${network} channel connected in Buffer`; continue; }
      const body = link ? `${text}\n\n${link}` : text;
      const imageUrl = String(req.body.imageUrl || '').trim() || undefined;
      const r = await createBufferPost(ch.id, body, mode, network, dueAt, imageUrl);
      results[network] = r.error ? `FAILED: ${r.error}` : (mode === 'now' ? 'posted' : `scheduled for ${dueAt}`);
      await new Promise((r2) => setTimeout(r2, 800)); // Buffer rate-limit spacing
    }
    if (!Object.keys(results).length) { res.status(400).json({ ok: false, error: 'Nothing to post — both social boxes are empty.' }); return; }
    res.json({ ok: true, results });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Buffer push failed' }); }
});

export default router;
