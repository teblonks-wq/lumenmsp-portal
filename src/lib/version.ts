// App version + changelog. Bump APP_VERSION and prepend a new CHANGELOG entry on each release.
// Minor work accumulates under the current version; ship a new MAJOR (v2, v3…) after a big batch.
export const APP_VERSION = 'v4.0';

export interface ChangelogGroup { area: string; items: string[]; }
export interface ChangelogEntry {
  version: string;
  date: string;        // ISO date of the release
  title: string;
  groups: ChangelogGroup[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: 'v4.0',
    date: '2026-08-06',
    title: 'RMM: the LumenMSP Agent, Cyber Essentials, patching, software & servers — plus the V4 look, VoiceBox and the Finance Agent',
    groups: [
      { area: 'Remote monitoring & management — NEW (Admin → Agents / Assets)', items: [
        'The LumenMSP Agent for Windows (and Linux): reports system info to the Portal, carries end-user chat to the helpdesk, and gives engineers a real remote toolbox on the asset page — a live terminal, cached software inventory with install/uninstall, services, local and Active Directory users, a file browser, registry editor and file transfer.',
        'Self-updating and safe to ship: one version source, signed MSI, SHA-256 verified before install, and a staged rollout in rings (internal → pilot → everyone) with per-device "Update now" and a Halt button.',
        'Discovery + deploy: the server console finds the unmanaged Windows machines on a customer\'s network and installs the agent over WinRM with per-host progress, generating a GPO where WinRM is off — so nothing is forced.',
        'Remote control rides along: MeshCentral is installed at enrolment, so a new machine is reachable from the moment it appears; every session is recorded and kept 60 days under Admin → Remote Sessions.',
        'Asset Manager: real hardware detail per device, an assigned-user picker, and a jump straight from a case to the machine it is about — agent devices and RMM assets kept as separate sources, joined only at the point of display.',
      ] },
      { area: 'Cyber Essentials — NEW (Admin → Cyber Essentials)', items: [
        'Assess one machine, one customer or the whole estate against the five controls. The agent gathers the evidence; the Portal makes every judgement, so tightening the standard never touches a customer machine.',
        'Every finding comes with the fix — the report is a work-list, not a score card — grouped so the same failure on eight machines reads as one job.',
        'End-of-life list auto-synced nightly from endoflife.date (hand-added rows are never overwritten), and full scan history with a score-over-time trend per customer.',
      ] },
      { area: 'Patching & software estate — NEW (Admin → Patching / Software)', items: [
        'Pending Windows Updates across every managed machine — what is missing, how long it has been missing, and which machines are waiting on a restart — with maintenance-window policies and manual deploy. Nothing is ever rebooted automatically.',
        'The whole software estate grouped by title: how many installs, what is behind (per machine, via WinGet or Chocolatey) and what is out of support — with one button to update a title across the estate, a customer or selected machines.',
      ] },
      { area: 'Servers — NEW (Admin → Servers)', items: [
        'Active Directory, SQL, Hyper-V, DNS, DHCP, IIS, shares, certificates and disk on every server running the agent — replication failures, stale accounts, backup dates, checkpoints and expiring certificates surfaced with plain judgements.',
      ] },
      { area: 'Look & feel — the V4 refresh', items: [
        'Three per-user themes on a Theme button: Aurora (light, brand glow), Carbon (dark) and Solstice (editorial light). Every page is built from one shared token set, so the whole estate reads as one product and inherits all three.',
        'Zoom-proof navigation, highlighted search, and a new Design system reference (Admin → Design system) documenting the tokens, components, data ramps and the software/Microsoft logo rules.',
      ] },
      { area: 'Calls & Insights', items: [
        'VoiceBox — NEW: voicemail transcription (Whisper) into the helpdesk, with departments, audit and a check-now.',
        'Site logic is the boundary end-to-end: per-contact site scoping on OneBoard, the Wallboard and my-insights; call-flow counted once per call (a queue hop no longer double-counts); a guard against comparing against stale data.',
        'Ask Claude on a ticket: whole-case Q&A that reads the hidden email text and jumps you to the moment in the timeline.',
        'Number Lookup made trustworthy: reverse-lookup results refresh on a 10-minute sync with an admin "update now", so a caller\'s name is current rather than cached.',
      ] },
      { area: 'Support & helpdesk', items: [
        'Helpdesk Review: an oldest-first walk through open cases with the full activity of each case mirrored read-only alongside — for clearing the tail without opening every ticket.',
        'Claude picks the support category on a new case (from email or a message), and a reply is held until the category is set; a recurring issue is flagged towards a problem record.',
        'Per-message Reply and Forward on every case; the Messages inbox now carries an Agent channel, so a reply reaches the machine the person is sitting at.',
      ] },
      { area: 'Sales & quotes', items: [
        'Quotes gained real throughput: duplicate a quote, bulk-convert accepted quotes to invoices, bulk mark lost or delete, and an "invoiced" status so a converted quote is unmistakable.',
      ] },
      { area: 'Marketing', items: [
        'Mass Mailer: default-domain campaigns with a Claude-drafted message and a "Data missing" sheet that shows exactly which customers can\'t be reached and why.',
      ] },
      { area: 'Finance', items: [
        'Finance Agent: an Ask-Claude on the invoice and case pages for billing questions — live GoCardless payment checks, credits, sibling invoices and the customer thread, in one place.',
        'GoCardless payout reconciliation fixed and back-filled, so outstanding balances reflect money actually collected.',
      ] },
      { area: 'Website', items: [
        'Rebuilt remote-support page: detects the caller\'s operating system and walks them through exactly what will happen on Windows, Mac or Linux — a run-once session that leaves nothing behind.',
      ] },
    ],
  },
  {
    version: 'v3.0',
    date: '2026-07-09',
    title: 'Domain Health (LITS-DMARC), Insights reporting rebuilt, payment authority, Socials Studio & platform refresh',
    groups: [
      { area: 'Domain Health — NEW (Admin → Domain Health)', items: [
        'LITS-DMARC: per-domain email-security monitoring — DMARC aggregate reports collected to our mailbox, ingested every 30 minutes, with sending sources, alignment rates, SLA and daily volume per customer domain.',
        'Setup checklist with live ✓/✖ per record: SPF, DKIM (real key detection incl. selectors seen in reports, key size, revoked keys), DMARC vs an agreed target policy (p=none/quarantine/reject dropdown), MX, Autodiscover and Intune CNAMEs — with copy-host/copy-value buttons and a step-by-step DKIM setup lightbox per mail provider.',
        'Domain info panel: registrar, Nominet IPS TAG, likely owner, registered/expiry dates (60-day renewal badge), nameservers and detected DNS manager (20i/Stack and ~20 others) with a console link.',
        'Microsoft 365 verification: when M365 hosts the mail, the full Microsoft DNS set is demanded — including SPF containing spf.protection.outlook.com.',
        'Daily 06:15 + post-boot sweep re-checks every monitored domain identically; DMARC data feeds the monthly IT Snapshot\'s email-security section automatically.',
        'Customer domains drive everything: Domain Health suggestions and the IT report\'s DNS checks now resolve from the customer record\'s domains (config fields demoted to fallback).',
      ] },
      { area: 'Insights reporting', items: [
        'ONE renderer: scheduled emails, manual generates and the Run tab all use the template/modules pipeline — UK times, Answered-by column and every configured section (a legacy renderer had been sending customers UTC-shifted, cut-down reports).',
        'Business hours enforced 100%: staff, outbound and voicemail figures (and the CSV) can no longer include out-of-hours calls.',
        'Staff table always reconciles with the scorecard — active extensions missing from the site\'s staff list are surfaced in a footnote; "Passed On" fixed to count real hand-offs, not same-group retries.',
        'Generate fixes: multi-day selection works, Send names exactly who received each report (and only marks sent when it truly went), report schedules can be deleted, and the config page warns that call-flow logic lives on the SITE.',
        'New send-daily-range script emails a backdated run of dailies in one command.',
      ] },
      { area: 'Invoicing & payments', items: [
        'Payment authority settled: GoCardless payout status marks DD invoices paid (with the payout\'s bank reference + date stored and printed on the invoice); QuickBooks payment sync handles bank-transfer invoices ONLY and can never touch a GoCardless-managed invoice.',
        'Back-link tool matches GoCardless payments to invoices imported without a GC reference (exact amount per mandate), then flips paid-out ones immediately.',
      ] },
      { area: 'Support & comms', items: [
        'Composer: one context-aware ✨ Claude button (Polish merged in), 📄 insert-template dropdown with a managed template library (incl. Microsoft Bookings sync — a template per bookable service), 🔗 labelled links, and an 👥 All-contacts button for bulk notices.',
        'Create a case straight from a WhatsApp/Teams message — not just tag to an existing one.',
        'New customer portal access level: Support & Insights (all company tickets + call insights, nothing financial).',
      ] },
      { area: 'Marketing — Socials Studio (rebuilt)', items: [
        'Stateless 4-step studio: source URLs + notes + Lumen\'s take → Claude writes one substantial plain-English article for end users plus LinkedIn/Facebook teasers → preview and push the article live to lumenmsp.co.uk/news instantly (no site rebuild) → push socials to Buffer now or scheduled, with the article link and hero photo attached.',
        'Free stock-photo picker (Pexels) with Claude-suggested searches; the website news page shows live articles at the top automatically.',
      ] },
      { area: 'Platform', items: [
        'Whole-portal readability pass: modern type scale everywhere (16px-era text, bigger tables, buttons and headings).',
        'Bookmarks dropdown on the dashboard (managed in Settings), shared staff quick-links.',
        'Staff user sync with Microsoft 365 — matches on Entra ID so name and domain changes update in place; leavers deactivate automatically.',
        'Codebase now on GitHub with one-button deploys that commit + push automatically.',
      ] },
    ],
  },
  {
    version: 'v2.0',
    date: '2026-07-07',
    title: 'Insights becomes part of the Portal, customer portal, unified comms inbox & monthly IT reports',
    groups: [
      { area: 'Insights — one platform', items: [
        'The standalone Insights app was retired: call analytics, dashboards, report templates and the report scheduler now live inside the Portal at /insights, against the same customer records.',
        'Same-day security hardening: per-site data scoping enforced end-to-end (cross-company bleed audit), legacy CSV import removed estate-wide, and report/sync jobs consolidated so only one scheduler can ever email customers.',
        'Tollring call sync runs hourly into the Portal; call-flow logic moved to one-logic-per-site.',
      ] },
      { area: 'Customer portal (/my)', items: [
        'Customers sign in to the Portal itself (Microsoft SSO from their own tenant) with per-contact access levels — tickets-only, finance, service or full.',
        'Self-service tickets (raise + track), invoices and quotes, their own call-insights reports, and monthly IT report copies.',
        'Read-only bookkeeper portal: external Microsoft login scoped to an expenses dashboard.',
      ] },
      { area: 'Unified comms', items: [
        'One messaging inbox for website chat, WhatsApp Business and Teams — per-message case tagging, WhatsApp template sending and a composer with loud new-message notifications.',
        'WhatsApp softphone: browser calling via the WhatsApp Business Calling API with call history.',
        'Claude auto-picks the support category on new tickets (email and message-created), left blank when unsure so a human decides before work starts.',
      ] },
      { area: 'Monthly IT reports', items: [
        'IT Operations & Security Snapshot per customer: Intune devices/compliance, Secure Score, live DNS checks, helpdesk stats and vulnerability figures auto-filled, SDM running notes consolidated by Claude into polished narrative.',
        'Runs automatically at 00:00 on the 1st (review-before-send per customer), with a 3-day staff reminder to finalise notes.',
      ] },
      { area: 'Marketing & web', items: [
        'Website live chat with staff console; marketing area with website stats (page views, visitors, live-now).',
        'Social content pipeline v1: Claude-drafted multi-network posts pushed to Buffer on a schedule.',
      ] },
    ],
  },
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
