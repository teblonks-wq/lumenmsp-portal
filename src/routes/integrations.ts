import { Router, Request, Response } from 'express';
import cron from 'node-cron';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { config } from '../config';
import { getGroup, getSetting, setSetting } from '../lib/settings';
import { QuickBooks } from '../lib/quickbooks';
import { GoCardless, chargeDateFor } from '../lib/gocardless';
import { sendMail } from '../lib/mailer';
import { renderInvoicePdf } from '../lib/invoice-pdf';
import { invoiceEmailHtml } from '../lib/emails';
import { syncGoCardlessMandates, linkGcPaymentsToInvoices, syncGoCardlessPayments } from '../lib/gocardless-sync';
const isEmailAddr = (e: any): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
import { giacomBillingTest } from '../lib/giacom';
import { syncGiacomBilling } from '../lib/giacom-sync';
import { dwsConfigured, fetchDwsBillRuns } from '../lib/dws-sftp';
import { teamsGraphStatus, teamsGraphAuthUrl, teamsGraphExchangeCode, teamsGraphDisconnect, teamsGraphDebug } from '../lib/teamsgraph';
import crypto from 'crypto';

const router = Router();
const QB_REDIRECT = config.APP_URL + '/settings/quickbooks/callback';

// ── Integrations settings page ──────────────────────────────────────────────────
router.get('/settings/integrations', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  const gc = await GoCardless.load();
  let qbCompany = '';
  if (qb.isConnected()) { const t = await qb.testConnection(); qbCompany = t.ok ? t.name : ''; }
  const gcCfg = await getGroup('gocardless');
  const teamsWebhook = (await getSetting('integrations', 'teams_webhook')) || '';
  const languagetoolUrl = (await getSetting('integrations', 'languagetool_url')) || '';
  const unifiKey = (await getSetting('unifi', 'api_key')) || '';
  const giCounts = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE customer_id IS NOT NULL)::int AS matched,
            COUNT(*) FILTER (WHERE customer_id IS NULL)::int AS unmatched,
            COUNT(DISTINCT external_customer_id)::int AS accounts
     FROM service_items WHERE source='giacom'`
  )).rows[0];
  const giUnmatchedAccounts = (await pool.query(
    "SELECT COUNT(DISTINCT external_customer_id)::int AS n FROM service_items WHERE source='giacom' AND customer_id IS NULL"
  )).rows[0].n;
  const giacom = {
    billingSet: !!(await getSetting('giacom', 'billing_key')),
    partnerSet: !!(await getSetting('giacom', 'partnercenter_key')),
    billingBase: (await getSetting('giacom', 'billing_base_url')) || 'https://cloudmarket-services.azure-api.net/Billing/v1',
    partnerBase: (await getSetting('giacom', 'partnercenter_base_url')) || 'https://cloudmarket-services.azure-api.net/PartnerCenter/v2',
    lastSync: (await getSetting('giacom', 'last_sync')) || '',
    matched: giCounts.matched, items: giCounts.matched + giCounts.unmatched, accounts: giCounts.accounts,
    unmatchedAccounts: giUnmatchedAccounts,
  };
  let dwsFiles: any[] = [];
  try { dwsFiles = (await pool.query('SELECT filename, status, rows_parsed, columns, ingested_at FROM dws_files ORDER BY ingested_at DESC LIMIT 15')).rows; } catch { /* table not migrated yet */ }
  const dws = { configured: dwsConfigured(), host: config.DWS_SFTP_HOST, files: dwsFiles };
  const ateraKey = (await getSetting('atera', 'api_key')) || config.ATERA_API_KEY;
  let ateraCustomers = 0, ateraTickets = 0;
  try {
    ateraCustomers = (await pool.query("SELECT COUNT(*)::int n FROM customer_external_ids WHERE source_system='atera'")).rows[0].n;
    ateraTickets = (await pool.query("SELECT COUNT(*)::int n FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL")).rows[0].n;
  } catch { /* tables may not exist yet */ }
  const atera = { hasKey: !!ateraKey, keyMasked: ateraKey ? ateraKey.slice(0, 6) + '…' + ateraKey.slice(-4) : '', customers: ateraCustomers, tickets: ateraTickets };

  const waG = await getGroup('whatsapp');
  let waCount = 0;
  try { waCount = (await pool.query("SELECT COUNT(*)::int n FROM inbox_messages WHERE channel='whatsapp'")).rows[0].n; } catch { /* noop */ }
  const wa = {
    phoneNumberId: waG.phone_number_id || '',
    tokenSet: !!waG.access_token,
    verifyToken: waG.verify_token || '',
    appSecretSet: !!waG.app_secret,
    businessNumber: waG.business_number || '',
    configured: !!(waG.phone_number_id && waG.access_token),
    webhookUrl: (config.APP_URL || 'https://portal.lumenmsp.co.uk') + '/webhooks/whatsapp',
    messages: waCount,
  };

  const tmG = await getGroup('teams');
  let teamsMsgCount = 0;
  try { teamsMsgCount = (await pool.query("SELECT COUNT(*)::int n FROM inbox_messages WHERE channel='teams'")).rows[0].n; } catch { /* noop */ }
  const tgs = await teamsGraphStatus();
  const teams = {
    inboundSecretSet: !!tmG.inbound_secret,
    outboundUrl: tmG.outbound_url || '',
    outboundSecretSet: !!tmG.outbound_secret,
    botName: tmG.bot_name || '',
    configured: !!tmG.outbound_url,
    webhookUrl: (config.APP_URL || 'https://portal.lumenmsp.co.uk') + '/webhooks/teams',
    messages: teamsMsgCount,
    graphConnected: tgs.connected,
    graphAccount: tgs.account,
  };

  const anthKey = (await getSetting('anthropic', 'api_key')) || '';
  const anthEnv = (process.env.ANTHROPIC_API_KEY || '').trim();
  const anthropic = {
    keySet: !!anthKey,
    keyMasked: anthKey ? anthKey.slice(0, 8) + '…' + anthKey.slice(-4) : '',
    envSet: !!anthEnv,
    model: (await getSetting('anthropic', 'model')) || 'claude-haiku-4-5-20251001',
  };

  const bufKey = (await getSetting('buffer', 'api_key')) || '';
  const bufEnv = (config.BUFFER_TOKEN || '').trim();
  const buffer = {
    keySet: !!bufKey,
    keyMasked: bufKey ? bufKey.slice(0, 6) + '…' + bufKey.slice(-4) : '',
    envSet: !!bufEnv,
  };

  const pexKey = (await getSetting('pexels', 'api_key')) || '';
  const pexels = {
    keySet: !!pexKey,
    keyMasked: pexKey ? pexKey.slice(0, 6) + '…' + pexKey.slice(-4) : '',
    envSet: !!(process.env.PEXELS_API_KEY || '').trim(),
  };

  res.render('settings/integrations', {
    user: req.session.user!,
    qb: { hasCreds: qb.hasCredentials(), connected: qb.isConnected(), company: qbCompany, env: qb.environment },
    gc: { configured: gc.isConfigured(), env: gcCfg.environment || 'live' },
    teamsWebhook, languagetoolUrl, unifiKey, giacom, dws, atera, wa, teams, anthropic, buffer, pexels,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── Teams via Graph (delegated as sp@) — connect / callback / disconnect ──────────
router.get('/settings/integrations/teams-graph/connect', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  (req.session as any).teamsGraphState = state;
  const hint = String(req.query.hint || 'sp@lumensolutions.co.uk');
  res.redirect(teamsGraphAuthUrl(state, hint));
});

router.get('/settings/integrations/teams-graph/callback', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (req.query.error) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Teams sign-in failed: ' + req.query.error)); return; }
  if (!code || state !== (req.session as any).teamsGraphState) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Teams sign-in state mismatch — try again.')); return; }
  const r = await teamsGraphExchangeCode(code);
  res.redirect('/settings/integrations?' + (r.ok ? 'msg=' + encodeURIComponent('Teams connected as ' + (r.account || 'support account')) : 'err=' + encodeURIComponent('Teams connect failed: ' + r.error)));
});

router.post('/settings/integrations/teams-graph/disconnect', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  await teamsGraphDisconnect();
  res.redirect('/settings/integrations?msg=' + encodeURIComponent('Teams disconnected'));
});

// Diagnostic / manual sync — returns what /me/chats sees and processes new messages.
router.get('/settings/integrations/teams-graph/sync', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try { res.json(await teamsGraphDebug()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Save WhatsApp Cloud API credentials.
router.post('/settings/integrations/whatsapp', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as any;
  await setSetting('whatsapp', 'phone_number_id', (b.phone_number_id || '').trim() || null);
  await setSetting('whatsapp', 'business_number', (b.business_number || '').trim() || null);
  await setSetting('whatsapp', 'verify_token', (b.verify_token || '').trim() || null);
  if ((b.access_token || '').trim()) await setSetting('whatsapp', 'access_token', b.access_token.trim());
  if ((b.app_secret || '').trim()) await setSetting('whatsapp', 'app_secret', b.app_secret.trim());
  res.redirect('/settings/integrations?msg=' + encodeURIComponent('WhatsApp settings saved'));
});

// Fetch new DWS bill-run files over SFTP (leave-and-track).
router.post('/settings/integrations/dws/fetch', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await fetchDwsBillRuns();
    let msg = `DWS: ${r.found} files found — ${r.downloaded} new, ${r.skipped} already had, ${r.errors} errors`;
    if (!r.found && r.entries.length) msg += ` · root contains: ${r.entries.slice(0, 20).join(', ')}`;
    res.redirect('/settings/integrations?msg=' + encodeURIComponent(msg));
  } catch (e: any) {
    res.redirect('/settings/integrations?err=' + encodeURIComponent('DWS fetch failed: ' + (e.message || 'unknown')));
  }
});

// ── Claude (Anthropic) — voice-to-message compose ─────────────────────────────
router.post('/settings/integrations/anthropic', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as any;
  if ((b.api_key || '').trim()) await setSetting('anthropic', 'api_key', b.api_key.trim());
  if (b.clear_key === '1') await setSetting('anthropic', 'api_key', null);
  await setSetting('anthropic', 'model', (b.model || '').trim() || null);
  res.redirect('/settings/integrations?msg=' + encodeURIComponent('Claude settings saved'));
});

// Buffer (social posting) — save / clear the personal API key (overrides server .env).
router.post('/settings/integrations/buffer', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as Record<string, string>;
  if ((b.api_key || '').trim()) await setSetting('buffer', 'api_key', b.api_key.trim());
  if (b.clear_key === '1') await setSetting('buffer', 'api_key', null);
  res.redirect('/settings/integrations?msg=' + encodeURIComponent('Buffer settings saved'));
});

// Pexels (free stock images for the content studio) — save / clear the API key.
router.post('/settings/integrations/pexels', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as Record<string, string>;
  if ((b.api_key || '').trim()) await setSetting('pexels', 'api_key', b.api_key.trim());
  if (b.clear_key === '1') await setSetting('pexels', 'api_key', null);
  res.redirect('/settings/integrations?msg=' + encodeURIComponent('Pexels settings saved'));
});

router.post('/settings/integrations/anthropic/test', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { aiComposeMessage } = await import('../lib/ai-compose');
    const out = await aiComposeMessage({ transcript: 'test: confirm the api key works, reply with a one line hello', channel: 'teams' });
    res.redirect('/settings/integrations?msg=' + encodeURIComponent('Claude OK — sample reply: ' + out.slice(0, 80)));
  } catch (e: any) {
    res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message || 'Claude test failed'));
  }
});

// ── Giacom / Cloud Market keys ────────────────────────────────────────────────
router.post('/settings/integrations/giacom', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as any;
  // Only overwrite a key when a new value is supplied (blank = keep existing).
  if ((b.billing_key || '').trim()) await setSetting('giacom', 'billing_key', b.billing_key.trim());
  if ((b.partnercenter_key || '').trim()) await setSetting('giacom', 'partnercenter_key', b.partnercenter_key.trim());
  await setSetting('giacom', 'billing_base_url', (b.billing_base_url || '').trim() || null);
  await setSetting('giacom', 'partnercenter_base_url', (b.partnercenter_base_url || '').trim() || null);
  res.redirect('/settings/integrations?msg=Giacom+settings+saved');
});

router.post('/settings/integrations/giacom/test', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const r = await giacomBillingTest();
  res.redirect('/settings/integrations?' + (r.ok ? 'msg=' : 'err=') + encodeURIComponent('Giacom: ' + r.message));
});

// Manual "Sync now" — pull Giacom billing into service_items.
router.post('/settings/integrations/giacom/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await syncGiacomBilling();
    try { const { syncItCloudDeltas } = await import('../lib/it-cloud-deltas'); await syncItCloudDeltas(); } catch (e2) { console.error('[itcloud-deltas] manual post-sync failed:', (e2 as Error).message); }
    res.redirect('/settings/integrations?msg=' + encodeURIComponent(`Giacom synced: ${r.fetched} items across ${r.customers} accounts — ${r.matched} matched, ${r.unmatched} unmatched`));
  } catch (e: any) {
    res.redirect('/settings/integrations?err=' + encodeURIComponent('Giacom sync failed: ' + (e.message || 'unknown')));
  }
});

// Match supplier accounts (Giacom, Lumen, …) to portal customers — auto-match misses
// + new lines each month. Shows unmatched first, across all sources.
router.get('/settings/giacom/match', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const accounts = (await pool.query(
    `SELECT source, external_customer_id AS gid, MAX(external_customer_name) AS gname,
            (ARRAY_AGG(customer_id) FILTER (WHERE customer_id IS NOT NULL))[1] AS customer_id,
            COUNT(*)::int AS items, SUM(total_cost)::numeric AS total
     FROM service_items WHERE external_customer_id IS NOT NULL
     GROUP BY source, external_customer_id
     ORDER BY (ARRAY_AGG(customer_id) FILTER (WHERE customer_id IS NOT NULL))[1] IS NOT NULL, source, MAX(external_customer_name)`
  )).rows;
  const customers = (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name")).rows;
  const nameById: Record<number, string> = {};
  customers.forEach((c: any) => { nameById[c.id] = c.name; });
  res.render('settings/giacom-match', { user: req.session.user!, accounts, customers, nameById, notice: req.query.msg || null });
});

router.post('/settings/giacom/link', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const source = ((req.body.source || '').trim()) || 'giacom';
  const gid = (req.body.gid || '').trim();
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  if (gid && customerId) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,$2,$3)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [customerId, source, gid]
    );
    await pool.query("UPDATE service_items SET customer_id=$1 WHERE source=$2 AND external_customer_id=$3", [customerId, source, gid]);
  }
  res.redirect('/settings/giacom/match?msg=Linked');
});

router.post('/settings/integrations/teams', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  await setSetting('integrations', 'teams_webhook', ((req.body as any).teams_webhook || '').trim() || null);
  res.redirect('/settings/integrations?msg=Teams+notifications+saved');
});

// Teams as a customer channel (two-way) — inbound webhook secret + outbound relay URL.
router.post('/settings/integrations/teams-channel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body as any;
  await setSetting('teams', 'outbound_url', (b.outbound_url || '').trim() || null);
  await setSetting('teams', 'bot_name', (b.bot_name || '').trim() || null);
  if ((b.inbound_secret || '').trim()) await setSetting('teams', 'inbound_secret', b.inbound_secret.trim());
  if ((b.outbound_secret || '').trim()) await setSetting('teams', 'outbound_secret', b.outbound_secret.trim());
  res.redirect('/settings/integrations?msg=' + encodeURIComponent('Teams channel settings saved'));
});

router.post('/settings/integrations/languagetool', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  await setSetting('integrations', 'languagetool_url', ((req.body as any).languagetool_url || '').trim() || null);
  res.redirect('/settings/integrations?msg=Grammar+checker+saved');
});

// UniFi Site Manager API key (drives the device-offline poller + alerts). Group 'unifi' / 'api_key'.
router.post('/settings/integrations/unifi', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  await setSetting('unifi', 'api_key', ((req.body as any).unifi_api_key || '').trim() || null);
  res.redirect('/settings/integrations?msg=UniFi+API+key+saved');
});

// ── QuickBooks OAuth ─────────────────────────────────────────────────────────────
router.get('/settings/quickbooks/connect', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.hasCredentials()) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Set QB_CLIENT_ID/SECRET in .env first.')); return; }
  const state = crypto.randomBytes(16).toString('hex');
  (req.session as any).qbState = state;
  res.redirect(qb.getAuthUrl(QB_REDIRECT, state));
});

router.get('/settings/quickbooks/callback', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { code, state, realmId } = req.query as Record<string, string>;
  if (!code || !realmId || state !== (req.session as any).qbState) {
    res.redirect('/settings/integrations?err=' + encodeURIComponent('QuickBooks authorisation failed or state mismatch.')); return;
  }
  const qb = await QuickBooks.load();
  const ok = await qb.exchangeCode(code, QB_REDIRECT, realmId, config.QB_ENVIRONMENT);
  res.redirect('/settings/integrations?' + (ok ? 'msg=QuickBooks+connected' : 'err=Token+exchange+failed'));
});

router.post('/settings/quickbooks/disconnect', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  await qb.disconnect();
  res.redirect('/settings/integrations?msg=QuickBooks+disconnected');
});

router.post('/settings/quickbooks/import-invoices', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  try {
    const since = String(req.body.since || '').trim() || undefined;
    const until = String(req.body.until || '').trim() || undefined;
    const r = await qb.importInvoices({ since, until });
    const range = since || until ? ` (${since || '…'} → ${until || 'now'})` : '';
    res.redirect('/settings/integrations?msg=' + encodeURIComponent(`Imported ${r.imported} invoices${range} (${r.skipped} skipped)`));
  } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); }
});

// Read-only: show which QuickBooks invoices aren't in the portal yet.
router.get('/settings/quickbooks/reconcile', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  try {
    const since = String(req.query.since || '').trim() || undefined;
    const until = String(req.query.until || '').trim() || undefined;
    const r = await qb.reconcileInvoices({ since, until });
    res.render('settings/qb-reconcile', { user: req.session.user!, ...r, since: since || '', until: until || '' });
  } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); }
});

// ── QB customer match tool ──────────────────────────────────────────────────────
router.get('/settings/quickbooks/match-customers', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  let qbCustomers: any[] = [];
  try { qbCustomers = await qb.getCustomers(); } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); return; }

  const ignored = new Set(((await getSetting('quickbooks', 'ignored_customers')) || '').split(',').map((s: string) => s.trim()).filter(Boolean));

  const portal = (await pool.query(`SELECT id, name, quickbooks_customer_id FROM customers WHERE deleted_at IS NULL AND is_placeholder=false`)).rows;
  const byQbId: Record<string, any> = {};
  const nameCount: Record<string, number> = {};
  const nameToCustomer: Record<string, any> = {};
  for (const c of portal) {
    if (c.quickbooks_customer_id) byQbId[String(c.quickbooks_customer_id)] = c;
    const k = (c.name || '').toLowerCase().trim();
    nameCount[k] = (nameCount[k] || 0) + 1; nameToCustomer[k] = c;
  }

  // Auto-link: exact (unique) name match to an unlinked portal customer
  let autoLinked = 0;
  for (const qc of qbCustomers) {
    if (ignored.has(String(qc.Id)) || byQbId[String(qc.Id)]) continue;
    const k = (qc.DisplayName || '').toLowerCase().trim();
    const pc = nameCount[k] === 1 ? nameToCustomer[k] : null;
    if (pc && !pc.quickbooks_customer_id) {
      await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qc.Id, pc.id]);
      pc.quickbooks_customer_id = qc.Id; byQbId[String(qc.Id)] = pc; autoLinked++;
    }
  }

  const rows = qbCustomers.filter((qc: any) => !ignored.has(String(qc.Id))).map((qc: any) => {
    const linked = byQbId[String(qc.Id)] || null;
    const k = (qc.DisplayName || '').toLowerCase().trim();
    const suggest = !linked && nameCount[k] >= 1 ? nameToCustomer[k] : null;
    return { qbId: qc.Id, qbName: qc.DisplayName, linked, suggest };
  }).sort((a, b) => a.qbName.localeCompare(b.qbName));

  const stats = {
    total: qbCustomers.length,
    linked: rows.filter((r) => r.linked).length,
    suggested: rows.filter((r) => !r.linked && r.suggest).length,
    unmatched: rows.filter((r) => !r.linked && !r.suggest).length,
    ignored: ignored.size, autoLinked,
  };
  const unmatchedCustomers = portal.filter((c: any) => !c.quickbooks_customer_id);
  res.render('settings/qb-customers', { user: req.session.user!, rows, stats, unmatchedCustomers, notice: req.query.msg || null });
});

router.post('/settings/quickbooks/create-customer-in-qb', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  const c = (await pool.query('SELECT id, name, email, phone, website FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!c) { res.redirect('/settings/quickbooks/match-customers?msg=Customer+not+found'); return; }
  try {
    const qbId = await qb.findOrCreateCustomer({ name: c.name, email: c.email, phone: c.phone, website: c.website });
    await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbId, customerId]);
    res.redirect('/settings/quickbooks/match-customers?msg=' + encodeURIComponent('Created "' + c.name + '" in QuickBooks'));
  } catch (e: any) { res.redirect('/settings/quickbooks/match-customers?msg=' + encodeURIComponent('Create in QB failed: ' + e.message)); }
});

router.post('/settings/quickbooks/link-customer', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qbId = (req.body.qb_id || '').trim();
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  if (qbId && customerId) await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbId, customerId]);
  res.redirect('/settings/quickbooks/match-customers?msg=Linked');
});

router.post('/settings/quickbooks/create-customer-in-portal', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const qbId = (req.body.qb_id || '').trim();
  const name = (req.body.name || '').trim();
  if (qbId && name) {
    await pool.query(
      `INSERT INTO customers (name, status, quickbooks_customer_id, created_by) VALUES ($1,'active',$2,$3)
       ON CONFLICT DO NOTHING`, [name, qbId, user.id]
    );
  }
  res.redirect('/settings/quickbooks/match-customers?msg=Created+in+portal');
});

router.post('/settings/quickbooks/ignore-customer', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qbId = (req.body.qb_id || '').trim();
  if (qbId) {
    const set = new Set(((await getSetting('quickbooks', 'ignored_customers')) || '').split(',').map((s: string) => s.trim()).filter(Boolean));
    set.add(qbId);
    await setSetting('quickbooks', 'ignored_customers', Array.from(set).join(','));
  }
  res.redirect('/settings/quickbooks/match-customers?msg=Ignored');
});

router.post('/settings/quickbooks/clear-ignored', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  await setSetting('quickbooks', 'ignored_customers', '');
  res.redirect('/settings/quickbooks/match-customers?msg=Ignore+list+cleared');
});

router.post('/settings/quickbooks/import-all-customers', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  let created = 0, linked = 0;
  try {
    const ignored = new Set(((await getSetting('quickbooks', 'ignored_customers')) || '').split(',').map((s: string) => s.trim()).filter(Boolean));
    const qbCustomers = await qb.getCustomers();
    const portal = (await pool.query(`SELECT id, name, quickbooks_customer_id FROM customers WHERE deleted_at IS NULL AND is_placeholder=false`)).rows;
    const byQbId = new Set(portal.filter((c: any) => c.quickbooks_customer_id).map((c: any) => String(c.quickbooks_customer_id)));
    const byName: Record<string, number> = {};
    for (const c of portal) byName[(c.name || '').toLowerCase().trim()] = c.id;
    for (const qc of qbCustomers) {
      if (byQbId.has(String(qc.Id)) || ignored.has(String(qc.Id))) continue;
      const match = byName[(qc.DisplayName || '').toLowerCase().trim()];
      if (match) { await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qc.Id, match]); linked++; }
      else { await pool.query(`INSERT INTO customers (name, status, quickbooks_customer_id, created_by) VALUES ($1,'active',$2,$3)`, [qc.DisplayName, qc.Id, user.id]); created++; }
    }
  } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); return; }
  res.redirect('/settings/quickbooks/match-customers?msg=' + encodeURIComponent(`Linked ${linked}, created ${created}`));
});

// ── QB item / product match tool ────────────────────────────────────────────────
router.get('/settings/quickbooks/match-items', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  let qbItems: any[] = [];
  try { qbItems = await qb.getItems(); } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); return; }

  const ignored = new Set(((await getSetting('quickbooks', 'ignored_items')) || '').split(',').map((s: string) => s.trim()).filter(Boolean));
  const products = (await pool.query(`SELECT id, name, quickbooks_item_id FROM asset_products WHERE is_active=true`)).rows;
  const byQbId: Record<string, any> = {}, nameCount: Record<string, number> = {}, nameToProduct: Record<string, any> = {};
  for (const p of products) { if (p.quickbooks_item_id) byQbId[String(p.quickbooks_item_id)] = p; const k = (p.name || '').toLowerCase().trim(); nameCount[k] = (nameCount[k] || 0) + 1; nameToProduct[k] = p; }

  let autoLinked = 0;
  for (const qi of qbItems) {
    if (ignored.has(String(qi.Id)) || byQbId[String(qi.Id)]) continue;
    const k = (qi.Name || '').toLowerCase().trim();
    const p = nameCount[k] === 1 ? nameToProduct[k] : null;
    if (p && !p.quickbooks_item_id) { await pool.query('UPDATE asset_products SET quickbooks_item_id=$1 WHERE id=$2', [qi.Id, p.id]); p.quickbooks_item_id = qi.Id; byQbId[String(qi.Id)] = p; autoLinked++; }
  }

  const rows = qbItems.filter((qi: any) => !ignored.has(String(qi.Id))).map((qi: any) => {
    const linked = byQbId[String(qi.Id)] || null;
    const k = (qi.Name || '').toLowerCase().trim();
    const suggest = !linked && nameCount[k] >= 1 ? nameToProduct[k] : null;
    return { qbId: qi.Id, qbName: qi.Name, qbType: qi.Type, linked, suggest };
  }).sort((a, b) => a.qbName.localeCompare(b.qbName));

  const stats = { total: qbItems.length, linked: rows.filter((r) => r.linked).length, unmatched: rows.filter((r) => !r.linked && !r.suggest).length, ignored: ignored.size, autoLinked };
  const unmatchedProducts = products.filter((p: any) => !p.quickbooks_item_id);
  const defaults: any = {
    item_comms: (await getSetting('quickbooks', 'item_comms')) || '',
    item_giacom: (await getSetting('quickbooks', 'item_giacom')) || '',
    item_default: (await getSetting('quickbooks', 'item_default')) || '',
    tax_code_standard: (await getSetting('quickbooks', 'tax_code_standard')) || '7',
    tax_code_zero: (await getSetting('quickbooks', 'tax_code_zero')) || '',
  };
  for (const cat of ['voice', 'mobile', 'internet', 'additional', 'oneoff', 'call']) defaults['item_cat_' + cat] = (await getSetting('quickbooks', 'item_cat_' + cat)) || '';
  res.render('settings/qb-items', { user: req.session.user!, rows, stats, unmatchedProducts, defaults, notice: req.query.msg || null });
});

// Save the default QB items (per comms category + source) + VAT tax-code IDs.
router.post('/settings/quickbooks/defaults', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const keys = ['item_comms', 'item_giacom', 'item_default', 'tax_code_standard', 'tax_code_zero',
    'item_cat_voice', 'item_cat_mobile', 'item_cat_internet', 'item_cat_additional', 'item_cat_oneoff', 'item_cat_call'];
  for (const k of keys) await setSetting('quickbooks', k, String(req.body[k] || '').trim());
  res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent('Default items & VAT codes saved'));
});

// One-click: create the comms-category items in QuickBooks (Simply VoIP, Simply Mobile, etc.) and
// map each comms category to them. Idempotent — re-links existing items by name.
router.post('/settings/quickbooks/create-comms-items', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  let incomeId = '';
  try { const accts = await qb.getIncomeAccounts(); incomeId = accts[0]?.Id || ''; } catch { /* ignore */ }
  if (!incomeId) { res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent('No QuickBooks income account found to create items against.')); return; }
  const names: Record<string, string> = { voice: 'Simply VoIP', mobile: 'Simply Mobile', internet: 'Broadband & Connectivity', additional: 'Additional Services', oneoff: 'One-off Charges', call: 'Call Charges' };
  let n = 0; const fails: string[] = [];
  for (const [cat, name] of Object.entries(names)) {
    try { const id = await qb.createItem(name, incomeId); await setSetting('quickbooks', 'item_cat_' + cat, id); n++; }
    catch (e: any) { fails.push(name + ': ' + e.message); }
  }
  res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent(`Created/linked ${n} comms QB item(s) and mapped them.` + (fails.length ? ' Issues: ' + fails.join('; ') : '')));
});

router.post('/settings/quickbooks/create-item-in-qb', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.body.product_id || ''), 10);
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  const p = (await pool.query('SELECT id, name FROM asset_products WHERE id=$1', [productId])).rows[0];
  if (!p) { res.redirect('/settings/quickbooks/match-items?msg=Product+not+found'); return; }
  try {
    const accounts = await qb.getIncomeAccounts();
    if (!accounts.length) throw new Error('No income account in QuickBooks to attach the item to.');
    const qbId = await qb.createItem(p.name, accounts[0].Id);
    await pool.query('UPDATE asset_products SET quickbooks_item_id=$1 WHERE id=$2', [qbId, productId]);
    res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent('Created "' + p.name + '" in QuickBooks'));
  } catch (e: any) { res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent('Create in QB failed: ' + e.message)); }
});

// Bulk: create every unmatched portal product as a Service item in QuickBooks.
router.post('/settings/quickbooks/create-all-items-in-qb', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  try {
    const accounts = await qb.getIncomeAccounts();
    if (!accounts.length) throw new Error('No income account in QuickBooks to attach items to.');
    const incomeId = accounts[0].Id;
    const products = (await pool.query(
      `SELECT id, name FROM asset_products WHERE is_active=true AND quickbooks_item_id IS NULL AND name IS NOT NULL AND name <> '' ORDER BY name`
    )).rows;
    let created = 0; const failed: string[] = [];
    for (const p of products) {
      try {
        const qbId = await qb.createItem(p.name, incomeId);
        await pool.query('UPDATE asset_products SET quickbooks_item_id=$1 WHERE id=$2', [qbId, p.id]);
        created++;
      } catch (e: any) { failed.push(p.name + ' (' + (e.message || 'error').slice(0, 60) + ')'); }
    }
    const msg = `Created/linked ${created} item(s) in QuickBooks` + (failed.length ? `; ${failed.length} failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}` : '');
    res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent(msg));
  } catch (e: any) { res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent('Create all failed: ' + e.message)); }
});

router.post('/settings/quickbooks/link-item', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qbId = (req.body.qb_item_id || '').trim();
  const productId = parseInt(String(req.body.product_id || ''), 10);
  if (qbId && productId) await pool.query('UPDATE asset_products SET quickbooks_item_id=$1 WHERE id=$2', [qbId, productId]);
  res.redirect('/settings/quickbooks/match-items?msg=Linked');
});

router.post('/settings/quickbooks/create-product-from-item', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qbId = (req.body.qb_item_id || '').trim();
  const name = (req.body.name || '').trim();
  if (qbId && name) await pool.query(`INSERT INTO asset_products (name, item_type, is_active, quickbooks_item_id) VALUES ($1,'service',true,$2)`, [name, qbId]);
  res.redirect('/settings/quickbooks/match-items?msg=Created+in+portal');
});

router.post('/settings/quickbooks/ignore-item', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qbId = (req.body.qb_item_id || '').trim();
  if (qbId) {
    const set = new Set(((await getSetting('quickbooks', 'ignored_items')) || '').split(',').map((s: string) => s.trim()).filter(Boolean));
    set.add(qbId); await setSetting('quickbooks', 'ignored_items', Array.from(set).join(','));
  }
  res.redirect('/settings/quickbooks/match-items?msg=Ignored');
});

router.post('/settings/quickbooks/import-all-items', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  let created = 0, linked = 0;
  try {
    const ignored = new Set(((await getSetting('quickbooks', 'ignored_items')) || '').split(',').map((s: string) => s.trim()).filter(Boolean));
    const qbItems = await qb.getItems();
    const products = (await pool.query(`SELECT id, name, quickbooks_item_id FROM asset_products WHERE is_active=true`)).rows;
    const byQbId = new Set(products.filter((p: any) => p.quickbooks_item_id).map((p: any) => String(p.quickbooks_item_id)));
    const byName: Record<string, number> = {};
    for (const p of products) byName[(p.name || '').toLowerCase().trim()] = p.id;
    for (const qi of qbItems) {
      if (byQbId.has(String(qi.Id)) || ignored.has(String(qi.Id))) continue;
      const match = byName[(qi.Name || '').toLowerCase().trim()];
      if (match) { await pool.query('UPDATE asset_products SET quickbooks_item_id=$1 WHERE id=$2', [qi.Id, match]); linked++; }
      else { await pool.query(`INSERT INTO asset_products (name, item_type, is_active, quickbooks_item_id) VALUES ($1,'service',true,$2)`, [qi.Name, qi.Id]); created++; }
    }
  } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); return; }
  res.redirect('/settings/quickbooks/match-items?msg=' + encodeURIComponent(`Linked ${linked}, created ${created}`));
});

// ── QB defaults (line item service + VAT code) ──────────────────────────────────
router.get('/settings/quickbooks/defaults', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  let items: any[] = [], taxCodes: any[] = [];
  try { items = await qb.getItems(); taxCodes = await qb.getTaxCodes(); }
  catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); return; }
  const currentItem = (await getSetting('quickbooks', 'default_item_id')) || '';
  const currentTax = (await getSetting('quickbooks', 'default_tax_code')) || '';
  res.render('settings/qb-defaults', { user: req.session.user!, items, taxCodes, currentItem, currentTax, notice: req.query.msg || null });
});

router.post('/settings/quickbooks/save-defaults', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if ((req.body.default_item_id || '').trim()) await setSetting('quickbooks', 'default_item_id', req.body.default_item_id.trim());
  if ((req.body.default_tax_code || '').trim()) await setSetting('quickbooks', 'default_tax_code', req.body.default_tax_code.trim());
  res.redirect('/settings/quickbooks/defaults?msg=Defaults+saved');
});

// ── Push an invoice to QuickBooks ───────────────────────────────────────────────
router.post('/invoices/:id/push-to-qb', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT i.*, c.id AS cust_id, c.quickbooks_customer_id, c.name, c.email, c.phone, c.website
     FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const inv = r.rows[0];
  if (!inv.cust_id) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Invoice has no customer.')); return; }
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('QuickBooks not connected.')); return; }
  try {
    let qbCust = inv.quickbooks_customer_id;
    if (!qbCust) {
      qbCust = await qb.findOrCreateCustomer({ name: inv.name, email: inv.email, phone: inv.phone, website: inv.website });
      await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbCust, inv.cust_id]);
    }
    const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [id])).rows;
    const qbInvId = await qb.pushInvoice(inv, items, qbCust);
    await pool.query('UPDATE invoices SET quickbooks_invoice_id=$1 WHERE id=$2', [qbInvId, id]);
    res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Pushed to QuickBooks'));
  } catch (e: any) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent(e.message)); }
});

// ── Complete an invoice: email finance contact + push to QB + submit for payment ─
// Complete an invoice: email finance contact, push/amend in QuickBooks, submit to
// GoCardless (with charge_date = due date). Returns the per-step results, or null if
// the invoice doesn't exist. Shared by the single Complete button and batch Complete.
export async function completeInvoice(id: number, userId: number): Promise<string[] | null> {
  const r = await pool.query(
    `SELECT i.*, c.id AS cust_id, c.name, c.email, c.phone, c.website, c.quickbooks_customer_id,
            c.gocardless_mandate_id, c.billing_contact_id
     FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL`, [id]
  );
  if (!r.rows.length) return null;
  const inv = r.rows[0];
  const user = { id: userId };
  const results: string[] = [];

  // 1. Email the FINANCE/billing contact only, WITH the invoice PDF attached + branded summary.
  let to = '', toName = '';
  if (inv.billing_contact_id) { const bc = await pool.query('SELECT email, full_name FROM customer_contacts WHERE id=$1', [inv.billing_contact_id]); to = bc.rows[0]?.email || ''; toName = bc.rows[0]?.full_name || ''; }
  if (!isEmailAddr(to)) { results.push('no finance contact email — not emailed'); }
  else {
    try {
      const pdf = await renderInvoicePdf(id);
      if (!pdf || pdf.length < 1000) throw new Error('PDF render produced an empty file');
      const total = '£' + (Number(inv.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const dueDate = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
      const body = invoiceEmailHtml({ contactName: toName || inv.name, invoiceNumber: inv.invoice_number, title: inv.title, total, dueDate, directDebit: !!inv.gocardless_mandate_id });
      await sendMail({
        to, subject: 'Invoice ' + inv.invoice_number + ' from Lumen IT Solutions',
        html: body, signatureName: 'Accounts Department',
        attachments: [{ filename: inv.invoice_number + '.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') }],
      });
      await pool.query(
        `INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, sent_by_user_id)
         VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6,$7)`,
        [id, config.FROM_NAME, config.FROM_EMAIL, to, 'Invoice ' + inv.invoice_number, 'Invoice ' + inv.invoice_number + ' emailed with PDF.', user.id]
      );
      await pool.query("UPDATE invoices SET emailed_at=NOW(), status=CASE WHEN status='draft' THEN 'issued' ELSE status END WHERE id=$1", [id]);
      results.push('emailed ' + to);
    } catch (e: any) { results.push('email failed: ' + (e.message || 'error')); }
  }

  // 2. Push/amend in QuickBooks (re-Complete after an edit syncs the change).
  try {
    const qb = await QuickBooks.load();
    if (!qb.isConnected()) { results.push('QB not connected'); }
    else {
      let qbCust = inv.quickbooks_customer_id;
      if (!qbCust && inv.cust_id) { qbCust = await qb.findOrCreateCustomer({ name: inv.name, email: inv.email, phone: inv.phone, website: inv.website }); await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbCust, inv.cust_id]); }
      if (!qbCust) { results.push('no QB customer'); }
      else {
        const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [id])).rows;
        if (inv.quickbooks_invoice_id) {
          await qb.updateInvoice(inv, items, qbCust, inv.quickbooks_invoice_id);
          results.push('amended in QB');
        } else {
          const qbId = await qb.pushInvoice(inv, items, qbCust);
          await pool.query('UPDATE invoices SET quickbooks_invoice_id=$1 WHERE id=$2', [qbId, id]);
          results.push('pushed to QB');
        }
      }
    }
  } catch (e: any) { results.push('QB failed: ' + e.message); }

  // 3. Direct Debit: collect if there's a mandate; if NOT, email the customer a DD-setup invite.
  try {
    const gc = await GoCardless.load();
    if (!gc.isConfigured()) { results.push('GC not configured'); }
    else if (inv.gocardless_mandate_id) {
      const pence = Math.round(Number(inv.total) * 100);
      if (pence <= 0) { results.push('£0 invoice — no Direct Debit taken'); }
      else if (inv.gocardless_payment_id && inv.payment_status !== 'failed') { results.push('already submitted for payment'); }
      else {
        const gcId = await gc.createPayment(inv.gocardless_mandate_id, pence, 'Invoice ' + inv.invoice_number, chargeDateFor(inv.due_date));
        await pool.query(`UPDATE invoices SET gocardless_payment_id=$1, payment_status='pending' WHERE id=$2`, [gcId, id]);
        results.push('submitted for payment');
      }
    } else if (isEmailAddr(to)) {
      // No mandate → send a Direct Debit setup invite to the finance contact.
      const flow = await gc.createMandateSetupFlow({
        redirectUri: config.APP_URL + '/gc/return', exitUri: config.APP_URL + '/gc/return',
        email: to, companyName: inv.name, metadata: { customer_id: String(inv.cust_id || '') },
      });
      await sendMail({
        to, subject: 'Set up Direct Debit — Lumen IT Solutions',
        html: `<p>Hi ${toName || inv.name || 'there'},</p><p>To pay your invoices automatically by Direct Debit, please set up a mandate using the secure link below (it takes a minute):</p><p><a href="${flow.authorisationUrl}">Set up Direct Debit</a></p>`,
        signatureName: 'Accounts Department',
      });
      results.push('DD invite sent');
    } else { results.push('no mandate, no finance email for invite'); }
  } catch (e: any) { results.push('payment failed: ' + e.message); }

  return results;
}

// ── Granular per-invoice actions (for bulk operations on the invoices list) ──────
// Each returns a short status string; a success result starts with a verb (emailed/pushed/amended/
// submitted/reminder). Anything else is a skip/condition, surfaced to the user.
async function loadInvForAction(id: number): Promise<any> {
  const r = await pool.query(
    `SELECT i.*, c.id AS cust_id, c.name, c.email, c.phone, c.website, c.quickbooks_customer_id,
            c.gocardless_mandate_id, c.billing_contact_id
       FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL`, [id]);
  return r.rows[0] || null;
}
async function billingEmail(inv: any): Promise<{ to: string; name: string }> {
  if (inv.billing_contact_id) {
    const bc = await pool.query('SELECT email, full_name FROM customer_contacts WHERE id=$1', [inv.billing_contact_id]);
    return { to: bc.rows[0]?.email || '', name: bc.rows[0]?.full_name || '' };
  }
  return { to: '', name: '' };
}

export async function emailInvoiceAction(id: number, userId: number): Promise<string> {
  const inv = await loadInvForAction(id); if (!inv) return 'not found';
  const { to, name } = await billingEmail(inv);
  if (!isEmailAddr(to)) return 'no billing email';
  const pdf = await renderInvoicePdf(id);
  if (!pdf || pdf.length < 1000) throw new Error('empty PDF');
  const total = '£' + (Number(inv.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dueDate = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  const body = invoiceEmailHtml({ contactName: name || inv.name, invoiceNumber: inv.invoice_number, title: inv.title, total, dueDate, directDebit: !!inv.gocardless_mandate_id });
  await sendMail({ to, subject: 'Invoice ' + inv.invoice_number + ' from Lumen IT Solutions', html: body, signatureName: 'Accounts Department',
    attachments: [{ filename: inv.invoice_number + '.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') }] });
  await pool.query(`INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, sent_by_user_id)
                    VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6,$7)`,
    [id, config.FROM_NAME, config.FROM_EMAIL, to, 'Invoice ' + inv.invoice_number, 'Invoice emailed (bulk).', userId]);
  await pool.query("UPDATE invoices SET emailed_at=NOW(), status=CASE WHEN status='draft' THEN 'issued' ELSE status END WHERE id=$1", [id]);
  return 'emailed ' + to;
}

export async function pushInvoiceToQBAction(id: number): Promise<string> {
  const inv = await loadInvForAction(id); if (!inv) return 'not found';
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) return 'QB not connected';
  let qbCust = inv.quickbooks_customer_id;
  if (!qbCust && inv.cust_id) { qbCust = await qb.findOrCreateCustomer({ name: inv.name, email: inv.email, phone: inv.phone, website: inv.website }); await pool.query('UPDATE customers SET quickbooks_customer_id=$1 WHERE id=$2', [qbCust, inv.cust_id]); }
  if (!qbCust) return 'no QB customer';
  const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [id])).rows;
  if (inv.quickbooks_invoice_id) { await qb.updateInvoice(inv, items, qbCust, inv.quickbooks_invoice_id); return 'amended in QB'; }
  const qbId = await qb.pushInvoice(inv, items, qbCust);
  await pool.query('UPDATE invoices SET quickbooks_invoice_id=$1 WHERE id=$2', [qbId, id]);
  return 'pushed to QB';
}

export async function submitInvoiceToGCAction(id: number): Promise<string> {
  const inv = await loadInvForAction(id); if (!inv) return 'not found';
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) return 'GC not configured';
  if (!inv.gocardless_mandate_id) return 'no DD mandate';
  const pence = Math.round(Number(inv.total) * 100);
  if (pence <= 0) return 'zero total - skipped';
  if (inv.gocardless_payment_id && inv.payment_status !== 'failed') return 'already submitted';
  const gcId = await gc.createPayment(inv.gocardless_mandate_id, pence, 'Invoice ' + inv.invoice_number, chargeDateFor(inv.due_date));
  await pool.query(`UPDATE invoices SET gocardless_payment_id=$1, payment_status='pending' WHERE id=$2`, [gcId, id]);
  return 'submitted for payment';
}

export async function remindInvoiceAction(id: number, userId: number): Promise<string> {
  const inv = await loadInvForAction(id); if (!inv) return 'not found';
  if (inv.payment_status === 'paid') return 'already paid - skipped';
  const { to, name } = await billingEmail(inv);
  if (!isEmailAddr(to)) return 'no billing email';
  const amount = '£' + (Number(inv.balance ?? inv.total) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dueDate = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  const dd = !!inv.gocardless_mandate_id;
  let pdf: Buffer | null = null; try { pdf = await renderInvoicePdf(id); } catch { /* attach optional */ }
  const html = `<p>Hi ${name || inv.name || 'there'},</p>`
    + `<p>This is a friendly reminder that invoice <strong>${inv.invoice_number}</strong> for <strong>${amount}</strong>${dueDate ? ' (due ' + dueDate + ')' : ''} is showing as outstanding on our records.</p>`
    + (dd ? '<p>You pay by Direct Debit, so no action is needed if collection is already scheduled.</p>'
          : '<p>Please arrange payment at your earliest convenience; a copy of the invoice is attached.</p>')
    + '<p>If you have already paid, thank you and please ignore this message.</p>';
  await sendMail({ to, subject: 'Payment reminder - invoice ' + inv.invoice_number, html, signatureName: 'Accounts Department',
    attachments: (pdf && pdf.length > 1000) ? [{ filename: inv.invoice_number + '.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') }] : undefined });
  await pool.query(`INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, sent_by_user_id)
                    VALUES ('invoice',$1,'outbound',$2,$3,$4,$5,$6,$7)`,
    [id, config.FROM_NAME, config.FROM_EMAIL, to, 'Payment reminder ' + inv.invoice_number, 'Reminder sent (bulk).', userId]);
  return 'reminder sent ' + to;
}

router.post('/invoices/:id/complete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const results = await completeInvoice(id, req.session.user!.id);
  if (!results) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Complete — ' + results.join(' · ')));
});

// Batch Complete — runs Complete (email + QB + GoCardless) over a set of selected invoices.
// Each invoice does several network round-trips, so a large selection easily exceeds the
// Nginx proxy timeout (504). We therefore run it as a fire-and-forget BACKGROUND job and
// return immediately; progress is written to setting invoices/batch_status and polled by the
// list page. One job at a time.
let _batchRunning = false;

async function runBatchComplete(ids: number[], userId: number): Promise<void> {
  _batchRunning = true;
  const status = { running: true, total: ids.length, done: 0, ok: 0, errs: [] as string[], startedAt: new Date().toISOString(), finishedAt: null as string | null };
  await setSetting('invoices', 'batch_status', JSON.stringify(status));
  for (const id of ids) {
    try { const r = await completeInvoice(id, userId); if (r) status.ok++; else status.errs.push('#' + id + ' not found'); }
    catch (e: any) { status.errs.push('#' + id + ': ' + (e.message || 'error')); }
    status.done++;
    // Persist progress every few invoices so the poller sees movement.
    if (status.done % 3 === 0 || status.done === ids.length) await setSetting('invoices', 'batch_status', JSON.stringify(status));
  }
  status.running = false; status.finishedAt = new Date().toISOString();
  await setSetting('invoices', 'batch_status', JSON.stringify(status));
  _batchRunning = false;
}

router.post('/invoices/batch-complete', requireAuth, async (req: Request, res: Response) => {
  const ids = ([] as any[]).concat(req.body.ids || []).map((n) => parseInt(String(n), 10)).filter(Boolean);
  const wantsJson = req.xhr || String(req.headers.accept || '').includes('application/json');
  if (!ids.length) { wantsJson ? res.status(400).json({ ok: false, error: 'No invoices selected.' }) : res.redirect('/invoices?err=' + encodeURIComponent('No invoices selected.')); return; }
  if (_batchRunning) { wantsJson ? res.status(409).json({ ok: false, error: 'A batch is already running — wait for it to finish.' }) : res.redirect('/invoices?err=' + encodeURIComponent('A batch is already running — wait for it to finish.')); return; }
  // Fire and forget; do not await — the request returns immediately and progress is polled.
  runBatchComplete(ids, req.session.user!.id).catch((e) => console.error('[batch-complete]', e.message));
  if (wantsJson) { res.json({ ok: true, started: true, total: ids.length }); return; }
  res.redirect('/invoices?batch=running&msg=' + encodeURIComponent(`Completing ${ids.length} invoice(s) in the background — this page will update as they finish.`));
});
// (GET /invoices/batch-status lives in routes/invoices.ts, declared before '/invoices/:id'.)

// ── GoCardless ──────────────────────────────────────────────────────────────────
// Public landing page the customer returns to after completing the GoCardless DD-setup flow.
// The mandate is created on GoCardless's side; it links back to the customer via the billing
// request metadata (and shows up on the GoCardless customer-match screen / next sync).
router.get('/gc/return', (_req: Request, res: Response) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Direct Debit set up</title></head>
    <body style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#374151;text-align:center;">
      <h1 style="color:#166534;">✓ Thank you</h1>
      <p>Your Direct Debit has been set up with Lumen IT Solutions. Future invoices will be collected automatically — there's nothing more you need to do.</p>
      <p style="color:#9ca3af;font-size:13px;margin-top:30px;">You can close this window.</p>
    </body></html>`);
});

