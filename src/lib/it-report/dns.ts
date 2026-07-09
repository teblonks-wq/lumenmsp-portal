import { promises as dns } from 'dns';

// ── DNS & Email Security checks ──────────────────────────────────────────────────
// Live lookups for the customer's primary domain — mirrors the "DNS & Email Security
// Status" table on the Staybrook snapshot (MX / SPF / DKIM / DMARC / Autodiscover / A).
// Fully automatable, no API/consent needed. Each row degrades to a ✖ if not found.

export interface DnsRow { record: string; purpose: string; ok: boolean; detail: string; }
export interface DnsResult { domain: string; rows: DnsRow[]; aRecordIp: string | null; }

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export async function getDnsSecurity(domain: string): Promise<DnsResult | null> {
  const d = (domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d || !d.includes('.')) return null;

  const [mx, spfTxt, dmarcTxt, dkim1, dkim2, autodisc, a] = await Promise.all([
    safe(() => dns.resolveMx(d)),
    safe(() => dns.resolveTxt(d)),
    safe(() => dns.resolveTxt(`_dmarc.${d}`)),
    safe(() => dns.resolveCname(`selector1._domainkey.${d}`)),
    safe(() => dns.resolveCname(`selector2._domainkey.${d}`)),
    safe(() => dns.resolveCname(`autodiscover.${d}`)),
    safe(() => dns.resolve4(d)),
  ]);

  const spf = (spfTxt || []).map((t) => t.join('')).find((s) => /^v=spf1/i.test(s)) || '';
  const dmarc = (dmarcTxt || []).map((t) => t.join('')).find((s) => /^v=DMARC1/i.test(s)) || '';
  const mxHost = (mx && mx.length) ? mx.sort((x, y) => x.priority - y.priority)[0].exchange : '';
  const dkimOk = !!(dkim1 && dkim1.length) || !!(dkim2 && dkim2.length);
  const autoOk = !!(autodisc && autodisc.length);
  const aIp = (a && a.length) ? a[0] : null;

  const rows: DnsRow[] = [
    { record: 'MX', purpose: 'Mail routing', ok: !!mxHost, detail: mxHost || 'not found' },
    { record: 'SPF', purpose: 'Authorised senders', ok: !!spf, detail: spf ? 'published' : 'not found' },
    { record: 'DKIM', purpose: 'Message integrity', ok: dkimOk, detail: dkimOk ? 'selector(s) published' : 'not found' },
    { record: 'DMARC', purpose: 'Policy & reporting', ok: !!dmarc, detail: dmarc ? (dmarc.match(/p=(\w+)/i)?.[0] || 'published') : 'not found' },
    { record: 'Autodiscover', purpose: 'Client configuration', ok: autoOk, detail: autoOk ? (autodisc as string[])[0] : 'not found' },
    { record: 'A Record', purpose: 'Website', ok: !!aIp, detail: aIp || 'not found' },
  ];
  return { domain: d, rows, aRecordIp: aIp };
}
