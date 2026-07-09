import { config } from '../config';
import { getSetting } from './settings';

// Minimal client for Buffer's GraphQL API (https://developers.buffer.com).
// Auth: a personal API key (Bearer). Endpoint: POST https://api.buffer.com.
// Used by the Marketing → Socials section to push posts to LinkedIn / Facebook /
// Google Business via Buffer. The token lives in the server .env (config.BUFFER_TOKEN)
// and is never sent to the browser.

const API = 'https://api.buffer.com';

// Token comes from Settings → Integrations (settings table) and falls back to the server .env.
export async function getBufferToken(): Promise<string> {
  return (await getSetting('buffer', 'api_key')) || config.BUFFER_TOKEN || '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql<T = any>(query: string, variables?: Record<string, any>, attempt = 0): Promise<T> {
  const token = await getBufferToken();
  if (!token) throw new Error('Buffer API key not set (Settings → Integrations).');
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  // Back off and retry on Buffer's rate limit (HTTP 429) or transient 503.
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * Math.pow(2, attempt);
    await sleep(Math.min(wait, 15000));
    return gql<T>(query, variables, attempt + 1);
  }
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Buffer API HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (json.errors) {
    const msg = json.errors.map((e: any) => e.message).join('; ');
    // Some rate limits arrive as a GraphQL error rather than a 429 — retry those too.
    if (/too many requests|rate limit/i.test(msg) && attempt < 4) {
      await sleep(Math.min(1500 * Math.pow(2, attempt), 15000));
      return gql<T>(query, variables, attempt + 1);
    }
    throw new Error(msg);
  }
  return json.data as T;
}

export interface BufferChannel { id: string; name: string; service: string; }
export type PostMode = 'schedule' | 'now' | 'queue';

export async function bufferConfigured(): Promise<boolean> { return !!(await getBufferToken()); }

export async function getOrganizationId(): Promise<string> {
  const d = await gql<{ account: { organizations: { id: string; name: string }[] } }>(
    `query { account { organizations { id name } } }`);
  const orgs = d?.account?.organizations || [];
  if (!orgs.length) throw new Error('No Buffer organisations found for this API key.');
  return orgs[0].id;
}

// Short in-memory cache so every Socials page load doesn't spend 2 Buffer calls (org + channels).
// Failures are negatively cached for a short window so a rate-limited Buffer isn't re-hammered
// (and doesn't make every page load retry for ~20s).
let _chCache: { at: number; channels: BufferChannel[] } | null = null;
let _chFail: { at: number; error: string } | null = null;
export async function getChannels(orgId?: string): Promise<BufferChannel[]> {
  if (!orgId && _chCache && Date.now() - _chCache.at < 60000) return _chCache.channels;
  if (!orgId && _chFail && Date.now() - _chFail.at < 20000) throw new Error(_chFail.error);
  try {
    const id = orgId || (await getOrganizationId());
    const d = await gql<{ channels: BufferChannel[] }>(
      `query GetChannels($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }`,
      { id });
    const channels = d?.channels || [];
    if (!orgId) { _chCache = { at: Date.now(), channels }; _chFail = null; }
    return channels;
  } catch (e: any) {
    if (!orgId) _chFail = { at: Date.now(), error: e?.message || 'Buffer unavailable' };
    throw e;
  }
}

// Map our network keys to a connected Buffer channel by its service string.
export function channelFor(channels: BufferChannel[], network: string): BufferChannel | undefined {
  return channels.find((c) => String(c.service || '').toLowerCase().includes(network));
}

// Google Business rejects phone numbers in the post body — drop any line containing one.
function stripPhones(text: string): string {
  return text.split('\n')
    .filter((l) => !/\b0\d[\d\s().-]{7,}\b/.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Per-channel required metadata. Facebook needs a post type; Google Business needs a
// post type (we use a standard "what's new" update). LinkedIn needs nothing.
function channelMetadata(network: string): any | undefined {
  if (network === 'facebook') return { facebook: { type: 'post' } };
  // Google Business: field is `google` (GoogleBusinessPostMetadataInput); type enum is post/offer/event.
  if (network === 'google') return { google: { type: 'post' } };
  return undefined;
}

// Create a post. schedule = customScheduled at dueAt; queue = next Buffer schedule slot;
// now = customScheduled a couple of minutes out (reliable "post immediately").
export async function createBufferPost(channelId: string, text: string, mode: PostMode, network: string, dueAt?: string, imageUrl?: string): Promise<{ id?: string; error?: string }> {
  const body = network === 'google' ? stripPhones(text) : text;
  const input: any = { text: body, channelId, schedulingType: 'automatic' };
  const meta = channelMetadata(network);
  if (meta) input.metadata = meta;
  if (imageUrl) input.assets = [{ image: { url: imageUrl } }];
  if (mode === 'queue') { input.mode = 'addToQueue'; }
  else if (mode === 'now') { input.mode = 'customScheduled'; input.dueAt = new Date(Date.now() + 2 * 60000).toISOString(); }
  else { input.mode = 'customScheduled'; if (dueAt) input.dueAt = dueAt; }

  const mutation = `mutation Create($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id dueAt } }
      ... on MutationError { message }
    }
  }`;
  try {
    const d = await gql<{ createPost: any }>(mutation, { input });
    const r = d.createPost;
    if (r && r.message) return { error: r.message };
    return { id: r?.post?.id };
  } catch (e: any) {
    // Fallback: inline literal in case the input type name differs in the beta schema.
    const inline = JSON.stringify(input).replace(/"(\w+)":/g, '$1:')
      .replace(/"(automatic|addToQueue|customScheduled)"/g, '$1');
    try {
      const d = await gql<{ createPost: any }>(`mutation { createPost(input: ${inline}) {
        ... on PostActionSuccess { post { id dueAt } }
        ... on MutationError { message } } }`);
      const r = d.createPost;
      if (r && r.message) return { error: r.message };
      return { id: r?.post?.id };
    } catch (e2: any) {
      return { error: e2.message || e.message };
    }
  }
}
