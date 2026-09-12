import fs from 'fs';
import path from 'path';
import { config } from '../config';

// ── Marketing studio: "Publish guide" ───────────────────────────────────────────
// Writes the lead-magnet landing page as a static, self-contained HTML file into the live
// website's /guides directory (same server — nginx serves it instantly, no Astro rebuild),
// exactly as news-publish.ts does for articles.
//
// The page holds NO link to the PDF. It holds a form that posts to the Portal
// (/api/guide-lead), and the Portal answers with a one-off download URL. That is the whole
// gate: there is no file path on the website to guess at.
//
// One-off server setup:
//   mkdir -p /var/www/lumenmsp/guides          (web root is lits-admin-owned, no sudo)
//   …and the website deploy.ps1 preserves guides/ across site deploys.

export interface GuidePublishInput {
  title: string; slug: string; intro: string; insideHtml: string; excerpt: string; imageUrl?: string;
}
export interface GuidePublishResult { url: string; slug: string; }

const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

// The "what's inside" list is model-written HTML, so strip anything that isn't the <ul>/<li>
// structure we asked for before it goes on a public page.
function cleanInside(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/<(?!\/?(ul|ol|li|strong|em|p|br)\b)[^>]*>/gi, '');
}

export function renderGuidePage(g: GuidePublishInput): string {
  const base = config.WEBSITE_BASE_URL.replace(/\/$/, '');
  const api = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
  const inside = cleanInside(g.insideHtml);
  const intro = esc(g.intro).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.title)} — free guide from Lumen IT Solutions</title>
