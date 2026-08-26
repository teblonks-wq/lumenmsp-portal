import cron from 'node-cron';
import { pool } from '../db/pool';
import { getGroup, setSetting } from './settings';

/**
 * Warranty — connectivity to the manufacturers' warranty services.
 *
 * ── The shape of this, and why ──────────────────────────────────────────────────
 *
 * A warranty is one FACT about a machine ("cover runs out on 14 March 2027") that we can
 * learn from four different places, and the point of this module is that the rest of the
 * Portal never has to care which:
 *
 *   • the manufacturer, by serial number — Dell, HP, Lenovo
 *   • an aggregator that covers all of them under one key
 *   • a human, off the paperwork, when there is no API and no key
 *
 * Every one of them writes the SAME columns on customer_assets, so the Hardware tab, the
 * asset list filters and any future report read one field and get an answer regardless of
 * where it came from. `warranty_source` records which, so nobody has to guess whether a
 * date was checked this morning or typed in 2024.
 *
 * ── The one rule that matters ───────────────────────────────────────────────────
 *
 * **A human beats the API, always.** Saving a warranty by hand sets `warranty_locked`, and
 * no lookup here will ever overwrite a locked row. The reason is not politeness: vendor
 * warranty APIs are wrong about second-hand kit, about machines re-sold between resellers,
 * and about anything covered by a third-party contract we hold rather than the maker. When
 * somebody has gone and read the actual contract, that is better data than Dell has, and a
 * nightly job silently reverting it would make this feature worse than no feature.
 *
 * ── Credentials ────────────────────────────────────────────────────────────────
 *
 * All of them live in the settings store (group `warranty`), entered on
 * /settings/integrations, never in code and never logged. Every adapter is DISABLED
 * until its credentials exist, and a disabled adapter is not an error — it is simply a
 * manufacturer we look up by hand for now. `providerStatus()` reports which are live so
 * the settings screen can say so plainly.
 *
 * ── A word on the endpoints ────────────────────────────────────────────────────
 *
 * Dell, HP and Lenovo all gate their warranty API documentation behind a partner login,
 * and all three have moved their endpoints at least once. The URLs below are the current
 * published ones and every one is OVERRIDABLE from settings (`dell_base`, `hp_base`,
 * `lenovo_base`, `aggregator_base`), so a vendor moving the goalposts is a settings edit
 * rather than a deploy. Until each account exists, treat the adapter as written-to-spec
 * and unproven — `probe()` exists to prove one the moment a key lands.
 */

// ── Types ───────────────────────────────────────────────────────────────────────

export interface Entitlement {
  serviceCode?: string | null;
  description?: string | null;
  entitlementType?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
}

export interface WarrantyResult {
  serial: string;
  found: boolean;
  provider?: string | null;      // 'dell' | 'hp' | 'lenovo' | 'aggregator'
  level?: string | null;         // headline service level
  start?: Date | null;
  end?: Date | null;             // LATEST end across entitlements
  shipDate?: Date | null;
  entitlements: Entitlement[];
  error?: string | null;
}

export type ProviderKey = 'dell' | 'hp' | 'lenovo' | 'aggregator';

interface Adapter {
  key: ProviderKey;
  label: string;
  /** Manufacturer strings on customer_assets.manufacturer that this adapter answers for. */
  matches: RegExp | null;        // null = aggregator, matches anything as a fallback
  /** How many serials one call may carry. */
  batchSize: number;
  configured(): Promise<boolean>;
  lookup(serials: string[]): Promise<WarrantyResult[]>;
}

// ── Small helpers ───────────────────────────────────────────────────────────────

const d = (v: any): Date | null => {
  if (!v) return null;
  const t = new Date(String(v));
  return isNaN(t.getTime()) ? null : t;
};
const latest = (list: (Date | null | undefined)[]): Date | null => {
  const ok = list.filter(Boolean) as Date[];
  return ok.length ? new Date(Math.max(...ok.map((x) => x.getTime()))) : null;
};
const earliest = (list: (Date | null | undefined)[]): Date | null => {
  const ok = list.filter(Boolean) as Date[];
  return ok.length ? new Date(Math.min(...ok.map((x) => x.getTime()))) : null;
};
const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
/** Vendor errors reach the UI, so they must never carry a key. Strip anything that looks
 *  like one and cap the length — an error field is a signal, not a log. */
