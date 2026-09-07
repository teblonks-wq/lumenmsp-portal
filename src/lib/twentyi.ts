import { getSetting } from './settings';

// ── 20i reseller API ────────────────────────────────────────────────────────────
// Terry, 7 Sep 2026: "let's get 20i set up and integrated — pushing DNS records would be great,
// especially linked into domain health."
//
// The Portal already knows what a domain's DNS SHOULD say: lib/dmarc/dns-check.ts reads the live
// records, scores the domain and generates the SPF and DMARC it would ask the customer to publish.
// Until now that was a value to copy into somebody else's control panel. Where 20i holds the zone,
// this closes the loop and publishes it.
//
// WHAT IS VERIFIED, AND WHAT IS NOT. The reference docs live on Apiary behind the reseller login,
// so the contract here was taken from working public code (the certbot DNS-01 plugin for 20i) and
// 20i's own guides:
//   • base https://api.20i.com, Authorization: Bearer <base64 of the general API key>   [documented]
//   • GET  /domain/{domain}       → the domain, 404/error when it is not on this account [verified]
//   • GET  /domain/{zone}/dns     → { records: [ … ] }, each carrying a `ref`            [verified]
//   • POST /domain/{zone}/dns     { new: { TXT: [ { host, txt } ] } }                    [verified]
//   • POST /domain/{zone}/dns     { delete: [ ref ] }                                    [verified]
// The field names for A / CNAME / MX writes are NOT verified, so this module refuses to write
// them: TXT is the only type it will publish. That is not a limitation in practice — SPF, DMARC
// and DKIM are all TXT, and they are the whole of what domain health generates. When the Apiary
// docs are to hand, add the other types to WRITEABLE and their shapes to `newPayload`.
//
// Everything that changes a zone goes through `publishTxt`, which previews first, matches the
// record it is replacing by exact host, and never deletes anything it has not identified.

const BASE = 'https://api.20i.com';
const TIMEOUT_MS = 20_000;

export class TwentyiError extends Error {
  constructor(msg: string, public status = 0) { super(msg); this.name = 'TwentyiError'; }
}

export async function apiKey(): Promise<string> {
  return ((await getSetting('twentyi', 'api_key')) || '').trim();
}
export async function configured(): Promise<boolean> {
  return !!(await apiKey());
}

/** The bearer is the base64 of the general API key — not the key itself. */
function bearer(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64');
}

async function req<T = any>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
  const key = await apiKey();
  if (!key) throw new TwentyiError('No 20i API key — add one in Settings → Integrations.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method, signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${bearer(key)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: any) {
    throw new TwentyiError(e.name === 'AbortError' ? '20i did not answer within 20 seconds.' : `Could not reach 20i: ${e.message}`);
  } finally { clearTimeout(timer); }

  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 20i answers JSON; a non-JSON body is an error page */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new TwentyiError('20i rejected the API key — check it in Settings → Integrations.', res.status);
    if (res.status === 404) throw new TwentyiError('20i does not know that domain on this account.', 404);
    const detail = json?.error?.message || json?.message || (text ? text.slice(0, 200) : `HTTP ${res.status}`);
    throw new TwentyiError(`20i: ${detail}`, res.status);
  }
  return json as T;
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export interface ZoneRecord {
  ref: string;            // 20i's handle for the record — the only safe way to delete one
  type: string;           // TXT | A | CNAME | MX | …
  host: string;           // '@' for the apex
  value: string;          // the payload, whatever the type calls it
  priority?: number | null;
  raw: any;
}

/** 20i names a record's payload differently per type; read whichever field is present. */
function valueOf(type: string, r: any): string {
  const v = r.txt ?? r.value ?? r.target ?? r.ip ?? r.address ?? r.canonical ?? r.data ?? r.content;
  return v == null ? '' : String(v);
}

/** Every record in a zone, normalised. Types come back either as a flat list or grouped by type. */
export async function listZone(domain: string): Promise<ZoneRecord[]> {
  const j = await req<any>('GET', `/domain/${encodeURIComponent(domain)}/dns`);
  const out: ZoneRecord[] = [];
  const push = (type: string, r: any) => {
    if (!r || typeof r !== 'object') return;
    out.push({
      ref: String(r.ref ?? r.id ?? ''),
      type: String(type || r.type || '').toUpperCase(),
      host: String(r.host ?? r.name ?? '@'),
      value: valueOf(type, r),
      priority: r.priority ?? r.pri ?? null,
      raw: r,
    });
  };
  const records = j?.records ?? j;
  if (Array.isArray(records)) records.forEach((r: any) => push(String(r?.type || ''), r));
  else if (records && typeof records === 'object') {
    for (const [type, list] of Object.entries(records)) {
      if (Array.isArray(list)) list.forEach((r) => push(type, r));
    }
  }
  return out;
}

/** Is this domain on the 20i account at all? Cheap gate before anything is written. */
export async function hasDomain(domain: string): Promise<boolean> {
  try { await req('GET', `/domain/${encodeURIComponent(domain)}`); return true; }
  catch (e: any) { if (e instanceof TwentyiError && e.status === 404) return false; throw e; }
}

