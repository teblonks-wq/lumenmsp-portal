// ── LITS-DMARC: domain registry info (RDAP) ─────────────────────────────────────
// Who actually holds the domain: registrar, Nominet IPS TAG (.uk), registrant,
// registration/expiry dates and registry status. Uses RDAP (the modern WHOIS):
//   .uk domains → Nominet's RDAP (includes the IPS TAG as the registrar handle)
//   everything else → rdap.org bootstrap redirector
// Best-effort: failures return { error } and never break the DNS check.

export interface DomainRegistryInfo {
  source: string;          // which RDAP endpoint answered
  registrar: string;       // e.g. "20i Limited"
  registrarTag: string;    // Nominet IPS TAG (e.g. "STACK") — '' for non-.uk
  registrant: string;      // likely owner (registries often redact for individuals)
  registered: string;      // YYYY-MM-DD
  expires: string;         // YYYY-MM-DD
  status: string[];        // registry status flags
  error?: string;
}

const vcardName = (entity: any): string => {
  const v = entity?.vcardArray?.[1];
  if (!Array.isArray(v)) return '';
  const fn = v.find((x: any) => Array.isArray(x) && x[0] === 'fn');
  return fn ? String(fn[3] || '') : '';
};

export async function fetchDomainInfo(domain: string): Promise<DomainRegistryInfo> {
  const d = (domain || '').trim().toLowerCase();
  const isUk = /\.uk$/.test(d);
  const url = isUk
    ? `https://rdap.nominet.uk/uk/domain/${encodeURIComponent(d)}`
    : `https://rdap.org/domain/${encodeURIComponent(d)}`;
  const out: DomainRegistryInfo = { source: isUk ? 'Nominet' : 'RDAP', registrar: '', registrarTag: '', registrant: '', registered: '', expires: '', status: [] };

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(url, { headers: { Accept: 'application/rdap+json, application/json' }, signal: ctl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) { out.error = `RDAP lookup failed (HTTP ${res.status})`; return out; }
    const doc: any = await res.json();

    for (const e of (doc.entities || [])) {
      const roles: string[] = e.roles || [];
      if (roles.includes('registrar')) {
        out.registrar = out.registrar || vcardName(e) || String(e.handle || '');
        // Nominet: the registrar entity's handle IS the IPS TAG.
        if (isUk && e.handle) out.registrarTag = String(e.handle);
      }
      if (roles.includes('registrant')) {
        out.registrant = out.registrant || vcardName(e) || '';
      }
      // Nominet nests the registrant under a "registrant" role entity too; some registries
      // put the org name in publicIds/remarks — fn above covers the common cases.
    }
    // Nominet also exposes the registrant as a top-level remark on some responses.
    if (!out.registrant && Array.isArray(doc.remarks)) {
      const r = doc.remarks.find((x: any) => /registrant/i.test(x?.title || ''));
      if (r && Array.isArray(r.description) && r.description[0]) out.registrant = String(r.description[0]);
    }
    for (const ev of (doc.events || [])) {
      const when = String(ev.eventDate || '').slice(0, 10);
      if (ev.eventAction === 'registration') out.registered = when;
      if (ev.eventAction === 'expiration') out.expires = when;
    }
    out.status = Array.isArray(doc.status) ? doc.status.map(String) : [];
    if (!out.registrar && !out.registered) out.error = 'RDAP answered but held no registrar data.';
  } catch (e: any) {
    out.error = /abort/i.test(String(e?.name || e?.message)) ? 'RDAP lookup timed out.' : `RDAP lookup failed: ${String(e?.message || e).slice(0, 80)}`;
  }
  return out;
}
