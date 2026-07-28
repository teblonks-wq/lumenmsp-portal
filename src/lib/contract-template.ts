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

export const DEFAULT_MSA_SECTIONS: TemplateSection[] = [
  {
    key: 'confidential',
    heading: 'Confidential statement',
    body:
      'The contents of this document are confidential and are intended exclusively for the prospective customer. ' +
      'Distribution or sharing of this information with persons or entities for which it is not intended is prohibited, ' +
      'in any form, without the express written consent of Lumen IT Solutions.',
  },
  {
    key: 'introduction',
    heading: 'Introduction',
    body:
      'This Service Agreement sets out the terms under which Lumen IT Solutions Limited ("Supplier") will provide IT, ' +
      'Cloud, and Communications services to the Client. This document outlines the scope of services, SLAs, ' +
      'responsibilities, and fees associated with our support and service offerings.',
    needsReview: true,
    note:
      'This paragraph promises "SLAs", but the agreement contains no SLA table — only the channel response times in ' +
      'Support Methods. Either add an SLA section or reword this sentence.',
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
      '- Phone: 09:00–17:00 — 0333 335 0170 — response 15–60 minutes\n' +
      '- Email: sp@lumensolutions.co.uk — response 1 hour during office hours\n' +
      '- WhatsApp / Microsoft Teams: general queries or minor issues — response 15–60 minutes during office hours\n' +
      '- Support Portal: https://sp.lumensolutions.co.uk — submit and track support requests online\n\n' +
      'Important: communication outside of these channels (e.g. personal numbers or social media) is not monitored and ' +
      'will fall outside of contracted support terms.',
    needsReview: true,
    note:
      'Support hours contradict the IT Services inclusions, which advertise an unlimited helpdesk 08:00–18:00 while this ' +
      'section says phone support runs 09:00–17:00. Both appear in the same agreement. Pick one.',
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
    needsReview: true,
    note:
      'The manual template opened this section with the Supplier Responsibilities sentence — "The supplier will maintain, ' +
      'and support business IT system used by the client. Additionally, the supplier will:" — above a list of client ' +
      'obligations. Reworded to address the client. Confirm the new wording reads as you intend.',
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
  legalName: 'Lumen IT Solutions Limited',
  address: 'Gemini House, Hargreaves Road, Groundwell Industrial Estate, Swindon, Wiltshire',
  postcode: 'SN25 5AZ',
  serviceContact: 'Terry O’Kelly — Managing Director',
  phone: '0333 335 0170',
  web: 'www.lumensolutions.co.uk',
};
