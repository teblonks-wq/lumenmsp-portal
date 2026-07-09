import { promises as dns } from 'dns';
import { config } from '../../config';
import { fetchDomainInfo, type DomainRegistryInfo } from './domain-info';

// ── LITS-DMARC: deep DNS analysis ────────────────────────────────────────────────
// A fuller SPF/DKIM/DMARC check than the IT-report snapshot table: parses the records,
// flags issues, scores the domain 0–100 and generates the records we'd ask the
// customer to publish (including rua= pointing at our collection mailbox).

export interface SpfCheck {
  found: boolean;
  record: string;
  allMechanism: string;      // '-all' | '~all' | '?all' | '+all' | ''
  issues: string[];
}
export interface DkimKeyInfo {
  selector: string;
  source: 'cname' | 'txt';   // CNAME (e.g. M365 → onmicrosoft) or direct TXT
  keyType: string;           // k= tag (rsa/ed25519), '' if unreadable
  keyBits: number | null;    // approx RSA size from the p= key length
  revoked: boolean;          // p= present but empty = key revoked
}
export interface DkimCheck {
  found: boolean;
  selectors: string[];       // selectors that resolved (CNAME or TXT)
  keys: DkimKeyInfo[];       // per-selector key detail
}
export interface DmarcCheck {
  found: boolean;
  record: string;
  policy: string;            // none | quarantine | reject | ''
  subPolicy: string;         // sp= if present
  pct: number;               // pct= (default 100)
  rua: string[];             // report addresses
  ruaIncludesUs: boolean;    // do reports come to our mailbox?
  issues: string[];
}
// Platform DNS rows — MX + the Office 365 service records (autodiscover, Intune enrolment).
export interface PlatformRow {
  record: string;            // 'MX' | 'Autodiscover' | …
  host: string;              // where it lives
  ok: boolean;
  optional: boolean;         // Intune rows are nice-to-have, not mail-critical
  detail: string;            // what we found
  expected: string;          // what to publish when missing/wrong ('' = fine as-is)
}

export interface DmarcDnsCheck {
  domain: string;
  mxHost: string;            // lowest-priority MX — tells us who hosts their mail
  mailProvider: string;      // 'Microsoft 365' | 'Google Workspace' | '' (unknown)
  nsHosts: string[];         // the domain's nameservers
  dnsManager: string;        // detected DNS provider ('20i (Stack DNS)', 'Cloudflare', …)
  dnsManagerUrl: string;     // login/console URL for the provider ('' if unknown)
  registry: DomainRegistryInfo | null; // RDAP/Nominet: registrar, IPS TAG, registrant, dates
  platform: PlatformRow[];   // MX + Office 365 DNS checks
  spf: SpfCheck;
  dkim: DkimCheck;
  dmarc: DmarcCheck;
  score: number;             // 0–100
  suggestedSpf: string;      // '' when the published SPF is already sound
  suggestedDmarc: string;    // the record we'd ask the customer to publish
  dkimGuidance: string;      // provider-specific setup note when DKIM is missing
  checkedAt: string;         // ISO
}

// Selectors we probe for DKIM. M365 uses selector1/selector2; the rest cover the
// common SaaS senders our customers actually use.
const DKIM_SELECTORS = [
  'selector1', 'selector2',            // Microsoft 365
  'google',                            // Google Workspace
  'k1', 'k2', 'k3',                    // Mailchimp/Mandrill
  's1', 's2', 'em',                    // SendGrid (em is a common CNAME prefix)
  'mail', 'default', 'dkim',           // generic
  'zendesk1', 'zendesk2',              // Zendesk
  'sig1',                              // Zoho
];

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

