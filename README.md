# Lumen MSP Portal

All-in-one ticketing, quotes, invoicing and customer management for Lumen IT Solutions.
Live at **portal.lumenmsp.co.uk**.

This is the rebuild of the legacy PHP/MySQL app (`D:\LITS\LumenMSP`) onto the same
stack as **LumenMSP Insights** — Node + TypeScript + Express + Prisma/Postgres.

## Stack

- **Runtime:** Node + TypeScript (CommonJS, ES2022, strict)
- **Web:** Express 4, `helmet`, `express-session` (12h cookie)
- **DB:** PostgreSQL via Prisma 7 (snake_case columns via `@map`); raw `pg` pool also available
- **Views:** EJS (server-rendered) with shared `layout.ejs`
- **Auth:** Microsoft Entra SSO (MSAL) + local email/password (bcrypt), session-based
- **PDFs:** Puppeteer (HTML-to-PDF) — `src/lib/pdf.ts`
- **Mail:** nodemailer wrapper — `src/lib/mailer.ts`
- **Jobs:** node-cron (added per-module as needed)
- **Deploy:** `deploy.ps1` → builds locally, ships `dist/` to Azure Ubuntu, PM2 + Nginx

## Layout

```
src/
  config.ts          env validation (zod)
  index.ts           Express bootstrap
  auth/              Microsoft SSO (MSAL)
  db/                pg pool + Prisma client
  middleware/        requireAuth / requireAdmin
  routes/            auth, dashboard (one file per area)
  lib/               mailer, pdf (+ services as ported)
  views/             EJS templates
static/              app.css, lumen-crest.png
prisma/schema.prisma starter schema (customers, users, contacts, sites, login_attempts)
```

## Local setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL + SESSION_SECRET (32+ chars)
npx prisma migrate dev      # create the schema in Postgres
npm run dev                 # tsx watch on http://localhost:3200
```

## Scripts

- `npm run dev` — watch mode
- `npm run build` — `tsc` → `dist/`
- `npm start` — run built app
- `npm run migrate` — `prisma migrate deploy` (production)
- `npm run migrate:dev` — `prisma migrate dev`
- `npm run studio` — Prisma Studio

## Port status

This is the **foundation only**. Modules are ported from the legacy app one at a time:
Customers → Quotes → Invoices → Products/Catalogue → Contracts → Inbox/Helpdesk →
Diary → Repair Centre → Automation.

**Not ported:** the legacy reporting module (now `insights.lumenmsp.co.uk`),
`app/_archive`, the `*-LumenMSP-001` duplicate files, and `graph_test.php`.