router.post('/settings/gocardless/save', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const key = (req.body.api_key || '').trim();
  const env = req.body.environment === 'sandbox' ? 'sandbox' : 'live';
  if (key) await setSetting('gocardless', 'api_key', key);
  await setSetting('gocardless', 'environment', env);
  res.redirect('/settings/integrations?msg=GoCardless+saved');
});

// ── GoCardless customer/mandate matching ─────────────────────────────────────────
// Pull GoCardless customers + their active mandates and reconcile to portal customers.
// Shows CURRENT matches (already linked), auto-links exact unique name/email matches so you
// don't map everyone by hand, and surfaces only suggestions + unmatched for a decision.
const gcName = (c: any): string => (c.company_name || [c.given_name, c.family_name].filter(Boolean).join(' ') || '').trim();

router.get('/settings/gocardless/match-customers', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) { res.redirect('/settings/integrations?err=' + encodeURIComponent('GoCardless not configured')); return; }
  let gcCustomers: any[] = []; let mandates: any[] = [];
  try { [gcCustomers, mandates] = await Promise.all([gc.listCustomers(), gc.listMandates('active')]); }
  catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); return; }

  // First active mandate per GoCardless customer id.
  const mandateByCust: Record<string, string> = {};
  for (const m of mandates) { const cust = m?.links?.customer; if (cust && !mandateByCust[cust]) mandateByCust[cust] = m.id; }

  const portal = (await pool.query('SELECT id, name, email, gocardless_mandate_id FROM customers WHERE deleted_at IS NULL')).rows;
  const byMandate: Record<string, any> = {};
  const nameCount: Record<string, number> = {}; const nameTo: Record<string, any> = {};
  const emailTo: Record<string, any> = {};
  for (const c of portal) {
    if (c.gocardless_mandate_id) byMandate[String(c.gocardless_mandate_id)] = c;
    const k = (c.name || '').toLowerCase().trim(); if (k) { nameCount[k] = (nameCount[k] || 0) + 1; nameTo[k] = c; }
    const e = (c.email || '').toLowerCase().trim(); if (e) emailTo[e] = c;
  }

  // Auto-link: a GC customer whose mandate isn't linked yet, matched to an UNLINKED portal
  // customer by exact email or unique exact name.
  let autoLinked = 0;
  for (const qc of gcCustomers) {
    const mid = mandateByCust[qc.id]; if (!mid || byMandate[String(mid)]) continue;
    const e = (qc.email || '').toLowerCase().trim();
    const k = gcName(qc).toLowerCase().trim();
    const pc = (e && emailTo[e]) || (k && nameCount[k] === 1 ? nameTo[k] : null);
    if (pc && !pc.gocardless_mandate_id) {
      await pool.query('UPDATE customers SET gocardless_mandate_id=$1 WHERE id=$2', [mid, pc.id]);
      pc.gocardless_mandate_id = mid; byMandate[String(mid)] = pc; autoLinked++;
    }
  }

  const rows = gcCustomers.map((qc: any) => {
    const mid = mandateByCust[qc.id] || null;
    const linked = mid ? (byMandate[String(mid)] || null) : null;
    const e = (qc.email || '').toLowerCase().trim(); const k = gcName(qc).toLowerCase().trim();
    const suggest = !linked && mid ? ((e && emailTo[e]) || (k && nameCount[k] >= 1 ? nameTo[k] : null)) : null;
    return { gcId: qc.id, gcName: gcName(qc) || '(no name)', gcEmail: qc.email || '', mandateId: mid, linked, suggest };
  }).sort((a: any, b: any) => a.gcName.localeCompare(b.gcName));

  const stats = {
    total: rows.length,
    withMandate: rows.filter((r: any) => r.mandateId).length,
    linked: rows.filter((r: any) => r.linked).length,
    suggested: rows.filter((r: any) => !r.linked && r.suggest).length,
    unmatched: rows.filter((r: any) => r.mandateId && !r.linked && !r.suggest).length,
    autoLinked,
  };
  const portalCustomers = portal.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
  res.render('settings/gocardless-customers', { user: req.session.user!, rows, stats, portalCustomers, notice: req.query.msg || null });
});

