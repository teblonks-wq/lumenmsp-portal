import { Router, Request, Response, NextFunction } from 'express';
import { requireAdmin } from '../middleware/auth';
import { websiteStats, visitorList } from '../lib/chat';
import { getGroup, setSetting } from '../lib/settings';
import { bufferConfigured, getChannels, channelFor, createBufferPost } from '../lib/buffer';
import { aiMarketingPost, aiGuidePost, aiComposeConfigured } from '../lib/ai-compose';
import { publishNewsArticle, websitePublishConfigured, renderArticlePreview } from '../lib/news-publish';
import { publishGuidePage, guidePublishConfigured, renderGuidePage } from '../lib/guide-publish';
import {
  guideUpload, readPdf, holdPdf, takePdf, dropPdf, storePdf, saveGuide, getGuide,
  listGuides, guideLeads, archiveGuide, slugify,
} from '../lib/guides';
import { searchFreeImages } from '../lib/images';
import {
  audience, audienceCoverage, createCampaign, updateDraft, sendTest, startSending, pauseSending,
  retryFailed, contactForUnsubToken, optOutByToken, campaignSignatureHtml, AudienceFilter,
} from '../lib/mass-mailer';
import {
  listSubscribers, subscriberCounts, setSubscriberOptOut, removeSubscriber, subscribersCsv,
  subscriberForUnsubToken, optOutSubscriberByToken,
} from '../lib/subscribers';
import { aiMassMailEmail, aiImproveEmailHtml } from '../lib/ai-compose';
import { pool } from '../db/pool';
import { pollsForAttaching, loadVersion, resultsFor } from '../lib/questionnaires';
import { answerOptions } from '../lib/questionnaire-spec';

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
    guidesReady: guidePublishConfigured(),
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

// ══ Marketing → Socials → Guide mode (lead magnets) ══════════════════════════
// Upload a PDF Terry has written → Claude reads it and writes the shop window (buzzy title,
// short intro, "what's inside", offer copy for LinkedIn/Facebook) → publish a gated landing
// page on the website. The PDF never goes on the website: the page holds a name/email form,
// and the Portal hands back a one-off download link (lib/guides.ts, routes/guides-public.ts).

// multer rejects (wrong type, over 25 MB) arrive as an error, not an exception, and would
// otherwise reach the HTML error page - which the studio's fetch cannot read. Answer in JSON.
const guidePdf = (req: Request, res: Response, next: NextFunction): void => {
  guideUpload.single('pdf')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE'
        ? 'That PDF is larger than 25 MB — compress it (or split it) and try again.'
        : (err.message || 'Upload failed') });
      return;
    }
    next();
  });
};

// Step 1 — the upload. Held in memory only; nothing is stored until Publish, so an abandoned
// draft leaves no orphan file and no half-made guide in the list.
router.post('/marketing/socials/guide-upload', requireAdmin, guidePdf, async (req: Request, res: Response) => {
  try {
    const f = (req as any).file;
    if (!f || !f.buffer) { res.status(400).json({ ok: false, error: 'No PDF received — choose a file first.' }); return; }
    const read = await readPdf(f.buffer);
    const pdfId = holdPdf(f.buffer, f.originalname || 'guide.pdf');
    res.json({
      ok: true, pdfId, name: f.originalname || 'guide.pdf', bytes: f.size,
      pages: read.pages, chars: read.text.length, scanned: read.scanned,
    });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Upload failed' });
  }
});

// Step 2 — Claude reads the guide and writes the offer.
router.post('/marketing/socials/guide-generate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const held = takePdf(String(req.body.pdfId || ''));
    if (!held) { res.status(400).json({ ok: false, error: 'That upload has expired — upload the PDF again.' }); return; }
    const read = await readPdf(held.buf);
    // An image-only PDF has nothing to extract, so send Claude the file itself. Over ~20 MB
    // that is not worth attempting — say so plainly rather than failing at the API.
    if (read.scanned && held.buf.length > 20 * 1024 * 1024) {
      res.status(400).json({ ok: false, error: 'This PDF has no readable text (it looks like scanned pages) and is too large to send to Claude as-is. Export it as a text PDF, or paste the key points into the notes box.' });
      return;
    }
    const out = await aiGuidePost({
      pdfText: read.text,
      pdfBase64: read.scanned ? held.buf.toString('base64') : null,
      pdfName: held.name,
      pages: read.pages,
      notes: String(req.body.content || '').trim(),
      take: String(req.body.take || '').trim(),
    });
    res.json({ ok: true, ...out, pages: read.pages, readAs: read.scanned ? 'pdf' : 'text' });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Generation failed' });
  }
});

