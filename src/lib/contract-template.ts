// ─────────────────────────────────────────────────────────────────────────────
// Multi Service Agreement — boilerplate template.
//
// Roughly 70% of the MSA is wording that never varies by customer. It lives here as
// ordered sections rather than in a Word file, so it is changed once and every future
// agreement picks it up. Per-customer data (parties, term, priced lines, signatures)
// is merged in at render time by contract-doc.ts.
//
// `needsReview` marks wording carried over from the manual template that contradicts
// itself or is incomplete. Those flags surface in the staff editor as a banner — they
// are deliberately NOT silently "fixed", because the correct answer is a business
// decision, not a formatting one.
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateSection {
  key: string;
  heading: string;
  body: string;           // simple markup: paragraphs separated by blank lines, "- " for bullets
  needsReview?: boolean;
  note?: string;          // shown to staff next to the review flag
}

export const MSA_TEMPLATE_CODE = 'msa';

// Bump whenever DEFAULT_MSA_SECTIONS changes. The template is stored in the database once
// seeded, so without this a wording fix would sit in the code and never reach production.
// loadTemplate() refreshes a stored template whose version is behind this number.
//   1 — initial
//   2 — Service Levels section added; phone hours corrected to 08:00–18:00; Client
//       Responsibilities reworded to address the client (all three review flags resolved)
export const MSA_TEMPLATE_VERSION = 2;

export const DEFAULT_MSA_SECTIONS: TemplateSection[] = [
  {
    key: 'confidential',
    heading: 'Confidential statement',
    body:
      'The contents of this document are confidential and are intended exclusively for the customer named in this ' +
      'agreement. Distribution or sharing of this information with persons or entities for which it is not intended ' +
      'is prohibited, in any form, without the express written consent of Lumen IT Solutions.',
  },
  {
    key: 'introduction',
    heading: 'Introduction',
    body:
      'This Service Agreement sets out the terms under which Lumen IT Solutions Limited ("Supplier") will provide IT, ' +
      'Cloud, and Communications services to the Client. This document outlines the scope of services, service levels, ' +
      'responsibilities, and fees associated with our support and service offerings.',
  },
  {
    // Resolves the old contradiction: the introduction promised "SLAs" while the agreement held
    // only channel response times. These ARE those response times, stated as a service level —
    // no new commitment, just presented as what the introduction says it is.
    key: 'service_levels',
    heading: 'Service Levels',
    body:
      'Support is available on every contracted channel from 08:00 to 18:00, Monday to Friday, excluding public holidays. ' +
      'The targets below are response times — the time within which a request is acknowledged and work begins. They are ' +
      'not resolution times, which vary with the nature of the fault.\n\n' +
      '- Telephone (0333 335 0170) — response within 15–60 minutes\n' +
      '- Email (sp@lumensolutions.co.uk) — response within 1 hour\n' +
      '- WhatsApp / Microsoft Teams — response within 15–60 minutes\n' +
      '- Support Portal (https://sp.lumensolutions.co.uk) — response within 1 hour\n\n' +
      'Requests raised outside these hours are responded to from the start of the next working day. Out-of-hours ' +
      'support is available at the rates set out under Additional fees.',
  },
  {
    key: 'updates',
    heading: 'Contract Updates & Service Changes',
    body:
      'This contract document will be maintained as your services evolve, increase, and decrease in quantity and value ' +
      'through the long term of the relationship. We reserve the right to use verified digital communication for ' +
      'extensions and expansions of your services, such as increasing and decreasing licences for Microsoft products.\n\n' +
      'Verified digital communication includes:\n\n' +
      '- Email correspondence\n' +
      '- Helpdesk interactions\n' +
      '- Confirmed meeting minutes\n\n' +
      'Lumen IT Solutions will always take care to avoid over-purchasing and will make reasonable steps to prevent ' +
      'long-term over-subscription.',
  },
  {
    key: 'exclusions',
    heading: 'Exclusions',
    body:
      'As this agreement is written in a spirit of partnership, the supplier will always make the best possible efforts ' +
      'to provide support and rectify problems as requested.\n\n' +
      'However, this agreement only applies within the service level guidance above and for the hardware and services specified.\n\n' +
      'Additionally:\n\n' +
      '- This contract does not cover problems caused by using equipment, software or services in a way that is not recommended.\n' +
      '- If this client has made unauthorised changes to the configuration or setup of equipment, software or services this agreement may not apply.\n' +
      '- If this client has prevented the supplier performing maintenance or upgrades, there may be a delay in resolving issues.\n\n' +
      'This contract does not apply to circumstances that could be considered beyond the supplier’s control, for instance: ' +
      'floods, wars, acts of god and so on.\n\n' +
      'This contract will not apply if the client fails to pay the supplier invoices before the due date.\n\n' +
      'Having said that, Lumen IT Solutions will always aim to be helpful and accommodating at all times, and will do its ' +
      'absolute best to assist the client wherever possible.',
  },
  {
    key: 'supplier_responsibilities',
    heading: 'Supplier Responsibilities',
    body:
      'The supplier will maintain and support the business IT systems used by the client.\n\n' +
      'Additionally, the supplier will:\n\n' +
      '- Ensure all relevant software, services and equipment are available to the client in line with the Service Level Agreement (SLA) included in this contract.\n' +
      '- Respond to support requests as described in this service contract, in the times specified, in any case.\n' +
      '- Maintain good communication with the client at all times.\n' +
      '- Ensure backups are taken and tested in accordance with the business backup procedure.\n' +
      '- Monitor and maintain server uptime.',
  },
  {
    key: 'support_methods',
    heading: 'Support Methods (Contracted Channels Only)',
    body:
      'The following support channels are included in your service agreement and should be used for all support-related ' +
      'communication. Use of these methods ensures proper ticket tracking and SLA coverage.\n\n' +
      '- Phone: 08:00–18:00 — 0333 335 0170 — response 15–60 minutes\n' +
      '- Email: sp@lumensolutions.co.uk — response 1 hour\n' +
      '- WhatsApp / Microsoft Teams: general queries or minor issues — response 15–60 minutes\n' +
      '- Support Portal: https://sp.lumensolutions.co.uk — submit and track support requests online\n\n' +
      'Important: communication outside of these channels (e.g. personal numbers or social media) is not monitored and ' +
      'will fall outside of contracted support terms.',
  },
  {
    key: 'client_responsibilities',
    heading: 'Client Responsibilities',
    body:
      'The client will co-operate with the supplier in the maintenance and support of the business IT systems covered by this agreement.\n\n' +
      'Additionally, the client will:\n\n' +
      '- Notify the supplier of issues and problems in a timely manner.\n' +
      '- Provide the supplier with access to equipment, software and services for maintenance, upgrades and fault prevention.\n' +
      '- Keep the supplier informed of potential changes to the IT system. For instance, if a member of staff needs remote access or their access level has changed.\n' +
      '- Maintain good communication with the supplier at all times.',
  },
  {
    key: 'additional_fees',
    heading: 'Additional fees',
    body:
      '- Out of hours remote support — £125.00 per hour, minimum 1 hour\n' +
      '- Project labour — £125.00 per hour, minimum 30 minutes\n' +
      '- Onsite out of hours support — £150.00 per hour, minimum 1 hour',
  },
  {
    key: 'caveats',
    heading: 'Caveats',
    body:
      'The supplier has agreed that if the service provided is of poor quality and does not meet the level of service ' +
      'promised, the customer will be allowed to break the contract if a reasonable resolution cannot be found.',
  },
];