const safeErr = (e: any): string =>
  String((e && e.message) || e || 'lookup failed')
    .replace(/[A-Za-z0-9_\-]{24,}/g, '***')
    .slice(0, 240);

export const _redactForTest = safeErr;

// ── Settings, cached ────────────────────────────────────────────────────────────
// pickAdapter() asks "is this provider configured?" once PER MACHINE, and each adapter
// answering it uncached is a round trip to the settings table. On a 400-device sweep that
// is sixteen hundred queries to answer a question whose answer cannot change mid-run. Ten
// seconds of cache removes all of them and still picks up a credential saved a moment ago
// on the settings screen.
let _cfg: { at: number; value: Record<string, string> } | null = null;
const CFG_TTL_MS = 10_000;

async function cfg(): Promise<Record<string, string>> {
  if (_cfg && Date.now() - _cfg.at < CFG_TTL_MS) return _cfg.value;
  const value = await getGroup('warranty');
  _cfg = { at: Date.now(), value };
  return value;
}

/** Drop the cached credentials — called when they are saved, so the settings screen's
 *  "Configured" badge and the test button never argue with each other. */
export function forgetWarrantyConfig(): void { _cfg = null; }

const HTTP_TIMEOUT_MS = 25_000;

async function httpJson(url: string, init: any = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      // The body of a vendor 4xx usually says WHICH thing is wrong (bad tag vs bad key),
      // and that distinction is the whole difference between "fix the data" and "fix the
      // account". Keep a little of it.
      throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
    }
    try { return text ? JSON.parse(text) : null; } catch { throw new Error('vendor returned a non-JSON body'); }
  } finally { clearTimeout(timer); }
}

// ── Token cache ─────────────────────────────────────────────────────────────────
// OAuth tokens for these APIs last an hour. Fetching one per batch would triple the call
// count and, on Dell, count against the rate limit that matters.

const tokens = new Map<string, { value: string; expires: number }>();

async function cachedToken(key: string, mint: () => Promise<{ value: string; ttlSecs: number }>): Promise<string> {
  const have = tokens.get(key);
  if (have && have.expires > Date.now() + 60_000) return have.value;
  const fresh = await mint();
  tokens.set(key, { value: fresh.value, expires: Date.now() + Math.max(60, fresh.ttlSecs) * 1000 });
  return fresh.value;
}

/** Drop a cached token — called when a 401 says the cached one is no longer good. */
export function forgetTokens(): void { tokens.clear(); }

// ── Dell ────────────────────────────────────────────────────────────────────────
// TechDirect: OAuth2 client-credentials, then asset-entitlements by service tag. Up to
// 100 tags per call, which is why the estate refresh is cheap on a Dell-heavy site.

const DELL_BASE_DEFAULT = 'https://apigtwb2c.us.dell.com';

