import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { websiteStats, visitorList } from '../lib/chat';
import { getGroup, setSetting } from '../lib/settings';
import { bufferConfigured, getChannels, channelFor, createBufferPost } from '../lib/buffer';
import {
  listPosts, getPostsByIds, addAdhocPost, deletePost, archivePosts, sentPostIds, setArticleImage,
  recordUpload, listUploads, assignSchedule, SocialPostRow,
  saveStudioPosts, listArchived, restorePosts, archiveBySlug, restoreBySlug, setRelevanceDate,
} from '../lib/socials';
import { aiGenerateStudio, aiComposeConfigured } from '../lib/ai-compose';
import { searchFreeImages } from '../lib/images';
import multer from 'multer';

// In-memory upload for studio context images (straight to base64 for Claude vision — never hits disk).
const studioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 4 } });
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

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

// ── Marketing → Socials ───────────────────────────────────────────────────────
// List every social post (per-network copy) with previews + tick-select, push the
// selected ones to Buffer (schedule / post now / add to queue), add ad-hoc updates,
// and show a log of every Buffer upload.
// Group per-network rows into one article per slug (skipping any variant already sent).
function groupArticles(posts: SocialPostRow[], skip?: Set<number>) {
  const map = new Map<string, { slug: string; title: string | null; link: string | null; kind: string; image: string | null; relevanceDate: string | null; variants: Record<string, SocialPostRow> }>();
  for (const p of posts) {
    if (skip && skip.has(p.id)) continue;
    if (!map.has(p.slug)) map.set(p.slug, { slug: p.slug, title: p.title, link: p.link, kind: p.kind, image: p.image_url, relevanceDate: p.relevance_date, variants: {} });
    const g = map.get(p.slug)!;
    if (!g.image && p.image_url) g.image = p.image_url;
    if (!g.relevanceDate && p.relevance_date) g.relevanceDate = p.relevance_date;
    g.variants[p.network] = p;
  }
  return [...map.values()];
}

