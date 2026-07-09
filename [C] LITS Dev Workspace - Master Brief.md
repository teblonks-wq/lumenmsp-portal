# LITS Dev Workspace — Master Brief

> Draft written before re-rooting the workspace to `D:\LITS`. Move this file (or its content) to
> `D:\LITS\CLAUDE.md` so Claude reads it at the start of every session once the parent folder is
> connected. Sections marked **(confirm)** are inferred from the server + existing docs and need
> verifying against the actual folders once `D:\LITS` is mounted.

---

## 1. Purpose

Lumen IT Solutions (LITS) runs several Node/PHP apps from one shared server. Today each app is
developed from its own connected folder, which means no single place gives Claude (or Terry) a view
of the whole estate. **Goal: re-root the Cowork workspace one level up at `D:\LITS` so every app,
its deploy path, its data and its backups can be seen and controlled from one project.** This brief
defines that workspace: what exists, where it lives, how it deploys, what to clean up, and how
backups should work.

---

## 2. Vision — one workspace to run all LITS dev

- See and edit **every app** (Portal, Insights, Website, legacy, client apps) from one root.
- A single, accurate **map of the estate**: local folder ↔ server path ↔ port ↔ PM2 process ↔ domain ↔ database.
- **Consistent deploy** story per app, documented and (where possible) scripted.
- **Folder hygiene** — retire what's been superseded (e.g. Insights now lives inside the Portal), archive legacy.
- **Backups that are proven**, not assumed — every DB, every web root, and the irreplaceable keystore.
- Claude operates across apps with full context and warns which deploy each change needs.

---

## 3. Proposed `D:\LITS` layout (confirm)

```
D:\LITS\
  LumenMSP Portal\            — main MSP tool (Node/TS). THIS session's folder. Live: portal.lumenmsp.co.uk
  LumenMSP - Insights\        — call-analytics app (Node/TS). Live: insights.lumenmsp.co.uk  (now also enveloped in Portal — see §8)
  LumenMSP\                   — legacy PHP/MySQL portal (reference/fallback). Live: porta.lumenmsp.co.uk
  LumenMSP - Marketing\
    LITS - LumenMSP - Website\
      lumenmsp-website\       — Astro static site → /var/www/lumenmsp (www.lumenmsp.co.uk)
      broadband-api\          — Node/Express backend (availability + orders + leads). Port 3400
  lumen-twa\                  — Android TWA (Bubblewrap) wrapper for the Portal mobile PWA + android.keystore
  (vault)\                    — keystore + passwords (location: confirm)
  (larkmead / prs-app sources?) — client apps also hosted on the same server (confirm if sources live here)
```

---

## 4. App inventory (server-confirmed this session)

| App | Local folder | Server path | Port | PM2 | Domain | Stack | Deploy |
|---|---|---|---|---|---|---|---|
| **LumenMSP Portal** | `LumenMSP Portal` | `/srv(=/data)/apps/lumenmsp-portal` | 3200 | `lumenmsp-portal` | portal.lumenmsp.co.uk | Node/TS, Express, Postgres (raw pg + Prisma schema), EJS, Puppeteer | `.\deploy.ps1` (build→ship→`prisma db push`→pm2) |
| **LumenMSP Insights** | `LumenMSP - Insights` | `/srv(=/data)/apps/lumenmsp-insights` | 3100 | `lumenmsp-insights` | insights.lumenmsp.co.uk | Node/TS | own deploy (confirm) |
| **Website backend** | `…/broadband-api` | `/data/apps/lumen-broadband-api` | 3400 | `lumen-broadband-api` | www.lumenmsp.co.uk `/api`,`/admin` | Node/Express, shares Insights Postgres | `scp *.js .env` → `npm i` → `pm2 restart` |
| **Website front-end** | `…/lumenmsp-website` | `/var/www/lumenmsp` (static) | — | — | www.lumenmsp.co.uk | Astro (static build) | `npm run build` → publish `dist/` to `/var/www/lumenmsp` |
| **Legacy PHP portal** | `LumenMSP` | `/srv/apps/lumenmsp` (PHP-FPM) | — | — | porta.lumenmsp.co.uk | PHP 8 / MySQL | reference/fallback only |
| **Larkmead PRISM** (client) | confirm | `/srv(=/data)/apps/larkmead-prism` | 3000 | `larkmead-prism` | prism.larkmead.co.uk | Node | own |
| **Purely Recruitment** (client) | confirm | `/srv(=/data)/apps/prs-app` (user `prsapp`) | 3300 | (prsapp-owned) | app.purely-recruitment.co.uk | Node | own |
| **LanguageTool** | n/a (service) | container/process | 8081 | `languagetool` | localhost (Portal grammar) | self-hosted LT | — |
| **Mobile TWA** | `lumen-twa` | n/a (built to APK, Intune) | — | — | wraps /m | Bubblewrap | build APK → Intune |

