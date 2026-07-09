// App version + changelog. Bump APP_VERSION and prepend a new CHANGELOG entry on each release.
// Minor work accumulates under the current version; ship a new MAJOR (v2, v3…) after a big batch.
export const APP_VERSION = 'v1.51';

export interface ChangelogGroup { area: string; items: string[]; }
export interface ChangelogEntry {
  version: string;
  date: string;        // ISO date of the release
  title: string;
  groups: ChangelogGroup[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: 'v1.51',
    date: '2026-06-25',
    title: 'Claude voice-to-message, office TV Ops Board, and support-team tweaks',
    groups: [
      { area: 'Productivity', items: [
        'Dictate a reply and Polish with Claude: voice-to-text in the browser, then Claude tidies rough notes into a complete, ready-to-send message (greeting, body, sign-off).',
        'Claude API key + model managed in Settings > Integrations (key here overrides the server .env).',
      ] },
      { area: 'Office TV Ops Board', items: [
        'Full-screen wallboard at /tv for the office TV: open UniFi/Giacom alerts, website stats, and new + unassigned cases.',
        'Case-load stats: cases this month, new per hour, closed per hour, live open and unassigned.',
        'Fast auto-refresh, a bing-bong on a new alert, and a sound on/off toggle. Overview only - no engineer diary.',
      ] },
      { area: 'Support-team tweaks', items: [
        'Case type no longer defaults to a value - the engineer must choose, with an info button explaining each type (ITIL).',
        'Reply composer opens at double height and grows with the content.',
        'E-Recycling: the item list is now compact rows with photos hidden until an item is opened.',
        'E-Recycling: submitting a collection to the recycler is desktop-only (removed from the mobile app).',
      ] },
    ],
  },
  {
    version: 'v1.5',
    date: '2026-06-24',
    title: 'IT & Cloud billing overhaul, product standardisation, E-Recycling, mobile + housekeeping',
    groups: [
      { area: 'IT & Cloud billing', items: [
        'Part-month proration: a new service\'s first invoice bills the full advance month PLUS a separate, clearly-labelled part-month catch-up line (services in advance, changes in arrears).',
        'Billing period pinned to the month billed in advance; established customers bill flat with no double-charge.',
        'Numberless staging — drafts carry no invoice number until "Complete run" numbers them, emails finance, pushes QuickBooks and submits Direct Debit.',
        'Complete run shows an invoice date / due date and a per-customer IT-Services vs Cloud split.',
      ] },
      { area: 'Catalogue & QuickBooks safeguards', items: [
        'Flag for invoice services that don\'t match the product catalogue (and so won\'t map to a QuickBooks item or reporting) — shown on the customer Cloud tab and the Bureau cockpit.',
        'Complete run is blocked when an invoice has unmatched services, with a deliberate "complete anyway" override.',
        'Synced Giacom lines now carry their catalogue product, so they map to the right QuickBooks item and reporting category.',
        'Standardised base-service names across rate cards and templates; added Business Endpoint Protection, Acronis M365 Backup, Advanced Business Protection and Secure Guard.',
      ] },
      { area: 'Customers', items: [
        'Delete (recycle) an IT & Cloud rate-card template, with a warning when the customer has synced Giacom services.',
        'Primary contact set to the principal across all customers; account numbers backfilled and capitalised.',
        'Invoices resolve the billing address from the customer record (cleaner, de-duplicated).',
      ] },
      { area: 'E-Recycling (new)', items: [
        'New Bureau tool to audit end-of-life IT kit — any equipment, with photos, make/model/serial, condition and notes.',
        'Build a collection batch, then submit a branded PDF manifest (with photos) by email to the e-waste firm.',
        'Available on the mobile field app (/m) with camera-first multi-photo capture.',
      ] },
      { area: 'Housekeeping', items: [
        'About page now shows a live count of the lines of code that make up the portal.',
        'Red price-increase notice on invoices (for the July Microsoft increase).',
        'Regenerate-invoice option added to the invoice actions menu.',
      ] },
    ],
  },
  {
    version: 'v1.4',
    date: '2026-06-23',
    title: 'First full release — legacy PHP/MySQL app rebuilt on the modern stack',
    groups: [
      { area: 'Platform & migration', items: [
        'Rebuilt the legacy PHP/MySQL portal on Node + TypeScript + PostgreSQL (same stack as Insights).',
        'Live on portal.lumenmsp.co.uk via PM2 + Nginx; data migrated module-by-module from MySQL.',
        'Grouped sidebar navigation, rich dashboard, global recycle bin.',
      ] },
      { area: 'Customers & CRM', items: [
        'Customer 360 — contacts, sites, domains, services and contracts in one view.',
        'Leads and Tasks; reminders for tasks and review follow-ups.',
        'Products & services catalogue shared across quotes and invoices.',
      ] },
      { area: 'Quotes & invoices', items: [
        'Quotes with PDF generation, profit view, send + public accept/reject.',
        'Invoices linked to quotes, copy/duplicate, IT and CS numbering schemes.',
        'GoCardless Direct Debit invite flow; QuickBooks invoice + payment sync.',
        'Outbound customer emails standardised to 11pt.',
      ] },
      { area: 'Helpdesk & multichannel', items: [
        'Tickets/Helpdesk with LITS- numbering, departments, priorities and escalation.',
        'One case, three channels — Email, Microsoft Teams and WhatsApp from a single composer.',
        'Rich-text composer with attachments; channel chips on every message.',
        'Inbound mail sync (multi-mailbox Graph), auto-ack with loop prevention, spam list, per-sender circuit breaker, processed mail moved to Imported.',
        'Unknown-sender workflow to link or create a client.',
      ] },
      { area: 'Comms & billing (Bureau)', items: [
        'Comms Bill Run — allocate CLIs, cost services, review by category, produce draft invoices.',
        'Package Manager hides wholesale cost behind a set sell price (Simply VoIP seats, recording, mobile).',
        'Purchase Ledger — receipts/supplier invoices in, auto-match to bank transactions, branded report.',
        'Bill-run lines show unit cost and number of units.',
      ] },
      { area: 'Insights — call analytics', items: [
        'Full Insights platform migrated into the portal under /insights, page-for-page.',
        'Visual report-config builder (source-of-truth, hunt groups, call flow, IVR options).',
        'Tollring/iCalls sync, number lookup, per-customer admin (sites, users, CSV import, data manager).',
        'Scheduler auto-generates and emails reports on schedule; manual generate is review-only with a Send step.',
      ] },
      { area: 'N3twrx — network monitoring', items: [
        'UniFi (Site Manager API + Alarm Manager webhook) and Giacom comms-status alerts.',
        'In-portal pop-up + 4-second siren on a site-down, coloured open-alert badge on the nav.',
        'UniFi alerts auto-clear on recovery; ticket creation is a manual option.',
      ] },
      { area: 'Voice & website chat', items: [
        'WhatsApp softphone built into the portal — answer and call back customers (WebRTC).',
        '"Call on WhatsApp" button on the ticket hero bar.',
        'Website chat bot with a real-time agent console; create quote/lead/ticket from a chat.',
      ] },
      { area: 'Mobile field app', items: [
        'Slim task-first PWA at /m, wrapped as an Android app and deployed via Intune (managed Google Play).',
        'Home, Support, Customers, Receipt and Tasks tabs; receipt logger with in-app camera.',
        'Directory dialling withholds caller ID (141); tickets render rich like the web.',
      ] },
      { area: 'Security & infrastructure', items: [
        'CSRF protection, HTML sanitisation, security headers; clean RoboShadow scan.',
        'Encrypted database + file backups to Azure; 3-tier backup topology.',
        'Microsoft SSO + bcrypt local login; activity and login-attempt logging.',
      ] },
    ],
  },
];
