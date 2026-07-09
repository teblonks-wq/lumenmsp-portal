import cron from 'node-cron';
import { getGroup, setSetting } from './settings';
import { raiseAlert } from './alerts';

// Polls the Giacom (Cloud Market) public StatusCast status page feed and raises an alert for each
// new incident / planned maintenance. No Giacom credentials needed. The feed URL is auto-detected
// from a few common StatusCast paths (and cached), or set explicitly in settings group
// 'giacom_status' key 'feed_url'. Disable with key 'enabled'='false'.
const CANDIDATES = [
  'https://status.cloud.market/rss',
  'https://status.cloud.market/feed',
  'https://status.cloud.market/feed/rss',
  'https://status.cloud.market/history.rss',
  'https://giacom.status.page/rss',
  'https://connectivitystatus.cloud.market/rss',
];

function tag(block: string, name: string): string {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  let v = m ? m[1] : '';
  v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#3?9;/g, "'")
       .replace(/\s+/g, ' ').trim();
  return v;
}
function linkOf(block: string): string {
  const a = block.match(/<link[^>]*href="([^"]+)"/i);
  if (a) return a[1];
  return tag(block, 'link');
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'LumenMSP-Portal', Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' } });
    if (!r.ok) return null;
    const t = await r.text();
    return /<item[\s>]|<entry[\s>]/i.test(t) ? t : null;
  } catch { return null; }
}

async function resolveFeedUrl(): Promise<{ url: string; xml: string } | null> {
  const g = await getGroup('giacom_status').catch(() => ({} as Record<string, string>));
  const configured = g.feed_url;
  const tryList = configured ? [configured, ...CANDIDATES] : CANDIDATES;
  for (const u of tryList) {
    const xml = await fetchXml(u);
    if (xml) { if (u !== configured) { try { await setSetting('giacom_status', 'feed_url', u); } catch { /* ignore */ } } return { url: u, xml }; }
  }
  return null;
}

async function poll(): Promise<void> {
  const g = await getGroup('giacom_status').catch(() => ({} as Record<string, string>));
  if (g.enabled === 'false') return;
  const found = await resolveFeedUrl();
  if (!found) { console.warn('[giacom-status] no working feed URL found'); return; }
  const blocks = found.xml.match(/<item[\s\S]*?<\/item>/gi) || found.xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const cutoff = Date.now() - 7 * 86400000;
  for (const b of blocks.slice(0, 25)) {
    const title = tag(b, 'title'); if (!title) continue;
    const guid = (tag(b, 'guid') || tag(b, 'id') || linkOf(b) || title).slice(0, 200);
    const desc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const pub = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
    const when = pub ? Date.parse(pub) : Date.now();
    if (when && when < cutoff) continue;
    const low = (title + ' ' + desc).toLowerCase();
    if (/resolved|restored|completed|all clear|closed/.test(low)) continue; // we alert on new issues only
    const severity = /maintenance|scheduled/.test(low) ? 'info' : /major|critical|outage|down|unavailable/.test(low) ? 'critical' : 'warning';
    await raiseAlert({ source: 'giacom', externalId: guid, severity, title, body: desc, url: linkOf(b) || found.url, raw: { pub } }).catch(() => {});
  }
}

export function startGiacomStatus(): void {
  cron.schedule('*/5 * * * *', () => { poll().catch((e) => console.error('[giacom-status]', e.message)); });
  console.log('✓ Giacom status poller started (5-min)');
}
