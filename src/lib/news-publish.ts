import fs from 'fs';
import path from 'path';
import { config } from '../config';

// ── Marketing studio: "Push to website" ─────────────────────────────────────────
// Writes a finished article as a static, self-contained HTML page into the live
// website's /news directory (same server — nginx serves it instantly, no Astro
// rebuild). Also maintains news/index.json + a simple news/index.html listing.
//
// One-off server setup (documented in config.ts):
//   sudo mkdir -p /var/www/lumenmsp/news && sudo chown lits-admin /var/www/lumenmsp/news
//   …and add --exclude=news/ to the website deploy's rsync --delete.

export interface PublishInput { title: string; slug: string; excerpt: string; articleHtml: string; imageUrl?: string; }
export interface PublishResult { url: string; slug: string; }

const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

// Strip anything dangerous from the article body: allow the tags the generator uses.
function cleanArticleHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

function articlePage(a: PublishInput, dateStr: string): string {
  const base = config.WEBSITE_BASE_URL.replace(/\/$/, '');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.title)} — Lumen IT Solutions</title>
<meta name="description" content="${esc(a.excerpt)}">
<link rel="canonical" href="${base}/news/live/${esc(a.slug)}/">
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(a.excerpt)}">
<meta property="og:type" content="article">
${a.imageUrl ? `<meta property="og:image" content="${esc(a.imageUrl)}">` : ''}
<style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc;line-height:1.7;}
  .top{background:#0b2545;padding:18px 20px;}
  .top a{color:#fff;text-decoration:none;font-weight:800;font-size:20px;letter-spacing:-.3px;}
  .wrap{max-width:760px;margin:0 auto;padding:36px 20px 60px;}
  h1{font-size:34px;line-height:1.2;margin:0 0 8px;}
  .meta{color:#64748b;font-size:15px;margin-bottom:26px;}
  article{background:#fff;border:1px solid #e6ecf2;border-radius:14px;padding:34px 36px;font-size:17.5px;}
  article h2{font-size:23px;margin:28px 0 10px;}
  article p{margin:0 0 16px;}
  article ul{margin:0 0 16px;padding-left:24px;}
  article li{margin-bottom:8px;}
  .cta{margin-top:34px;padding:20px 24px;background:#ecfeff;border:1px solid #a5f3fc;border-radius:12px;font-size:16.5px;}
  .cta a{color:#0e7490;font-weight:700;}
  .foot{color:#94a3b8;font-size:13.5px;text-align:center;margin-top:34px;}
  .foot a{color:#64748b;}
</style>
</head>
<body>
<div class="top"><a href="${base}/">Lumen IT Solutions</a></div>
<div class="wrap">
  <h1>${esc(a.title)}</h1>
  <div class="meta">${esc(dateStr)} · Lumen IT Solutions</div>
  ${a.imageUrl ? `<img src="${esc(a.imageUrl)}" alt="" style="width:100%;border-radius:14px;margin:0 0 22px;display:block;">` : ''}
  <article>${cleanArticleHtml(a.articleHtml)}</article>
  <div class="cta">Questions about how this affects your business? <a href="${base}/contact">Talk to Lumen IT Solutions</a> — straight answers, no jargon.</div>
  <div class="foot"><a href="${base}/news/">More news</a> · <a href="${base}/">lumenmsp.co.uk</a></div>
</div>
</body>
</html>`;
}

function newsIndexPage(items: { slug: string; title: string; excerpt: string; date: string }[]): string {
  const base = config.WEBSITE_BASE_URL.replace(/\/$/, '');
  const rows = items.map((i) => `
  <a class="item" href="${base}/news/live/${esc(i.slug)}/">
    <div class="t">${esc(i.title)}</div>
    <div class="d">${esc(new Date(i.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</div>
    <div class="x">${esc(i.excerpt)}</div>
  </a>`).join('');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>News — Lumen IT Solutions</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc;line-height:1.6;}
  .top{background:#0b2545;padding:18px 20px;}
  .top a{color:#fff;text-decoration:none;font-weight:800;font-size:20px;}
  .wrap{max-width:760px;margin:0 auto;padding:36px 20px 60px;}
  h1{font-size:32px;}
  .item{display:block;background:#fff;border:1px solid #e6ecf2;border-radius:12px;padding:20px 24px;margin-bottom:14px;text-decoration:none;color:#0f172a;}
  .item:hover{border-color:#0ea5b7;}
  .t{font-size:19px;font-weight:700;}
  .d{color:#64748b;font-size:13.5px;margin:2px 0 8px;}
  .x{font-size:15.5px;color:#334155;}
</style></head>
<body><div class="top"><a href="${config.WEBSITE_BASE_URL}/">Lumen IT Solutions</a></div>
<div class="wrap"><h1>News</h1>${rows || '<p>No articles yet.</p>'}</div></body></html>`;
}

export function websitePublishConfigured(): boolean {
  return !!config.WEBSITE_NEWS_DIR && fs.existsSync(config.WEBSITE_NEWS_DIR);
}

// Exact page render WITHOUT writing anything — the studio's Preview button.
export function renderArticlePreview(input: PublishInput): string {
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return articlePage(input, dateStr);
}

export async function publishNewsArticle(input: PublishInput): Promise<PublishResult> {
  const dir = config.WEBSITE_NEWS_DIR;
  if (!dir) throw new Error('WEBSITE_NEWS_DIR is not configured.');
  if (!fs.existsSync(dir)) throw new Error(`The news directory (${dir}) does not exist or the Portal cannot see it — run the one-off setup: sudo mkdir -p ${dir} && sudo chown lits-admin ${dir}`);

  const slug = String(input.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug || !input.title.trim() || !input.articleHtml.trim()) throw new Error('Title, slug and article body are all required.');

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Write the article page.
  const artDir = path.join(dir, slug);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'index.html'), articlePage({ ...input, slug }, dateStr), 'utf8');

  // Maintain index.json (newest first, replace same slug) + regenerate the listing page.
  const idxPath = path.join(dir, 'index.json');
  let items: { slug: string; title: string; excerpt: string; date: string; image?: string }[] = [];
  try { items = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch { /* first article */ }
  items = items.filter((i) => i.slug !== slug);
  items.unshift({ slug, title: input.title.trim(), excerpt: input.excerpt.trim(), date: now.toISOString().slice(0, 10), image: (input.imageUrl || '').trim() || undefined });
  fs.writeFileSync(idxPath, JSON.stringify(items, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), newsIndexPage(items), 'utf8');

  return { url: `${config.WEBSITE_BASE_URL.replace(/\/$/, '')}/news/live/${slug}/`, slug };
}
