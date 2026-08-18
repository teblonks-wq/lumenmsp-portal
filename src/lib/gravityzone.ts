import { pool } from '../db/pool';
import { getSetting, setSetting } from './settings';
import { logActivity } from './activity';
import { nextTicketNumber } from '../routes/tickets';

// ── Bitdefender GravityZone ─────────────────────────────────────────────────────
// GravityZone is the engine, the Portal is the cockpit. Lumen gives AV away with the
// Managed IT package, so SCOPE FOLLOWS THE CONTRACT (customers.is_itsm) rather than
// being sold per seat: enable a customer once and every machine of theirs is picked
// up from then on.
//
// Design notes that matter:
//
//  * ONE rpc() helper. Every call goes through it, so auth, the service path and error
//    handling exist in a single place — and when a method name or field turns out to
//    differ from the documentation, it is a one-line fix rather than a rewrite.
//  * The raw endpoint record is STORED. Display columns are derived from it; a field
//    we read wrong can be re-derived without re-syncing the estate.
//  * testConnection() probes each service and reports exactly what answered, with the
//    raw payload. The API surface is discovered from Lumen's own tenant rather than
//    trusted from a PDF — which is the only way to be sure.
//  * The API key lives in the settings table (group 'gravityzone'), entered by an
//    admin in the Portal. It is a credential to every customer's security console:
//    it never goes in a repo, a URL, or anybody's chat window.
//
// Auth is HTTP Basic with the key as the username and an empty password:
//   Authorization: Basic base64(apiKey + ':')

const DEFAULT_BASE = 'https://cloudgz.gravityzone.bitdefender.com/api';
const API_VERSION = 'v1.0';

/** The services we use. Kept as data so testConnection can walk them. */
export const GZ_SERVICES = ['companies', 'network', 'packages', 'licensing', 'incidents', 'accounts',
  // Added 2026-08-17 for Terry's three asks: policy exclusions, quarantine restore, and
  // device/company event history. The API key already has all three scopes enabled.
  'policies', 'quarantine', 'push'] as const;
export type GzService = typeof GZ_SERVICES[number];

export interface GzConfig { key: string; base: string }

export async function gzConfig(): Promise<GzConfig | null> {
  const key = (await getSetting('gravityzone', 'api_key')) || '';
  if (!key) return null;
  const base = ((await getSetting('gravityzone', 'base_url')) || DEFAULT_BASE).replace(/\/+$/, '');
  return { key, base };
}

export async function gzConfigured(): Promise<boolean> {
  return !!(await getSetting('gravityzone', 'api_key'));
}

export async function saveGzConfig(key: string | null, base: string | null): Promise<void> {
  if (key !== null) await setSetting('gravityzone', 'api_key', key || null);
  if (base !== null) await setSetting('gravityzone', 'base_url', (base || DEFAULT_BASE).replace(/\/+$/, ''));
}

export class GzError extends Error {
  constructor(message: string, readonly status?: number, readonly rpcCode?: number) { super(message); }
}

let rpcId = 0;

/**
 * One JSON-RPC call. Returns the `result` payload, throws GzError with the message
 * GravityZone actually gave — an API error here is nearly always "the key lacks this
 * scope" or "this tenant has no such service", and both deserve saying out loud.
 */
export async function rpc<T = any>(service: GzService | string, method: string, params: any = {}): Promise<T> {
  const cfg = await gzConfig();
  if (!cfg) throw new GzError('GravityZone is not configured — an admin needs to add the API key.');

  const url = `${cfg.base}/${API_VERSION}/jsonrpc/${service}`;
  const auth = Buffer.from(cfg.key + ':').toString('base64');
  const body = { id: String(++rpcId), jsonrpc: '2.0', method, params };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) {
    throw new GzError(`Could not reach GravityZone (${e.message}). Check the access URL and that the server has outbound HTTPS.`);
  }

  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON — reported below */ }

  if (res.status === 401 || res.status === 403) {
    throw new GzError('GravityZone refused the key (HTTP ' + res.status + '). Check it is active and has the right scopes.', res.status);
  }
  if (!json) throw new GzError(`GravityZone returned HTTP ${res.status} with no JSON body.`, res.status);
  if (json.error) {
    const m = json.error.message || 'unknown error';
    const d = json.error.data?.details ? ` — ${json.error.data.details}` : '';
    throw new GzError(`${method}: ${m}${d}`, res.status, json.error.code);
  }
  return json.result as T;
}

/**
 * Try the same method on several service paths and return the first that answers.
 *
 * This exists because of a real hour lost: `getCompaniesList` is documented under
 * PARTNERS > Public API > **Network**, not under a `companies` service, so calling
 * /jsonrpc/companies returns "Method not found" on a perfectly good partner tenant
 * with every API enabled on the key. Rather than hard-code one guess, ask the tenant.
 * Throws the LAST error if nothing works, so the message is still useful.
 */
export async function rpcAny<T = any>(candidates: Array<[string, string]>, params: any = {}): Promise<{ result: T; service: string; method: string }> {
  let last: any = new GzError('No candidate services were tried.');
  for (const [service, method] of candidates) {
    try { return { result: await rpc<T>(service, method, params), service, method }; }
    catch (e: any) { last = e; }
  }
  throw last;
}

/**
 * The query every endpoint listing needs, and none of it is optional in practice:
 *
 *  - allItemsRecursively: WITHOUT this the API returns only the top level of a
 *    company's inventory, so machines inside groups are silently missing. Default
 *    is false, which is the sort of default that produces a confident wrong answer.
 *  - returnProductOutdated / includeScanLogs: these attributes are omitted from the
 *    response unless asked for. "productOutdated" absent reads exactly like
 *    "not outdated", so this must be on.
 */
export const EP_QUERY = {
  filters: { depth: { allItemsRecursively: true } },
  options: { returnProductOutdated: true, includeScanLogs: true },
};

export interface ProbeResult { service: string; method: string; ok: boolean; note: string; sample?: any }

/**
 * Where in a payload does a key matching `re` live? Returns a dotted path, or null.
 *
 * Written because guessing field paths has been the single most expensive habit on this
 * integration: we read `agent.productOutdated` off a list row that never contained it and
 * the whole estate rendered as healthy. When the shape is unknown, find it and report the
 * path rather than testing two guesses and concluding "not supported".
 */