/** Domains on the account — used by the Test button, and to say which domains we can act on. */
export async function listDomains(): Promise<Array<{ name: string; id: string | null; expires: string | null }>> {
  const j = await req<any>('GET', '/domain');
  const list: any[] = Array.isArray(j) ? j : (j?.domains ?? j?.result ?? []);
  return list.map((d: any) => ({
    name: String(d?.name ?? d?.domain ?? d?.id ?? ''),
    id: d?.id != null ? String(d.id) : null,
    expires: d?.expiryDate ?? d?.expires ?? null,
  })).filter((d) => d.name);
}

// ── Writing (TXT only — see the header) ─────────────────────────────────────────

export const WRITEABLE = new Set(['TXT']);

const norm = (h: string) => {
  const s = String(h || '').trim().replace(/\.$/, '');
  return s === '' || s === '@' ? '@' : s.toLowerCase();
};
/** SPF and DMARC are compared ignoring whitespace runs; the semantics don't care. */
const sameValue = (a: string, b: string) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();

export interface PublishPlan {
  domain: string;
  host: string;
  value: string;
  replaces: ZoneRecord[];   // exactly what will be deleted, by ref
  alreadyRight: boolean;    // nothing to do
  note: string;             // one sentence for the confirmation
}

/**
 * Work out what publishing this TXT would do, WITHOUT touching anything.
 *
 * `match` decides which existing records at that host this one replaces — SPF replaces the
 * existing SPF, DMARC the existing DMARC, and a DKIM selector replaces that selector. Records at
 * the same host that are none of those (a Google verification string, say) are left alone: a TXT
 * host legitimately holds several unrelated values, and deleting one is how a verification breaks.
 */
export async function planTxt(domain: string, host: string, value: string, match: (existing: string) => boolean): Promise<PublishPlan> {
  const h = norm(host);
  const zone = await listZone(domain);
  const atHost = zone.filter((r) => r.type === 'TXT' && norm(r.host) === h);
  const replaces = atHost.filter((r) => match(r.value));
  const alreadyRight = replaces.length === 1 && sameValue(replaces[0].value, value) ;
  const note = alreadyRight
    ? `${domain} already publishes exactly that at ${h}.`
    : replaces.length === 0
      ? `Add a TXT record at ${h} on ${domain}. Nothing is removed.`
      : replaces.length === 1
        ? `Replace the TXT at ${h} on ${domain}. The old value goes, the new one takes its place.`
        : `Replace ${replaces.length} TXT records at ${h} on ${domain} with one. Having more than one is itself the fault.`;
  return { domain, host: h, value, replaces, alreadyRight, note };
}

export interface PublishResult { ok: boolean; added: boolean; deleted: number; error?: string }

/**
 * Do it: add the new record, then delete what it replaced.
 *
 * ADD FIRST, DELETE AFTER, on purpose. If the add fails the zone is untouched. If the delete
 * fails, the domain briefly has both records — visible and fixable — rather than none, which for
 * SPF means mail starts failing. The one exception is a lone exact replacement, where the record
 * must be removed first because 20i will not hold two identical values.
 */
export async function publishTxt(plan: PublishPlan): Promise<PublishResult> {
  if (plan.alreadyRight) return { ok: true, added: false, deleted: 0 };
  if (!(await hasDomain(plan.domain))) return { ok: false, added: false, deleted: 0, error: `${plan.domain} is not on the 20i account, so its DNS is not ours to change.` };

  const exactDupe = plan.replaces.filter((r) => sameValue(r.value, plan.value));
  let deleted = 0;
  try {
    if (exactDupe.length) {
      await req('POST', `/domain/${encodeURIComponent(plan.domain)}/dns`, { delete: exactDupe.map((r) => r.ref) });
      deleted += exactDupe.length;
    }
    await req('POST', `/domain/${encodeURIComponent(plan.domain)}/dns`, { new: { TXT: [{ host: plan.host, txt: plan.value }] } });
  } catch (e: any) {
    return { ok: false, added: false, deleted, error: e.message };
  }
  const toGo = plan.replaces.filter((r) => !exactDupe.includes(r) && r.ref);
  if (toGo.length) {
    try {
      await req('POST', `/domain/${encodeURIComponent(plan.domain)}/dns`, { delete: toGo.map((r) => r.ref) });
      deleted += toGo.length;
    } catch (e: any) {
      return { ok: true, added: true, deleted, error: `The new record is published, but the old one could not be removed (${e.message}). Both are live — remove the old one in StackCP.` };
    }
  }
  return { ok: true, added: true, deleted };
}

// ── The matchers domain health uses ─────────────────────────────────────────────
export const isSpf = (v: string) => /^\s*v=spf1\b/i.test(v);
export const isDmarc = (v: string) => /^\s*v=DMARC1\b/i.test(v);
export const isDkim = (v: string) => /(^|;)\s*(v=DKIM1|k=rsa|p=)/i.test(v);