router.get('/marketing/socials', requireAdmin, async (req: Request, res: Response) => {
  const tab = ['schedule', 'create', 'previous'].includes(String(req.query.tab)) ? String(req.query.tab) : 'schedule';
  const posts = await listPosts();
  const uploads = await listUploads(60);
  const sent = await sentPostIds(); // already-pushed rows are hidden from the "to schedule" list
  const articles = groupArticles(posts, sent);
  const archived = groupArticles(await listArchived(120));

  const bufferReady = await bufferConfigured();
  let channels: { id: string; name: string; service: string }[] = [];
  let channelError: string | null = null;
  if (bufferReady) {
    try {
      // Never let a slow / rate-limited Buffer hang the page — cap the wait and render anyway.
      channels = await Promise.race([
        getChannels(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Buffer is slow or rate-limited — channel status will refresh shortly.')), 6000)),
      ]);
    } catch (e: any) { channelError = e.message; }
  }

  res.render('marketing/socials', {
    user: req.session.user!, tab, articles, archived, uploads, channels, channelError,
    bufferReady, aiReady: await aiComposeConfigured(),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/marketing/socials/push', requireAdmin, async (req: Request, res: Response) => {
  const action = ['schedule', 'now', 'queue', 'archive'].includes(String(req.body.action)) ? String(req.body.action) : 'queue';
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  const idNums = ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0);

  if (action === 'archive') {
    if (!idNums.length) return res.redirect('/marketing/socials?err=' + encodeURIComponent('Tick at least one post to archive.'));
    await archivePosts(idNums);
    return res.redirect('/marketing/socials?msg=' + encodeURIComponent(`Archived ${idNums.length} post(s).`));
  }
  const mode = action as 'schedule' | 'now' | 'queue';

  const posts = await getPostsByIds(idNums);
  if (!posts.length) return res.redirect('/marketing/socials?err=' + encodeURIComponent('Tick at least one post first.'));
  if (!(await bufferConfigured())) return res.redirect('/marketing/socials?err=' + encodeURIComponent('Buffer API key not set — add it in Settings → Integrations.'));

  let channels;
  try { channels = await getChannels(); }
  catch (e: any) { return res.redirect('/marketing/socials?err=' + encodeURIComponent('Buffer: ' + e.message)); }

  const startStr = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.start || '')) ? String(req.body.start) : undefined;
  const dueMap = mode === 'schedule' ? assignSchedule(posts, startStr) : null;
  const by = req.session.user?.displayName || req.session.user?.email || 'unknown';
  let ok = 0, fail = 0;
  const done: number[] = []; // successfully pushed rows → auto-archived so the list empties itself

  for (const p of posts) {
    const ch = channelFor(channels, p.network);
    if (!ch) {
      await recordUpload({ postId: p.id, slug: p.slug, network: p.network, action: mode, status: 'error', message: `No ${p.network} channel connected in Buffer`, createdBy: by });
      fail++; continue;
    }
    const dueAt = mode === 'schedule' ? dueMap!.get(p.id) : undefined;
    const r = await createBufferPost(ch.id, p.body, mode, p.network, dueAt, p.image_url || undefined);
    if (r.error) {
      await recordUpload({ postId: p.id, slug: p.slug, network: p.network, action: mode, status: 'error', message: r.error, dueAt: dueAt || null, createdBy: by });
      fail++;
    } else {
      await recordUpload({ postId: p.id, slug: p.slug, network: p.network, action: mode, status: 'ok', bufferPostId: r.id || null, dueAt: dueAt || null, createdBy: by });
      done.push(p.id);
      ok++;
    }
    await new Promise((r) => setTimeout(r, 800)); // space out calls to stay under Buffer's rate limit
  }
  // Auto-archive everything that went out cleanly; anything that failed stays visible to retry.
  if (done.length) await archivePosts(done);
  res.redirect('/marketing/socials?msg=' + encodeURIComponent(`Pushed ${ok} to Buffer (${mode}) — auto-archived` + (fail ? `; ${fail} failed and kept for retry — see the log` : '')));
});

router.post('/marketing/socials/add', requireAdmin, async (req: Request, res: Response) => {
  const { title, link, body, image_url } = req.body as Record<string, string>;
  let networks = (req.body.networks ?? []) as any;
  if (!Array.isArray(networks)) networks = networks ? [networks] : [];
  networks = networks.filter((n: string) => ['linkedin', 'facebook', 'google'].includes(n));
  if (!body || !body.trim() || !networks.length) {
    return res.redirect('/marketing/socials?err=' + encodeURIComponent('Add a message and pick at least one network.'));
  }
  await addAdhocPost(title || '', link || '', networks, body.trim(), (image_url || '').trim() || undefined);
  res.redirect('/marketing/socials?msg=' + encodeURIComponent('Ad-hoc post added.'));
});

// Set / change the image for an article (applies to all its channel variants).
router.post('/marketing/socials/image', requireAdmin, async (req: Request, res: Response) => {
  const { slug, image_url } = req.body as Record<string, string>;
  if (slug) await setArticleImage(slug, (image_url || '').trim() || null);
  res.redirect('/marketing/socials?msg=' + encodeURIComponent('Image updated.'));
});

router.post('/marketing/socials/:id/delete', requireAdmin, async (req: Request, res: Response) => {
  await deletePost(Number(req.params.id));
  res.redirect('/marketing/socials?msg=' + encodeURIComponent('Post removed.'));
});