// Link a mandate to a portal customer (clears any other customer holding the same mandate).
router.post('/settings/gocardless/link-customer', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const mandateId = String(req.body.mandate_id || '').trim();
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  if (mandateId && customerId) {
    await pool.query('UPDATE customers SET gocardless_mandate_id=NULL WHERE gocardless_mandate_id=$1', [mandateId]);
    await pool.query('UPDATE customers SET gocardless_mandate_id=$1 WHERE id=$2', [mandateId, customerId]);
  }
  res.redirect('/settings/gocardless/match-customers?msg=Linked');
});

// On-demand: pull new mandates and auto-link the email matches now (same as the hourly job).
router.post('/settings/gocardless/sync-mandates', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const r = await syncGoCardlessMandates();
  res.redirect('/settings/gocardless/match-customers?msg=' + encodeURIComponent(`Synced ${r.total} GoCardless customer(s): ${r.linked} auto-linked by email, ${r.unmatched} left to match manually.`));
});

router.post('/settings/gocardless/unlink-customer', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.body.customer_id || ''), 10);
  if (customerId) await pool.query('UPDATE customers SET gocardless_mandate_id=NULL WHERE id=$1', [customerId]);
  res.redirect('/settings/gocardless/match-customers?msg=Unlinked');
});

// Back-link invoices that arrived without a GC payment ref (e.g. QB imports): match each
// mandate's GC payments to unlinked unpaid invoices by exact amount, then immediately run
// the payout sync so anything already paid_out flips to paid with its payout reference.
router.post('/settings/gocardless/link-payments', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const r = await linkGcPaymentsToInvoices();
    const p = await syncGoCardlessPayments();
    res.redirect('/settings/gocardless/match-customers?msg=' + encodeURIComponent(
      `Payment back-link: ${r.linked} invoice(s) linked across ${r.customers} customer(s), ${r.unmatched} with no matching GC payment. Payout sync: ${p.paid} marked paid, ${p.failed} failed.`));
  } catch (e: any) {
    res.redirect('/settings/gocardless/match-customers?msg=' + encodeURIComponent('Back-link failed: ' + (e.message || '').slice(0, 100)));
  }
});

