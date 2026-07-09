import { promises as dns } from 'dns';

// ── LITS-DMARC: sender classification ────────────────────────────────────────────
// Maps a report row's source IP to a human sender name via reverse DNS. This is the
// MSP-scale version of the big vendors' "sender intelligence" databases: a seed list
// of the senders our customers actually use, matched on the PTR hostname suffix.
// Unknown sources keep their PTR (or bare IP) so staff can spot them and we can
// extend the list over time.

interface KnownSender { name: string; ptrSuffixes: string[]; }

const KNOWN_SENDERS: KnownSender[] = [
  { name: 'Microsoft 365', ptrSuffixes: ['.outbound.protection.outlook.com', '.protection.outlook.com'] },
  { name: 'Google Workspace / Gmail', ptrSuffixes: ['.google.com', '.googlemail.com'] },
  { name: 'Mailchimp / Mandrill', ptrSuffixes: ['.mcsv.net', '.mcdlv.net', '.rsgsv.net', '.mandrillapp.com'] },
  { name: 'SendGrid', ptrSuffixes: ['.sendgrid.net'] },
  { name: 'Amazon SES', ptrSuffixes: ['.amazonses.com', '.smtp-out.amazonses.com'] },
  { name: 'Brevo (Sendinblue)', ptrSuffixes: ['.sendinblue.com', '.brevo.com'] },
  { name: 'Mailgun', ptrSuffixes: ['.mailgun.net', '.mailgun.org', '.mailgun.info'] },
  { name: 'Postmark', ptrSuffixes: ['.mtasv.net'] },
  { name: 'HubSpot', ptrSuffixes: ['.hubspotemail.net'] },
  { name: 'Salesforce / Pardot', ptrSuffixes: ['.exacttarget.com', '.mcsignup.com', '.pardot.com', '.salesforce.com'] },
  { name: 'Zendesk', ptrSuffixes: ['.zendesk.com'] },
  { name: 'Intuit / QuickBooks', ptrSuffixes: ['.intuit.com', '.notification.intuit.com'] },
  { name: 'Xero', ptrSuffixes: ['.xero.com'] },
  { name: 'Sage', ptrSuffixes: ['.sage.com', '.sagenotifications.com'] },
  { name: 'DocuSign', ptrSuffixes: ['.docusign.net', '.docusign.com'] },
  { name: 'GoCardless', ptrSuffixes: ['.gocardless.com'] },
  { name: 'Stripe', ptrSuffixes: ['.stripe.com'] },
  { name: 'Zoho', ptrSuffixes: ['.zoho.com', '.zohomail.com'] },
  { name: 'Constant Contact', ptrSuffixes: ['.constantcontact.com', '.ccsend.com'] },
  { name: 'Klaviyo', ptrSuffixes: ['.klaviyomail.com'] },
  { name: 'ActiveCampaign', ptrSuffixes: ['.acems1.com', '.emsend1.com', '.activehosted.com'] },
  { name: 'Mimecast', ptrSuffixes: ['.mimecast.com'] },
  { name: 'Proofpoint', ptrSuffixes: ['.pphosted.com', '.ppe-hosted.com'] },
  { name: 'Barracuda', ptrSuffixes: ['.barracudanetworks.com', '.ess.barracudanetworks.com'] },
  { name: 'Apple iCloud', ptrSuffixes: ['.icloud.com', '.apple.com'] },
  { name: 'Yahoo / AOL', ptrSuffixes: ['.yahoo.com', '.yahoodns.net', '.aol.com'] },
  { name: 'OVH', ptrSuffixes: ['.ovh.net', '.mail-out.ovh.net'] },
  { name: 'Ionos (1&1)', ptrSuffixes: ['.kundenserver.de', '.perfora.net', '.ionos.co.uk', '.ui-portal.com'] },
  { name: 'Heart Internet / Krystal', ptrSuffixes: ['.hosts.co.uk', '.krystal.uk'] },
  { name: 'Fasthosts', ptrSuffixes: ['.fasthosts.co.uk', '.livemail.co.uk'] },
  { name: 'Atlassian', ptrSuffixes: ['.atlassian.net', '.atlassian.com'] },
  { name: 'GitHub', ptrSuffixes: ['.github.com', '.github.net'] },
  { name: 'Freshworks', ptrSuffixes: ['.freshemail.io', '.freshworks.com'] },
  { name: 'Meta / Facebook', ptrSuffixes: ['.facebook.com', '.facebookmail.com'] },
  { name: 'LinkedIn', ptrSuffixes: ['.linkedin.com'] },
];

export interface SenderClass { name: string; known: boolean; ptr: string; }

// Per-process PTR cache so a big ingest run doesn't hammer resolver lookups.
const ptrCache = new Map<string, string>();

export async function reverseLookup(ip: string): Promise<string> {
  const hit = ptrCache.get(ip);
  if (hit !== undefined) return hit;
  let ptr = '';
  try {
    const names = await dns.reverse(ip);
    ptr = (names && names[0]) ? names[0].toLowerCase().replace(/\.$/, '') : '';
  } catch { /* no PTR */ }
  // Cap the cache so a long-lived process can't grow it unbounded.
  if (ptrCache.size > 5000) ptrCache.clear();
  ptrCache.set(ip, ptr);
  return ptr;
}

export function classifyPtr(ptr: string, ip: string): SenderClass {
  const p = (ptr || '').toLowerCase();
  if (p) {
    for (const s of KNOWN_SENDERS) {
      if (s.ptrSuffixes.some((suf) => p === suf.slice(1) || p.endsWith(suf))) {
        return { name: s.name, known: true, ptr: p };
      }
    }
    return { name: p, known: false, ptr: p };
  }
  return { name: ip, known: false, ptr: '' };
}

export async function classifySender(ip: string): Promise<SenderClass> {
  const ptr = await reverseLookup(ip);
  return classifyPtr(ptr, ip);
}
