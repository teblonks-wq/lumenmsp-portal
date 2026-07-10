import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import path from 'path';
import crypto from 'crypto';
import { config } from './config';
import { pool } from './db/pool';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import customerRoutes from './routes/customers';
import quoteRoutes from './routes/quotes';
import invoiceRoutes from './routes/invoices';
import productRoutes from './routes/products';
import contractRoutes from './routes/contracts';
import ticketRoutes from './routes/tickets';
import leadRoutes from './routes/leads';
import taskRoutes, { startTaskReminders } from './routes/tasks';
import contactRoutes from './routes/contacts';
import adminRoutes from './routes/admin';
import integrationRoutes, { startQbPaymentSync } from './routes/integrations';
import commsRoutes from './routes/comms';
import searchRoutes from './routes/search';
import recycleRoutes from './routes/recycle';
import notificationRoutes from './routes/notifications';
import toolsRoutes from './routes/tools';
import bureauRoutes from './routes/bureau';
import packageRoutes from './routes/packages';
import purchaseRoutes from './routes/purchases';
import mobileRoutes from './routes/mobile';
import myRoutes, { ensureCustomerPortalColumn } from './routes/my';
import credentialRoutes from './routes/credentials';
import ateraRoutes from './routes/atera';
import webhookRoutes from './routes/webhooks';
import insightsRoutes from './routes/insights';
import itReportRoutes from './routes/it-report';
import bookkeeperRoutes from './routes/bookkeeper';
import softphoneRoutes from './routes/softphone';
import chatRoutes from './routes/chat';
import chatPublicRoutes from './routes/chat-public';
import leadsApiRoutes from './routes/leads-api';
import marketingRoutes from './routes/marketing';
import networkRoutes from './routes/network';
import erecyclingRoutes from './routes/erecycling';
import aiRoutes from './routes/ai';
import tvRoutes from './routes/tv';
import { ensureChatTables } from './lib/chat';
import { ensureAlertsTable } from './lib/alerts';
import { ensureSocialsTables } from './lib/socials';
import { startGiacomStatus } from './lib/giacom-status';
import { startUnifiPoll } from './lib/unifi';
import { hasFinanceAccess, hasVaultAccess } from './middleware/auth';
import { startRecurringBilling } from './lib/recurring-billing';
import reviewRoutes, { startReviewReminders } from './routes/reviews';
import { startMailSync } from './lib/mailsync';
import { startInvoiceInbox } from './lib/purchase-inbox';
import { startPostponeSweep } from './lib/postpone-sweep';
import { startBackupCron } from './lib/backup';
import { startTeamsGraphCron } from './lib/teamsgraph';
import { startGiacomSync } from './lib/giacom-sync';
import { startDwsSync } from './lib/dws-sftp';
import { startGoCardlessSync } from './lib/gocardless-sync';
import { startExtLabelSync } from './lib/insights/ext-labels';
import { startTollringSync } from './lib/insights/tollring-sync';
import { startReportScheduler } from './lib/insights/report-scheduler';
import { ensureSiteLogicColumn, ensureReportPoolTables } from './lib/insights/report-generator';
import { ensureItReportTables } from './lib/it-report/generate';
import { startItReportScheduler } from './lib/it-report/scheduler';
import dmarcRoutes from './routes/dmarc';
import { ensureDmarcTables } from './lib/dmarc/store';
import { startDmarcIngest } from './lib/dmarc/ingest';
import http from 'http';
import { attachCallSocket, callHistory } from './lib/callhub';
import { getGroup } from './lib/settings';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
// Content-Security-Policy: 'unsafe-inline' is required because the EJS views use inline
// <script>/onclick and inline styles heavily; the host allow-list covers the only external
// resources we load (Quill editor + Tabler icon font). A nonce-based CSP is a future hardening.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.quilljs.com', 'https://cdn.jsdelivr.net'],
      // The views use inline on* handlers (onclick etc.) extensively — helmet's default
      // script-src-attr 'none' would block them all, so allow inline attribute handlers.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.quilljs.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'data:', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // 'self' so the Portal can frame its own same-origin pages (the Insights embed in Tools).
      frameSrc: ["'self'"],
      // 'self' (not 'none') so the Portal can frame its own pages (the Insights embed); still blocks
      // external sites from clickjacking the Portal.
      frameAncestors: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.set('trust proxy', 1);