// Preview — the EXACT landing page Publish would produce, rendered without writing anything.
router.post('/marketing/socials/preview-guide', requireAdmin, async (req: Request, res: Response) => {
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: https:; img-src * data: https:; style-src 'unsafe-inline'");
  res.send(renderGuidePage({
    title: String(req.body.title || ''), slug: String(req.body.slug || 'preview'),
    intro: String(req.body.intro || ''), insideHtml: String(req.body.insideHtml || ''),
    excerpt: String(req.body.excerpt || ''), imageUrl: String(req.body.imageUrl || '').trim() || undefined,
  }));
});

// Step 3 — store the PDF privately, write the landing page, record the guide.
router.post('/marketing/socials/publish-guide', requireAdmin, async (req: Request, res: Response) => {
  try {
    const pdfId = String(req.body.pdfId || '');
    const held = takePdf(pdfId);
    if (!held) { res.status(400).json({ ok: false, error: 'That upload has expired — upload the PDF again before publishing.' }); return; }

    const title = String(req.body.title || '').trim();
    const slug = slugify(String(req.body.slug || title));
    if (!title || !slug) { res.status(400).json({ ok: false, error: 'A title and a page address are both required.' }); return; }

    const intro = String(req.body.intro || '').trim();
    const insideHtml = String(req.body.insideHtml || '').trim();
    const excerpt = String(req.body.excerpt || '').trim();
    const imageUrl = String(req.body.imageUrl || '').trim() || null;

    const stored = storePdf(held.buf, held.name);
    const published = await publishGuidePage({ title, slug, intro, insideHtml, excerpt, imageUrl: imageUrl || undefined });
    await saveGuide({
      slug: published.slug, title, intro, insideHtml, excerpt, imageUrl,
      pdfFile: stored.file, pdfName: stored.name, pdfBytes: stored.bytes,
      landingUrl: published.url, createdBy: req.session.user!.displayName || req.session.user!.email || null,
    });
    dropPdf(pdfId);
    res.json({ ok: true, url: published.url, slug: published.slug });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Publish failed' });
  }
});

// ══ Marketing → Guides ═══════════════════════════════════════════════════════
// What is live, and what each guide has actually produced.
router.get('/marketing/guides', requireAdmin, async (req: Request, res: Response) => {
  let guides: any[] = [];
  try { guides = await listGuides(); } catch { /* tables appear on first deploy */ }
  res.render('marketing/guides', { user: req.session.user!, guides, notice: req.query.msg || null });
});

router.get('/marketing/guides/:slug', requireAdmin, async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '');
  const guide = await getGuide(slug);
  if (!guide) { res.status(404).render('error', { message: 'Guide not found.' }); return; }
  res.render('marketing/guide-detail', {
    user: req.session.user!, guide, leads: await guideLeads(slug).catch(() => []),
  });
});

router.post('/marketing/guides/:slug/archive', requireAdmin, async (req: Request, res: Response) => {
  await archiveGuide(String(req.params.slug || ''));
  res.redirect('/marketing/guides?msg=' + encodeURIComponent('Guide withdrawn — its landing page is still live on the website, so delete that folder on the server if you want it gone entirely.'));
});

// ══ Marketing → Mass Mailer ══════════════════════════════════════════════════
// Bulk email to contacts on their customer's DEFAULT domain only (lib/mass-mailer).