// ── Content studio ──────────────────────────────────────────────────────────────
// Generate (multipart so optional context images can be uploaded): topic + up to 3 URLs + steer
// + up to 4 images -> four platform-tailored drafts + a suggested free-image search.
router.post('/marketing/socials/generate', requireAdmin, studioUpload.array('images', 4), async (req: Request, res: Response) => {
  try {
    const topic = String(req.body.topic || '').trim();
    const urls = [req.body.url1, req.body.url2, req.body.url3].map((u) => String(u || '').trim()).filter(Boolean);
    const context = String(req.body.context || '').trim() || null;
    const files = (req.files as any[]) || [];
    const images = files
      .filter((f) => IMG_TYPES.includes(f.mimetype))
      .slice(0, 4)
      .map((f) => ({ media_type: f.mimetype as string, data: (f.buffer as Buffer).toString('base64') }));
    const out = await aiGenerateStudio({ topic, urls, context, images });
    // Assemble the website piece as ready-to-paste Astro markdown (frontmatter + body).
    const today = new Date().toISOString().slice(0, 10);
    const esc = (s: string) => String(s || '').replace(/"/g, '\\"');
    const websiteMd =
      `---\ntitle: "${esc(out.website.title)}"\ndate: ${out.relevanceDate || today}\n` +
      `category: "${esc(out.website.category)}"\nexcerpt: "${esc(out.website.excerpt)}"\nauthor: "Lumen MSP"\n---\n\n${out.website.body}`;
    res.json({ ok: true, relevanceDate: out.relevanceDate, imageQuery: out.imageQuery, linkedin: out.linkedin, facebook: out.facebook, google: out.google, website: websiteMd });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Generation failed' });
  }
});

// Free stock-image search (Pexels) — used by the studio to suggest a matching image.
router.get('/marketing/socials/image-search', requireAdmin, async (req: Request, res: Response) => {
  try {
    const images = await searchFreeImages(String(req.query.q || ''));
    res.json({ ok: true, images });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Image search failed' });
  }
});

// Save the (edited) generated pieces as one topic.
router.post('/marketing/socials/create', requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as Record<string, string>;
  if (!String(b.topic || '').trim()) return res.redirect('/marketing/socials?tab=create&err=' + encodeURIComponent('Add a topic.'));
  if (![b.linkedin, b.facebook, b.google, b.website].some((x) => String(x || '').trim())) {
    return res.redirect('/marketing/socials?tab=create&err=' + encodeURIComponent('Generate or write at least one piece first.'));
  }
  const rel = /^\d{4}-\d{2}-\d{2}$/.test(String(b.relevance_date || '')) ? String(b.relevance_date) : null;
  await saveStudioPosts({
    topic: b.topic, relevanceDate: rel, link: String(b.link || '').trim() || null, imageUrl: String(b.image_url || '').trim() || null,
    linkedin: String(b.linkedin || '').trim(), facebook: String(b.facebook || '').trim(),
    google: String(b.google || '').trim(), website: String(b.website || '').trim(),
  });
  res.redirect('/marketing/socials?msg=' + encodeURIComponent('Saved — your posts are in the schedule list.'));
});

// Per-card archive / restore by slug, and relevance-date override.
router.post('/marketing/socials/archive-slug', requireAdmin, async (req: Request, res: Response) => {
  if (req.body.slug) await archiveBySlug(String(req.body.slug));
  res.redirect('/marketing/socials?msg=' + encodeURIComponent('Archived.'));
});
router.post('/marketing/socials/restore', requireAdmin, async (req: Request, res: Response) => {
  if (req.body.slug) await restoreBySlug(String(req.body.slug));
  else {
    let ids = req.body.ids; if (!Array.isArray(ids)) ids = ids ? [ids] : [];
    await restorePosts((ids as any[]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0));
  }
  res.redirect('/marketing/socials?tab=previous&msg=' + encodeURIComponent('Restored to the schedule list.'));
});
router.post('/marketing/socials/relevance', requireAdmin, async (req: Request, res: Response) => {
  const rel = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.relevance_date || '')) ? String(req.body.relevance_date) : null;
  if (req.body.slug) await setRelevanceDate(String(req.body.slug), rel);
  res.redirect('/marketing/socials?msg=' + encodeURIComponent('Date updated.'));
});

export default router;
