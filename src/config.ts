import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT:                z.coerce.number().default(3200),
  NODE_ENV:            z.enum(['development', 'production']).default('development'),
  DATABASE_URL:        z.string().min(1),
  // Insights DB (lumenmsp_insights) — read by the merged /insights section. Optional until set.
  INSIGHTS_DATABASE_URL: z.string().default(''),
  SESSION_SECRET:      z.string().min(32),

  // Microsoft Entra SSO (optional until configured)
  AZURE_TENANT_ID:     z.string().default(''),   // our home tenant GUID (staff) — also the first entry in the multi-tenant allow-list
  AZURE_CLIENT_ID:     z.string().default(''),
  AZURE_CLIENT_SECRET: z.string().default(''),
  AZURE_REDIRECT_URI:  z.string().default('https://portal.lumenmsp.co.uk/auth/callback'),
  // 'true' = let customers sign in from their own work/school tenants (authority=/organizations),
  // but RESTRICT to an allow-list in code: our home tenant (AZURE_TENANT_ID) + each customer's
  // recorded customers.entra_tenant_id. This admits approved customer tenants without opening to
  // every tenant in the world. Leave blank for staff-only single-tenant behaviour.
  AZURE_MULTI_TENANT:  z.string().default(''),

  // Microsoft Graph (for shared-mailbox sync + send — optional until configured)
  GRAPH_TENANT_ID:     z.string().default(''),
  GRAPH_CLIENT_ID:     z.string().default(''),
  GRAPH_CLIENT_SECRET: z.string().default(''),
  GRAPH_SYNC_MAILBOX:  z.string().default(''),   // inbound: mailbox we read replies from (e.g. sp@lumenmsp.co.uk)
  GRAPH_SEND_FROM:     z.string().default(''),   // outbound: default send-as mailbox (e.g. sales@lumenmsp.co.uk)
  GRAPH_TEAMS_SENDER:  z.string().default('sp@lumensolutions.co.uk'), // Teams-licensed mailbox used to send escalation chats

  // LITS-DMARC — shared mailbox that customer rua= records point at. Aggregate reports
  // are Graph-polled from here every 30 min. Blank = DMARC ingest disabled.
  DMARC_MAILBOX:       z.string().default(''),   // e.g. dmarc@lumenmsp.co.uk

  // Marketing studio "Push to website": directory the Portal writes news articles into
  // (static HTML, served by the website's nginx). Lives at /news/live/ — a sub-path the
  // Astro build does NOT own, so portal articles and the Astro news system never collide;
  // the Astro news listing pulls /news/live/index.json client-side to show these instantly.
  // One-off server setup: mkdir -p /var/www/lumenmsp/news/live (web root is lits-admin-owned).
  // The website deploy.ps1 preserves news/live across site deploys.
  WEBSITE_NEWS_DIR:    z.string().default('/var/www/lumenmsp/news/live'),
  WEBSITE_BASE_URL:    z.string().default('https://www.lumenmsp.co.uk'),

  // QuickBooks Online (OAuth client creds; tokens stored in settings table)
  QB_CLIENT_ID:        z.string().default(''),
  QB_CLIENT_SECRET:    z.string().default(''),
  QB_ENVIRONMENT:      z.enum(['production', 'sandbox']).default('production'),

  // Giacom / Cloud Market APIs (Azure APIM — auth via Ocp-Apim-Subscription-Key).
  // Put the actual subscription keys in the server .env (never committed).
  GIACOM_BILLING_KEY:           z.string().default(''),
  GIACOM_PARTNERCENTER_KEY:     z.string().default(''),
  GIACOM_BILLING_BASE_URL:      z.string().default('https://cloudmarket-services.azure-api.net/Billing/v1'),
  GIACOM_PARTNERCENTER_BASE_URL: z.string().default('https://cloudmarket-services.azure-api.net/PartnerCenter/v2'),

  // DWS / Giacom bill-run SFTP (detailed billing + CDR files)
  DWS_SFTP_HOST:       z.string().default(''),
  DWS_SFTP_PORT:       z.coerce.number().default(2222),
  DWS_SFTP_USER:       z.string().default(''),
  DWS_SFTP_PASS:       z.string().default(''),
  DWS_REMOTE_DIR:      z.string().default('/Monthly'), // Portal pulls monthly bill runs; Daily (CDRs) is Insights' domain
  DWS_MAX_PER_RUN:     z.coerce.number().default(50),   // newest-first cap per fetch (safety against deep history)

  // Password vault — 32-byte AES-256-GCM key (base64 or hex). Set in server .env only.
  VAULT_KEY:           z.string().default(''),

  // Atera RMM/PSA — API key (also settable in Settings → Integrations, which wins).
  ATERA_API_KEY:       z.string().default(''),

  // Buffer (social scheduling) — personal API key for Marketing → Socials. Server .env only.
  BUFFER_TOKEN:        z.string().default(''),

  APP_URL:             z.string().default('https://portal.lumenmsp.co.uk'),
  FROM_EMAIL:          z.string().default('noreply@lumenmsp.co.uk'),
  FROM_NAME:           z.string().default('Lumen MSP Portal'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