// Campaign list.
router.get('/marketing/mass-mailer', requireAdmin, async (req: Request, res: Response) => {
  let campaigns: any[] = [];
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM mail_campaign_recipients r WHERE r.campaign_id=c.id) AS total,
              (SELECT COUNT(*)::int FROM mail_campaign_recipients r WHERE r.campaign_id=c.id AND r.status='sent') AS sent,
              (SELECT COUNT(*)::int FROM mail_campaign_recipients r WHERE r.campaign_id=c.id AND r.status='failed') AS failed
       FROM mail_campaigns c ORDER BY c.created_at DESC`);
    campaigns = rows;
  } catch { /* tables appear on first deploy's prisma db push */ }
  res.render('marketing/mass-mailer', { user: req.session.user!, campaigns, notice: req.query.msg || null });
});

// Compose (new) / edit draft — same form.
router.get('/marketing/mass-mailer/new', requireAdmin, async (req: Request, res: Response) => {
  res.render('marketing/mass-mailer-form', {
    user: req.session.user!, campaign: null, aiReady: await aiComposeConfigured(),
    polls: await pollsForAttaching().catch(() => []),
  });
});

router.get('/marketing/mass-mailer/:id/edit', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const { rows } = await pool.query('SELECT * FROM mail_campaigns WHERE id=$1', [id]);
  if (!rows.length) { res.status(404).render('error', { message: 'Campaign not found.' }); return; }
  if (rows[0].status !== 'draft') { res.redirect('/marketing/mass-mailer/' + id); return; }
  res.render('marketing/mass-mailer-form', {
    user: req.session.user!, campaign: rows[0], aiReady: await aiComposeConfigured(),
    polls: await pollsForAttaching().catch(() => []),
  });
});

// Live audience preview for the compose page.
router.get('/marketing/mass-mailer/audience.json', requireAdmin, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.status || '');
    const f: AudienceFilter = (q === 'all' || q === 'subscribers' || q === 'everyone') ? q : 'active';
    res.json({ ok: true, recipients: await audience(f), coverage: await audienceCoverage(f) });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

// Claude: draft a campaign email from rough notes / improve the current draft.
router.post('/marketing/mass-mailer/ai-draft', requireAdmin, async (req: Request, res: Response) => {
  try {
    const out = await aiMassMailEmail({ notes: String(req.body.notes || ''), tone: String(req.body.tone || '').trim() || null });
    res.json({ ok: true, ...out });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Draft failed' }); }
});

router.post('/marketing/mass-mailer/ai-improve', requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json({ ok: true, bodyHtml: await aiImproveEmailHtml(String(req.body.bodyHtml || '')) });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Improve failed' }); }
});

const parseCampaignBody = (req: Request) => ({
  name: String(req.body.name || '').trim() || 'Untitled campaign',
  subject: String(req.body.subject || '').trim(),
  bodyHtml: String(req.body.bodyHtml || ''),
  statusFilter: (['all', 'subscribers', 'everyone'].includes(String(req.body.statusFilter))
    ? String(req.body.statusFilter) : 'active') as AudienceFilter,
  excludeEmails: String(req.body.excludeEmails || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  createdBy: req.session.user!.id,
  questionnaireVersionId: parseInt(String(req.body.questionnaireVersionId || ''), 10) || null,
});

router.post('/marketing/mass-mailer', requireAdmin, async (req: Request, res: Response) => {
  try {
    const input = parseCampaignBody(req);
    if (!input.subject || !input.bodyHtml.trim()) { res.status(400).json({ ok: false, error: 'Subject and message are both required.' }); return; }
    const id = await createCampaign(input);
    res.json({ ok: true, id });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Could not create campaign' }); }
});

router.post('/marketing/mass-mailer/:id/update', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const input = parseCampaignBody(req);
    if (!input.subject || !input.bodyHtml.trim()) { res.status(400).json({ ok: false, error: 'Subject and message are both required.' }); return; }
    await updateDraft(id, input);
    res.json({ ok: true, id });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Could not update campaign' }); }
});

// Campaign detail + live status.
router.get('/marketing/mass-mailer/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Campaign not found.' }); return; }
  const { rows } = await pool.query('SELECT * FROM mail_campaigns WHERE id=$1', [id]);
  if (!rows.length) { res.status(404).render('error', { message: 'Campaign not found.' }); return; }
  const rec = await pool.query(
    `SELECT * FROM mail_campaign_recipients WHERE campaign_id=$1 ORDER BY customer_name ASC, full_name ASC`, [id]);
  const vid = rows[0].questionnaire_version_id;
  const pollVersion = vid ? await loadVersion(vid).catch(() => null) : null;
  const pollQuestion = pollVersion ? pollVersion.questions.find((x) => x.type !== 'heading') : null;
  res.render('marketing/mass-mailer-detail', {
    user: req.session.user!, campaign: rows[0], recipients: rec.rows, notice: req.query.msg || null,
    signatureHtml: await campaignSignatureHtml(),
    poll: pollVersion,
    pollOptions: pollQuestion ? answerOptions(pollQuestion) : [],
    pollResults: vid ? await resultsFor(vid).catch(() => null) : null,
  });
});

router.get('/marketing/mass-mailer/:id/status.json', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const c = await pool.query('SELECT status FROM mail_campaigns WHERE id=$1', [id]);
  const r = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM mail_campaign_recipients WHERE campaign_id=$1 GROUP BY status`, [id]);
  const counts: Record<string, number> = {};
  r.rows.forEach((x: any) => { counts[x.status] = x.n; });
  const rec = await pool.query(
    `SELECT id, status, error, sent_at FROM mail_campaign_recipients WHERE campaign_id=$1`, [id]);
  res.json({ ok: true, status: c.rows[0]?.status, counts, recipients: rec.rows });
});

