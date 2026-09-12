import crypto from 'crypto';
import { pool } from '../db/pool';

// ── Portal-owned content analytics ──────────────────────────────────────────────
// The Astro site has its own page-view beacon in BaseLayout.astro, posting to the
// broadband-api. The pages the Portal writes — news articles under /news/live/ and guide
// landing pages under /guides/ — are standalone HTML and never had it, so from the day the
// Socials Studio shipped, everything it published was invisible in Website Stats.
//
// They beacon HERE instead of to the website's endpoint, for one reason: that table stores
// the path only. We need the query string, because that is where the utm_source lives, and
// per-network attribution is the whole point of tagging the links. Keeping it in the Portal
// DB also means views, form submissions and downloads can be joined into one funnel without
// a cross-database query.
//
// Created with raw SQL here AND declared in prisma/schema.prisma (model ContentView) so
// `prisma db push --accept-data-loss` cannot drop it.

export async function ensureContentViewTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_views (
      id           BIGSERIAL PRIMARY KEY,
      kind         TEXT,
      slug         TEXT,
      path         TEXT NOT NULL,
      utm_source   TEXT,
      utm_medium   TEXT,
      utm_campaign TEXT,
      referrer     TEXT,
      ua           TEXT,
      ip_hash      TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_views_slug ON content_views (kind, slug);
    CREATE INDEX IF NOT EXISTS idx_content_views_created ON content_views (created_at);
  `);
}

// Bots announce themselves. Not exhaustive and not meant to be — it keeps the obvious
// crawlers out of the numbers without pretending to be bot detection.
const BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|slackbot|discord|preview|monitor|pingdom|uptime|headless|lighthouse|curl|wget|python-requests|scrapy/i;

export function isBot(ua: string): boolean { return BOT.test(String(ua || '')); }

// Same shape as the website's beacon: a salted hash, never the address itself. Enough to
// count people roughly once, not enough to identify anybody.
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update('lumen-cv:' + String(ip || '')).digest('hex').slice(0, 32);
}

export interface ViewInput {
  kind: string; slug: string; path: string;
  utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null;
  referrer?: string | null; ua?: string | null; ip?: string | null;
}

export async function recordView(v: ViewInput): Promise<void> {
  if (isBot(v.ua || '')) return;
  await pool.query(
    `INSERT INTO content_views (kind, slug, path, utm_source, utm_medium, utm_campaign, referrer, ua, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [String(v.kind || '').slice(0, 20) || null, String(v.slug || '').slice(0, 80) || null,
      String(v.path || '').slice(0, 300),
      (v.utmSource || '').slice(0, 60) || null, (v.utmMedium || '').slice(0, 60) || null,
      (v.utmCampaign || '').slice(0, 80) || null, (v.referrer || '').slice(0, 300) || null,
      (v.ua || '').slice(0, 300) || null, hashIp(v.ip || '')]);
}

export interface ViewStats {
  views: number;          // every hit
  people: number;         // distinct ip_hash — a rough head count, not a promise
  last: string | null;
  sources: { source: string; views: number; people: number }[];
  daily: { day: string; views: number }[];
}

export async function viewStats(kind: string, slug: string, days = 90): Promise<ViewStats> {
  const where = `kind=$1 AND slug=$2 AND created_at > NOW() - ($3 || ' days')::interval`;
  const totals = await pool.query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT ip_hash)::int AS people, MAX(created_at) AS last
       FROM content_views WHERE ${where}`, [kind, slug, String(days)]);
  const sources = await pool.query(
    `SELECT COALESCE(NULLIF(utm_source,''), 'direct / other') AS source,
            COUNT(*)::int AS views, COUNT(DISTINCT ip_hash)::int AS people
       FROM content_views WHERE ${where}
      GROUP BY 1 ORDER BY 2 DESC`, [kind, slug, String(days)]);
  const daily = await pool.query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS views
       FROM content_views WHERE ${where}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 30`, [kind, slug, String(days)]);
  const t = totals.rows[0] || {};
  return {
    views: t.views || 0, people: t.people || 0, last: t.last || null,
    sources: sources.rows, daily: daily.rows,
  };
}

// View counts for many slugs at once — the Guides list, without a query per row.
export async function viewCounts(kind: string, slugs: string[]): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const { rows } = await pool.query(
    `SELECT slug, COUNT(*)::int AS n FROM content_views WHERE kind=$1 AND slug = ANY($2::text[]) GROUP BY slug`,
    [kind, slugs]);
  const out: Record<string, number> = {};
  rows.forEach((r: any) => { out[r.slug] = r.n; });
  return out;
}

// Everything the Portal has published and tracked, newest activity first.
export async function trackedContent(days = 90): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT kind, slug,
            COUNT(*)::int AS views,
            COUNT(DISTINCT ip_hash)::int AS people,
            MAX(created_at) AS last_view,
            MIN(created_at) AS first_view
       FROM content_views
      WHERE created_at > NOW() - ($1 || ' days')::interval AND slug IS NOT NULL
      GROUP BY kind, slug
      ORDER BY views DESC`, [String(days)]);
  return rows;
}

// Where the traffic came from across everything, for the summary row.
export async function sourceTotals(days = 90): Promise<{ source: string; views: number }[]> {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(utm_source,''), 'direct / other') AS source, COUNT(*)::int AS views
       FROM content_views WHERE created_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 2 DESC`, [String(days)]);
  return rows;
}

// ── Link tagging ────────────────────────────────────────────────────────────────
// Every link we push anywhere carries where it came from, so "which channel actually
// works" is answerable from our own data rather than from Buffer's.
export function tagUrl(url: string, source: string, medium: string, campaign: string): string {
  const u = String(url || '').trim();
  if (!u) return u;
  if (/[?&]utm_source=/.test(u)) return u;           // already tagged — leave it alone
  const sep = u.includes('?') ? '&' : '?';
  const q = [
    'utm_source=' + encodeURIComponent(source),
    'utm_medium=' + encodeURIComponent(medium),
    campaign ? 'utm_campaign=' + encodeURIComponent(campaign) : '',
  ].filter(Boolean).join('&');
  return u + sep + q;
}

// The slug a published URL belongs to, for tagging without being told separately.
export function slugFromUrl(url: string): string {
  const m = String(url || '').match(/\/(?:guides|news\/live)\/([a-z0-9-]+)\/?/i);
  return m ? m[1] : '';
}