export function findKeyPath(o: any, re: RegExp, path = '', depth = 0): string | null {
  if (o == null || depth > 6 || typeof o !== 'object') return null;
  for (const k of Object.keys(o)) {
    const here = path ? `${path}.${k}` : k;
    if (re.test(k)) return here;
    const hit = findKeyPath(o[k], re, here, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Read a dotted path out of an object. */
export function atPath(o: any, path: string): any {
  let v = o;
  for (const k of path.split('.')) { if (v == null) return undefined; v = v[k]; }
  return v;
}

/**
 * The sibling keys around a found path, with a hint of each one's type.
 *
 * Lumen's tenant found "exclusions" at settings.antimalware.settings.activateExclusions —
 * which is almost certainly a BOOLEAN switch ("are exclusions on?"), not the LIST of
 * exclusions we need to audit. The list will be a sibling. Reporting the neighbours turns
 * one more guessing round into a single answer.
 */
export function siblingsOf(root: any, path: string): string {
  const parentPath = path.split('.').slice(0, -1).join('.');
  const parent = parentPath ? atPath(root, parentPath) : root;
  if (!parent || typeof parent !== 'object') return '';
  return Object.keys(parent).map((k) => {
    const v = (parent as any)[k];
    const kind = Array.isArray(v) ? `array[${v.length}]`
      : v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v;
    return `${k}:${kind}`;
  }).join(', ');
}

/**
 * Probe the tenant. Deliberately harmless — nothing here changes anything — and it
 * returns the raw first item so we can see the REAL field names in this tenant
 * rather than assuming the documented ones.
 */
export async function testConnection(): Promise<{ ok: boolean; probes: ProbeResult[] }> {
  const probes: ProbeResult[] = [];
  const add = async (service: string, method: string, params: any, describe: (r: any) => string) => {
    try {
      const r = await rpc(service, method, params);
      const items = (r as any)?.items;
      probes.push({
        service, method, ok: true, note: describe(r),
        sample: Array.isArray(items) && items.length ? items[0] : r,
      });
    } catch (e: any) {
      probes.push({ service, method, ok: false, note: e.message });
    }
  };

  // Companies. NOTE the service path: getCompaniesList is documented under
  // PARTNERS > Public API > NETWORK, not under `companies` — calling /jsonrpc/companies
  // returns "Method not found" on a healthy partner tenant (Lumen, 2026-08-17). Both
  // paths are probed so the working one is visible rather than assumed.
  await add('network', 'getCompaniesList', {},
    (r) => `${(Array.isArray(r) ? r.length : r?.items?.length) || 0} managed company/companies (via network)`);
  await add('companies', 'getCompaniesList', {},
    (r) => `${(Array.isArray(r) ? r.length : r?.items?.length) || 0} companies (via companies)`);
  await add('companies', 'getCompanyDetails', {},
    (r) => `own company: ${r?.name || '(unnamed)'}`);
  // Groups within a company — the fallback boundary if companies are ever unreadable.
  // (getContainers does NOT exist on this API; the real method is getCustomGroupsList.)
  await add('network', 'getCustomGroupsList', {},
    (r) => `${(Array.isArray(r) ? r.length : r?.items?.length) || 0} custom group(s)`);
  // Endpoints at the API key's own level. On a partner tenant this is Lumen's own
  // Computers and Groups, so 0 here is normal — customers' machines need parentId.
  await add('network', 'getEndpointsList', { page: 1, perPage: 5, ...EP_QUERY },
    (r) => `${r?.total ?? (r?.items?.length || 0)} endpoints at the key's own level` +
           ` (0 is expected on a partner tenant — customers' machines sit under their company)`);
  // ...so probe the first managed company too, which is the number that actually matters.
  try {
    const cl: any = await rpc('network', 'getCompaniesList', {});
    const first = (Array.isArray(cl) ? cl : cl?.items || [])[0];
    if (first?.id) {
      await add('network', 'getEndpointsList', { parentId: first.id, page: 1, perPage: 5, ...EP_QUERY },
        (r) => `${r?.total ?? (r?.items?.length || 0)} endpoints under "${first.name}"`);
    }
  } catch { /* the companies probe above already reported why */ }
  await add('packages', 'getPackagesList', { page: 1, perPage: 5 },
    (r) => `${r?.total ?? (r?.items?.length || 0)} installation packages`);
  // "? total" on Lumen's tenant (17 Aug) means totalSlots is NOT the field name here.
  // Rather than shrug, report where the numbers actually are — seat counts feed both the
  // cost of the giveaway and the quantity on a billed AV line, so a silent "?" is a
  // number nobody notices is missing.
  await add('licensing', 'getLicenseInfo', {},
    (r) => {
      const used = seatCount(r, 'used') ?? 0;
      const total = seatCount(r, 'total');
      if (total != null) return `licence seats: ${total} total, ${used} used`;
      // The field can EXIST and be empty. On Lumen's tenant totalSlots is present but
      // holds nothing — which on a monthly MSP subscription is the expected shape: you
      // are billed on use, so there is no ceiling to report. That is good news (a rollout
      // cannot hit a seat wall) and worth saying plainly rather than printing "?".
      const raw = (r as any)?.totalSlots ?? atPath(r, findKeyPath(r, /^totalSlots$/i) || '');
      const present = raw !== undefined;
      return `licence seats: ${used} used` + (present
        ? ` — no total, which is normal on a monthly subscription: seats are billed on use, so a rollout cannot run out`
        : ` — no seat total in this payload at all`);
    });

  // ── Capability probes for what Terry asked for on 17 Aug ─────────────────────────
  // "we wll need to be able to add exaptions from portal", "we always want to be able to
  // restore files if needed", "we must be able to see events on the device level and
  // compnay level in portal".
  //
  // Whether each of those is buildable depends on what THIS tenant's API actually
  // exposes, and the documentation has already been wrong three times on this
  // integration (wrong service path, wrong parameter name, fields absent from the list
  // row). So we ask the tenant instead of trusting a page. Every probe below is
  // READ-ONLY — none of them changes a policy, releases a file or enables a push
  // subscription; they establish only whether the door opens.
  //
  // What the answers mean:
  //  * policies readable + a policy's exclusions visible → the Portal can at minimum
  //    VERIFY our agent exclusions are present in every policy (RULE ONE) and show
  //    exactly what is missing. Writing them needs a write method to exist; the public
  //    Policies API has historically been read-only, in which case exclusions stay a
  //    one-off human edit per policy and the Portal audits rather than authors them.
  //  * quarantine readable → "restore if needed" is buildable, because the restore
  //    counterpart is a task-creating method on the same service.
  //  * push settings readable → events can be PUSHED to the Portal in real time rather
  //    than polled, which is what makes device-level and company-level event history
  //    affordable.
  await add('policies', 'getPoliciesList', { page: 1, perPage: 5 },
    (r) => `${r?.total ?? (r?.items?.length || 0)} policies readable` +
           ` — needed to audit the agent exclusions in every policy`);
  try {
    const pl: any = await rpc('policies', 'getPoliciesList', { page: 1, perPage: 5 });
    const p0 = (Array.isArray(pl) ? pl : pl?.items || [])[0];
    if (p0?.id) {
      // Where exclusions live in the payload is not documented consistently, and on
      // Lumen's tenant neither guess matched — so hunt for the key anywhere in the tree
      // and SAY WHERE it was found. That path is what an exclusions audit has to read.
      await add('policies', 'getPolicyDetails', { policyId: p0.id },
        (r) => {
          const at = findKeyPath(r, /exclusion/i);
          if (!at) return `read policy "${r?.name || p0.name || p0.id}" — no exclusion field anywhere in the payload, so the API does not return them`;
          const val = atPath(r, at);
          // A boolean here is the "exclusions are on" switch, not the list of them. RULE
          // ONE needs the LIST — is our agent's folder actually excluded — so say which
          // one we found and what sits beside it.
          const isList = Array.isArray(val);
          return `read policy "${r?.name || p0.name || p0.id}" — ` +
            (isList
              ? `exclusion LIST at ${at} (${val.length} entr${val.length === 1 ? 'y' : 'ies'}) — the agent exclusions can be audited`
              : `${at} is ${val === null ? 'null' : typeof val}, which is the on/off switch rather than the list. Beside it: ${siblingsOf(r, at) || '(nothing)'}`);
        });
    }
  } catch { /* the list probe above already said why */ }

  // ── CAN we write a policy, or only read one? ─────────────────────────────────────
  // This decides whether "add the exclusion from the Portal" is buildable at all, and it
  // is the kind of question the documentation has already answered wrongly three times on
  // this integration. So ask the tenant.
  //
  // SAFELY. Every candidate below is called with NO parameters. A method that does not
  // exist answers -32601 "Method not found"; a method that DOES exist rejects the empty
  // call for missing required parameters. That difference tells us the door exists
  // without ever pushing it — nothing here can modify a policy, because none of these
  // calls names one.
  for (const method of ['createPolicy', 'updatePolicy', 'setPolicyDetails', 'editPolicy', 'assignPolicy']) {
    try {
      await rpc('policies', method, {});
      // It answered a bare call. Surprising, but it means the method is there.
      probes.push({ service: 'policies', method, ok: true,
        note: 'EXISTS and accepted an empty call — exclusions could be written from the Portal' });
    } catch (e: any) {
      const msg = String(e.message || '');
      const missing = /method not found|not supported|unknown method/i.test(msg);
      probes.push({
        service: 'policies', method,
        // Not-found is the EXPECTED answer, so it is not a failure of the connection —
        // it is the answer to the question. Marked ok so a red row never implies the key
        // is wrong when the truth is "this API is read-only".
        ok: !missing,
        note: missing
          ? 'not available — the Policies API is read-only here, so exclusions stay a human edit in the console and the Portal audits them'
          : `EXISTS (rejected the empty call: ${msg}) — writing exclusions from the Portal is worth building`,
      });
    }
  }

  // Quarantine is SPLIT BY TARGET, not one service: a bare /jsonrpc/quarantine returned
  // HTTP 404 with no JSON body on Lumen's tenant (17 Aug), which is the signature of a
  // wrong URL rather than a missing scope — the server never got as far as JSON-RPC. The
  // computers and Exchange quarantines are separate endpoints, so ask for the one we
  // want. Same lesson as getCompaniesList: question the PATH before the tenant.
  try {
    const got = await rpcAny<any>([
      ['quarantine/computers', 'getQuarantineItemsList'],
      ['quarantine', 'getQuarantineItemsList'],
    ], { page: 1, perPage: 5 });
    probes.push({
      service: got.service, method: got.method, ok: true,
      note: `${got.result?.total ?? (got.result?.items?.length || 0)} quarantined item(s) readable` +
            ` — so restoring a file is reachable`,
      sample: got.result?.items?.[0] ?? got.result,
    });
  } catch (e: any) {
    probes.push({ service: 'quarantine/computers', method: 'getQuarantineItemsList', ok: false, note: e.message });
  }

  // Event push. "Settings for event push service were not set" is NOT a failure — it is
  // the correct answer before anything is configured, and it proves the service path and
  // the key's scope are both fine. Reporting that as a red cross would send someone
  // hunting a problem that does not exist, so it is called out as ready-to-enable.
  try {
    const r: any = await rpc('push', 'getPushEventSettings', {});
    probes.push({
      service: 'push', method: 'getPushEventSettings', ok: true,
      note: `event push is ${r?.status ? 'ENABLED' : 'configured but off'}` +
            `${r?.serviceType ? ' (' + r.serviceType + ')' : ''}`,
      sample: r,
    });
  } catch (e: any) {
    const notSet = /were not set|not configured|no settings/i.test(e.message || '');
    probes.push({
      service: 'push', method: 'getPushEventSettings', ok: notSet,
      note: notSet
        ? 'available and the key can reach it — nothing subscribed yet, which is exactly what we expect'
          + ' before we point it at the Portal. This is how device and company events arrive live.'
        : e.message,
    });
  }
  await add('incidents', 'getBlocklistItems', { page: 1, perPage: 5 },
    (r) => `${r?.total ?? (r?.items?.length || 0)} blocklist item(s) readable`);

  return { ok: probes.some((p) => p.ok), probes };
}

// ── Sync ────────────────────────────────────────────────────────────────────────

const s = (v: any) => (v == null ? null : String(v));
const bool = (v: any) => v === true || v === 1 || v === '1';

/** Which module names GravityZone reports as on, folded to a short human string. */
function modulesOn(mods: any): string | null {
  if (!mods || typeof mods !== 'object') return null;
  const NICE: Record<string, string> = {
    antimalware: 'Antimalware', advancedThreatControl: 'ATC', firewall: 'Firewall',
    contentControl: 'Content', deviceControl: 'Device', encryption: 'Encryption',
    advancedAntiExploit: 'Anti-exploit', networkAttackDefense: 'Network defence',
    powerUser: 'Power user', edrSensor: 'EDR', hyperDetect: 'HyperDetect',
  };
  const on = Object.entries(mods).filter(([, v]) => bool(v)).map(([k]) => NICE[k] || k);
  return on.length ? on.join(', ') : null;
}

/** GravityZone's dates arrive as strings; anything unparseable becomes null. */
function when(v: any): Date | null {
  if (!v) return null;
  const t = Date.parse(String(v).replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t) : null;
}

async function pageThrough(service: string, method: string, params: any, cap = 60): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= cap; page++) {
    const r: any = await rpc(service, method, { ...params, page, perPage: 100 });
    const items = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
    out.push(...items);
    const pages = Number(r?.pagesCount ?? 1);
    if (!items.length || page >= pages) break;
  }
  return out;
}

export interface SyncResult {
  companies: number; mappedCompanies: number; endpoints: number; matchedDevices: number;
  detections: number; ticketsRaised: number; warnings: string[];
}

/**
 * Pull companies then endpoints, map them to Portal customers and devices, and raise
 * a case for anything infected. Safe to run repeatedly: everything upserts on the
 * GravityZone id.
 */
export async function syncGravityZone(userId: number | null = null): Promise<SyncResult> {
  const out: SyncResult = { companies: 0, mappedCompanies: 0, endpoints: 0, matchedDevices: 0, detections: 0, ticketsRaised: 0, warnings: [] };

  // ── Groupings: companies on a partner tenant, network FOLDERS on a direct one ──
  // Lumen's tenant is a single company (getCompaniesList is partner-only and returns
  // "Method not found" there even with every API enabled), so the thing that separates
  // one customer's machines from another's is the folder tree under Network. Both are
  // handled the same way from here on: a grouping has an id, a name, and a customer
  // mapping a human confirms.
  let companies: any[] = [];
  let partnerTenant = false;
  try {
    // getCompaniesList lives on the NETWORK service (see rpcAny's note) and returns a
    // bare array of { id, name } — the managed companies under Lumen.
    const got = await rpcAny<any>([['network', 'getCompaniesList'], ['companies', 'getCompaniesList']], {});
    const items = Array.isArray(got.result) ? got.result : (got.result?.items || []);
    companies = items.filter((c: any) => c?.id);
    partnerTenant = companies.length > 0;
    if (partnerTenant) out.warnings.push(`Partner tenant: ${companies.length} managed company/companies via ${got.service}/${got.method}.`);
  } catch {
    try {
      const own = await rpcAny<any>([['companies', 'getCompanyDetails'], ['network', 'getCompanyDetails']], {});
      if (own.result?.id) companies = [own.result];
    } catch { /* no companies service at all — folders below carry the boundary */ }
  }

  // ── Us ────────────────────────────────────────────────────────────────────────
  // getCompaniesList returns the companies we MANAGE. It does not return us. So Lumen
  // IT Solutions never appeared in the picker and our own estate had nowhere to be
  // mapped — Terry, 18 Aug: "why is LITS not available? Actually it's not in that list.
  // Well, do I have to add myself then?" No: getCompanyDetails with no companyId is the
  // caller's own company, and that is the partner root our own machines sit in.
  //
  // It is flagged, because the root is not a managed company: packages/getPackagesList
  // answers "Id of a managed company is expected" for it. The picker says so on the row
  // rather than letting that error be discovered after mapping.
  try {
    const own = await rpcAny<any>([['companies', 'getCompanyDetails'], ['network', 'getCompanyDetails']], {});
    const ownId = s(own.result?.id);
    if (ownId) {
      const at = companies.findIndex((c) => s(c.id) === ownId);
      if (at >= 0) companies[at] = { ...companies[at], ...own.result, __ownCompany: true };
      else companies.push({ ...own.result, __ownCompany: true });
    }
  } catch { /* not fatal — the managed list is still the useful part */ }

  // Groups. On a single-company tenant these ARE the per-customer boundary, so they
  // are synced as groupings too and can be mapped to customers exactly the same way.
  if (!partnerTenant) {
    try {
      const got = await rpcAny<any>([['network', 'getCustomGroupsList'], ['network', 'getContainers']], {});
      const items = Array.isArray(got.result) ? got.result : (got.result?.items || []);
      for (const c of items) if (c?.id) companies.push({ id: c.id, name: c.name || '(unnamed group)', __folder: true });
      if (items.length) out.warnings.push(`Single-company tenant: using the ${items.length} group(s) as the customer boundary.`);
    } catch (e: any) {
      out.warnings.push('No groups readable (' + e.message + ') — endpoints will be attributed by hostname only.');
    }
  }

  // Name-match to Portal customers, but only accept an EXACT case-insensitive match.
  // A fuzzy guess here could show one client another client's machines.
  // ...and only when the name is UNIQUE on our side. Two Portal customers with the same
  // name (a duplicate record, or a group and its trading entity) previously meant
  // whichever row the query returned last silently won the mapping — and a mapping is
  // what decides whose machines a customer sees. Same rule as the ambiguous hostname
  // below: an ambiguous name maps to NOBODY and is reported.
  const custRows = (await pool.query(`SELECT id, name FROM customers WHERE NOT is_placeholder`)).rows;
  const byName = new Map<string, number>();
  const ambiguousNames = new Set<string>();
  for (const c of custRows) {
    const key = String(c.name).trim().toLowerCase();
    if (byName.has(key)) { ambiguousNames.add(key); continue; }
    byName.set(key, Number(c.id));
  }
  for (const key of ambiguousNames) {
    byName.delete(key);
    out.warnings.push(`More than one Portal customer is called "${key}" — left unmapped rather than guessed.`);
  }

  for (const c of companies) {
    const gzId = s(c.id); if (!gzId) continue;
    const name = s(c.name) || '(unnamed)';
    const guess = byName.get(name.trim().toLowerCase()) ?? null;

    // getCompaniesList returns a BARE {id,name} — no licence at all. The licence facts
    // that decide what a customer costs (subscription type, protection model, reserved
    // seats) only come from getCompanyDetails, so fetch it per company and merge.
    //
    // This matters more than it looks. If a company is provisioned in Giacom Cloud
    // Market rather than by us, the product chosen THERE sets the protection model, and
    // nothing on our side gets a say — £0.99 or £5.07 is decided before we ever see it.
    // Reading it back is the only way to know which arrived. Cheap: one call per
    // customer, and there are tens of these, not thousands.
    let det: any = null;
    if (!c.__folder) {
      try { det = await rpc<any>('companies', 'getCompanyDetails', { companyId: gzId }); }
      catch (e: any) {
        if (out.warnings.length < 30) out.warnings.push(`Could not read licence detail for "${name}": ${e.message}`);
      }
    }
    const merged = det ? { ...c, ...det } : c;
    const lic = merged.licenseSubscription || merged.license || {};
    const r = await pool.query(
      `INSERT INTO security_companies (gz_id, name, customer_id, license_total, license_used, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (gz_id) DO UPDATE SET
         name=EXCLUDED.name, license_total=EXCLUDED.license_total, license_used=EXCLUDED.license_used,
         raw=EXCLUDED.raw, synced_at=NOW(),
         -- never overwrite a mapping a human has confirmed
         customer_id=COALESCE(security_companies.customer_id, EXCLUDED.customer_id)
       RETURNING customer_id`,
      // Seat counts are looked up through several paths on purpose. getCompanyDetails
      // may carry them at the top level or nested under licenseSubscription depending on
      // the call, and reading the wrong one gives null — which renders as "—" and looks
      // like a company with no seats rather than a lookup we got wrong.
      [gzId, name, guess, seatCount(merged, 'total'), seatCount(merged, 'used'), JSON.stringify(merged)]);
    out.companies++;
    if (r.rows[0]?.customer_id) out.mappedCompanies++;
  }

  // Shout about anything not on the standard tier, once per sync, while the numbers are
  // fresh. A company quietly sitting on a trial or on mspSecureExtra is a bill nobody
  // reads until the invoice, so it belongs in the sync result rather than a screen
  // somebody has to remember to open.
  for (const a of await licenceAudit()) {
    if (a.problems.length && out.warnings.length < 40) out.warnings.push(`${a.name}: ${a.problems.join('; ')}`);
  }

  // ── Endpoints ────────────────────────────────────────────────────────────────
  // A partner tenant needs one call per company. A single-company tenant gets the flat
  // list and each endpoint tells us its own folder via groupId.
  const companyIds = companies.filter((c) => !c.__folder).map((c) => s(c.id)).filter(Boolean) as string[];
  const batches: Array<{ gzCompanyId: string | null; items: any[] }> = [];
  if (partnerTenant) {
    // Lumen's own machines sit at the root, not under a managed company, so the flat
    // list is fetched too. Ordered FIRST so the per-company calls below win on any
    // endpoint that appears in both.
    try { batches.push({ gzCompanyId: null, items: await pageThrough('network', 'getEndpointsList', EP_QUERY) }); }
    catch { /* the per-company calls are the ones that matter */ }
    // parentId — NOT companyId. companyId is not a parameter of this method, so it was
    // silently ignored and every company came back empty.
    for (const cid of companyIds) {
      try { batches.push({ gzCompanyId: cid, items: await pageThrough('network', 'getEndpointsList', { parentId: cid, ...EP_QUERY }) }); }
      catch (e: any) { out.warnings.push(`Endpoints for company ${cid}: ${e.message}`); }
    }
  } else {
    try { batches.push({ gzCompanyId: companyIds[0] ?? null, items: await pageThrough('network', 'getEndpointsList', EP_QUERY) }); }
    catch (e: any) { out.warnings.push('Endpoints: ' + e.message); }
  }

  const compMap = new Map<string, number | null>(
    (await pool.query(`SELECT gz_id, customer_id FROM security_companies`)).rows
      .map((r: any) => [String(r.gz_id), r.customer_id ? Number(r.customer_id) : null]));

  // One detail call per managed endpoint, but bounded: a runaway sync must not hammer
  // the API and trip its rate limit for everything else Lumen does.
  const DETAIL_CAP = 750;
  let detailCalls = 0;
  let detailBadReported = 0;

  for (const batch of batches) {
    for (const e of batch.items) {
      const gzId = s(e.id); if (!gzId) continue;
      // The grouping is the company on a partner tenant, the network FOLDER otherwise.
      const gzCompanyId = s(e.companyId) || s(e.groupId) || batch.gzCompanyId;
      let customerId = gzCompanyId ? (compMap.get(gzCompanyId) ?? null) : null;
      const name = s(e.name) || s(e.label) || s(e.fqdn) || gzId;

      // getEndpointsList does NOT return agent version, modules, malware status or a
      // last-seen time — those live only on getManagedEndpointDetails. Reading them off
      // the list row (which is what this code did first) yields undefined everywhere,
      // i.e. "healthy, nothing to report", which is the worst possible wrong answer for
      // a security screen. So managed endpoints get one detail call each, capped, and a
      // failure degrades to list-only data rather than losing the endpoint.
      let d: any = {};
      if (bool(e.isManaged) && detailCalls < DETAIL_CAP) {
        detailCalls++;
        try { d = (await rpc<any>('network', 'getManagedEndpointDetails', { endpointId: gzId })) || {}; }
        catch (err: any) {
          if (detailBadReported < 3) { out.warnings.push(`Details unavailable for ${name}: ${err.message}`); detailBadReported++; }
        }
      }
      const agent = d.agent || {};
      const malware = d.malwareStatus || {};

      // Match to one of our devices by hostname — the one thing both sides agree on.
      //
      // On a single-company tenant this is the PRIMARY way a machine gets attributed to
      // a customer, which makes ambiguity dangerous: two customers can both own a
      // "SERVER01", and attaching to the wrong one would show one client another
      // client's machine. So an ambiguous hostname matches NOTHING and is reported.
      let assetId: number | null = null;
      try {
        const m = await pool.query(
          `SELECT id, customer_id FROM customer_assets
            WHERE merged_into_id IS NULL AND lower(hostname) = lower($1)
              AND ($2::int IS NULL OR customer_id = $2)
            ORDER BY (agent_device_id IS NOT NULL) DESC, id`,
          [String(name).split('.')[0], customerId]);
        if (m.rows.length === 1) {
          assetId = Number(m.rows[0].id);
          out.matchedDevices++;
          // No grouping mapping? Then the device we matched tells us the customer.
          if (customerId == null && m.rows[0].customer_id) customerId = Number(m.rows[0].customer_id);
        } else if (m.rows.length > 1) {
          out.warnings.push(`"${name}" exists at more than one customer — left unmatched rather than guessed.`);
        }
      } catch { /* matching is a convenience, never a reason to drop the row */ }

      await pool.query(
        `INSERT INTO security_endpoints
           (gz_id, gz_company_id, customer_id, asset_id, name, fqdn, ip, os_name, is_managed,
            policy_name, agent_version, outdated, infected, modules_on, last_seen_at, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (gz_id) DO UPDATE SET
           -- COALESCE, not plain assignment: the same endpoint can arrive twice in one
           -- run (root flat list, then its company's list). A later pass that does not
           -- know the company must not erase attribution a previous pass established.
           -- A genuine move to another company still updates, because that value is
           -- not null.
           gz_company_id=COALESCE(EXCLUDED.gz_company_id, security_endpoints.gz_company_id),
           customer_id=COALESCE(EXCLUDED.customer_id, security_endpoints.customer_id),
           asset_id=COALESCE(EXCLUDED.asset_id, security_endpoints.asset_id),
           name=EXCLUDED.name, fqdn=EXCLUDED.fqdn, ip=EXCLUDED.ip, os_name=EXCLUDED.os_name,
           is_managed=EXCLUDED.is_managed, policy_name=EXCLUDED.policy_name,
           agent_version=EXCLUDED.agent_version, outdated=EXCLUDED.outdated, infected=EXCLUDED.infected,
           modules_on=EXCLUDED.modules_on, last_seen_at=EXCLUDED.last_seen_at, raw=EXCLUDED.raw, synced_at=NOW()`,
        [gzId, gzCompanyId, customerId, assetId, name, s(e.fqdn) || s(d.fqdn), s(e.ip) || s(d.ip),
         s(e.operatingSystemVersion) || s(d.operatingSystemVersion),
         // "Managed" for our purposes means the security agent is actually on it, which
         // is managedWithBest — isManaged alone can be true for an unprotected machine
         // that GravityZone merely knows about.
         bool(e.managedWithBest) || bool(d.managedWithBest),
         s(e.policy?.name) || s(d.policy?.name),
         s(agent.engineVersion) || s(agent.version),
         // productOutdated is TOP-LEVEL on the list row (and only present because
         // EP_QUERY asks for it), not under agent.
         bool(e.productOutdated) || bool(d.productOutdated) || bool(agent.productOutdated) || bool(agent.productUpdateAvailable),
         bool(malware.infected) || bool(malware.detection),
         modulesOn(d.modules),
         // There is no lastSeen on the list row; the details call has one, and the last
         // successful scan is the honest fallback.
         when(d.lastSeen) || when(e.lastSuccessfulScan?.date) || when(d.lastSuccessfulScan?.date),
         JSON.stringify(Object.keys(d).length ? { ...e, __details: d } : e)]);
      out.endpoints++;

      // Infected? That is a case, not a dashboard number somebody might notice.
      if (bool(malware.infected) || bool(malware.detection)) {
        const threat = s(malware.detection) || s(malware.threatName) || 'Malware detected';
        const key = `gz:${gzId}:${threat}`.slice(0, 200);
        const existing = await pool.query(`SELECT id FROM security_detections WHERE dedupe_key=$1`, [key]);
        if (!existing.rows.length) {
          out.detections++;
          let ticketId: number | null = null;
          // Our own tools are not an incident. Bitdefender's Hyper Detect files our
          // remote control as Gen:Illusion.PUP.MeshCentral, which is a fair heuristic
          // and the wrong answer: it is ours. Raising a support case for it every sync
          // would train everyone to close Bitdefender cases unread, and the one that
          // mattered would go with them. Recorded, shown, and given the fix — but no
          // case, because there is nothing for support to do that a policy exclusion
          // does not do better.
          const ownTool = isOwnToolDetection(threat, s(malware.detectionPath), s(e.policy?.name));
          if (ownTool) {
            out.warnings.push(`${name}: "${threat}" is one of our own tools — add the exclusion to policy "${s(e.policy?.name) || 'unknown'}" rather than treating it as an infection.`);
          }
          if (!ownTool) try {
            const tn = await nextTicketNumber();
            const subject = `[Bitdefender] ${threat} on ${name}`.slice(0, 160);
            const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]);
            const desc = '<div style="white-space:pre-wrap;">'
              + esc(`Bitdefender reported a detection on ${name}.\n\nThreat: ${threat}\nPolicy: ${s(e.policy?.name) || 'unknown'}\nLast seen by GravityZone: ${s(e.lastSeen) || 'unknown'}\n\nRaised automatically by the Portal from the GravityZone sync.`)
              + '</div>';
            const t = await pool.query(
              `INSERT INTO inbox_tickets (ticket_number, source, customer_id, status, department, category,
                                          subject, description, activity_status, stage, updated_at)
               VALUES ($1,'alert',$2,'new','support','incident',$3,$4,'unread','awaiting_triage',NOW()) RETURNING id`,
              [tn, customerId, subject, desc]);
            ticketId = Number(t.rows[0].id);
            out.ticketsRaised++;
          } catch (err: any) {
            out.warnings.push(`Could not raise a case for ${name}: ${err.message}`);
          }
          await pool.query(
            `INSERT INTO security_detections (dedupe_key, customer_id, endpoint_gz_id, hostname, threat_name, detail, ticket_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
            [key, customerId, gzId, name, threat, s(e.policy?.name), ticketId]);
        }
      }
    }
  }

  await setSetting('gravityzone', 'last_sync', new Date().toISOString());
  // Keep the warnings. They used to travel back only in a query string, truncated to
  // three — and the licence audit's findings (a company on a trial, a company on a tier
  // costing four times the standard) are exactly the ones that would fall off the end.
  // A warning nobody can read is not a warning.
  await setSetting('gravityzone', 'last_sync_warnings', JSON.stringify(out.warnings.slice(0, 60)));
  await logActivity(userId, 'gz_sync', 'security_endpoints', null,
    `GravityZone sync: ${out.endpoints} endpoints, ${out.companies} companies, ${out.matchedDevices} matched to our devices` +
    (out.ticketsRaised ? `, ${out.ticketsRaised} detection case(s) raised` : ''));
  return out;
}

// ── Licence audit ───────────────────────────────────────────────────────────────
// What each company is ACTUALLY licensed as, read back from GravityZone rather than
// assumed from what we asked for. Two reasons this exists:
//
//  1. A company provisioned in Giacom Cloud Market gets its protection model from the
//     product chosen there. Nothing on our side influences it, so reading it back is
//     the only way to know whether a customer landed on £0.99 or £5.07.
//  2. Bitdefender's createCompany silently makes a TRIAL if licenseSubscription is
//     omitted. A trial expires, and the whole point of AV is that it does not stop.
//
// Every field is looked up through several candidate paths. This tenant has already
// contradicted the documentation three times, and an audit that reads `undefined` and
// says "fine" is worse than no audit at all — so an unreadable value is reported as
// unknown, never as healthy.

/** Cost per endpoint per month, from Terry's Giacom reseller list (17 Aug 2026). */
export const MODEL_COST: Record<string, number> = {
  aLaCarte: 0.99, mspSecure: 1.93, mspSecurePlus: 4.00, mspSecureExtra: 5.07,
};
/** What Lumen charges the public per endpoint per month. */
export const AV_SELL_PRICE = 3.00;
/** The tier Lumen standardises on — anything else is worth a second look. */
export const STANDARD_MODEL = 'aLaCarte';

const SUBSCRIPTION_LABEL: Record<number, string> = {
  1: 'trial', 2: 'licence key', 3: 'monthly subscription',
  4: 'monthly licence TRIAL', 5: 'monthly subscription TRIAL', 6: 'FRAT subscription',
};

export interface LicenceAudit {
  gzId: string; name: string; customerId: number | null; customerName: string | null;
  subscriptionType: number | null; subscriptionLabel: string;
  protectionModel: string | null; productType: number | null;
  reservedSlots: number | null; totalSlots: number | null; usedSlots: number | null;
  costPerEndpoint: number | null; monthlyCost: number | null;
  problems: string[];
}

function pick(o: any, paths: string[][]): any {
  for (const p of paths) {
    let v = o;
    for (const k of p) { if (v == null) break; v = v[k]; }
    if (v != null && v !== '') return v;
  }
  return null;
}

/**
 * Total or used licence seats, wherever this tenant happens to put them.
 * Used seats is the number that matters twice over: it is what Giacom bills on, and it
 * is the quantity for the £3.00 AV line on customers who pay for it.
 */
export function seatCount(o: any, which: 'total' | 'used'): number | null {
  const keys = which === 'total'
    ? [['licenseSubscription', 'totalSlots'], ['licenseSubscription', 'total'], ['totalSlots'], ['total'],
       ['license', 'totalSlots'], ['license', 'total']]
    : [['licenseSubscription', 'usedSlots'], ['licenseSubscription', 'used'], ['usedSlots'], ['used'],
       ['license', 'usedSlots'], ['license', 'used']];
  const v = pick(o, keys);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function licenceAudit(): Promise<LicenceAudit[]> {
  const rows = (await pool.query(
    `SELECT sc.gz_id, sc.name, sc.customer_id, sc.license_total, sc.license_used, sc.raw,
            c.name AS customer_name
       FROM security_companies sc
       LEFT JOIN customers c ON c.id = sc.customer_id
      ORDER BY sc.name`)).rows;

  return rows.map((r: any) => {
    const raw = r.raw || {};
    const lic = raw.licenseSubscription || raw.license || {};
    const typeRaw = pick(raw, [['licenseSubscription', 'type'], ['license', 'type'], ['licenseType'], ['type']]);
    const subscriptionType = typeRaw == null || typeRaw === '' ? null : Number(typeRaw);
    const protectionModel = pick(raw, [
      ['licenseSubscription', 'assignedProtectionModel'], ['license', 'assignedProtectionModel'],
      ['assignedProtectionModel'], ['protectionModel'],
    ]);
    const productType = (() => {
      const v = pick(raw, [['licenseSubscription', 'assignedProductType'], ['assignedProductType'], ['productType']]);
      return v == null ? null : Number(v);
    })();
    const reservedSlots = (() => {
      const v = pick(raw, [['licenseSubscription', 'reservedSlots'], ['reservedSlots']]);
      return v == null ? null : Number(v);
    })();
    // Prefer the stored columns, but fall back to the raw record — so an audit run
    // against data synced before this lookup existed still reads correctly.
    const totalSlots = r.license_total == null ? seatCount(raw, 'total') : Number(r.license_total);
    const usedSlots = r.license_used == null ? seatCount(raw, 'used') : Number(r.license_used);
    const model = protectionModel ? String(protectionModel) : null;
    const costPerEndpoint = model && MODEL_COST[model] != null ? MODEL_COST[model] : null;

    const problems: string[] = [];
    // A trial is the loud one: protection that stops on a date nobody has in a diary.
    if (subscriptionType != null && [1, 4, 5].includes(subscriptionType)) {
      problems.push(`on a ${SUBSCRIPTION_LABEL[subscriptionType]} — this expires, and then the AV stops`);
    }
    if (model && model !== STANDARD_MODEL) {
      const extra = costPerEndpoint != null && MODEL_COST[STANDARD_MODEL] != null
        ? ` (£${(costPerEndpoint - MODEL_COST[STANDARD_MODEL]).toFixed(2)}/endpoint/month more than standard)` : '';
      problems.push(`on ${model}, not ${STANDARD_MODEL}${extra}`);
    }
    if (reservedSlots != null && reservedSlots > 0) {
      problems.push(`${reservedSlots} seat(s) RESERVED — a rollout stops dead at that number even with the pool free`);
    }
    if (!r.customer_id) problems.push('not mapped to a Portal customer');
    // Say nothing rather than something wrong: an unreadable licence is reported as
    // unknown so it shows as a gap to chase, not as a pass.
    if (subscriptionType == null && !model) problems.push('licence detail unreadable — treat as unverified');

    return {
      gzId: String(r.gz_id), name: String(r.name || ''),
      customerId: r.customer_id ? Number(r.customer_id) : null,
      customerName: r.customer_name || null,
      subscriptionType,
      subscriptionLabel: subscriptionType == null ? 'unknown' : (SUBSCRIPTION_LABEL[subscriptionType] || `type ${subscriptionType}`),
      protectionModel: model, productType, reservedSlots, totalSlots, usedSlots,
      costPerEndpoint,
      monthlyCost: costPerEndpoint != null && usedSlots != null ? Number((costPerEndpoint * usedSlots).toFixed(2)) : null,
      problems,
    };
  });
}

/** Confirm (or clear) which Portal customer a GravityZone company is. */
export async function mapCompany(gzId: string, customerId: number | null): Promise<void> {
  await pool.query(`UPDATE security_companies SET customer_id=$1 WHERE gz_id=$2`, [customerId, gzId]);
  await pool.query(`UPDATE security_endpoints SET customer_id=$1 WHERE gz_company_id=$2`, [customerId, gzId]);
}

// ── The assessment ──────────────────────────────────────────────────────────────
// Computed from data we ALREADY hold: the agent's security collector reports every
// registered AV product per machine. No site visits, no questionnaires.

/** Third-party AV that Bitdefender's own competitive removal deals with. */
const AUTO_REMOVE = [
  'avast', 'avg', 'avira', 'bullguard', 'comodo', 'eset', 'nod32', 'f-secure', 'g data',
  'kaspersky', 'mcafee', 'malwarebytes', 'norton', 'symantec', 'panda', 'sophos',
  'trend micro', 'webroot', 'vipre', 'total defense', 'zonealarm', 'k7', 'quick heal',
  // Webroot was bought by OpenText and REBRANDED. CUK-B003 reports itself as
  // "OpenTextT Core Endpoint Protection" (their spelling, with the stray T) while still
  // running the WRSVC service underneath. Matching only on "webroot" would have filed
  // every Chropynska machine as an unknown product needing a manual visit - on the one
  // customer whose whole rollout hinges on Webroot being removed automatically.
  'opentext', 'carbonite',
];
/** Products that want taking off by hand — EDR/managed stacks with tamper protection. */
const MANUAL = ['crowdstrike', 'sentinelone', 'carbon black', 'cylance', 'cortex', 'huntress', 'trellix', 'elastic', 'defender for endpoint'];

/**
 * The agent version the security collector first shipped in. Below this, a machine can be
 * online, enrolled and perfectly healthy and still know nothing about its own AV — which
 * is not "no agent", and is not something a refresh can fix.
 */
export const SECURITY_COLLECTOR_MIN = '1.0.24';

/** Compare dotted versions numerically: '1.0.9' is older than '1.0.24', not newer. */
export function versionLt(a: string | null | undefined, b: string): boolean {
  if (!a) return false;                       // unknown version is not evidence of old
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

export const agentTooOld = (v: string | null | undefined) => versionLt(v, SECURITY_COLLECTOR_MIN);

export interface AssessRow {
  assetId: number | null; hostname: string; currentAv: string | null;
  category: 'clean' | 'auto_remove' | 'manual' | 'unknown'; plan: string;
}

export function categoriseAv(products: string[]): { category: AssessRow['category']; plan: string } {
  const names = products.map((p) => p.toLowerCase());
  const thirdParty = names.filter((n) => n && !/defender|windows security|security center/.test(n));
  if (!thirdParty.length) {
    return { category: 'clean', plan: 'Microsoft Defender only — Bitdefender installs straight over it and Defender steps aside on its own.' };
  }
  const manual = thirdParty.find((n) => MANUAL.some((m) => n.includes(m)));
  if (manual) {
    return { category: 'manual', plan: `${manual} has tamper protection — it must be removed from its own console first, then Bitdefender goes on.` };
  }
  const auto = thirdParty.find((n) => AUTO_REMOVE.some((m) => n.includes(m)));
  if (auto) {
    return { category: 'auto_remove', plan: `Bitdefender's competitive removal uninstalls ${auto} during install. No separate visit needed.` };
  }
  return { category: 'manual', plan: `${thirdParty[0]} is not on the known-removable list — check it by hand before deploying.` };
}

/** Build (and store) a customer's migration plan from the agent's security data. */
export async function buildAssessment(customerId: number, userId: number | null): Promise<number> {
  // "No agent data" used to cover FOUR different situations behind one sentence, and the
  // sentence it printed — "the LumenMSP agent goes on first" — is flatly wrong for three
  // of them. Terry ran this against Lumen's own estate and got 24 of 24 "no agent yet" on
  // machines that demonstrably have the agent. An instruction that confident and that
  // wrong sends someone off installing software that is already there.
  //
  // So the four are told apart:
  //   * no agent linked to the asset at all          → install the agent
  //   * an agent EXISTS at this hostname, unlinked    → link it; installing again is wrong
  //   * the linked agent is revoked                   → re-enrol
  //   * agent live but no security report yet         → wait for the pass, or pull it now
  const rows = (await pool.query(
    `SELECT a.id AS asset_id, a.hostname, a.agent_device_id,
            d.id AS device_id, COALESCE(d.revoked, false) AS revoked, d.security_json, d.agent_version,
            (SELECT gz_id FROM security_endpoints se WHERE se.asset_id = a.id LIMIT 1) AS gz_id,
            (SELECT ad.id FROM agent_devices ad
              WHERE ad.customer_id = a.customer_id
                AND lower(ad.hostname) = lower(a.hostname)
                AND NOT COALESCE(ad.revoked, false)
              LIMIT 1) AS same_name_device_id
       FROM customer_assets a
       LEFT JOIN agent_devices d ON d.id = a.agent_device_id
      WHERE a.customer_id = $1 AND a.merged_into_id IS NULL
      ORDER BY a.hostname`,
    [customerId])).rows;

  const items: AssessRow[] = rows.map((r: any) => {
    const base = { assetId: Number(r.asset_id), hostname: String(r.hostname || '?') };
    // Already on Bitdefender? Then there is nothing to plan for this machine.
    if (r.gz_id) {
      return { ...base, currentAv: 'Bitdefender', category: 'clean' as const, plan: 'Already protected by Bitdefender — nothing to do.' };
    }
    let j: any = null;
    try { j = r.security_json ? JSON.parse(r.security_json) : null; } catch { j = null; }
    if (!j) {
      let plan: string;
      if (r.device_id && r.revoked) {
        plan = 'The agent on this machine has been revoked — re-enrol it, then this can be assessed.';
      } else if (r.device_id && agentTooOld(r.agent_version)) {
        // The case that actually bit. LITS-010 is online and checking in, but on v1.0.23
        // — and the security collector only arrived in v1.0.24. Telling someone to press
        // "Refresh from device" here would be a second wrong instruction: the agent has
        // nothing to refresh WITH. The fix is the agent update, not the machine.
        plan = `The agent here is ${r.agent_version} — the security collector arrived in `
             + `v${SECURITY_COLLECTOR_MIN}. This machine reports nothing about AV until it updates, `
             + 'so the agent rollout has to land before the assessment means anything.';
      } else if (r.device_id) {
        plan = 'Agent is on and enrolled, but it has not sent a security report yet. That arrives on the '
             + 'daily pass; "Refresh from device" on the machine\'s Security tab pulls it now.';
      } else if (r.same_name_device_id) {
        plan = `An agent IS reporting from a machine of this name (device ${r.same_name_device_id}), it is just `
             + 'not linked to this asset record. Link them rather than installing again.';
      } else {
        plan = 'No LumenMSP agent on this machine — that goes on first, then it can be assessed properly.';
      }
      return { ...base, currentAv: null, category: 'unknown' as const, plan };
    }
    const list = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);
    const products = [...list(j.av), ...list(j.antispyware)]
      .map((p: any) => String(p?.name || '').trim()).filter(Boolean);
    const uniq = Array.from(new Set(products));
    const { category, plan } = categoriseAv(uniq);
    return { assetId: Number(r.asset_id), hostname: String(r.hostname || '?'), currentAv: uniq.join(', ') || null, category, plan };
  });

  // A new assessment supersedes the last one rather than editing it — an approval is
  // a record of what was true when it was given.
  await pool.query(`UPDATE security_assessments SET status='superseded' WHERE customer_id=$1 AND status <> 'superseded'`, [customerId]);
  const a = await pool.query(
    `INSERT INTO security_assessments (customer_id, status, created_by) VALUES ($1,'draft',$2) RETURNING id`,
    [customerId, userId]);
  const id = Number(a.rows[0].id);
  for (const it of items) {
    await pool.query(
      `INSERT INTO security_assessment_items (assessment_id, asset_id, hostname, current_av, category, plan, included)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [id, it.assetId, it.hostname, it.currentAv, it.category, it.plan]);
  }
  await logActivity(userId, 'security_assessment', 'security_assessments', id,
    `Endpoint Security assessment built for customer ${customerId}: ${items.length} machine(s)`);
  return id;
}

/**
 * Which customers are in scope. AV ships free with Managed IT, so ITSM customers are
 * in by default; the override list handles the exceptions in both directions.
 */
export async function inScopeCustomers(): Promise<Array<{ id: number; name: string; inScope: boolean; reason: string }>> {
  const off = new Set(String((await getSetting('gravityzone', 'excluded_customers')) || '').split(',').map((x) => x.trim()).filter(Boolean));
  const on = new Set(String((await getSetting('gravityzone', 'included_customers')) || '').split(',').map((x) => x.trim()).filter(Boolean));
  const rows = (await pool.query(
    `SELECT id, name, is_itsm FROM customers WHERE status <> 'inactive' AND NOT is_placeholder ORDER BY name`)).rows;
  return rows.map((c: any) => {
    const id = Number(c.id);
    if (off.has(String(id))) return { id, name: c.name, inScope: false, reason: 'excluded by hand' };
    if (on.has(String(id))) return { id, name: c.name, inScope: true, reason: 'included by hand' };
    return { id, name: c.name, inScope: !!c.is_itsm, reason: c.is_itsm ? 'Managed IT customer' : 'not a Managed IT customer' };
  });
}

// ── Our own tools are not malware ───────────────────────────────────────────────
// Bitdefender's Hyper Detect files MeshCentral as Gen:Illusion.PUP.MeshCentral. It is
// not a bad heuristic — MeshCentral IS a remote-access tool, and PUP detection exists to
// find remote-access tools nobody authorised. It is OURS, which is the whole of the
// difference, and a policy exclusion is the only place that difference can be recorded.
//
// Terry, 18 Aug, on his own machine: "not good if our chosen remote control is showing
// up as threat."
//
// So these detections are recorded and shown, but they do not raise a support case. A
// case raised every sync for a tool we chose teaches everyone to close Bitdefender cases
// unread — and the real one would go out with them. Deliberately matched BY NAME rather
// than by the PUP category, so an unauthorised remote-access tool on a customer's machine
// still raises a case exactly as it does today.
const OWN_TOOL_PATTERNS = [/meshcentral/i, /mesh\s*agent/i, /lumenmsp/i, /lumenagentservice/i];

export function isOwnToolDetection(...parts: Array<string | null | undefined>): boolean {
  const hay = parts.filter(Boolean).join(' ');
  return OWN_TOOL_PATTERNS.some((re) => re.test(hay));
}

/**
 * Is THIS customer enabled for Endpoint Security?
 *
 * THE MAPPING IS THE ENABLEMENT. Terry, 18 Aug: "as long as we map every time then we're
 * golden — this way you don't need a magic button to enable a customer."
 *
 * He is right, and it is the better design. A customer cannot be deployed to without a
 * GravityZone company and an installation package; mapping both is already two deliberate
 * choices a human makes, naming exactly which company and which installer. A separate
 * enable switch adds nothing except a third thing to forget, and a state where a customer
 * looks enabled but cannot actually deploy.
 *
 * The safety property the old switch provided is preserved, on one condition: the package
 * mapping must never happen automatically. That is why resolvePackage() no longer adopts
 * a company's only package on its own — if it did, a sync could quietly enable a customer
 * nobody had chosen, which is the exact thing the gate exists to prevent.
 */
export async function customerEnabled(customerId: number): Promise<{ ok: boolean; reason: string }> {
  const r = (await pool.query(
    `SELECT c.name,
            (SELECT gz_id FROM security_companies WHERE customer_id=c.id ORDER BY gz_id LIMIT 1) AS gz_id,
            (SELECT package_name FROM security_packages WHERE customer_id=c.id) AS package_name
       FROM customers c WHERE c.id=$1 AND NOT c.is_placeholder AND c.status <> 'inactive'`,
    [customerId])).rows[0];

  if (!r) return { ok: false, reason: 'that customer is inactive or does not exist' };
  if (!r.gz_id) return { ok: false, reason: 'not mapped to a GravityZone company' };
  if (!r.package_name) return { ok: false, reason: 'no installation package mapped' };
  return { ok: true, reason: `mapped to a company and the "${r.package_name}" package` };
}

export async function setCustomerScope(customerId: number, inScope: boolean | null): Promise<void> {
  const read = async (k: string) => new Set(String((await getSetting('gravityzone', k)) || '').split(',').map((x) => x.trim()).filter(Boolean));
  const inc = await read('included_customers');
  const exc = await read('excluded_customers');
  inc.delete(String(customerId)); exc.delete(String(customerId));
  if (inScope === true) inc.add(String(customerId));
  if (inScope === false) exc.add(String(customerId));
  await setSetting('gravityzone', 'included_customers', Array.from(inc).join(','));
  await setSetting('gravityzone', 'excluded_customers', Array.from(exc).join(','));
}