router.post('/invoices/:id/submit-for-payment', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT i.*, c.gocardless_mandate_id FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.deleted_at IS NULL`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Invoice not found.' }); return; }
  const inv = r.rows[0];
  if (!inv.gocardless_mandate_id) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('Customer has no GoCardless mandate.')); return; }
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent('GoCardless not configured.')); return; }
  try {
    const pence = Math.round(Number(inv.total) * 100);
    const gcId = await gc.createPayment(inv.gocardless_mandate_id, pence, 'Invoice ' + inv.invoice_number, chargeDateFor(inv.due_date));
    await pool.query(`UPDATE invoices SET gocardless_payment_id=$1, payment_status='pending' WHERE id=$2`, [gcId, id]);
    res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Payment submitted to GoCardless'));
  } catch (e: any) { res.redirect('/invoices/' + id + '?err=' + encodeURIComponent(e.message)); }
});

// Pull payment state from QuickBooks into the portal (bookkeeper marks paid in QB).
router.post('/settings/quickbooks/sync-payments', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const qb = await QuickBooks.load();
  if (!qb.isConnected()) { res.redirect('/settings/integrations?err=Not+connected'); return; }
  try {
    const r = await qb.syncPayments();
    res.redirect('/settings/integrations?msg=' + encodeURIComponent(`Payment sync: updated ${r.updated} of ${r.checked} QB invoices`));
  } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent(e.message)); }
});

// Scheduled QB → portal payment sync (every 2 hours). No-ops if QB isn't connected.
let _qbSyncStarted = false;
export function startQbPaymentSync(): void {
  if (_qbSyncStarted) return;
  _qbSyncStarted = true;
  cron.schedule('0 */2 * * *', async () => {
    try {
      const qb = await QuickBooks.load();
      if (!qb.isConnected()) return;
      const r = await qb.syncPayments();
      if (r.updated) console.log(`[qb] payment sync: updated ${r.updated}/${r.checked}`);
    } catch (e) { console.error('[qb] payment sync error:', (e as Error).message); }
  });
  console.log('[qb] payment sync scheduled (every 2h)');
}

export default router;