---

## 5. Server & infrastructure

- **Host:** shared **LITS App Server**, `lits-admin@51.11.176.101` (Ubuntu 22.04 Azure VM). Node 20, PM2, Nginx, Certbot.
- **Critical gotcha:** `/srv/apps` and `/data/apps` are the **same location** (apps moved to the `/data` SSD; one is a symlink). Do **not** `rm` an apparent "duplicate" copy — it deletes the live app. (Bit us this session.)
- **Ports in use:** 3000 larkmead · 3100 insights · 3200 portal · 3300 prs-app · 3400 broadband-api · 8081 LanguageTool. New apps must pick a free port.
- **Permissions:** `/srv|/data/apps` and `/var/www` are root-owned — `sudo` needed to create app dirs / publish the site; `sudo chown` to `lits-admin` after.
- **Nginx vhosts** (`/etc/nginx/sites-available/…`): each domain proxies to its app's port; the website vhost serves static `/var/www/lumenmsp` + proxies `/api/` & `/admin` → 3400.

---

## 6. Databases

- **PostgreSQL 16** (localhost:5432): `lumenmsp_portal` (role `portal`), `lumenmsp_insights` (role `insights` — **also used by the website broadband-api** for `page_views`/`bb_lookups`/`orders`), plus the larkmead and prs-app DBs.
- **MySQL 8**: legacy LumenMSP data (source for Portal migrations).
- DB credentials live in each app's server `.env` (never commit). Connection-string passwords with `@`/`!` must be URL-encoded.

---

## 7. Deploy model (per app)

- **Portal:** `.\deploy.ps1` — builds locally, ships, `prisma db push --accept-data-loss` (placeholder schema), restarts PM2. View-only changes can use `deploy-views.ps1` (no logout). Restarting logs everyone out — warn staff.
- **Insights:** own deploy (confirm script). Note: **only ONE app may run the Insights report scheduler + Tollring sync** — the Portal now owns it; the standalone Insights crons must be disabled to avoid duplicate customer emails.
- **Website backend:** `scp` changed `*.js`/`.env` to `/data/apps/lumen-broadband-api`, `npm install --omit=dev`, `pm2 restart lumen-broadband-api`.
- **Website front-end:** `npm run build` → stage in `~/site-dist` → `sudo rsync -a --delete ~/site-dist/ /var/www/lumenmsp/`.
- **Mobile TWA:** built outside the repos in `lumen-twa` (Bubblewrap + `android.keystore`), distributed via Intune.

---

## 8. Folder cleanup — analysis & recommendations

**Insights (the big one).** The Insights pipeline has been **enveloped into the Portal** (`src/lib/insights/`, `/insights` routes, the report scheduler + Tollring sync now run in the Portal). The standalone `lumenmsp-insights` app (port 3100, `insights.lumenmsp.co.uk`) is therefore largely redundant **except** that it still serves the public `insights.lumenmsp.co.uk` domain. **Decision needed:** either (a) point `insights.lumenmsp.co.uk` at the Portal and **retire** the standalone app + folder, or (b) keep the standalone as the public face and have it call the Portal. Recommendation: (a) — one codebase, less drift. Until then, confirm the standalone Insights scheduler/crons are **disabled** (they were a duplicate-email risk).