// Inclusion bullets for the narrative service blocks. These sit above the priced tables
// in the document and describe what the service covers.
export const DEFAULT_SERVICE_BLURBS: Record<string, { title: string; intro?: string; bullets: string[] }> = {
  IT: {
    title: 'IT Services',
    intro: 'Business Managed Support: All-Inclusive Proactive IT Management',
    bullets: [
      '24/7 smart monitoring with auto-healing for critical systems',
      'Unlimited Helpdesk (08:00–18:00)',
      'Unlimited onsite support (Call-out: £0.60/mile)',
      'Fully managed antivirus and threat detection',
      'Microsoft 365 & Cloud Services Support',
      'Patch management & health checks',
      'Unlimited workshop services (e.g. new computer builds)',
      'Regular IT reviews and planning sessions',
      'Documentation of systems and credentials',
      'Cybersecurity annual assessment',
      'Third-party vendor coordination',
      'Preferred project rates',
    ],
  },
  Cloud: {
    title: 'Cloud Services',
    intro: 'Microsoft 365 Licensing & Services',
    bullets: [
      'Licence provisioning and account setup',
      'Ongoing user management',
      'Email routing, aliasing, SPF, DKIM, and security configuration',
      'M365 Security Monitoring (Defender, Entra Policies)',
      'Liaison with Microsoft on escalations',
    ],
  },
  Backup: {
    title: 'Acronis Backup Solutions',
    intro: 'Lumen IT Solutions offers comprehensive backup solutions through our Acronis Cyber Protect platform.',
    bullets: [
      'Daily automatic cloud backups',
      'Granular recovery of emails, files, databases',
      'Ransomware protection & alerting',
      'Managed retention policies',
      'Fully managed by Lumen support team',
    ],
  },
  Comms: { title: 'Communications Services', bullets: [] },
  Hardware: { title: 'Hardware', bullets: [] },
};

