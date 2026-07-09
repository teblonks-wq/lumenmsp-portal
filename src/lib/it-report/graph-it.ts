import { config } from '../../config';
import { getGraphTokenForTenant } from '../graph';

// ── Microsoft Graph collectors for the monthly IT report ─────────────────────────
// Each pulls from a CUSTOMER's Entra tenant (customers.entra_tenant_id) using the
// portal's multi-tenant app (app-only, client-credentials). Every collector degrades
// GRACEFULLY: if the tenant isn't set, the app isn't consented for the needed
// permission (403), or the data simply isn't there (404), it returns
// { available:false, note } so the report renders a tidy "data pending" card instead
// of blowing up. The report never fails because one section is unavailable.

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface Unavailable { available: false; note: string; }
function unavailable(note: string): Unavailable { return { available: false, note }; }

// Turn an HTTP failure into a human note for the placeholder card.
function noteFromStatus(status: number, what: string): string {
  if (status === 401 || status === 403) return `${what}: the portal app isn't consented for this permission in the customer's tenant yet.`;
  if (status === 404) return `${what}: not available for this tenant.`;
  return `${what}: unavailable right now (HTTP ${status}).`;
}

async function graphGetAll(tenant: string, path: string): Promise<{ ok: true; value: any[] } | { ok: false; status: number }> {
  const token = await getGraphTokenForTenant(tenant);
  const out: any[] = [];
  let url: string = GRAPH + path;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status };
    const data: any = await res.json();
    for (const v of (data.value || [])) out.push(v);
    url = data['@odata.nextLink'] || '';
    if (out.length > 5000) break; // safety cap
  }
  return { ok: true, value: out };
}

// ── Intune: managed devices & compliance ─────────────────────────────────────────
export interface IntuneDevice { name: string; assignedTo: string; os: string; compliant: boolean; encrypted: boolean; lastSync: string; }
export interface IntuneSummary {
  available: true;
  total: number;
  compliant: number;
  nonCompliant: number;
  unknown: number;
  encrypted: number;
  staleCheckIn: number;              // not synced in > 30 days
  byOs: { os: string; count: number }[];
  compliancePct: number;
  devices: IntuneDevice[];           // per-device list for the "Assigned devices" table
}