router.post('/marketing/mass-mailer/:id/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = req.session.user!;
    await sendTest(parseInt(String(req.params.id), 10), u.email, u.displayName);
    res.json({ ok: true, to: u.email });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Test send failed' }); }
});

router.post('/marketing/mass-mailer/:id/send', requireAdmin, async (req: Request, res: Response) => {
  try { await startSending(parseInt(String(req.params.id), 10)); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Could not start sending' }); }
});

router.post('/marketing/mass-mailer/:id/pause', requireAdmin, async (req: Request, res: Response) => {
  await pauseSending(parseInt(String(req.params.id), 10));
  res.json({ ok: true });
});

router.post('/marketing/mass-mailer/:id/retry-failed', requireAdmin, async (req: Request, res: Response) => {
  try { res.json({ ok: true, retried: await retryFailed(parseInt(String(req.params.id), 10)) }); }
  catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/marketing/mass-mailer/:id/delete', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query("DELETE FROM mail_campaigns WHERE id=$1 AND status IN ('draft','sent','failed','paused')", [id]);
  res.redirect('/marketing/mass-mailer?msg=' + encodeURIComponent('Campaign deleted'));
});

// ══ Marketing → Subscribers ══════════════════════════════════════════════════
// People who are not customers but ticked the opt-in box on a guide. The Mass Mailer can
// send to this list; nothing else may write to it (lib/subscribers.ts explains why).
router.get('/marketing/subscribers', requireAdmin, async (req: Request, res: Response) => {
  let subs: any[] = [], counts = { total: 0, optedIn: 0, optedOut: 0 };
  try { subs = await listSubscribers(true); counts = await subscriberCounts(); } catch { /* table arrives on first deploy */ }
  res.render('marketing/subscribers', { user: req.session.user!, subs, counts, notice: req.query.msg || null });
});

router.get('/marketing/subscribers.csv', requireAdmin, async (req: Request, res: Response) => {
  const rows = await listSubscribers(true).catch(() => []);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lumen-subscribers-' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send(subscribersCsv(rows));
});

router.post('/marketing/subscribers/:id/opt', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const out = String(req.body.action || '') === 'out';
  await setSubscriberOptOut(id, out);
  res.redirect('/marketing/subscribers?msg=' + encodeURIComponent(out ? 'Unsubscribed — they will not be emailed again.' : 'Re-subscribed.'));
});

router.post('/marketing/subscribers/:id/delete', requireAdmin, async (req: Request, res: Response) => {
  await removeSubscriber(parseInt(String(req.params.id), 10));
  res.redirect('/marketing/subscribers?msg=' + encodeURIComponent('Removed from the list entirely.'));
});

