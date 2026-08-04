# [C] Session log — 2026-08-03 (with Claude)

A big build day. Everything below is committed to `D:\LITS\LumenMSP Portal` and deployed unless flagged otherwise.

## Shipped today

**Claude MCP connector** — read-only JSON-RPC endpoint `POST /mcp/<MCP_TOKEN>` (`src/routes/mcp.ts`): search, get_customer, list/get tickets, list/get invoices, outstanding_invoices. Wired in `index.ts`; token in server `.env` (`MCP_TOKEN`). Connected to Claude Desktop via local bridge.

**Forwarded-email ack fix** (`lib/mailsync.ts`) — staff-forwarded cases now acknowledge the ORIGINAL sender, not the forwarder. Plus one-off `scripts/resend-new-case-acks.ts`.

**IT report overhaul** (`lib/it-report/*`, `views/it-report/edit.ejs`, `lib/ai-compose.ts`):
- Domain Health section wired to real LITS-DMARC data (score, SPF/DKIM/DMARC, registrar/expiry, senders table, spoof-block counts).
- Email authentication % auto-derived from DMARC (manual deliverability box removed).
- Support "work carried out" table + case-exclusion checkboxes on settings.
- Binary status board on Overall IT Status (OK / Needs attention / Not monitored per marker).
- Anti-waffle AI prompt (hard word caps, banned filler, no date-stamp errors, no cross-section repetition).
- Devices section is INTUNE ONLY (backups never shown there).
- Email delivery: clean email-safe COVER email + full report as **PDF attachment** (`htmlToPdf`), across preview / send-draft / send-now / scheduler.
- Report graphics (score meter, split bars, case-mix bars) — email/print-safe, CVD-validated colours.

**Backup providers** (provider-agnostic tables `backup_*`, mirrored in prisma schema):
- **MSP360** (`lib/msp360.ts`) — live, nightly 05:45. Companies/storage + plan status + daily history.
- **Acronis** (`lib/acronis.ts`) — live, nightly 06:05. Per-tenant workloads + storage + last-run from activities feed.
- **Azure Backup** (`lib/azure-backup.ts`) — built, auto-links by tenant; needs Reader RBAC per customer subscription.
- Linking UI lives on the **customer panel** (Assets → Backup → Manage provider links); IT report just reads it.
- Backup visible on: customer panel card, asset list badges, asset detail tab (+ history), IT report.

**Graph single-app consolidation** — the Portal now uses ONE app for internal + customer Graph:
- `GRAPH_CLIENT_ID = c2328889-e54c-430b-9b74-e3575c80facb` ("LumenMSP", verified, has Intune + Secure Score + mail + users + groups).
- Consent flow: v2 adminconsent, redirect pinned to `portal.lumenmsp.co.uk/auth/callback`, friendly success page (`routes/auth.ts`).
- Consent status badges on Customers list; consent judged by a directory read (not Intune, which many tenants don't license); stale-token self-heal in probe + report collectors.
- **Per-permission test button** on customer panel ("Test Microsoft 365 access") — pass/fail per scope.
- Write-access capability framework (`lib/graph-capabilities.ts` + Integrations UI) built but dormant — for future ad-hoc per-customer write via a separate write app.

**Service-health strip** on the customer panel (Domain Health / Backup / Devices / M365 / Support tiles). Roadmap phases 2–5 in `[C] Service Health - unified monitoring plan.md`.

**Integrations page** — MSP360 + Acronis credential cards added (save/test/sync).

## Reports status
- **Staybrook (262)** — SENT (July 2026). Intune 6/7 compliant, Secure Score 41%, Acronis 199 GB, Domain Health 85/100.
- **Larkmead (282)** — previewed & ready, NOT sent. Backup 3.55 TB (LVG linked). NOTE: Intune compliance is **19% (19/101)** — accurate but low; decide whether to add an SDM context line before sending. Check exclusions (the "FW: Large Animal - Daily" auto-forwards) + recipients first.

## Open follow-ups
1. **Rotate the c2328889 client secret** — it passed through chat. Regenerate on the app, update server `.env` GRAPH_CLIENT_SECRET (`sed` line), redeploy.
2. Larkmead: finalise compliance note + exclusions, then send (new PDF format).
3. Staff-open tracking false-positive — internal/staff opens of tracked docs log as customer opens; suppress by office IP or staff session.
4. Add `ServiceHealth.Read.All` to c2328889 (+ consent) if you want the service-health tile.
5. If Teams CHAT sync is used, add chat scopes to c2328889 (it lacks `ChatMessage.Read.All`, `Chat.ReadWrite.All`, `Chat.Create`) — mail/users already work.
6. Turn Monthly ON per customer in IT report settings for the ones you want auto-sent.
7. Service-health plan phases 2–5 (Intune per-asset, O365 health, RoboShadow API, asset_events timeline).

## Server / config notes
- Portal: Azure `lits-admin@51.11.176.101`, `/srv/apps/lumenmsp-portal`. Deploy: `.\deploy.ps1` (builds, tests journeys, ships, restarts, git commit+push).
- `.env` keys added today: `MCP_TOKEN`, `MSP360_USER/PASS`, `ACRONIS_CLIENT_ID/SECRET/DC`. `GRAPH_CLIENT_ID/SECRET` now c2328889.
- EJS errors aren't caught by `tsc` — they 500 at render. Compile-check views before deploy.
