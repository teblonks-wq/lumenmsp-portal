import { getGraphTokenForTenant } from './graph';

// ── Microsoft 365 read-only views for a customer tenant ─────────────────────────
// Everything here uses the READ-ONLY reporting app, which most customers have already
// consented to — so this needs nothing new from them. Write actions (block sign-in,
// reset password, licence assignment) live behind their own capability packs and are
// deliberately NOT in this file: keeping reads and writes apart means an accident here
// can't change anything in a customer's tenant.

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function get(tenant: string, url: string): Promise<any> {
  const token = await getGraphTokenForTenant(tenant);
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error || {};
    throw new Error(`${err.code || res.status}: ${(err.message || 'Graph request failed').slice(0, 300)}`);
  }
  return data;
}

/** Follow @odata.nextLink to the end. Tenants outgrow one page sooner than you'd think. */
async function getAll(tenant: string, url: string, cap = 20): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < cap; page++) {
    const data = await get(tenant, next);
    out.push(...(data.value || []));
    next = data['@odata.nextLink'] || null;
  }
  return out;
}

// Microsoft's SKU GUIDs are meaningless and the part numbers are only half-readable, so
// the common ones get a proper name. Anything unrecognised falls back to the part number,
// which is still better than a GUID — this list never needs to be complete.
const SKU_NAMES: Record<string, string> = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  ENTERPRISEPACK: 'Office 365 E1',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  O365_BUSINESS: 'Microsoft 365 Apps for business',
  OFFICESUBSCRIPTION: 'Microsoft 365 Apps for enterprise',
  EMS: 'Enterprise Mobility + Security E3',
  EMSPREMIUM: 'Enterprise Mobility + Security E5',
  AAD_PREMIUM: 'Entra ID P1',
  AAD_PREMIUM_P2: 'Entra ID P2',
  POWER_BI_STANDARD: 'Power BI (free)',
  POWER_BI_PRO: 'Power BI Pro',
  PROJECTPROFESSIONAL: 'Project Plan 3',
  VISIOCLIENT: 'Visio Plan 2',
  MCOEV: 'Teams Phone',
  MCOPSTN1: 'Teams Calling Plan (domestic)',
  TEAMS_EXPLORATORY: 'Teams Exploratory',
  WINDOWS_STORE: 'Windows Store',
  FLOW_FREE: 'Power Automate (free)',
  DEFENDER_ENDPOINT_P1: 'Defender for Endpoint P1',
  ATP_ENTERPRISE: 'Defender for Office 365 P1',
};

export const skuName = (partNumber: string) => SKU_NAMES[partNumber] || partNumber;

export interface M365Sku {
  skuId: string;
  partNumber: string;
  name: string;
  total: number;      // units purchased
  assigned: number;   // units consumed
  spare: number;
}

/** The licence pools: what they're paying for and how much of it is doing nothing. */
export async function listSkus(tenant: string): Promise<M365Sku[]> {
  const rows = await getAll(tenant, '/subscribedSkus');
  return rows
    // capabilityStatus 'Enabled' excludes expired/suspended subscriptions still on the record
    .filter((s: any) => (s.capabilityStatus || 'Enabled') !== 'Deleted')
    .map((s: any) => {
      const total = Number(s.prepaidUnits?.enabled || 0);
      const assigned = Number(s.consumedUnits || 0);
      return {
        skuId: s.skuId,
        partNumber: s.skuPartNumber,
        name: skuName(s.skuPartNumber),
        total,
        assigned,
        spare: Math.max(0, total - assigned),
      };
    })
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface M365User {
  id: string;
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
  enabled: boolean;
  isGuest: boolean;
  licences: string[];
  createdAt: string | null;
}

/**
 * Everyone in the directory — including unlicensed and disabled accounts, which the
 * existing directory-sync deliberately skips. For an admin panel those are exactly the
 * rows you want: a disabled account still holding an E3 is money going nowhere, and a
 * leaver who was never disabled is a security finding.
 */
export async function listUsers(tenant: string): Promise<M365User[]> {
  const skus = await listSkus(tenant).catch(() => [] as M365Sku[]);
  const byId = new Map(skus.map((s) => [s.skuId, s.name]));

  const rows = await getAll(tenant,
    '/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,jobTitle,department,userType,assignedLicenses,createdDateTime&$top=200');

  return rows.map((u: any) => ({
    id: u.id,
    displayName: u.displayName || u.userPrincipalName || '(no name)',
    email: (u.mail || u.userPrincipalName || '').toLowerCase(),
    jobTitle: u.jobTitle || '',
    department: u.department || '',
    enabled: u.accountEnabled !== false,
    isGuest: (u.userType || 'Member') === 'Guest',
    licences: (u.assignedLicenses || [])
      .map((l: any) => byId.get(l.skuId) || '')
      .filter(Boolean),
    createdAt: u.createdDateTime || null,
  })).sort((a: M365User, b: M365User) => a.displayName.localeCompare(b.displayName));
}

export interface M365Group {
  id: string;
  name: string;
  description: string;
  kind: string;          // Microsoft 365 | Security | Distribution | Mail-enabled security
  mail: string;
  members: number | null;
}

export async function listGroups(tenant: string): Promise<M365Group[]> {
  const rows = await getAll(tenant,
    '/groups?$select=id,displayName,description,mail,mailEnabled,securityEnabled,groupTypes&$top=200');

  return rows.map((g: any) => {
    const unified = (g.groupTypes || []).includes('Unified');
    const kind = unified ? 'Microsoft 365'
      : g.mailEnabled && g.securityEnabled ? 'Mail-enabled security'
      : g.mailEnabled ? 'Distribution'
      : 'Security';
    return {
      id: g.id,
      name: g.displayName || '(no name)',
      description: g.description || '',
      kind,
      mail: g.mail || '',
      members: null,   // a count per group is a request per group; done on demand instead
    };
  }).sort((a: M365Group, b: M365Group) => a.name.localeCompare(b.name));
}

/** Summary for the panel header. */
export function summarise(users: M365User[], skus: M365Sku[]) {
  const licensed = users.filter((u) => u.licences.length && !u.isGuest);
  return {
    users: users.filter((u) => !u.isGuest).length,
    guests: users.filter((u) => u.isGuest).length,
    licensed: licensed.length,
    disabled: users.filter((u) => !u.enabled && !u.isGuest).length,
    // The one that gets attention: disabled accounts still consuming a paid licence.
    wasted: users.filter((u) => !u.enabled && !u.isGuest && u.licences.length).length,
    spare: skus.reduce((n, s) => n + s.spare, 0),
  };
}