// ── Socials Studio step 5: email the list about what we just published ──────────
// Builds a Mass Mailer DRAFT (Claude writes the copy in the mailer's own shape) and hands
// back its review page. Deliberately a draft: a campaign goes out to real people, so it
// still passes through the test-send and Start sending buttons rather than firing from here.
router.post('/marketing/socials/email-campaign', requireAdmin, async (req: Request, res: Response) => {
  try {
    const title = String(req.body.title || '').trim();
    const link = String(req.body.link || '').trim();
    const summary = String(req.body.summary || '').trim();
    const kind = String(req.body.kind || 'article') === 'guide' ? 'guide' : 'article';
    const listChoice = String(req.body.list || 'subscribers');
    const statusFilter: AudienceFilter =
      listChoice === 'active' ? 'active' : listChoice === 'everyone' ? 'everyone' : 'subscribers';

    if (!title) { res.status(400).json({ ok: false, error: 'Generate the copy first — there is no title to email about.' }); return; }
    if (!link) { res.status(400).json({ ok: false, error: kind === 'guide' ? 'Publish the guide first, so the email has something to link to.' : 'Push the article to the website first, so the email has something to link to.' }); return; }

    const notes = [
      kind === 'guide'
        ? `We have published a new free guide and want to tell our list about it. The guide is called "${title}".`
        : `We have published a new article on our website and want to tell our list about it. It is called "${title}".`,
      summary ? `What it covers: ${summary}` : null,
      `Include this link as a clickable link on its own line, with link text that invites the click (${kind === 'guide' ? 'e.g. "Get your free copy"' : 'e.g. "Read the full article"'}): ${link}`,
      kind === 'guide'
        ? 'Make clear the guide is free and takes minutes to read. Do not promise anything the title does not.'
        : 'Keep it short — the article does the work; this email just gets them there.',
    ].filter(Boolean).join('\n');

    const draft = await aiMassMailEmail({ notes, tone: 'warm, plain-spoken, not salesy' });
    // Belt and braces: if the model left the link out, the email is useless, so add it back.
    const bodyHtml = draft.bodyHtml.includes(link)
      ? draft.bodyHtml
      : draft.bodyHtml + `<p><a href="${link}">${kind === 'guide' ? 'Get your free copy' : 'Read the full article'}</a></p>`;

    const id = await createCampaign({
      name: (kind === 'guide' ? 'Guide: ' : 'Article: ') + title.slice(0, 90),
      subject: draft.subject,
      bodyHtml,
      statusFilter,
      excludeEmails: [],
      createdBy: req.session.user!.id,
      questionnaireVersionId: null,
    });
    res.json({ ok: true, id, url: '/marketing/mass-mailer/' + id });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Could not build the email' });
  }
});

// ── Public unsubscribe (no auth — linked from every campaign email) ────────────
const unsubPage = (title: string, msg: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<title>${title} — Lumen IT Solutions</title></head>`
  + `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;margin:0;">`
  + `<div style="max-width:480px;margin:12vh auto;background:#fff;border-radius:16px;padding:36px 32px;box-shadow:0 12px 30px rgba(2,6,23,.12);text-align:center;">`
  + `<h1 style="font-size:22px;margin:0 0 10px;color:#0f172a;">${title}</h1>`
  + `<div style="color:#475569;font-size:15px;line-height:1.5;">${msg}</div>`
  + `<p style="color:#94a3b8;font-size:13px;margin:24px 0 0;">Lumen IT Solutions</p>`
  + `</div></body></html>`;

router.get('/unsubscribe/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  // Two kinds of recipient share this page: a customer contact, and a marketing subscriber
  // who opted in from a guide. Try the contact first, then the subscriber list.
  const contact = (await contactForUnsubToken(token).catch(() => null))
    || (await subscriberForUnsubToken(token).catch(() => null));
  if (!contact) { res.status(404).send(unsubPage('Link not recognised', 'This unsubscribe link is not valid. If you meant to stop our emails, just reply to any of them and we will sort it.')); return; }
  if (contact.opted_out) { res.send(unsubPage('Already unsubscribed', `<p>${contact.email || 'You'} will not receive marketing updates from us.</p>`)); return; }
  // Confirm with a button (a bare GET can be triggered by link scanners / prefetch).
  res.send(unsubPage('Unsubscribe from Lumen updates',
    `<p>Stop marketing updates to <strong>${contact.email || 'this address'}</strong>?</p>`
    + `<form method="post" action="/unsubscribe/${token}" style="margin:18px 0 0;">`
    + `<button type="submit" style="background:#0ea5b7;color:#fff;border:0;font-weight:600;padding:11px 26px;border-radius:6px;font-size:15px;cursor:pointer;">Unsubscribe</button>`
    + `</form>`));
});

router.post('/unsubscribe/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const ok = (await optOutByToken(token).catch(() => false))
    || (await optOutSubscriberByToken(token).catch(() => false));
  res.send(ok
    ? unsubPage('You are unsubscribed', '<p>Done — you will not receive marketing updates from us. Service emails about your account are unaffected.</p>')
    : unsubPage('Link not recognised', 'This unsubscribe link is not valid. If you meant to stop our emails, just reply to any of them and we will sort it.'));
});

export default router;