<meta name="description" content="${esc(g.excerpt)}">
<link rel="canonical" href="${base}/guides/${esc(g.slug)}/">
<meta property="og:title" content="${esc(g.title)}">
<meta property="og:description" content="${esc(g.excerpt)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${base}/guides/${esc(g.slug)}/">
${g.imageUrl ? `<meta property="og:image" content="${esc(g.imageUrl)}">` : ''}
<meta name="twitter:card" content="${g.imageUrl ? 'summary_large_image' : 'summary'}">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc;line-height:1.65;}
  .top{background:#0b2545;padding:18px 20px;}
  .top a{color:#fff;text-decoration:none;font-weight:800;font-size:20px;letter-spacing:-.3px;}
  .wrap{max-width:960px;margin:0 auto;padding:34px 20px 60px;}
  .pill{display:inline-block;background:#ecfeff;color:#0e7490;border:1px solid #a5f3fc;border-radius:999px;padding:4px 14px;font-size:13.5px;font-weight:700;margin-bottom:14px;}
  h1{font-size:38px;line-height:1.15;margin:0 0 14px;letter-spacing:-.5px;}
  .lede{font-size:18.5px;color:#334155;}
  .lede p{margin:0 0 14px;}
  .cols{display:flex;gap:30px;align-items:flex-start;flex-wrap:wrap;margin-top:26px;}
  .left{flex:1 1 400px;min-width:300px;}
  .right{flex:0 1 380px;min-width:300px;}
  .hero{width:100%;border-radius:14px;display:block;margin:0 0 22px;}
  .inside{background:#fff;border:1px solid #e6ecf2;border-radius:14px;padding:22px 26px;}
  .inside h2{font-size:19px;margin:0 0 10px;}
  .inside ul{margin:0;padding-left:22px;}
  .inside li{margin-bottom:9px;font-size:16px;}
  .card{background:#fff;border:1px solid #e6ecf2;border-radius:16px;padding:26px 26px 22px;box-shadow:0 10px 28px rgba(2,6,23,.08);position:sticky;top:20px;}
  .card h2{font-size:20px;margin:0 0 4px;}
  .card .sub{color:#64748b;font-size:14.5px;margin:0 0 18px;}
  label{display:block;font-size:13.5px;font-weight:700;color:#334155;margin:0 0 4px;}
  input{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15.5px;font-family:inherit;margin-bottom:13px;background:#fff;color:#0f172a;}
  input:focus{outline:none;border-color:#0ea5b7;box-shadow:0 0 0 3px rgba(14,165,183,.16);}
  button{width:100%;background:#0ea5b7;color:#fff;border:0;font-weight:700;padding:14px;border-radius:8px;font-size:16.5px;cursor:pointer;font-family:inherit;}
  button:hover{background:#0e7490;}
  button:disabled{opacity:.65;cursor:default;}
  .small{color:#64748b;font-size:13px;line-height:1.55;margin:13px 0 0;}
  .small strong{color:#334155;}
  .done .small{color:#94a3b8;font-size:12.5px;}
  /* The reassurance is the reason people finish this form, so it is not fine print. */
  .why{margin:16px 0 0;padding:14px 16px;background:#ecfeff;border:1px solid #a5f3fc;border-left:5px solid #0ea5b7;border-radius:10px;color:#134e4a;font-size:14.5px;line-height:1.55;}
  .why h3{margin:0 0 6px;font-size:15px;color:#0e7490;}
  .why p{margin:0 0 8px;}
  .why p:last-child{margin:0;}
  .why b{font-weight:700;color:#0f3d3a;}
  .msg{font-size:14.5px;margin:12px 0 0;}
  .bad{color:#b91c1c;}
  .done{text-align:center;padding:8px 0 4px;}
  .done h2{font-size:22px;margin:0 0 6px;}
  .done p{color:#475569;font-size:15.5px;margin:0 0 18px;}
  .dl{display:inline-block;background:#0ea5b7;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;font-size:16.5px;}
  .optin{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px;color:#334155;line-height:1.5;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:13px 14px;margin:2px 0 15px;cursor:pointer;}
  .optin:hover{border-color:#0ea5b7;}
  .optin input{width:auto;margin:2px 0 0;flex:0 0 auto;}
  .optin b{color:#334155;font-weight:700;}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
  .foot{color:#94a3b8;font-size:13.5px;text-align:center;margin-top:40px;}
  .foot a{color:#64748b;}
  @media (max-width:720px){ h1{font-size:29px;} .card{position:static;} }
</style>
</head>
<body>
<div class="top"><a href="${base}/">Lumen IT Solutions</a></div>
<div class="wrap">
  <span class="pill">Free guide · no cost, no catch · no sales call</span>
  <h1>${esc(g.title)}</h1>
  <div class="lede"><p>${intro}</p></div>
  <div class="cols">
    <div class="left">
      ${g.imageUrl ? `<img class="hero" src="${esc(g.imageUrl)}" alt="">` : ''}
      ${inside ? `<div class="inside"><h2>What's inside</h2>${inside}</div>` : ''}
    </div>
    <div class="right">
      <div class="card" id="gcard">
        <div id="gform">
          <h2>Get your free copy</h2>
          <p class="sub">Tell us where to send it and the download starts straight away. No follow-up unless you ask for one.</p>
          <form id="gf" autocomplete="on">
            <label for="gn">Your name</label>
            <input id="gn" name="name" type="text" autocomplete="name" required>
            <label for="ge">Work email</label>
            <input id="ge" name="email" type="email" autocomplete="email" required>
            <label for="gc">Company <span style="font-weight:400;color:#94a3b8;">(optional)</span></label>
            <input id="gc" name="company" type="text" autocomplete="organization">
            <label for="gp">Phone <span style="font-weight:400;color:#94a3b8;">(optional)</span></label>
            <input id="gp" name="phone" type="tel" autocomplete="tel">
            <label class="optin" for="go"><input id="go" name="optin" type="checkbox"><span>Send me the occasional email with practical IT and security tips. <b>Leave this unticked and you will not hear from us at all.</b></span></label>
            <div class="hp"><label for="gw">Leave this empty</label><input id="gw" name="website" type="text" tabindex="-1" autocomplete="off"></div>
            <button type="submit" id="gb">Send me the guide</button>
          </form>
          <p class="msg bad" id="gmsg" style="display:none;"></p>
          <div class="why">
            <h3>Why we ask for this</h3>
            <p><b>To keep bots away from the file.</b> That is the whole reason for this form &mdash; nothing else.</p>
            <p><b>We will never share or sell your details.</b> They stay with us, full stop.</p>
            <p><b>We will not contact you unless you tick the box above.</b> Leave it unticked and you get the guide and never hear from us. Tick it and you can unsubscribe from any email, any time.</p>
          </div>
        </div>
        <div id="gdone" class="done" style="display:none;">
          <h2>It's on its way 🎉</h2>
          <p>Your download should start automatically. If it doesn't, use the button below.</p>
          <a class="dl" id="gdl" href="#">Download the guide</a>
          <p class="small">Keep this page open until the download finishes.</p>
        </div>
      </div>
    </div>
  </div>
  <div class="foot"><a href="${base}/news/">News</a> · <a href="${base}/contact">Talk to us</a> · <a href="${base}/">lumenmsp.co.uk</a></div>
</div>
<script>
(function(){
  var f = document.getElementById('gf'), btn = document.getElementById('gb'), msg = document.getElementById('gmsg');
  f.addEventListener('submit', function(e){
    e.preventDefault();
    msg.style.display = 'none';
    var body = {
      slug: ${JSON.stringify(g.slug)},
      name: document.getElementById('gn').value,
      email: document.getElementById('ge').value,
      company: document.getElementById('gc').value,
      phone: document.getElementById('gp').value,
      optin: document.getElementById('go').checked,
      website: document.getElementById('gw').value
    };
    btn.disabled = true; btn.textContent = 'One moment…';
    fetch(${JSON.stringify(api + '/api/guide-lead')}, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function(r){ return r.json(); }).then(function(d){
      btn.disabled = false; btn.textContent = 'Send me the guide';
      if (!d || !d.ok || !d.url) {
        msg.textContent = (d && d.error) || 'Something went wrong — please try again, or email hello@lumenmsp.co.uk and we will send it over.';
        msg.style.display = 'block';
        return;
      }
      document.getElementById('gdl').href = d.url;
      document.getElementById('gform').style.display = 'none';
      document.getElementById('gdone').style.display = 'block';
      window.location.href = d.url;
    }).catch(function(){
      btn.disabled = false; btn.textContent = 'Send me the guide';
      msg.textContent = 'We could not reach our server — please try again in a moment.';
      msg.style.display = 'block';
    });
  });
})();
</script>
</body>
</html>`;
}

export function guidePublishConfigured(): boolean {
  return !!config.WEBSITE_GUIDES_DIR && fs.existsSync(config.WEBSITE_GUIDES_DIR);
}

export function guideUrlFor(slug: string): string {
  return `${config.WEBSITE_BASE_URL.replace(/\/$/, '')}/guides/${slug}/`;
}

export async function publishGuidePage(input: GuidePublishInput): Promise<GuidePublishResult> {
  const dir = config.WEBSITE_GUIDES_DIR;
  if (!dir) throw new Error('WEBSITE_GUIDES_DIR is not configured.');
  if (!fs.existsSync(dir)) throw new Error(`The guides directory (${dir}) does not exist or the Portal cannot see it — run the one-off setup: mkdir -p ${dir}`);

  const slug = String(input.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug || !input.title.trim()) throw new Error('A title and a page address are both required.');

  const pageDir = path.join(dir, slug);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'index.html'), renderGuidePage({ ...input, slug }), 'utf8');

  // index.json lets the Astro site list the available guides client-side later, the same way
  // the news listing does — written now so the data is there when that page is built.
  const idxPath = path.join(dir, 'index.json');
  let items: { slug: string; title: string; excerpt: string; date: string; image?: string }[] = [];
  try { items = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch { /* first guide */ }
  items = items.filter((i) => i.slug !== slug);
  items.unshift({
    slug, title: input.title.trim(), excerpt: input.excerpt.trim(),
    date: new Date().toISOString().slice(0, 10), image: (input.imageUrl || '').trim() || undefined,
  });
  fs.writeFileSync(idxPath, JSON.stringify(items, null, 2), 'utf8');

  return { url: guideUrlFor(slug), slug };
}
