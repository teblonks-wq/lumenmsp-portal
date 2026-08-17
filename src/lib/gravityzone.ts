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
export const GZ_SERVICES = ['companies', 'network', 'packages', 'licensing', 'incidents', 'accounts'] as const;
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

export interface ProbeResult { service: string; method: string; ok: boolean; note: string; sample?: any }

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

  // Companies: present on partner/MSP accounts. A direct tenant has getCompanyDetails
  // instead — either answer is fine, we just need to know which.
  await add('companies', 'getCompaniesList', { page: 1, perPage: 5 },
    (r) => `${r?.total ?? (r?.items?.length || 0)} companies visible`);
  await add('companies', 'getCompanyDetails', {},
    (r) => `own company: ${r?.name || '(unnamed)'}`);
  await add('network', 'getEndpointsList', { page: 1, perPage: 5 },
    (r) => `${r?.total ?? (r?.items?.length || 0)} endpoints on the first page`);
  await add('packages', 'getPackagesList', { page: 1, perPage: 5 },
    (r) => `${r?.total ?? (r?.items?.length || 0)} installation packages`);
  await add('licensing', 'getLicenseInfo', {},
    (r) => `licence seats: ${r?.totalSlots ?? '?'} total, ${r?.usedSlots ?? '?'} used`);

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

  // ── Companies ────────────────────────────────────────────────────────────────
  let companies: any[] = [];
  try {
    companies = await pageThrough('companies', 'getCompaniesList', {});
  } catch (e: any) {
    // A direct (non-partner) tenant has no company list — it IS one company.
    try {
      const own: any = await rpc('companies', 'getCompanyDetails', {});
      if (own?.id) companies = [own];
      else out.warnings.push('No companies returned: ' + e.message);
    } catch (e2: any) {
      out.warnings.push('Companies unavailable (' + e.message + ')');
    }
  }

  // Name-match to Portal customers, but only accept an EXACT case-insensitive match.
  // A fuzzy guess here could show one client another client's machines.
  const custRows = (await pool.query(`SELECT id, name FROM customers WHERE NOT is_placeholder`)).rows;
  const byName = new Map<string, number>();
  for (const c of custRows) byName.set(String(c.name).trim().toLowerCase(), Number(c.id));

  for (const c of companies) {
    const gzId = s(c.id); if (!gzId) continue;
    const name = s(c.name) || '(unnamed)';
    const guess = byName.get(name.trim().toLowerCase()) ?? null;
    const lic = c.licenseSubscription || c.license || {};
    const r = await pool.query(
      `INSERT INTO security_companies (gz_id, name, customer_id, license_total, license_used, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (gz_id) DO UPDATE SET
         name=EXCLUDED.name, license_total=EXCLUDED.license_total, license_used=EXCLUDED.license_used,
         raw=EXCLUDED.raw, synced_at=NOW(),
         -- never overwrite a mapping a human has confirmed
         customer_id=COALESCE(security_companies.customer_id, EXCLUDED.customer_id)
       RETURNING customer_id`,
      [gzId, name, guess, lic.total ?? lic.totalSlots ?? null, lic.used ?? lic.usedSlots ?? null, JSON.stringify(c)]);
    out.companies++;
    if (r.rows[0]?.customer_id) out.mappedCompanies++;
  }

  // ── Endpoints ────────────────────────────────────────────────────────────────
  // Per company where we can (a partner tenant needs it), otherwise the flat list.
  const companyIds = companies.map((c) => s(c.id)).filter(Boolean) as string[];
  const batches: Array<{ gzCompanyId: string | null; items: any[] }> = [];
  if (companyIds.length > 1) {
    for (const cid of companyIds) {
      try { batches.push({ gzCompanyId: cid, items: await pageThrough('network', 'getEndpointsList', { companyId: cid }) }); }
      catch (e: any) { out.warnings.push(`Endpoints for company ${cid}: ${e.message}`); }
    }
  } else {
    try { batches.push({ gzCompanyId: companyIds[0] ?? null, items: await pageThrough('network', 'getEndpointsList', {}) }); }
    catch (e: any) { out.warnings.push('Endpoints: ' + e.message); }
  }

  const compMap = new Map<string, number | null>(
    (await pool.query(`SELECT gz_id, customer_id FROM security_companies`)).rows
      .map((r: any) => [String(r.gz_id), r.customer_id ? Number(r.customer_id) : null]));

  for (const batch of batches) {
    for (const e of batch.items) {
      const gzId = s(e.id); if (!gzId) continue;
      const gzCompanyId = s(e.companyId) || batch.gzCompanyId;
      const customerId = gzCompanyId ? (compMap.get(gzCompanyId) ?? null) : null;
      const name = s(e.name) || s(e.label) || s(e.fqdn) || gzId;
      const agent = e.agent || {};
      const malware = e.malwareStatus || {};

      // Match to one of our devices: hostname first (that is what both sides agree
      // on), narrowed to the customer when we know it.
      let assetId: number | null = null;
      try {
        const m = await pool.query(
          `SELECT id FROM customer_assets
            WHERE merged_into_id IS NULL AND lower(hostname) = lower($1)
              AND ($2::int IS NULL OR customer_id = $2)
            ORDER BY (agent_device_id IS NOT NULL) DESC, id LIMIT 1`,
          [String(name).split('.')[0], customerId]);
        if (m.rows[0]) { assetId = Number(m.rows[0].id); out.matchedDevices++; }
      } catch { /* matching is a convenience, never a reason to drop the row */ }

      await pool.query(
        `INSERT INTO security_endpoints
           (gz_id, gz_company_id, customer_id, asset_id, name, fqdn, ip, os_name, is_managed,
            policy_name, agent_version, outdated, infected, modules_on, last_seen_at, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (gz_id) DO UPDATE SET
           gz_company_id=EXCLUDED.gz_company_id, customer_id=EXCLUDED.customer_id,
           asset_id=COALESCE(EXCLUDED.asset_id, security_endpoints.asset_id),
           name=EXCLUDED.name, fqdn=EXCLUDED.fqdn, ip=EXCLUDED.ip, os_name=EXCLUDED.os_name,
           is_managed=EXCLUDED.is_managed, policy_name=EXCLUDED.policy_name,
           agent_version=EXCLUDED.agent_version, outdated=EXCLUDED.outdated, infected=EXCLUDED.infected,
           modules_on=EXCLUDED.modules_on, last_seen_at=EXCLUDED.last_seen_at, raw=EXCLUDED.raw, synced_at=NOW()`,
        [gzId, gzCompanyId, customerId, assetId, name, s(e.fqdn), s(e.ip),
         s(e.operatingSystemVersion) || s(e.operatingSystem), bool(e.isManaged),
         s(e.policy?.name), s(agent.engineVersion) || s(agent.version),
         bool(agent.productOutdated) || bool(agent.productUpdateAvailable),
         bool(malware.infected) || bool(malware.detection),
         modulesOn(e.modules), when(e.lastSeen) || when(e.lastSuccessfulScan),
         JSON.stringify(e)]);
      out.endpoints++;

      // Infected? That is a case, not a dashboard number somebody might notice.
      if (bool(malware.infected) || bool(malware.detection)) {
        const threat = s(malware.detection) || s(malware.threatName) || 'Malware detected';
        const key = `gz:${gzId}:${threat}`.slice(0, 200);
        const existing = await pool.query(`SELECT id FROM security_detections WHERE dedupe_key=$1`, [key]);
        if (!existing.rows.length) {
          out.detections++;
          let ticketId: number | null = null;
          try {
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
  await logActivity(userId, 'gz_sync', 'security_endpoints', null,
    `GravityZone sync: ${out.endpoints} endpoints, ${out.companies} companies, ${out.matchedDevices} matched to our devices` +
    (out.ticketsRaised ? `, ${out.ticketsRaised} detection case(s) raised` : ''));
  return out;
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
];
/** Products that want taking off by hand — EDR/managed stacks with tamper protection. */
const MANUAL = ['crowdstrike', 'sentinelone', 'carbon black', 'cylance', 'cortex', 'huntress', 'trellix', 'elastic', 'defender for endpoint'];

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
  const rows = (await pool.query(
    `SELECT a.id AS asset_id, a.hostname, d.security_json,
            (SELECT gz_id FROM security_endpoints se WHERE se.asset_id = a.id LIMIT 1) AS gz_id
       FROM customer_assets a
       LEFT JOIN agent_devices d ON d.id = a.agent_device_id AND NOT COALESCE(d.revoked, false)
      WHERE a.customer_id = $1 AND a.merged_into_id IS NULL
      ORDER BY a.hostname`,
    [customerId])).rows;

  const items: AssessRow[] = rows.map((r: any) => {
    // Already on Bitdefender? Then there is nothing to plan for this machine.
    if (r.gz_id) {
      return { assetId: Number(r.asset_id), hostname: String(r.hostname || '?'), currentAv: 'Bitdefender', category: 'clean' as const, plan: 'Already protected by Bitdefender — nothing to do.' };
    }
    let j: any = null;
    try { j = r.security_json ? JSON.parse(r.security_json) : null; } catch { j = null; }
    if (!j) {
      return {
        assetId: Number(r.asset_id), hostname: String(r.hostname || '?'), currentAv: null,
        category: 'unknown' as const,
        plan: 'No agent data — the LumenMSP agent goes on first, then this machine can be assessed properly.',
      };
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