**Legacy PHP portal (`LumenMSP`, porta.lumenmsp.co.uk).** Kept as a read-only fallback after the cutover. Once you're confident in the Portal, **archive the local folder** and decide whether to keep the `porta` vhost as reference or retire it. The reporting/call-data modules in it were intentionally never ported.

**`lumenmsp-dev`** (`/srv/apps/lumenmsp-dev`). A dev/staging copy — confirm whether it's still used; if not, remove to free space.

**Duplicates/artifacts to sweep:** the `[C]`-prefixed Claude files, old daily logs, the `*-LumenMSP-001` duplicate files and `app/_archive/` in the legacy app. Keep the vault + keystore untouched.

**Client apps (larkmead, prs-app).** Separate clients on the same box — keep isolated; include in the map but they're not part of the LumenMSP product. (prs-app runs as user `prsapp` and owns port 3300.)

---

## 9. Backups — what to verify (don't assume)

Current intended **3-tier topology**: Azure Backup (the VM, Enhanced) + app DB/content to Azure BLOB (`webobjects/lumenmsp` — confirmed working) + Wasabi/MSP360 for `D:\`. To make this trustworthy, verify each item:

- **Databases:** `lumenmsp_portal`, `lumenmsp_insights` (covers the website's `orders`/leads data too), larkmead, prs — are all included in a scheduled `pg_dump` → BLOB, with a tested restore.
- **Web roots & code:** `/var/www/lumenmsp` (the live site) and each app's `/data/apps/*` (or rely on the git/local source as the source of truth).
- **Server `.env` files** — they hold creds not in git. Back these up securely (they're the only copy of some secrets).
- **The Android keystore** (`lumen-twa/android.keystore`) — **irreplaceable**; losing it means you can't update the app. Confirm it's in the vault **and** backed up off-machine.
- **MySQL** legacy data retained until the Portal migration is fully trusted.

Action: produce a one-page **backup matrix** (what / where / frequency / last tested restore) and fix any gaps.

---

## 10. How Claude works across the workspace

- Treat `D:\LITS` as the root; know which app a change belongs to and **state which deploy it needs** (and whether it logs users out).
- Never `rm` server "duplicates" (`/srv`=`/data`). Keep secrets out of chat and out of memory; reference, don't echo.
- Sandbox note: the dev sandbox mangles UTF-8 (em-dash/£/emoji) and sometimes truncates file reads, so compile-checks there throw false errors — the authoritative build is each app's real build (Windows / server). Verify structure via the editor, not the sandbox.
- Put outputs in the right app's folder; prefix Claude-created files with `[C]`.

---

## 11. Open decisions for Terry

1. **Insights:** retire the standalone app and serve `insights.lumenmsp.co.uk` from the Portal (recommended), or keep separate? (And confirm the standalone crons are off.)
2. **Legacy PHP:** archive the folder + retire the `porta` vhost, or keep as reference?
3. **`lumenmsp-dev`:** still needed?
4. **Client app sources (larkmead, prs-app):** do their sources live under `D:\LITS`, and do you want them in scope or just mapped?
5. **Backups:** OK to build/verify the backup matrix and add any missing DB dumps?

---

## 12. When `D:\LITS` is connected — Claude's first pass

1. Survey every folder; correct §3/§4 against reality (paths, which sources are present).
2. Refresh each app's own `CLAUDE.md`/README and reconcile with this brief.
3. Produce the **backup matrix** (§9) and a **cleanup plan** (§8) with concrete, reversible steps (recycle/archive, never hard-delete).
4. Confirm the standalone Insights scheduler is disabled; finalise the Insights decision (§11.1).
5. Carry over the open product roadmap (website order flow: live pricing + address-level UPRN + GoCardless DD + terms; Portal backlog).