// Extra headers the scanner flags: Permissions-Policy (camera kept 'self' for the /m PWA's
// receipt camera) and no-store on dynamic responses (login/app pages shouldn't be cached).
app.use((req, res, next) => {
  // microphone=(self): required for the WhatsApp softphone's getUserMedia(audio). camera=(self) for the /m receipt camera.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), payment=(), camera=(self)');
  if (!req.path.startsWith('/static')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// ── View engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../src/views'));
// View cache OFF: lets us hot-deploy .ejs view/CSS tweaks (copy the file to the server) and have
// them go live on the next request — no process restart, so nobody gets logged out. Tiny per-render
// recompile cost, negligible for our traffic.
app.set('view cache', false);

// ── Body parsing ──────────────────────────────────────────────────────────────
// Larger limit: the bureau batch-pricing form can post many rows at once.
app.use(express.urlencoded({ extended: true, limit: '5mb', parameterLimit: 100000 }));
// Stash the raw JSON body so inbound webhooks (WhatsApp) can verify the HMAC signature.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

// ── Static files ──────────────────────────────────────────────────────────────
// The website chat widget is embedded cross-origin (on lumenmsp.co.uk), so it must be exempt
// from helmet's global Cross-Origin-Resource-Policy: same-origin — otherwise the browser blocks
// the external site from loading it. Only the embeddable widget is opened up.
app.get('/static/js/chat-widget.js', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use('/static', express.static(path.join(__dirname, '../static')));

// ── PWA: manifest + service worker (SW served at root so it can scope the whole app) ─
// cacheControl:false stops sendFile from setting its own cacheable Cache-Control that would
// override the no-store/Pragma we set in the security-header middleware (ZAP flagged the manifest).
const noStoreSend = { cacheControl: false, headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' } };
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, '../static/manifest.webmanifest'), noStoreSend);
});
// Separate manifest for the DESKTOP install (full portal, start_url '/') — kept distinct
// from the mobile /m app's manifest so the two never collide.
app.get('/portal.webmanifest', (_req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, '../static/portal.webmanifest'), noStoreSend);
});
// Public privacy policy (needed for the Meta app to go Live, and good practice generally).
app.get('/privacy', (_req, res) => {
  res.render('privacy', { updated: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) });
});

// Public landing pages for the GoCardless Direct Debit setup flow (customer isn't logged in).
const ddPage = (title: string, msg: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<title>${title} — Lumen IT</title></head>`
  + `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;margin:0;">`
  + `<div style="max-width:480px;margin:12vh auto;background:#fff;border-radius:16px;padding:36px 32px;box-shadow:0 12px 30px rgba(2,6,23,.12);text-align:center;">`
  + `<div style="font-size:40px;margin-bottom:10px;">✅</div>`
  + `<h1 style="font-size:22px;margin:0 0 10px;color:#0f172a;">${title}</h1>`
  + `<p style="color:#475569;font-size:15px;line-height:1.5;margin:0;">${msg}</p>`
  + `<p style="color:#94a3b8;font-size:13px;margin:24px 0 0;">Lumen IT Solutions</p>`
  + `</div></body></html>`;
app.get('/dd/complete', (_req, res) => {
  res.send(ddPage('Direct Debit set up', "Thank you — your Direct Debit is all set. There's nothing more you need to do; we'll collect future invoices automatically and always let you know in advance."));
});
app.get('/dd/exit', (_req, res) => {
  res.send(ddPage('Not completed', "No problem — your Direct Debit wasn't set up. To try again, use the link in the email we sent you, or get in touch and we'll resend it."));
});
app.get('/sw.js', (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript').sendFile(path.join(__dirname, '../static/app-sw.js'), noStoreSend);
});
// Digital Asset Links — verifies the Android TWA (Intune-deployed app) owns this domain so
// it runs full-screen with no address bar. Fingerprint + package come from env (set after
// you generate the signing keystore): TWA_SHA256 (colon-separated SHA-256), TWA_PACKAGE.
app.get('/.well-known/assetlinks.json', (_req, res) => {
  const fp = (process.env.TWA_SHA256 || '').trim();
  const pkg = (process.env.TWA_PACKAGE || 'uk.co.lumenmsp.portal').trim();
  res.type('application/json').json(fp ? [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: [fp] },
  }] : []);
});