const dell: Adapter = {
  key: 'dell',
  label: 'Dell TechDirect',
  matches: /dell/i,
  batchSize: 100,
  async configured() {
    const g = await cfg();
    return !!(g.dell_client_id && g.dell_client_secret);
  },
  async lookup(serials) {
    const g = await cfg();
    const base = (g.dell_base || DELL_BASE_DEFAULT).replace(/\/+$/, '');
    const token = await cachedToken('dell', async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: g.dell_client_id,
        client_secret: g.dell_client_secret,
      });
      const j = await httpJson(`${base}/auth/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
      if (!j || !j.access_token) throw new Error('Dell returned no access token');
      return { value: String(j.access_token), ttlSecs: Number(j.expires_in) || 3600 };
    });

    const url = `${base}/PROD/sbil/asset-entitlement-components/v5/asset-entitlements`
      + `?servicetags=${encodeURIComponent(serials.join(','))}`;
    const j = await httpJson(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    return parseDell(j, serials);
  },
};

/**
 * Dell's payload -> our shape. Pure, and separated from the call ON PURPOSE: none of these
 * three vendor APIs can be exercised without a partner account, so the parsing is the part
 * that has to be provable from a captured payload rather than from a live call. Every
 * parser below is exported for exactly that reason and is covered by test-warranty.ts.
 */
export function parseDell(j: any, serials: string[]): WarrantyResult[] {
  const rows: any[] = Array.isArray(j) ? j : (j && Array.isArray(j.assetEntitlementList) ? j.assetEntitlementList : []);
  // Index by service tag so a tag Dell did not answer for is reported as not-found rather
  // than silently dropped — a missing answer and a missing warranty are different things
  // and the asset page says which.
  const byTag = new Map<string, any>();
  for (const r of rows) {
    const tag = String((r && (r.serviceTag || r.id)) || '').trim().toUpperCase();
    if (tag) byTag.set(tag, r);
  }
  return serials.map((s) => {
    const r = byTag.get(s.trim().toUpperCase());
    if (!r) return { serial: s, found: false, provider: 'dell', entitlements: [] };
    const ents: Entitlement[] = (r.entitlements || []).map((e: any) => ({
      serviceCode: e.serviceLevelCode ?? null,
      description: e.serviceLevelDescription ?? e.serviceLevelGroup ?? null,
      entitlementType: e.entitlementType ?? null,
      startDate: d(e.startDate),
      endDate: d(e.endDate),
    }));
    // The headline is the entitlement that runs LONGEST — that is the date somebody means
    // when they ask "is it under warranty". An expired ProSupport next to a live
    // accidental-damage plan must not report the machine as out of cover.
    const head = ents.slice().sort((a, b) =>
      (b.endDate ? b.endDate.getTime() : 0) - (a.endDate ? a.endDate.getTime() : 0))[0];
    return {
      serial: s,
      found: true,
      provider: 'dell',
      level: (head && head.description) || r.productLineDescription || null,
      start: earliest(ents.map((e) => e.startDate)),
      end: latest(ents.map((e) => e.endDate)),
      shipDate: d(r.shipDate),
      entitlements: ents,
    };
  });
}

// ── HP ──────────────────────────────────────────────────────────────────────────
// HP's Product Warranty API is a JOB API: you post the serials, it returns a job id, and
// you poll until it is done. That is why this adapter has a wait loop and the others do
// not — it is HP's shape, not ours. Serial alone is often not enough for HP; the product
// number narrows it, so we send the model when we have one.

const HP_BASE_DEFAULT = 'https://css.api.hp.com';

const hp: Adapter = {
  key: 'hp',
  label: 'HP',
  matches: /^(hp|hewlett)/i,
  batchSize: 50,
  async configured() {
    const g = await cfg();
    return !!(g.hp_api_key && g.hp_api_secret);
  },
  async lookup(serials) {
    const g = await cfg();
    const base = (g.hp_base || HP_BASE_DEFAULT).replace(/\/+$/, '');
    const token = await cachedToken('hp', async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: g.hp_api_key,
        client_secret: g.hp_api_secret,
      });
      const j = await httpJson(`${base}/oauth/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
      if (!j || !j.access_token) throw new Error('HP returned no access token');
      return { value: String(j.access_token), ttlSecs: Number(j.expires_in) || 3600 };
    });
    const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

    const job = await httpJson(`${base}/productWarranty/v2/jobs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(serials.map((s) => ({ sn: s }))),
    });
    const jobId = job && (job.jobId || job.id);
    if (!jobId) throw new Error('HP accepted the request but returned no job id');

    // Poll. HP's own guidance is a few seconds for a small batch; cap it so a stuck job
    // cannot hold the nightly run open. A timeout here is a retry tomorrow, not a failure
    // worth waking anyone for.
    let out: any = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await httpJson(`${base}/productWarranty/v2/jobs/${encodeURIComponent(String(jobId))}`, { headers: auth });
      const status = String((st && (st.status || st.jobStatus)) || '').toLowerCase();
      if (status === 'completed' || status === 'complete' || Array.isArray(st)) { out = st; break; }
      if (status === 'error' || status === 'failed') throw new Error('HP reported the job failed');
    }
    if (!out) throw new Error('HP did not finish the lookup in time');

    return parseHp(out, serials);
  },
};

export function parseHp(out: any, serials: string[]): WarrantyResult[] {
  const rows: any[] = Array.isArray(out) ? out : ((out && (out.results || out.devices)) || []);
  const bySn = new Map<string, any>();
  for (const r of rows) {
    const sn = String((r && (r.sn || r.serialNumber || (r.device && r.device.sn))) || '').trim().toUpperCase();
    if (sn) bySn.set(sn, r);
  }
  return serials.map((s) => {
    const r = bySn.get(s.trim().toUpperCase());
    if (!r) return { serial: s, found: false, provider: 'hp', entitlements: [] };
    const offers: any[] = r.offers || r.warranties || (r.warranty && r.warranty.offers) || [];
    const ents: Entitlement[] = offers.map((o: any) => ({
      serviceCode: o.serviceObligationLineItemNumber ?? o.offerId ?? null,
      description: o.offerDescription ?? o.serviceLevelDescription ?? o.name ?? null,
      entitlementType: o.serviceType ?? o.offerType ?? null,
      startDate: d(o.startDate || o.serviceObligationStartDate),
      endDate: d(o.endDate || o.serviceObligationEndDate),
    }));
    const head = ents.slice().sort((a, b) =>
      (b.endDate ? b.endDate.getTime() : 0) - (a.endDate ? a.endDate.getTime() : 0))[0];
    return {
      serial: s,
      found: true,
      provider: 'hp',
      level: (head && head.description) || null,
      start: earliest(ents.map((e) => e.startDate)),
      end: latest(ents.map((e) => e.endDate)),
      shipDate: d(r.shipDate || r.deliveryDate),
      entitlements: ents,
    };
  });
}

// ── Lenovo ──────────────────────────────────────────────────────────────────────
// One serial per call, ClientID header, no OAuth. Cheapest of the three to run and the
// most limited: it answers for one machine and it answers slowly, so the estate sweep
// spaces the calls out rather than firing the whole Lenovo fleet at once.

const LENOVO_BASE_DEFAULT = 'https://supportapi.lenovo.com';

const lenovo: Adapter = {
  key: 'lenovo',
  label: 'Lenovo',
  matches: /lenovo|thinkpad|thinkcentre/i,
  batchSize: 1,
  async configured() {
    const g = await cfg();
    return !!g.lenovo_client_id;
  },
  async lookup(serials) {
    const g = await cfg();
    const base = (g.lenovo_base || LENOVO_BASE_DEFAULT).replace(/\/+$/, '');
    const out: WarrantyResult[] = [];
    for (const s of serials) {
      try {
        const j = await httpJson(`${base}/V2.5/Warranty?Serial=${encodeURIComponent(s)}`, {
          headers: { ClientID: g.lenovo_client_id, Accept: 'application/json' },
        });
        out.push(parseLenovo(j, s));
      } catch (e: any) {
        out.push({ serial: s, found: false, provider: 'lenovo', entitlements: [], error: safeErr(e) });
      }
    }
    return out;
  },
};

// ── Aggregator ──────────────────────────────────────────────────────────────────
// One key covering every manufacturer (ScalePad Lifecycle Manager and its competitors all
// expose the same shape: POST serials, get warranty back). Deliberately generic and fully
// configurable, because which aggregator we buy — if we buy one — is a commercial decision
// that has not been made. It is the LAST resort in pickAdapter(): a manufacturer's own
// answer beats a reseller of that answer.

const aggregator: Adapter = {
  key: 'aggregator',
  label: 'Aggregator',
  matches: null,
  batchSize: 50,
  async configured() {
    const g = await cfg();
    return !!(g.aggregator_base && g.aggregator_key);
  },
  async lookup(serials) {
    const g = await cfg();
    const base = String(g.aggregator_base).replace(/\/+$/, '');
    const j = await httpJson(base, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${g.aggregator_key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serials }),
    });
    return parseAggregator(j, serials);
  },
};

export function parseAggregator(j: any, serials: string[]): WarrantyResult[] {
  const rows: any[] = Array.isArray(j) ? j : ((j && (j.results || j.assets || j.data)) || []);
  const bySn = new Map<string, any>();
  for (const r of rows) {
    const sn = String((r && (r.serial || r.serialNumber || r.sn)) || '').trim().toUpperCase();
    if (sn) bySn.set(sn, r);
  }
  return serials.map((s) => {
    const r = bySn.get(s.trim().toUpperCase());
    if (!r) return { serial: s, found: false, provider: 'aggregator', entitlements: [] };
    const ents: Entitlement[] = (r.entitlements || r.warranties || []).map((e: any) => ({
      serviceCode: e.code ?? null,
      description: e.description ?? e.name ?? null,
      entitlementType: e.type ?? null,
      startDate: d(e.startDate || e.start),
      endDate: d(e.endDate || e.end),
    }));
    return {
      serial: s,
      found: true,
      provider: 'aggregator',
      level: r.serviceLevel || r.warrantyType || (ents[0] && ents[0].description) || null,
      start: d(r.warrantyStart || r.start) || earliest(ents.map((e) => e.startDate)),
      end: d(r.warrantyEnd || r.end) || latest(ents.map((e) => e.endDate)),
      shipDate: d(r.shipDate || r.purchaseDate),
      entitlements: ents,
    };
  });
}

export function parseLenovo(j: any, serial: string): WarrantyResult {
  const list: any[] = (j && (j.Warranty || j.warranty)) || [];
  const ents: Entitlement[] = list.map((w: any) => ({
    serviceCode: w.ID ?? w.Type ?? null,
    description: w.Name ?? w.Description ?? null,
    entitlementType: w.Type ?? null,
    startDate: d(w.Start),
    endDate: d(w.End),
  }));
  if (!ents.length) return { serial, found: false, provider: 'lenovo', entitlements: [] };
  const head = ents.slice().sort((a, b) =>
    (b.endDate ? b.endDate.getTime() : 0) - (a.endDate ? a.endDate.getTime() : 0))[0];
  return {
    serial,
    found: true,
    provider: 'lenovo',
    level: (head && head.description) || null,
    start: earliest(ents.map((e) => e.startDate)),
    end: latest(ents.map((e) => e.endDate)),
    shipDate: d(j && j.Shipped),
    entitlements: ents,
  };
}

const ADAPTERS: Adapter[] = [dell, hp, lenovo, aggregator];

// ── Which adapter answers for a machine ────────────────────────────────────────

/** The manufacturer's own service if it is configured, otherwise the aggregator, otherwise
 *  nothing — which means "look it up by hand", not "error". */
async function pickAdapter(manufacturer: string | null | undefined): Promise<Adapter | null> {
  const m = String(manufacturer || '');
  for (const a of ADAPTERS) {
    if (a.matches && a.matches.test(m) && (await a.configured())) return a;
  }
  if (await aggregator.configured()) return aggregator;
  return null;
}

/** Which service would answer for this manufacturer, by name — or null, meaning "nobody
 *  is connected for this make yet, so it is a manual job". The asset page asks this so it
 *  can offer a Check-now button that will actually do something, instead of one that
 *  fails on the click. */
export async function providerLabelFor(manufacturer: string | null | undefined): Promise<string | null> {
  const ad = await pickAdapter(manufacturer);
  return ad ? ad.label : null;
}

export async function providerStatus(): Promise<{ key: ProviderKey; label: string; configured: boolean }[]> {
  const out = [];
  for (const a of ADAPTERS) out.push({ key: a.key, label: a.label, configured: await a.configured() });
  return out;
}

// ── Writing a result back ───────────────────────────────────────────────────────

/**
 * Persist one lookup. Returns what happened, in words, so a "check now" button can say
 * something truthful rather than just reloading the page.
 *
 * A LOCKED asset is never written. A lookup that found nothing clears the error and stamps
 * the check time but leaves any existing dates alone — a vendor that has forgotten a
 * machine is not evidence that the machine has no warranty.
 */
export async function applyResult(assetId: number, r: WarrantyResult): Promise<string> {
  const locked = (await pool.query('SELECT warranty_locked FROM customer_assets WHERE id=$1', [assetId]))
    .rows[0]?.warranty_locked;
  if (locked) return 'Left alone — this warranty was entered by hand and is locked.';

  if (r.error) {
    await pool.query(
      `UPDATE customer_assets SET warranty_checked_at=NOW(), warranty_error=$2, updated_at=NOW() WHERE id=$1`,
      [assetId, r.error.slice(0, 240)]);
    return `Lookup failed: ${r.error}`;
  }
  if (!r.found) {
    await pool.query(
      `UPDATE customer_assets SET warranty_checked_at=NOW(),
              warranty_error='The manufacturer has no warranty record for this serial number.',
              updated_at=NOW() WHERE id=$1`, [assetId]);
    return 'The manufacturer does not recognise that serial number.';
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE customer_assets
          SET warranty_provider=$2, warranty_level=$3, warranty_start=$4, warranty_end=$5,
              warranty_ship_date=$6, warranty_source=$7, warranty_checked_at=NOW(),
              warranty_error=NULL, updated_at=NOW()
        WHERE id=$1`,
      [assetId, r.provider || null, r.level || null, r.start || null, r.end || null,
       r.shipDate || null, `api:${r.provider}`]);
    // Replaced wholesale, never merged — see the schema comment.
    await client.query('DELETE FROM asset_warranty_entitlements WHERE asset_id=$1', [assetId]);
    for (const e of r.entitlements) {
      await client.query(
        `INSERT INTO asset_warranty_entitlements
           (asset_id, service_code, description, entitlement_type, start_date, end_date, source, collected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [assetId, e.serviceCode || null, e.description || null, e.entitlementType || null,
         e.startDate || null, e.endDate || null, `api:${r.provider}`]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const when = r.end ? r.end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'no end date given';
  return `Updated from ${r.provider}: ${r.level || 'warranty'} — ${when}.`;
}

// ── Refresh one asset ───────────────────────────────────────────────────────────

export async function refreshAsset(assetId: number): Promise<string> {
  const a = (await pool.query(
    'SELECT id, serial_number, manufacturer, warranty_locked FROM customer_assets WHERE id=$1', [assetId])).rows[0];
  if (!a) return 'Device not found.';
  if (a.warranty_locked) return 'This warranty was entered by hand and is locked, so nothing was fetched.';
  const serial = String(a.serial_number || '').trim();
  if (!serial) return 'No serial number on this device — there is nothing to look the warranty up by.';

  const ad = await pickAdapter(a.manufacturer);
  if (!ad) {
    return `No warranty service is connected for ${a.manufacturer || 'this manufacturer'} yet. `
         + `Add the credentials under Settings → Integrations, or type the warranty in below.`;
  }
  try {
    const [r] = await ad.lookup([serial]);
    return await applyResult(assetId, r || { serial, found: false, provider: ad.key, entitlements: [] });
  } catch (e: any) {
    const msg = safeErr(e);
    // A 401 on a cached token is worth exactly one retry with a fresh one — tokens do get
    // revoked mid-life and re-minting is cheaper than a day of failures.
    if (/HTTP 401/.test(msg)) {
      forgetTokens();
      try {
        const [r2] = await ad.lookup([serial]);
        return await applyResult(assetId, r2 || { serial, found: false, provider: ad.key, entitlements: [] });
      } catch (e2: any) {
        return await applyResult(assetId, { serial, found: false, entitlements: [], error: safeErr(e2) });
      }
    }
    return await applyResult(assetId, { serial, found: false, entitlements: [], error: msg });
  }
}

// ── Refresh the estate ──────────────────────────────────────────────────────────

export interface SweepSummary { checked: number; updated: number; failed: number; skipped: number; }

/**
 * The nightly sweep. It is deliberately NOT "refresh everything every night":
 *
 *   • a warranty end date changes when somebody buys an extension, which is rare
 *   • the vendors rate-limit, and Lenovo is one call per machine
 *
 * so it refreshes anything never checked, anything last checked more than `staleDays` ago,
 * and — more often — anything expiring within 90 days, because that is the window where
 * an extension actually gets bought and the date actually moves.
 */
export async function sweep(opts: { limit?: number; staleDays?: number } = {}): Promise<SweepSummary> {
  const limit = opts.limit ?? 400;
  const staleDays = opts.staleDays ?? 30;
  const sum: SweepSummary = { checked: 0, updated: 0, failed: 0, skipped: 0 };

  const rows = (await pool.query(
    `SELECT id, serial_number, manufacturer
       FROM customer_assets
      WHERE merged_into_id IS NULL AND archived_at IS NULL
        AND warranty_locked = false
        AND serial_number IS NOT NULL AND serial_number <> ''
        AND ( warranty_checked_at IS NULL
              OR warranty_checked_at < NOW() - ($1 || ' days')::interval
              OR (warranty_end IS NOT NULL
                  AND warranty_end BETWEEN NOW() AND NOW() + INTERVAL '90 days'
                  AND warranty_checked_at < NOW() - INTERVAL '7 days') )
      ORDER BY warranty_checked_at ASC NULLS FIRST
      LIMIT $2`, [String(staleDays), limit])).rows;

  // Group by the adapter that answers for each machine, so Dell's 100-tag batch is
  // actually used instead of 100 separate calls.
  const byAdapter = new Map<Adapter, { id: number; serial: string }[]>();
  for (const r of rows) {
    const ad = await pickAdapter(r.manufacturer);
    if (!ad) { sum.skipped++; continue; }
    if (!byAdapter.has(ad)) byAdapter.set(ad, []);
    byAdapter.get(ad)!.push({ id: r.id, serial: String(r.serial_number).trim() });
  }

  for (const [ad, list] of byAdapter) {
    for (const batch of chunk(list, ad.batchSize)) {
      let results: WarrantyResult[] = [];
      try {
        results = await ad.lookup(batch.map((b) => b.serial));
      } catch (e: any) {
        // A whole batch failing is one vendor problem, not N device problems. Record it
        // against each device so the page explains itself, and move on to the next batch.
        const msg = safeErr(e);
        results = batch.map((b) => ({ serial: b.serial, found: false, entitlements: [], error: msg }));
      }
      const bySerial = new Map(results.map((r) => [r.serial.trim().toUpperCase(), r]));
      for (const b of batch) {
        const r = bySerial.get(b.serial.toUpperCase());
        sum.checked++;
        try {
          await applyResult(b.id, r || { serial: b.serial, found: false, entitlements: [] });
          if (r && r.found) sum.updated++; else sum.failed++;
        } catch (e: any) {
          sum.failed++;
          console.error('[warranty] write failed for asset', b.id, safeErr(e));
        }
      }
      // Be a good citizen. Lenovo in particular does not enjoy a fleet arriving at once.
      await new Promise((r) => setTimeout(r, ad.batchSize === 1 ? 400 : 1200));
    }
  }

  await setSetting('warranty', 'last_sweep', new Date().toISOString());
  await setSetting('warranty', 'last_sweep_summary', JSON.stringify(sum));
  console.log(`[warranty] sweep: ${sum.checked} checked, ${sum.updated} updated, ${sum.failed} failed, ${sum.skipped} no provider`);
  return sum;
}

/** Prove a single provider's credentials without touching any asset — the settings screen's
 *  "test" button. Uses a serial the caller supplies, because none of these APIs has a
 *  ping endpoint and a made-up tag is indistinguishable from a bad key. */
export async function probe(key: ProviderKey, serial: string): Promise<{ ok: boolean; message: string }> {
  const ad = ADAPTERS.find((a) => a.key === key);
  if (!ad) return { ok: false, message: 'Unknown provider.' };
  if (!(await ad.configured())) return { ok: false, message: `${ad.label} has no credentials saved yet.` };
  try {
    const [r] = await ad.lookup([serial.trim()]);
    if (!r) return { ok: false, message: `${ad.label} answered, but with nothing in it.` };
    if (r.error) return { ok: false, message: r.error };
    if (!r.found) return { ok: true, message: `${ad.label} answered — it just has no record for that serial. The credentials work.` };
    return {
      ok: true,
      message: `${ad.label} answered: ${r.level || 'warranty found'}${r.end ? `, cover to ${r.end.toLocaleDateString('en-GB')}` : ''}.`,
    };
  } catch (e: any) {
    return { ok: false, message: safeErr(e) };
  }
}

// ── Presentation helper, shared by every surface ────────────────────────────────
// One place decides what "expiring soon" means, so the asset page, the list and any
// future report cannot disagree about the colour of the same machine.

export interface WarrantyView {
  state: 'active' | 'expiring' | 'expired' | 'unknown';
  label: string;
  days: number | null;
}

export function warrantyView(end: Date | string | null | undefined): WarrantyView {
  const e = end ? new Date(end) : null;
  if (!e || isNaN(e.getTime())) return { state: 'unknown', label: 'Not known', days: null };
  const days = Math.round((e.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { state: 'expired', label: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`, days };
  if (days <= 90) return { state: 'expiring', label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`, days };
  return { state: 'active', label: 'In warranty', days };
}

// ── Scheduled job ───────────────────────────────────────────────────────────────

let _started = false;

export function startWarrantySync(): void {
  if (_started) return;
  _started = true;
  // 03:40, between the end-of-life pull and the morning. Nothing else runs here.
  cron.schedule('40 3 * * *', () => {
    sweep().catch((e) => console.error('[warranty] nightly sweep failed:', safeErr(e)));
  });
  console.log('✓ Warranty sync scheduled (03:40 daily, manufacturer warranty services)');
}