// Supplier party block — single source of truth. The manual template disagreed with itself:
// the cover page footer still carried the old 54 Base Point Business Centre / SN5 7EX address
// and the lumenitsolutions.co.uk domain, while inner pages used Gemini House / SN25 5AZ.
export const SUPPLIER = {
  // The CONTRACTING party is the limited company; LumenMSP is the trading name it is branded
  // under. Both must appear — the customer signs with the brand they recognise, but the
  // agreement has to name the legal entity to be enforceable against it.
  brand: 'LumenMSP',
  legalName: 'Lumen IT Solutions Limited',
  tradingAs: 'Lumen IT Solutions Limited, trading as LumenMSP',
  address: 'Gemini House, Hargreaves Road, Groundwell Industrial Estate, Swindon, Wiltshire',
  postcode: 'SN25 5AZ',
  serviceContact: 'Terry O’Kelly — Managing Director',
  phone: '0333 335 0170',
  email: 'back.office@lumensolutions.co.uk',
  web: 'www.lumensolutions.co.uk',
  companyNumber: '14951068',
  vatNumber: '443375688',
  // Matches the footer already used on invoice PDFs, so every document the customer receives
  // carries identical legal wording.
  tradingStatement:
    'LumenMSP is a trading name of Lumen IT Solutions Limited. Registered in England & Wales · ' +
    'Company No. 14951068 · Gemini House, Hargreaves Road, Groundwell Industrial Estate, Swindon, SN25 5AZ',
};


// ─────────────────────────────────────────────────────────────────────────────
// Extension document. An extension must not restate the agreement — it continues it.
// The wording below is what carries the original terms forward, so the signed extension
// and the original are read together rather than the extension replacing anything.
// ─────────────────────────────────────────────────────────────────────────────
export const EXTENSION_SECTIONS: TemplateSection[] = [
  {
    key: 'extension_continuation',
    heading: 'Continuation of agreement',
    body:
      'This document extends the Multi Product — Service Contract already in place between the parties named below. ' +
      'It is to be read together with that agreement and does not replace it.\n\n' +
      'All services, pricing, responsibilities, support levels, exclusions and terms of the original agreement ' +
      'continue on the same terms for the duration of the extended term set out below.\n\n' +
      'Where a line in the schedule below shows a revised quantity or price, that line supersedes the equivalent line ' +
      'in the original agreement from the start of the extended term. Every other part of the original agreement ' +
      'continues unchanged and is not varied by this extension.',
  },
  {
    key: 'extension_notice',
    heading: 'Notice and further renewal',
    body:
      'At the end of the extended term this agreement continues to renew on the same basis as the original agreement, ' +
      'unless notice is given in accordance with the notice period stated below.',
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// Template changelog. An extension says the agreement "continues on the same terms" — so if
// the standard wording has moved since the original was signed, the extension has to say so.
// Silently extending onto changed wording is exactly the trap the Staybrook amendment fell
// into: two documents, no record of what differed.
//
// Add an entry whenever MSA_TEMPLATE_VERSION is bumped. Entries render on extension documents
// under "Wording changes since your original agreement".
// ─────────────────────────────────────────────────────────────────────────────
export interface TemplateChange {
  version: number; date: string;
  items: { heading: string; detail: string; kind: 'improvement' | 'clarification' }[];
}

export const TEMPLATE_CHANGELOG: TemplateChange[] = [
  {
    version: 2,
    date: '2026-07-28',
    items: [
      {
        // The one that genuinely increases what the customer gets — two extra hours of phone
        // cover per day, at no extra cost. Led with, and labelled as such.
        kind: 'improvement',
        heading: 'Longer telephone support hours',
        detail:
          'Telephone support now runs 08:00–18:00, two hours longer each day than the 09:00–17:00 previously ' +
          'stated, bringing it in line with the unlimited helpdesk hours already listed in your inclusions. ' +
          'There is no change to your monthly cost.',
      },
      {
        kind: 'improvement',
        heading: 'Response times now committed in writing',
        detail:
          'Your response-time targets are set out as their own Service Levels section rather than being implied ' +
          'by the support channel list — 15–60 minutes by telephone and messaging, one hour by email and portal. ' +
          'The targets are unchanged; they are now something you can hold us to.',
      },
      {
        kind: 'clarification',
        heading: 'Client Responsibilities',
        detail:
          'This section previously opened with a sentence describing the supplier\'s obligations rather than the ' +
          'client\'s. It now addresses the client. The obligations listed beneath it are unchanged.',
      },
    ],
  },
];
