---
author: claude
type: reference
scope: Portal (this report) + Website (scan pending)
updated: 2026-06-25
---

# Security remediation tracker

Single place for vulnerability-scan findings and their fixes across the estate.
Started from the **RoboShadow scan of 2026-06-25** (portal.lumenmsp.co.uk + server
51.11.176.101). A **separate website scan** (www.lumenmsp.co.uk on its own host) is
expected within a few hours — add its findings here when it lands.

## Verdict (2026-06-25 scan)

Clean. **0 Critical / 0 High / 0 Medium, 0 CVEs.** Network: only 3 open ports
(80, 443 nginx; 3478 = WebRTC STUN/TURN for the softphone — expected). Web app (OWASP/ZAP):
38 alerts = **0 High, 0 Medium, 13 Low, 25 Info** — all HTTP hardening, nothing exploitable.

## Access model (who can reach what — context for CSRF scope)

CSRF protection matters on **cookie-session** routes that change state. Bearer/HMAC APIs
are not CSRF-applicable. Current layers:

- **Portal** (cookie session, staff only today): no session → login; `customer` role → **blocked** ("portal coming soon"); authenticated staff (base); **finance** (`finance_group`/admin); **support/vault** (`support_group`/admin); **admin**. → *All staff POST forms need CSRF tokens.*
- **Portal public APIs** (`/api/leads` bearer, `/webhooks/*` HMAC, `/api/chat/*` token): **not** cookie-auth → **exclude** from CSRF.
- **Insights** (customers' only login): SSO, roles viewer/admin/lumen_admin, customer-scoped.

## Update after code review (2026-06-25)

On reading the Portal source, **most of these are already fixed in code, pending deploy**:
- **CSRF (item 1) is already implemented** — `index.ts` mints a per-session synchroniser token,
  exposes it to views, and enforces it on authenticated state-changing requests (webhooks + public
  token flows exempt). The scan flagged it because ZAP was unauthenticated and only saw the login
  pages. **Action: confirm it's deployed + that forms carry the token; not a rebuild.**
- **Header items (2–5) are already set via `helmet`** in `index.ts` (CSP with allow-list, CORP
  same-origin with a cross-origin exemption for the embedded chat widget, Referrer-Policy,
  Permissions-Policy, and `Cache-Control: no-store` on non-static). **The `ops/[C] nginx-security-headers.conf`
  is now a BACKUP/alternative — don't double-set the same headers in both nginx and helmet.**

So the real remaining action is likely just **deploying** the current build and re-scanning, not new
code. The table below is kept for the re-scan checklist.

## Findings & status

| # | Finding | Risk | Surface | Fix | Where | Deploy / logout | Status |
|---|---|---|---|---|---|---|---|
| 1 | Absence of Anti-CSRF tokens | Low | Portal forms | Add CSRF token to cookie-session POST forms (see spec below) | Express app + EJS | `deploy.ps1` → **logs staff out** | TODO |
| 2 | Missing Content-Security-Policy | Low | Portal | `Content-Security-Policy` header | nginx (`ops/[C] nginx-security-headers.conf`) | nginx reload — **no logout** | Drafted |
| 3 | Insufficient Site Isolation (Spectre) | Low | Portal | `Cross-Origin-Resource-Policy` (+COOP) | nginx | reload — no logout | Drafted |
| 4 | Incomplete/No Cache-control & Pragma | Low | Portal | `Cache-Control: no-store` on app pages | nginx | reload — no logout | Drafted |
| 5 | (hardening) sniffing/clickjacking/referrer | Info/Low | Portal | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` | nginx | reload — no logout | Drafted |
| – | Authentication/Session "identified", Storable content | Info | Portal | No action (informational) | – | – | Noted |

Items 2–5 are all in the nginx block — **one reload clears them, no staff logout**. Item 1 is
the only app-code change.

## Fix 1 — Anti-CSRF tokens (spec)

**Goal:** every state-changing POST/PUT/DELETE made from a logged-in browser session carries an
unguessable token tied to the session; bearer/HMAC/token APIs are exempt.

**Recommended approach — double-submit cookie** (the modern replacement for the deprecated
`csurf`; e.g. the `csrf-csrf` package, or a small hand-rolled equivalent):
1. On session start, generate a random token; expose it to views (`res.locals.csrfToken`).
2. Add a hidden field to every EJS form: `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`. For `fetch()` POSTs, send it as an `X-CSRF-Token` header (read from a meta tag).
3. Middleware validates `_csrf` / `X-CSRF-Token` on unsafe methods.
4. **Exempt** the public APIs: `/api/leads`, `/webhooks/*`, `/api/chat/*` (they authenticate by bearer/HMAC/token, not the staff cookie) — mount CSRF only on the staff routers, or skip-list these paths.
5. SameSite: also set the session cookie `SameSite=Lax` (defence in depth; most state-changing actions are top-level POSTs so Lax is fine).

**Effort:** moderate — the token field must be added across the EJS forms (customers, quotes,
invoices, tickets, tasks, contracts, products, bureau, admin, settings…). Ships via `deploy.ps1`,
which **logs everyone out → warn staff first.** Low risk of breakage if the API exempt-list is right;
test login + a couple of POST forms in staging first.

## Deploy order (Portal)

1. **nginx headers** (items 2–5) — paste `ops/[C] nginx-security-headers.conf` into the portal vhost, `sudo nginx -t`, `sudo systemctl reload nginx`. No logout. Re-check with `curl -sI`.
2. **CSRF tokens** (item 1) — implement, test, then `deploy.ps1` in a quiet window (warn staff: it logs them out).

## Website (pending)

Separate host + scan coming. When it arrives, triage the same way and add rows here. Expect:
header hardening on the Astro static site (set at its nginx/host), and a closer look at the
**broadband-api** `/api` endpoints (input validation, rate-limiting, the order/lead intake) since
those are the public write surface. The consent/visitor-data work (`…/Website/[C] cookie-consent-compliance.md`)
already tightened that area.