// ── Sessions ──────────────────────────────────────────────────────────────────
// Kept as a named handler so the WebSocket call-socket can reuse it to auth upgrades.
const sessionMiddleware = session({
  secret:            config.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   12 * 60 * 60 * 1000, // 12 hours
  },
});
app.use(sessionMiddleware);

// ── CSRF protection (synchroniser token, per session) ──────────────────────────
// A token is minted per session and exposed to views (res.locals.csrfToken) + a meta tag.
// The global script in the footer injects it into every form and fetch. We enforce it on
// authenticated, state-changing requests; webhooks (signature-authenticated) and unauthenticated
// public flows (login, capability-token quote-accept, etc.) are exempt.
app.use((req, res, next) => {
  const s = req.session as any;
  if (!s.csrfToken) s.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = s.csrfToken;
  next();
});
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next();         // verified by signature/secret
  if (req.path.startsWith('/api/chat')) return next();          // public website chat widget (token-based, CORS)
  if (!req.session.user) return next();                          // public/login flows use other protections
  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf) || req.query._csrf;
  if (sent && sent === (req.session as any).csrfToken) return next();
  res.status(403).send('Security check failed (CSRF). Please refresh the page and try again.');
});

// ── Sidebar badges (lead count) ─────────────────────────────────────────────────
app.use(async (req, res, next) => {
  res.locals.leadCount = 0;
  res.locals.unreadMail = 0;
  res.locals.bureauCount = 0;
  res.locals.canFinance = false;
  res.locals.canVault = false;
  if (req.session.user) {
    try { res.locals.canFinance = await hasFinanceAccess(req.session.user); } catch { /* noop */ }
    try { res.locals.canVault = await hasVaultAccess(req.session.user); } catch { /* noop */ }
    try {
      // Badge only brand-new leads that haven't been actioned yet. Open = being worked,
      // proposed = answered/awaiting the customer, won/lost = closed — none need a nudge.
      const r = await pool.query(
        "SELECT COUNT(*)::int n FROM leads WHERE status='new' AND deleted_at IS NULL"
      );
      res.locals.leadCount = r.rows[0].n;
    } catch { /* table may not exist during early scaffolding */ }
    try {
      const m = await pool.query("SELECT COUNT(*)::int n FROM communications WHERE direction='inbound' AND is_unread=true");
      res.locals.unreadMail = m.rows[0].n;
    } catch { /* communications table may not exist yet */ }
    if (req.session.user.role === 'admin') {
      try {
        // Distinct unallocated CLIs/refs (not raw lines) — matches the Bureau hub + bill run.
        const b = await pool.query("SELECT COUNT(DISTINCT product_reference)::int n FROM service_items WHERE customer_id IS NULL AND product_reference IS NOT NULL");
        res.locals.bureauCount = b.rows[0].n;
      } catch { /* service_items table may not exist yet */ }
    }
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
// Public inbound webhooks (WhatsApp) MUST be registered before any router that applies
// auth/finance gates — Meta calls them unauthenticated.
app.use('/', webhookRoutes);
app.use('/', chatPublicRoutes);   // public website chat API (token-based, CORS, no auth)
app.use('/', leadsApiRoutes);     // public website lead intake (bearer token, no session)
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/', customerRoutes);
app.use('/', quoteRoutes);
app.use('/', invoiceRoutes);
app.use('/', productRoutes);
app.use('/', contractRoutes);
app.use('/', ticketRoutes);
app.use('/', leadRoutes);
app.use('/', taskRoutes);
app.use('/', contactRoutes);
app.use('/', adminRoutes);
app.use('/', integrationRoutes);
app.use('/', commsRoutes);
app.use('/', searchRoutes);
app.use('/', recycleRoutes);
app.use('/', notificationRoutes);
app.use('/', toolsRoutes);
app.use('/', bureauRoutes);
app.use('/', packageRoutes);
app.use('/', purchaseRoutes);
app.use('/', mobileRoutes);
app.use('/', myRoutes);           // customer portal (/my) — requireCustomer-guarded inside
app.use('/', credentialRoutes);
app.use('/', ateraRoutes);
app.use('/', reviewRoutes);
app.use('/', insightsRoutes);
app.use('/', itReportRoutes);     // Monthly IT Operations & Security Snapshot (staff)
app.use('/', dmarcRoutes);        // LITS-DMARC — email authentication monitoring (staff)
app.use('/', bookkeeperRoutes);   // Read-only external bookkeeper expenses portal
app.use('/', softphoneRoutes);
app.use('/', chatRoutes);
app.use('/', marketingRoutes);
app.use('/', networkRoutes);
app.use('/', erecyclingRoutes);
app.use('/', aiRoutes);
app.use('/', tvRoutes);

// WebRTC ICE servers for the WhatsApp softphone — STUN (always) + TURN (from settings
// group 'webrtc' once a coturn server is configured). Staff-only.
app.get('/api/calls/ice', async (req, res) => {
  const user = (req.session as any)?.user;
  if (!user || user.customerId) { res.status(403).json({ iceServers: [] }); return; }
  const w = await getGroup('webrtc').catch(() => ({} as Record<string, string>));
  const iceServers: any[] = [{ urls: w.stun_url || 'stun:stun.l.google.com:19302' }];
  if (w.turn_url) {
    iceServers.push({ urls: w.turn_url, username: w.turn_username || undefined, credential: w.turn_credential || undefined });
  }
  res.json({ iceServers });
});

// Recent WhatsApp call history for the softphone panel (callable flag reflects the 24h window).
app.get('/api/calls/history', async (req, res) => {
  const user = (req.session as any)?.user;
  if (!user || user.customerId) { res.status(403).json([]); return; }
  try { res.json(await callHistory(40)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
// http.createServer (not app.listen) so the WhatsApp call WebSocket can share the port.
const server = http.createServer(app);
attachCallSocket(server, sessionMiddleware);
server.listen(config.PORT, () => {
  console.log(`Lumen MSP Portal running on port ${config.PORT}`);
  console.log(`  ENV: ${config.NODE_ENV}`);
  startMailSync();
  startInvoiceInbox();
  startPostponeSweep();
  startBackupCron();
  startTeamsGraphCron();
  startGiacomSync();
  startDwsSync();
  startGoCardlessSync();    // hourly: auto-link new GoCardless mandates by email
  startExtLabelSync();      // 04:30: label CLIs with their extension name from Insights
  startReviewReminders();
  startTaskReminders();
  startQbPaymentSync();     // QB payment sync: BANK-TRANSFER invoices only — it now skips any
  // invoice with a gocardless_payment_id (GC's payout sync owns those). Division of authority
  // decided 2026-07-09 after QB's stale balances kept overwriting GC-confirmed payments.
  startRecurringBilling();
  startTollringSync();      // Insights: hourly Tollring call sync → call_events
  startReportScheduler();   // Insights: per-minute due-report generate + email
  ensureSiteLogicColumn().catch((e) => console.error('ensureSiteLogicColumn failed:', e.message)); // Insights: lift call logic to the site level + backfill
  ensureReportPoolTables().catch((e) => console.error('ensureReportPoolTables failed:', e.message)); // Insights: report pool (templates) + per-site schedules
  ensureCustomerPortalColumn().catch((e) => console.error('ensureCustomerPortalColumn failed:', e.message)); // customer portal master switch
  ensureChatTables().catch((e) => console.error('ensureChatTables failed:', e.message)); // website live-chat
  ensureAlertsTable().catch((e) => console.error('ensureAlertsTable failed:', e.message)); // N3twrx alerts
  ensureItReportTables().catch((e) => console.error('ensureItReportTables failed:', e.message)); // Monthly IT Snapshot config/runs/notes
  startItReportScheduler(); // Monthly IT Snapshot: 00:00 on the 1st, previous month
  ensureDmarcTables().catch((e) => console.error('ensureDmarcTables failed:', e.message)); // LITS-DMARC domains/reports/records
  startDmarcIngest();       // LITS-DMARC: poll the rua mailbox every 30 min (no-op until DMARC_MAILBOX set)
  ensureSocialsTables().catch((e) => console.error('ensureSocialsTables failed:', e.message)); // legacy socials table kept; seeding retired with the 2026-07-09 stateless studio rewrite
  startGiacomStatus();   // N3twrx: poll Giacom status feed
  startUnifiPoll();      // N3twrx: poll UniFi Site Manager API for offline devices
});