function cleanDomain(domain: string): string {
  return (domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function dmarcMailbox(): string {
  return (config.DMARC_MAILBOX || '').trim();
}

// Parse tag=value pairs from a DMARC record.
function dmarcTags(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.split(';')) {
    const m = part.trim().match(/^([a-z]+)\s*=\s*(.+)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

const POLICY_RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };

// DNS provider detection from nameserver hostnames — tells staff (and the customer)
// exactly WHERE to publish the records we're advising. Matched by substring.
const DNS_MANAGERS: { name: string; url: string; match: string[] }[] = [
  { name: '20i (Stack DNS)', url: 'https://my.20i.com/', match: ['stackdns.com', '20i.com'] },
  { name: 'Cloudflare', url: 'https://dash.cloudflare.com/', match: ['ns.cloudflare.com'] },
  { name: 'Microsoft Azure DNS', url: 'https://portal.azure.com/', match: ['azure-dns.'] },
  { name: 'AWS Route 53', url: 'https://console.aws.amazon.com/route53/', match: ['awsdns-'] },
  { name: 'GoDaddy', url: 'https://dcc.godaddy.com/', match: ['domaincontrol.com'] },
  { name: '123 Reg', url: 'https://www.123-reg.co.uk/secure/', match: ['123-reg.co.uk'] },
  { name: 'IONOS (1&1)', url: 'https://my.ionos.co.uk/', match: ['ui-dns.'] },
  { name: 'OVH', url: 'https://www.ovh.com/manager/', match: ['ovh.net', 'ovh.co.uk'] },
  { name: 'Google (Cloud DNS / Domains)', url: 'https://console.cloud.google.com/net-services/dns/', match: ['googledomains.com', 'ns-cloud-'] },
  { name: 'Namecheap', url: 'https://ap.www.namecheap.com/', match: ['registrar-servers.com'] },
  { name: 'Gandi', url: 'https://admin.gandi.net/', match: ['gandi.net'] },
  { name: 'Heart Internet', url: 'https://customer.heartinternet.uk/', match: ['heartinternet.co.uk'] },
  { name: 'Fasthosts', url: 'https://admin.fasthosts.co.uk/', match: ['fasthosts.net.uk', 'livedns.co.uk'] },
  { name: 'Krystal', url: 'https://katapult.krystal.uk/', match: ['krystal.uk', 'krystal.co.uk'] },
  { name: 'Wix', url: 'https://manage.wix.com/', match: ['wixdns.net'] },
  { name: 'Squarespace', url: 'https://account.squarespace.com/', match: ['squarespacedns.com'] },
  { name: 'DNSMadeEasy', url: 'https://dnsmadeeasy.com/', match: ['dnsmadeeasy.com'] },
  { name: 'Names.co.uk', url: 'https://admin.names.co.uk/', match: ['namesco.', 'names.co.uk'] },
  { name: 'TSOHost / Paragon', url: 'https://my.tsohost.com/', match: ['tsohost.', 'paragon.'] },
];

function detectDnsManager(nsHosts: string[]): { name: string; url: string } {
  for (const ns of nsHosts) {
    for (const m of DNS_MANAGERS) {
      if (m.match.some((s) => ns.includes(s))) return { name: m.name, url: m.url };
    }
  }
  return { name: '', url: '' };
}

// extraSelectors: selectors observed in this domain's aggregate reports (auth_results
// names the selector each sender signed with) — lets us detect keys we'd never guess.
// targetPolicy: the per-customer agreed enforcement level — the published p= is checked
// against it and the suggested record is generated AT the target.
export async function checkDmarcDns(domain: string, extraSelectors: string[] = [], targetPolicy = 'none'): Promise<DmarcDnsCheck | null> {
  const d = cleanDomain(domain);
  if (!d || !d.includes('.')) return null;
  const target = POLICY_RANK[targetPolicy] !== undefined ? targetPolicy : 'none';

  const [spfTxt, dmarcTxt, mx, autodisc, entReg, entEnr, nsRecs] = await Promise.all([
    safe(() => dns.resolveTxt(d)),
    safe(() => dns.resolveTxt(`_dmarc.${d}`)),
    safe(() => dns.resolveMx(d)),
    safe(() => dns.resolveCname(`autodiscover.${d}`)),
    safe(() => dns.resolveCname(`enterpriseregistration.${d}`)),
    safe(() => dns.resolveCname(`enterpriseenrollment.${d}`)),
    safe(() => dns.resolveNs(d)),
  ]);
  const nsHosts = (nsRecs || []).map((n) => String(n).toLowerCase().replace(/\.$/, '')).sort();
  const manager = detectDnsManager(nsHosts);
  const mxHost = (mx && mx.length) ? mx.sort((a, b) => a.priority - b.priority)[0].exchange.toLowerCase().replace(/\.$/, '') : '';
  const mailProvider = /protection\.outlook\.com$/.test(mxHost) ? 'Microsoft 365'
    : /google\.com$|googlemail\.com$/.test(mxHost) ? 'Google Workspace' : '';
  const isM365 = mailProvider === 'Microsoft 365';
  const cname = (v: string[] | null) => (v && v.length) ? v[0].toLowerCase().replace(/\.$/, '') : '';
  const adTarget = cname(autodisc), erTarget = cname(entReg), eeTarget = cname(entEnr);

  // ── MX + Office 365 platform records ──
  const platform: PlatformRow[] = [
    {
      record: 'MX', host: d, optional: false,
      ok: !!mxHost && (!isM365 || /mail\.protection\.outlook\.com$/.test(mxHost)),
      detail: mxHost || 'no MX record — domain cannot receive mail',
      expected: !mxHost ? `${d.replace(/\./g, '-')}.mail.protection.outlook.com (if Microsoft 365)`
        : (isM365 && !/mail\.protection\.outlook\.com$/.test(mxHost)) ? `${d.replace(/\./g, '-')}.mail.protection.outlook.com` : '',
    },
    {
      record: 'Autodiscover', host: `autodiscover.${d}`, optional: false,
      ok: !!adTarget && (!isM365 || adTarget === 'autodiscover.outlook.com'),
      detail: adTarget || 'not found — Outlook profile setup will fail',
      expected: (!adTarget || (isM365 && adTarget !== 'autodiscover.outlook.com')) ? 'CNAME → autodiscover.outlook.com' : '',
    },
  ];
  if (isM365) {
    platform.push(
      {
        record: 'Intune registration', host: `enterpriseregistration.${d}`, optional: true,
        ok: erTarget === 'enterpriseregistration.windows.net',
        detail: erTarget || 'not found — affects Entra device registration by UPN',
        expected: erTarget === 'enterpriseregistration.windows.net' ? '' : 'CNAME → enterpriseregistration.windows.net',
      },
      {
        record: 'Intune enrolment', host: `enterpriseenrollment.${d}`, optional: true,
        ok: eeTarget === 'enterpriseenrollment.manage.microsoft.com',
        detail: eeTarget || 'not found — affects MDM auto-enrolment by UPN',
        expected: eeTarget === 'enterpriseenrollment.manage.microsoft.com' ? '' : 'CNAME → enterpriseenrollment.manage.microsoft.com',
      },
    );
  }
  const probeSelectors = Array.from(new Set([
    ...DKIM_SELECTORS,
    ...extraSelectors.map((s) => (s || '').trim().toLowerCase()).filter((s) => /^[a-z0-9._-]{1,63}$/.test(s)),
  ]));
  const dkimResults = await Promise.all(probeSelectors.map(async (sel): Promise<DkimKeyInfo | null> => {
    const host = `${sel}._domainkey.${d}`;
    const cnameV = await safe(() => dns.resolveCname(host));
    // resolveTxt follows CNAME chains, so this reads the actual key record either way
    // (e.g. M365's selector1 CNAME → the real key on *.onmicrosoft.com).
    const txt = await safe(() => dns.resolveTxt(host));
    const rec = (txt || []).map((t) => t.join('')).find((s) => /v=DKIM1|k=|p=/i.test(s)) || '';
    if (!rec && !(cnameV && cnameV.length)) return null;
    const kMatch = rec.match(/(?:^|;)\s*k\s*=\s*([a-z0-9-]+)/i);
    const pMatch = rec.match(/(?:^|;)\s*p\s*=\s*([A-Za-z0-9+/=\s]*)(?:;|$)/);
    const pVal = pMatch ? pMatch[1].replace(/\s+/g, '') : '';
    const keyBytes = pVal ? Math.floor(pVal.length * 3 / 4) : 0;
    const keyBits = keyBytes >= 380 ? 4096 : keyBytes >= 230 ? 2048 : keyBytes >= 100 ? 1024 : null;
    return {
      selector: sel,
      source: (cnameV && cnameV.length) ? 'cname' : 'txt',
      keyType: kMatch ? kMatch[1].toLowerCase() : (rec ? 'rsa' : ''),
      keyBits,
      revoked: !!rec && !!pMatch && pVal === '',
    };
  }));
  const dkimKeys = dkimResults.filter((k): k is DkimKeyInfo => !!k);

  // ── SPF ──
  const spfRecords = (spfTxt || []).map((t) => t.join('')).filter((s) => /^v=spf1/i.test(s));
  const spfRecord = spfRecords[0] || '';
  const spfIssues: string[] = [];
  let allMech = '';
  if (!spfRecord) spfIssues.push('No SPF record published.');
  else {
    if (spfRecords.length > 1) spfIssues.push(`Multiple SPF records published (${spfRecords.length}) — receivers treat this as a permanent error.`);
    const allM = spfRecord.match(/([-~?+])all\b/);
    allMech = allM ? `${allM[1]}all` : '';
    if (!allMech) spfIssues.push('SPF has no terminating "all" mechanism.');
    else if (allMech === '+all') spfIssues.push('SPF ends "+all" — authorises the entire internet to send as this domain.');
    else if (allMech === '?all') spfIssues.push('SPF ends "?all" (neutral) — provides no protection.');
    // Mail platform verification (beyond deliverability): if Microsoft 365 hosts the mail,
    // the SPF record MUST authorise Microsoft's senders or every M365-sent mail fails SPF.
    if (isM365 && !/include:spf\.protection\.outlook\.com/i.test(spfRecord)) {
      spfIssues.push('Mail is hosted on Microsoft 365 but SPF does not include spf.protection.outlook.com — mail sent from M365 fails SPF.');
    }
    const lookups = (spfRecord.match(/\b(include|a|mx|ptr|exists|redirect)[:=\s]/gi) || []).length;
    if (lookups > 10) spfIssues.push(`SPF likely exceeds the 10-DNS-lookup limit (~${lookups} lookup mechanisms).`);
  }

  // ── DKIM ──
  const selectors = dkimKeys.filter((k) => !k.revoked).map((k) => k.selector);

  // ── DMARC ──
  const dmarcRecords = (dmarcTxt || []).map((t) => t.join('')).filter((s) => /^v=DMARC1/i.test(s));
  const dmarcRecord = dmarcRecords[0] || '';
  const dmarcIssues: string[] = [];
  let policy = '', subPolicy = '', pct = 100;
  let rua: string[] = [];
  const us = dmarcMailbox().toLowerCase();
  if (!dmarcRecord) dmarcIssues.push('No DMARC record published — spoofed mail is not policed and no reports are generated.');
  else {
    const tags = dmarcTags(dmarcRecord);
    policy = (tags.p || '').toLowerCase();
    subPolicy = (tags.sp || '').toLowerCase();
    pct = tags.pct ? parseInt(tags.pct, 10) || 100 : 100;
    rua = (tags.rua || '').split(',').map((s) => s.trim().replace(/^mailto:/i, '')).filter(Boolean);
    if (!policy) dmarcIssues.push('DMARC record has no p= policy tag.');
    if (policy === 'none') dmarcIssues.push('Policy is p=none (monitor only) — spoofed mail is still delivered.');
    if (!rua.length) dmarcIssues.push('No rua= reporting address — nobody is receiving aggregate reports.');
    if (pct < 100) dmarcIssues.push(`Policy only applies to ${pct}% of mail (pct=${pct}).`);
  }
  const ruaIncludesUs = !!us && rua.some((r) => r.toLowerCase() === us);
  if (dmarcRecord && !ruaIncludesUs && us) dmarcIssues.push(`Reports are not being sent to our collector (${us}).`);
  if (dmarcRecord && (POLICY_RANK[policy] ?? 0) < POLICY_RANK[target]) {
    dmarcIssues.push(`Published policy (p=${policy || 'none'}) is below the agreed target (p=${target}) — record needs updating.`);
  }

  // ── Score ──
  let score = 0;
  if (spfRecord) score += 15;
  if (allMech === '-all' || allMech === '~all') score += 10;
  if (selectors.length) score += 20;
  if (dmarcRecord) score += 15;
  if (policy === 'quarantine') score += 15;
  else if (policy === 'reject') score += 25;
  if (ruaIncludesUs) score += 10;
  if (spfIssues.some((i) => /Multiple SPF|\+all/.test(i))) score = Math.max(0, score - 15);
  score = Math.min(100, score);

  // ── Suggested records ── (DMARC is generated AT the agreed target policy)
  const suggestedDmarc = us ? `v=DMARC1; p=${target}; rua=mailto:${us}; fo=1; adkim=r; aspf=r` : '';

  // SPF: only suggest when missing or clearly broken; base it on who hosts their mail.
  let suggestedSpf = '';
  const spfBroken = !spfRecord || allMech === '+all' || allMech === '?all' || !allMech || spfRecords.length > 1
    || (isM365 && !/include:spf\.protection\.outlook\.com/i.test(spfRecord));
  if (spfBroken) {
    if (mailProvider === 'Microsoft 365') suggestedSpf = 'v=spf1 include:spf.protection.outlook.com -all';
    else if (mailProvider === 'Google Workspace') suggestedSpf = 'v=spf1 include:_spf.google.com -all';
    else suggestedSpf = 'v=spf1 mx -all';
    // Keep any includes they already have (e.g. Mailchimp) so the suggestion doesn't cut senders off.
    if (spfRecord) {
      const keeps = (spfRecord.match(/include:[^\s]+/gi) || []).filter((i) => !suggestedSpf.includes(i.toLowerCase()));
      if (keeps.length) suggestedSpf = suggestedSpf.replace(' -all', ` ${keeps.join(' ')} -all`);
    }
  }

  // DKIM: provider-specific pointer when nothing is signing.
  let dkimGuidance = '';
  if (!selectors.length) {
    if (mailProvider === 'Microsoft 365') {
      dkimGuidance = 'Enable DKIM in Microsoft Defender (Email authentication settings → DKIM → select the domain → Enable). '
        + 'Microsoft shows two CNAMEs to publish first: selector1._domainkey and selector2._domainkey → selector1/2-<domain-key>._domainkey.<tenant>.onmicrosoft.com.';
    } else if (mailProvider === 'Google Workspace') {
      dkimGuidance = 'Generate the DKIM key in Google Admin (Apps → Google Workspace → Gmail → Authenticate email), publish the google._domainkey TXT it gives you, then click "Start authentication".';
    } else {
      dkimGuidance = 'No DKIM selectors found. Enable DKIM signing at the mail provider and publish the selector record they give you.';
    }
  }

  // Registry (RDAP/Nominet) — who holds the domain. Best-effort; never blocks the check.
  const registry = await fetchDomainInfo(d).catch(() => null);

  return {
    domain: d,
    mxHost,
    mailProvider,
    nsHosts,
    dnsManager: manager.name,
    dnsManagerUrl: manager.url,
    registry,
    platform,
    spf: { found: !!spfRecord, record: spfRecord, allMechanism: allMech, issues: spfIssues },
    dkim: { found: !!selectors.length, selectors, keys: dkimKeys },
    dmarc: { found: !!dmarcRecord, record: dmarcRecord, policy, subPolicy, pct, rua, ruaIncludesUs, issues: dmarcIssues },
    score,
    suggestedSpf,
    suggestedDmarc,
    dkimGuidance,
    checkedAt: new Date().toISOString(),
  };
}