export async function getIntuneSummary(tenant: string | null | undefined): Promise<IntuneSummary | Unavailable> {
  if (!tenant) return unavailable('No Entra tenant ID is set for this customer.');
  try {
    const sel = '$select=deviceName,userDisplayName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted';
    const r = await graphGetAll(tenant, `/deviceManagement/managedDevices?${sel}&$top=200`);
    if (!r.ok) return unavailable(noteFromStatus(r.status, 'Intune devices'));
    const raw = r.value;
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    let compliant = 0, nonCompliant = 0, unknown = 0, encrypted = 0, stale = 0;
    const byOs = new Map<string, number>();
    const devices: IntuneDevice[] = [];
    for (const d of raw) {
      const state = String(d.complianceState || 'unknown').toLowerCase();
      const isCompliant = state === 'compliant';
      if (isCompliant) compliant++;
      else if (state === 'noncompliant' || state === 'error') nonCompliant++;
      else unknown++;
      if (d.isEncrypted) encrypted++;
      const last = d.lastSyncDateTime ? new Date(d.lastSyncDateTime).getTime() : 0;
      if (!last || (now - last) > thirtyDays) stale++;
      const os = String(d.operatingSystem || 'Unknown');
      byOs.set(os, (byOs.get(os) || 0) + 1);
      devices.push({
        name: String(d.deviceName || 'device'), assignedTo: String(d.userDisplayName || '—'),
        os, compliant: isCompliant, encrypted: !!d.isEncrypted, lastSync: d.lastSyncDateTime || '',
      });
    }
    devices.sort((a, b) => a.assignedTo.localeCompare(b.assignedTo) || a.name.localeCompare(b.name));
    const total = raw.length;
    return {
      available: true, total, compliant, nonCompliant, unknown, encrypted, staleCheckIn: stale,
      byOs: [...byOs.entries()].map(([os, count]) => ({ os, count })).sort((a, b) => b.count - a.count),
      compliancePct: total ? Math.round((compliant / total) * 100) : 0,
      devices,
    };
  } catch (e) {
    return unavailable(`Intune devices: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── Microsoft Secure Score ───────────────────────────────────────────────────────
export interface SecureScoreSummary {
  available: true;
  currentScore: number;
  maxScore: number;
  pct: number;
  industryAvgPct: number | null;     // "AllTenants" comparative, if present
  asOf: string;
  topActions: { name: string; scoreGain: string }[];
}

export async function getSecureScoreSummary(tenant: string | null | undefined): Promise<SecureScoreSummary | Unavailable> {
  if (!tenant) return unavailable('No Entra tenant ID is set for this customer.');
  try {
    const token = await getGraphTokenForTenant(tenant);
    const res = await fetch(`${GRAPH}/security/secureScores?$top=1`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) return unavailable(noteFromStatus(res.status, 'Secure Score'));
    const data: any = await res.json();
    const s = (data.value || [])[0];
    if (!s) return unavailable('Secure Score: no score published for this tenant yet.');
    const currentScore = Math.round(s.currentScore || 0);
    const maxScore = Math.round(s.maxScore || 0);
    const pct = maxScore ? Math.round((currentScore / maxScore) * 100) : 0;
    const allTenants = (s.averageComparativeScores || []).find((c: any) => c.basis === 'AllTenants');
    const industryAvgPct = (allTenants && maxScore) ? Math.round((allTenants.averageScore / maxScore) * 100) : null;
    // Top improvement actions not yet fully achieved.
    const topActions = (s.controlScores || [])
      .filter((c: any) => (c.scoreInPercentage ?? 100) < 100)
      .sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
      .slice(0, 5)
      .map((c: any) => ({ name: String(c.controlName || c.description || 'Control'), scoreGain: String(c.description || '') }));
    return { available: true, currentScore, maxScore, pct, industryAvgPct, asOf: s.createdDateTime || '', topActions };
  } catch (e) {
    return unavailable(`Secure Score: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── Vulnerability posture (Defender for Endpoint TVM) ────────────────────────────
// TVM lives on the Defender API (api.securitycenter.microsoft.com), a DIFFERENT audience
// to Graph, so it needs its own app-only token + WindowsDefenderATP permissions consented
// in the tenant. We attempt it; if the app isn't set up for Defender in this tenant it
// degrades to a "data pending" note (the common case until Defender is wired per customer).
export interface VulnerabilitySummary {
  available: true;
  exposureScore: number | null;
  configScore: number | null;
  topRecommendations: { name: string; weaknesses: number; exposedDevices: number }[];
}

const DEFENDER = 'https://api.securitycenter.microsoft.com/api';

async function getDefenderToken(tenant: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GRAPH_CLIENT_ID, client_secret: config.GRAPH_CLIENT_SECRET,
      scope: 'https://api.securitycenter.microsoft.com/.default', grant_type: 'client_credentials',
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'token error'), { status: res.status });
  return data.access_token;
}

export async function getVulnerabilitySummary(tenant: string | null | undefined): Promise<VulnerabilitySummary | Unavailable> {
  if (!tenant) return unavailable('No Entra tenant ID is set for this customer.');
  try {
    let token: string;
    try { token = await getDefenderToken(tenant); }
    catch (e: any) { return unavailable(noteFromStatus(e.status || 0, 'Vulnerability testing (Defender TVM)')); }
    const hdr = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    const expRes = await fetch(`${DEFENDER}/exposureScore`, { headers: hdr });
    if (!expRes.ok) return unavailable(noteFromStatus(expRes.status, 'Vulnerability testing (Defender TVM)'));
    const exp: any = await expRes.json();

    let configScore: number | null = null;
    try { const c = await fetch(`${DEFENDER}/configurationScore`, { headers: hdr }); if (c.ok) { const cd: any = await c.json(); configScore = Math.round(cd.score ?? cd.value ?? 0) || null; } } catch { /* optional */ }

    let topRecommendations: VulnerabilitySummary['topRecommendations'] = [];
    try {
      const rec = await fetch(`${DEFENDER}/recommendations?$top=5&$orderby=exposedMachinesCount desc`, { headers: hdr });
      if (rec.ok) {
        const rd: any = await rec.json();
        topRecommendations = (rd.value || []).slice(0, 5).map((x: any) => ({
          name: String(x.recommendationName || x.productName || 'Recommendation'),
          weaknesses: x.weaknessesCount || 0,
          exposedDevices: x.exposedMachinesCount || 0,
        }));
      }
    } catch { /* optional */ }

    return { available: true, exposureScore: Math.round(exp.score ?? exp.value ?? 0) || null, configScore, topRecommendations };
  } catch (e) {
    return unavailable(`Vulnerability testing: ${(e as Error).message.slice(0, 120)}`);
  }
}
