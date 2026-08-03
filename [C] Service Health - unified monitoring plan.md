# [C] Service Health — unified monitooring surface (plan)

*Drafted 2026-08-03 with Claude, after the MSP360/Acronis/Azure backup build. Status: agreed direction, phased delivery.*

## The principle

Every monitored service element is accessible **on the customer** and **on the asset**, wherever it is relevant — one place to look per entity, regardless of which tool produces the data. The Portal is heading towards system-of-record status (Atera exit planned), so every integration must:

1. Store into **Portal-owned, provider-agnostic tables** (the backup pattern: `provider` column, snapshot + append-only history).
2. Link at **customer level** explicitly (short names ≠ portal names) or automatically where the key is the tenant (Azure, Intune, O365).
3. Match at **asset level** by machine name (or serial where available).
4. Be **read** by the surfaces — customer panel, asset page, IT report, alerts — never queried live per page view.

## Surface design

### Customer panel — "Service health" strip (top of Overview or its own tab)
One tile per monitored element, colour-coded, each clicking through to its detail:

| Tile | Source | State today |
|---|---|---|
| Domain Health | dmarc_domains (already customer-linked) | **Data live** — tile needed |
| Backup | backup_* tables (MSP360 ✓, Acronis ✓, Azure ready) | **Live** — card exists on Assets tab; tile needed |
| Devices / Intune | Graph per tenant (consent gated) | Data live for consented tenants; tile needed |
| Graph consent | graph_consent_status | **Live** on Customers list; reuse on panel |
| Office 365 health | Graph serviceAnnouncement API | Needs `ServiceHealth.Read.All` on the app + small sync |
| Vulnerability (RoboShadow) | RoboShadow API (they have one) or monthly manual | Explore API; manual fields exist in IT report |
| Network (N3twrx/UniFi) | alerts/unifi polls (already running) | Data live; tile needed |
| Support | inbox_tickets | Live everywhere; tile = open cases count |

### Asset page — tabs per relevant element
- Backup ✓ (done, with accruing history)
- Intune: match Graph managedDevice by name → compliance, encryption, last sync, OS patch level
- RoboShadow: per-device vulnerabilities when API is wired
- History: one **asset_events** timeline (portal-owned): synced state changes, backup results, assignment changes, "rebuilt/retired" manual events — the system-of-record backbone

## Storage pattern (repeat of the backup shape)

- `<element>_snapshot` — replaced per sync, current state
- `<element>_history` — append-only daily, keyed on the run/observation date
- `provider` column everywhere; links via existing `backup_provider_links`-style tables or tenant auto-link
- Mirror every table in prisma/schema.prisma as no-op models (db push drops unmirrored tables)

## Phases

1. **Service-health strip on the customer panel** — tiles for Domain Health, Backup, Intune/consent, Network, Support. All data already in the DB; UI work only. *(Quick win.)*
2. **Intune on the asset page** — nightly per-tenant device sync into portal tables (consented tenants only), matched by device name; unlocks patch/encryption per asset + richer report Devices section.
3. **Office 365 service health** — add ServiceHealth.Read.All to the app registration, re-consent tenants, nightly incidents sync; tile + report mention ("no M365 service incidents affected you this month").
4. **RoboShadow API** — explore their API (they publish one); auto-fill the report's vulnerability section + per-device findings.
5. **asset_events timeline** — the unified history table; backfill from existing syncs; manual event entry (rebuilt, retired, reassigned).

## Rules of thumb going forward

- New data source? It gets: a lib with sync → portal tables + history, a customer link (explicit or tenant-auto), an asset match where meaningful, a tile, and a report section that READS it. No page ever calls a vendor API inline.
- The IT report never gets its own data plumbing again — it renders what the customer already monitors.
