import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcryptjs';
import { graphConfigured, graphListLicensedUsers } from '../lib/graph';
import { syncInternalUsers } from '../lib/dirsync';
import { sendWelcomeEmail, welcomeEmailHtml, STATUS_EMAILS, defaultStatusEmail, renderTemplate, quoteEmailHtml, invoiceEmailHtml, onboardingEmailHtml } from '../lib/emails';
import { sendMail } from '../lib/mailer';
import { getSetting, setSetting } from '../lib/settings';
import { runBackup, listBackups, backupStatus, backupRunning } from '../lib/backup';
import { nextTicketNumber } from './tickets';
import { APP_VERSION, CHANGELOG } from '../lib/version';
import { linesOfCode } from '../lib/loc';
import { logActivity } from '../lib/activity';
import { buildSignatureHtml, getSignatureHtml } from '../lib/signature';
import { config } from '../config';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

const bannerDir = path.join(__dirname, '../../static/branding');
fs.mkdirSync(bannerDir, { recursive: true });
const bannerUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, bannerDir),
    filename: (_req, file, cb) => {
      const ext = (file.originalname.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      cb(null, 'banner-' + Date.now() + '.' + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)),
});

const router = Router();
const ROLES = ['staff', 'admin'];
const INTERNAL_DOMAINS = ['lumensolutions.co.uk', 'lumenmsp.co.uk'];
const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const isInternalDomain = (email: string): boolean => INTERNAL_DOMAINS.includes((email.split('@')[1] || '').toLowerCase());

router.use('/admin', requireAuth, requireAdmin);

// ── Landing ────────────────────────────────────────────────────────────────────
router.get('/admin', async (req: Request, res: Response) => {
  const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE is_active=true AND customer_id IS NULL) AS users,
      (SELECT COUNT(*)::int FROM users WHERE is_active=true AND customer_id IS NOT NULL) AS customer_users,
      (SELECT COUNT(*)::int FROM login_attempts WHERE created_at >= NOW() - INTERVAL '24 hours') AS attempts_24h,
      (SELECT COUNT(*)::int FROM login_attempts WHERE success=false AND created_at >= NOW() - INTERVAL '24 hours') AS failed_24h`);

  res.render('admin/index', { user: req.session.user!, stats: counts.rows[0] });
});

// ── About: next document numbers, case throughput, version + changelog ──────────
router.get('/admin/about', async (req: Request, res: Response) => {
  const digitsMax = (col: string, where = '') =>
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(${col}, '[^0-9]', '', 'g'), '')::bigint), 0) AS m FROM ${where}`;
  const [nextTicket, qn, invIt, invCs, stats] = await Promise.all([
    nextTicketNumber(),
    pool.query(digitsMax('quote_number', 'quotes')),
    pool.query(digitsMax('invoice_number', "invoices WHERE invoice_scheme='IT'")),
    pool.query(digitsMax('invoice_number', "invoices WHERE invoice_scheme='CS'")),
    pool.query(`SELECT
        (SELECT COUNT(*)::int FROM inbox_tickets WHERE deleted_at IS NULL) AS total,
        (SELECT COUNT(*)::int FROM inbox_tickets WHERE deleted_at IS NULL AND status NOT IN ('resolved','closed')) AS open_cases,
        (SELECT COUNT(*)::int FROM inbox_tickets WHERE created_at >= NOW() - INTERVAL '30 days') AS created_30d,
        (SELECT COUNT(*)::int FROM inbox_tickets WHERE closed_at >= NOW() - INTERVAL '30 days') AS resolved_30d`),
  ]);
  const pad = (n: number) => String(n).padStart(4, '0');
  res.render('admin/about', {
    user: req.session.user!,
    version: APP_VERSION,
    changelog: CHANGELOG,
    nextNumbers: {
      ticket: nextTicket,
      quote:  'Q-'  + pad(Number(qn.rows[0].m) + 1),
      invIt:  'IT-' + pad(Number(invIt.rows[0].m) + 1),
      invCs:  'CS-' + pad(Number(invCs.rows[0].m) + 1),
    },
    stats: stats.rows[0],
    avgPerDay:      (stats.rows[0].created_30d / 30).toFixed(1),
    resolvedPerDay: (stats.rows[0].resolved_30d / 30).toFixed(1),
    loc: linesOfCode(),
  });
});

// ── Users ────────────────────────────────────────────────────────────────────────
router.get('/admin/users', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, is_active, support_group, sales_group, finance_group, hidden_from_lookups, last_login_at, entra_oid,
            (password_hash IS NOT NULL) AS has_password
     FROM users WHERE customer_id IS NULL ORDER BY is_active DESC, display_name ASC`
  );
  res.render('admin/users', { user: req.session.user!, users: rows, domains: INTERNAL_DOMAINS, notice: req.query.msg || null, err: req.query.err || null });
});

// Sync internal staff from our own Microsoft 365 tenant — matches on Entra object ID first,
// so domain and name changes update accounts in place (roles/passwords untouched); leavers
// are deactivated. Break-glass and local-only accounts are never touched.
router.post('/admin/users/sync', async (req: Request, res: Response) => {
  try {
    const r = await syncInternalUsers();
    await logActivity(req.session.user!.id, 'updated', 'users', 0, `M365 staff sync: +${r.added} added, ${r.updated} updated, ${r.archived} deactivated (${r.total} in tenant)`).catch(() => {});
    res.redirect('/admin/users?msg=' + encodeURIComponent(`Synced with Microsoft 365: ${r.added} added, ${r.updated} updated, ${r.archived} deactivated (${r.total} tenant users)`));
  } catch (e: any) {
    res.redirect('/admin/users?err=' + encodeURIComponent('Sync failed: ' + (e.message || '').slice(0, 100)));
  }
});

// ── Import staff from Microsoft 365 (licensed users only) ───────────────────────
router.get('/admin/users/import', async (req: Request, res: Response) => {
  if (!graphConfigured()) {
    res.render('admin/users-import', { user: req.session.user!, m365: [], existing: {}, error: 'Microsoft Graph is not configured.' });
    return;
  }
  try {
    const list = await graphListLicensedUsers();
    const ex = await pool.query('SELECT lower(email) AS email FROM users');
    const existing: Record<string, boolean> = {};
    ex.rows.forEach((r: any) => { existing[r.email] = true; });
    res.render('admin/users-import', { user: req.session.user!, m365: list, existing, error: null });
  } catch (e: any) {
    res.render('admin/users-import', { user: req.session.user!, m365: [], existing: {}, error: e.message });
  }
});

router.post('/admin/users/import', async (req: Request, res: Response) => {
  const sel = (req.body as any).users;
  const welcome = !!(req.body as any).welcome;
  const list = Array.isArray(sel) ? sel : (sel ? [sel] : []);
  for (const item of list) {
    const parts = String(item).split('|');
    const email = (parts[0] || '').toLowerCase().trim();
    const oid = parts[1] || null;
    const name = parts.slice(2).join('|').trim() || email;
    if (!email) continue;
    try {
      const before = await pool.query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email]);
      const isNew = before.rows.length === 0;
      await pool.query(
        `INSERT INTO users (email, display_name, entra_oid, role, customer_id, is_active)
         VALUES ($1,$2,$3,'staff',NULL,true)
         ON CONFLICT (email) DO UPDATE SET entra_oid = COALESCE(users.entra_oid, EXCLUDED.entra_oid), is_active = true`,
        [email, name, oid]
      );
      if (isNew && welcome) {
        try { await sendWelcomeEmail(email, name, req.session.user!.displayName); }
        catch (e) { console.error('Welcome email failed:', email, e); }
      }
    } catch (e) { console.error('Import user failed:', email, e); }
  }
  res.redirect('/admin/users');
});

// Set a user's group memberships (support / sales) from the Users checkboxes.
router.post('/admin/users/:id/groups', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body as any;
  await pool.query(
    'UPDATE users SET support_group=$2, sales_group=$3, finance_group=$4, hidden_from_lookups=$5 WHERE id=$1 AND customer_id IS NULL',
    [id, b.support === 'on', b.sales === 'on', b.finance === 'on', b.hidden === 'on']
  );
  res.redirect('/admin/users');
});

// Resend the welcome email to a staff user
router.post('/admin/users/:id/welcome', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT email, display_name FROM users WHERE id=$1 AND customer_id IS NULL', [id]);
  if (r.rows.length) {
    try { await sendWelcomeEmail(r.rows[0].email, r.rows[0].display_name, req.session.user!.displayName); }
    catch (e) { console.error('Resend welcome failed:', r.rows[0].email, e); }
  }
  res.redirect('/admin/users');
});

// ── Branding (email signature + templates) ──────────────────────────────────────
router.get('/admin/branding', async (req: Request, res: Response) => {
  const custom = await getSetting('branding', 'email_signature');
  const bannerUrl = (await getSetting('branding', 'email_banner_url')) || '';
  const isCustom = !!(custom && custom.trim());
  const sigTemplate = isCustom ? custom : buildSignatureHtml('{{name}}', bannerUrl);
  const sigPreview = await getSignatureHtml(req.session.user!.displayName);
  const welcomePreview = welcomeEmailHtml('Sample User') + sigPreview;

  const statusEmails = [];
  for (const s of STATUS_EMAILS) {
    const saved = await getSetting('email_templates', s.status);
    const tpl = saved && saved.trim() ? saved : defaultStatusEmail(s.status);
    const vars = { name: 'Sample Customer', ticket: 'LITS-100123', subject: 'Outlook keeps asking for a password' };
    statusEmails.push({
      ...s,
      tpl,
      subject: renderTemplate(s.subject, vars),
      preview: renderTemplate(tpl, vars) + sigPreview,
      custom: !!(saved && saved.trim()),
    });
  }

  res.render('admin/branding', {
    user: req.session.user!, sigTemplate, bannerUrl, sigPreview, welcomePreview, isCustom, statusEmails,
    saved: req.query.saved === '1',
  });
});

router.post('/admin/branding/banner', bannerUpload.single('banner'), async (req: Request, res: Response) => {
  const f = (req as any).file;
  if (f) {
    const base = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
    await setSetting('branding', 'email_banner_url', base + '/static/branding/' + f.filename);
  }
  res.redirect('/admin/branding?saved=1');
});

router.post('/admin/branding/status-emails', async (req: Request, res: Response) => {
  const b = req.body as any;
  for (const s of STATUS_EMAILS) {
    const v = (b['template_' + s.status] || '').trim();
    await setSetting('email_templates', s.status, v || null);
  }
  res.redirect('/admin/branding?saved=1');
});

// ── Mail flow (outbound email log) ──────────────────────────────────────────────
router.get('/admin/mail-flow', async (req: Request, res: Response) => {
  const status = String(req.query.status || '').trim();
  const params: any[] = [];
  let where = '';
  if (['sent', 'failed', 'not_sent'].includes(status)) { params.push(status); where = 'WHERE status=$1'; }
  const { rows } = await pool.query(`SELECT * FROM email_log ${where} ORDER BY created_at DESC LIMIT 200`, params);
  const counts = await pool.query(`SELECT status, COUNT(*)::int n FROM email_log WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY status`);
  const summary: Record<string, number> = {};
  counts.rows.forEach((r: any) => { summary[r.status] = r.n; });
  let spam: any[] = [];
  try {
    spam = (await pool.query(
      `SELECT s.*, u.display_name AS created_by_name FROM spam_senders s
       LEFT JOIN users u ON u.id = s.created_by_id ORDER BY s.created_at DESC`
    )).rows;
  } catch { /* table may not exist before first db push */ }
  // Inbound that the auto-mail/loop guard filed away without raising a ticket.
  let suppressed: any[] = [];
  try {
    suppressed = (await pool.query(
      `SELECT id, from_name, from_email, subject, suppression_reason, received_at
         FROM inbox_messages
        WHERE processing_status='suppressed' AND ticket_id IS NULL
        ORDER BY received_at DESC LIMIT 100`
    )).rows;
  } catch { /* noop */ }
  res.render('admin/mail-flow', { user: req.session.user!, items: rows, status, summary, spam, suppressed, saved: req.query.saved || null });
});

// Recover a suppressed inbound email → raise it as a proper support ticket.
router.post('/admin/mail-flow/suppressed/:id/raise', async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const m = (await pool.query('SELECT * FROM inbox_messages WHERE id=$1 AND processing_status=\'suppressed\'', [id])).rows[0];
  if (!m) { res.redirect('/admin/mail-flow?saved=norecover'); return; }
  const from = (m.from_email || '').toLowerCase().trim();
  // Match a customer/contact by the sender address.
  const contact = from ? (await pool.query('SELECT id, customer_id FROM customer_contacts WHERE email IS NOT NULL AND lower(email)=lower($1) LIMIT 1', [from])).rows[0] : null;
  const tn = await nextTicketNumber();
  const escH = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  const t = await pool.query(
    `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, status, department, category, subject, description, activity_status, stage, updated_at)
     VALUES ($1,'email',$2,$3,'new','support','incident',$4,$5,'unread','awaiting_triage', NOW()) RETURNING id`,
    [tn, contact ? contact.customer_id : null, contact ? contact.id : null, m.subject || '(no subject)', m.body_text || '']
  );
  const tid = t.rows[0].id;
  await pool.query(
    `UPDATE inbox_messages SET ticket_id=$1, processing_status='matched', body_html=COALESCE(body_html, $2) WHERE id=$3`,
    [tid, '<div style="white-space:pre-wrap;">' + escH(m.body_text || '') + '</div>', id]
  );
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [tid, user.id, `Recovered from auto-filed mail (was: ${m.suppression_reason || 'suppressed'}) by ${user.displayName}`]);
  await logActivity(user.id, 'created', 'tickets', tid, `Recovered suppressed email → ${tn}`);
  res.redirect('/tickets/' + tid + '?msg=' + encodeURIComponent('Recovered onto the helpdesk.'));
});

// Block list — add an email or domain by hand.
router.post('/admin/mail-flow/spam', async (req: Request, res: Response) => {
  const raw = String(req.body.value || '').toLowerCase().trim();
  if (raw) {
    const kind = raw.includes('@') ? 'email' : 'domain';
    await pool.query(
      `INSERT INTO spam_senders (value, kind, created_by_id, reason)
       VALUES ($1,$2,$3,'Added manually') ON CONFLICT (value) DO NOTHING`,
      [raw, kind, req.session.user!.id]
    );
  }
  res.redirect('/admin/mail-flow?saved=blocked');
});

// Release — remove a sender/domain from the block list.
router.post('/admin/mail-flow/spam/:id/release', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('DELETE FROM spam_senders WHERE id=$1', [id]);
  res.redirect('/admin/mail-flow?saved=released');
});

router.get('/admin/mail-flow/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM email_log WHERE id=$1', [id]);
  if (!r.rows.length) { res.redirect('/admin/mail-flow'); return; }
  res.render('admin/mail-flow-detail', { user: req.session.user!, m: r.rows[0] });
});

// ── Comms Log (WhatsApp / Teams, inbound + outbound) ──────────────────────────────
router.get('/admin/comms-log', async (req: Request, res: Response) => {
  const channel = String(req.query.channel || '').trim();
  const direction = String(req.query.direction || '').trim();
  const conds: string[] = [];
  const params: any[] = [];
  if (['whatsapp', 'teams'].includes(channel)) { params.push(channel); conds.push(`channel=$${params.length}`); }
  if (['inbound', 'outbound'].includes(direction)) { params.push(direction); conds.push(`direction=$${params.length}`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  let items: any[] = [];
  try {
    items = (await pool.query(
      `SELECT cl.*, t.ticket_number FROM channel_log cl
         LEFT JOIN inbox_tickets t ON t.id = cl.ticket_id
       ${where} ORDER BY cl.created_at DESC LIMIT 300`, params
    )).rows;
  } catch { /* table may not exist before first db push */ }
  let summary: any[] = [];
  try {
    summary = (await pool.query(
      `SELECT channel, direction, status, COUNT(*)::int n FROM channel_log
        WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY channel, direction, status`
    )).rows;
  } catch { /* noop */ }
  res.render('admin/comms-log', { user: req.session.user!, items, summary, channel, direction });
});

// ── Backups ──────────────────────────────────────────────────────────────────────
router.get('/admin/backups', async (req: Request, res: Response) => {
  res.render('admin/backups', { user: req.session.user!, status: await backupStatus(), notice: req.query.msg || null, error: req.query.err || null });
});

router.post('/admin/backups/save', async (req: Request, res: Response) => {
  const b = req.body as any;
  await setSetting('backup', 'az_account', (b.az_account || '').trim() || null);
  await setSetting('backup', 'az_container', (b.az_container || '').trim() || null);
  await setSetting('backup', 'az_prefix', (b.az_prefix || '').trim() || 'portal-backups/');
  await setSetting('backup', 'retention_days', String(parseInt(b.retention_days, 10) || 30));
  await setSetting('backup', 'hour', String(Math.min(23, Math.max(0, parseInt(b.hour, 10) || 2))));
  await setSetting('backup', 'enabled', b.enabled === 'on' || b.enabled === 'true' ? 'true' : 'false');
  if ((b.az_key || '').trim()) await setSetting('backup', 'az_key', b.az_key.trim());
  if ((b.passphrase || '').trim()) await setSetting('backup', 'passphrase', b.passphrase.trim());
  // Passphrase hint only — a reminder for whoever needs to restore, never the passphrase itself.
  await setSetting('backup', 'pass_clue', (b.pass_clue || '').trim() || null);
  res.redirect('/admin/backups?msg=' + encodeURIComponent('Backup settings saved'));
});

router.post('/admin/backups/run', async (req: Request, res: Response) => {
  const st = await backupStatus();
  if (!st.configured) { res.redirect('/admin/backups?err=' + encodeURIComponent('Configure Azure storage + passphrase before running a backup.')); return; }
  if (backupRunning()) { res.redirect('/admin/backups?msg=' + encodeURIComponent('A backup is already running — refresh for progress.')); return; }
  // Backups can run for minutes (dump + tar + encrypt + upload) — far longer than Nginx's
  // proxy timeout. Kick it off in the background and return immediately; the status panel
  // reflects progress ("running" → "ok"/"failed") on refresh.
  runBackup('manual').catch((e) => console.error('Backup run failed:', e));
  res.redirect('/admin/backups?msg=' + encodeURIComponent('Backup started — refresh this page in a minute for the result.'));
});

router.get('/admin/backups/list.json', async (_req: Request, res: Response) => {
  res.json(await listBackups());
});

// ── Activity log (audit trail) ──────────────────────────────────────────────────
router.get('/admin/activity', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT a.*, u.display_name AS user_name FROM activity_log a
     LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200`
  );
  res.render('admin/activity', { user: req.session.user!, items: rows });
});

router.post('/admin/branding/signature', async (req: Request, res: Response) => {
  const b = req.body as any;
  await setSetting('branding', 'email_signature', (b.signature || '').trim() || null);
  res.redirect('/admin/branding?saved=1');
});

router.post('/admin/branding/reset', async (req: Request, res: Response) => {
  await setSetting('branding', 'email_signature', null);
  res.redirect('/admin/branding?saved=1');
});

router.get('/admin/users/new', (req: Request, res: Response) => {
  res.render('admin/user-form', { user: req.session.user!, edit: null, error: null });
});

router.get('/admin/users/:id/edit', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM users WHERE id=$1 LIMIT 1', [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'User not found.' }); return; }
  res.render('admin/user-form', { user: req.session.user!, edit: r.rows[0], error: null });
});

router.post('/admin/users', async (req: Request, res: Response) => {
  const b = req.body;
  const email = (b.email || '').toLowerCase().trim();
  const name = (b.display_name || '').trim();
  if (!email || !name) { res.render('admin/user-form', { user: req.session.user!, edit: b, error: 'Email and name are required.' }); return; }
  if (!isInternalDomain(email)) {
    res.render('admin/user-form', { user: req.session.user!, edit: b, error: 'Internal users must use an @lumensolutions.co.uk or @lumenmsp.co.uk email. For external users, use Customer Users.' });
    return;
  }
  const role = ROLES.includes(b.role) ? b.role : 'staff';
  const hash = b.password && b.password.length >= 8 ? await bcrypt.hash(b.password, 10) : null;
  try {
    await pool.query(
      `INSERT INTO users (email, display_name, role, is_active, password_hash) VALUES ($1,$2,$3,true,$4)`,
      [email, name, role, hash]
    );
  } catch (e: any) {
    res.render('admin/user-form', { user: req.session.user!, edit: b, error: e.code === '23505' ? 'A user with that email already exists.' : 'Could not create user.' });
    return;
  }
  res.redirect('/admin/users');
});

router.post('/admin/users/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const role = ROLES.includes(b.role) ? b.role : 'staff';
  const isActive = b.is_active === 'on' || b.is_active === '1';
  await pool.query(
    `UPDATE users SET display_name=$1, role=$2, is_active=$3 WHERE id=$4`,
    [(b.display_name || '').trim(), role, isActive, id]
  );
  if (b.password && b.password.length >= 8) {
    const hash = await bcrypt.hash(b.password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);
  }
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (req.session.user!.id === id) { res.redirect('/admin/users'); return; } // don't deactivate yourself
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [id]);
  res.redirect('/admin/users');
});

// ── Customer users (external, scoped to a customer) ──────────────────────────────
router.get('/admin/customer-users', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.last_login_at, u.entra_oid,
            (u.password_hash IS NOT NULL) AS has_password, c.id AS customer_id, c.name AS customer_name
     FROM users u JOIN customers c ON c.id = u.customer_id
     ORDER BY u.is_active DESC, c.name ASC, u.display_name ASC`
  );
  res.render('admin/customer-users', { user: req.session.user!, users: rows });
});

async function customerOptions() {
  return (await pool.query(`SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name`)).rows;
}

router.get('/admin/customer-users/new', async (req: Request, res: Response) => {
  res.render('admin/customer-user-form', { user: req.session.user!, edit: null, customers: await customerOptions(), error: null });
});

router.get('/admin/customer-users/:id/edit', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM users WHERE id=$1 AND customer_id IS NOT NULL LIMIT 1', [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'User not found.' }); return; }
  res.render('admin/customer-user-form', { user: req.session.user!, edit: r.rows[0], customers: await customerOptions(), error: null });
});

router.post('/admin/customer-users', async (req: Request, res: Response) => {
  const b = req.body;
  const email = (b.email || '').toLowerCase().trim();
  const name = (b.display_name || '').trim();
  const customerId = b.customer_id ? parseInt(b.customer_id, 10) : null;
  if (!email || !name || !customerId) {
    res.render('admin/customer-user-form', { user: req.session.user!, edit: b, customers: await customerOptions(), error: 'Email, name and customer are required.' });
    return;
  }
  const hash = b.password && b.password.length >= 8 ? await bcrypt.hash(b.password, 10) : null;
  try {
    await pool.query(
      `INSERT INTO users (email, display_name, role, is_active, password_hash, customer_id) VALUES ($1,$2,'customer',true,$3,$4)`,
      [email, name, hash, customerId]
    );
  } catch (e: any) {
    res.render('admin/customer-user-form', { user: req.session.user!, edit: b, customers: await customerOptions(), error: e.code === '23505' ? 'A user with that email already exists.' : 'Could not create user.' });
    return;
  }
  res.redirect('/admin/customer-users');
});

router.post('/admin/customer-users/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const isActive = b.is_active === 'on' || b.is_active === '1';
  await pool.query(
    `UPDATE users SET display_name=$1, customer_id=$2, is_active=$3 WHERE id=$4 AND customer_id IS NOT NULL`,
    [(b.display_name || '').trim(), b.customer_id ? parseInt(b.customer_id, 10) : null, isActive, id]
  );
  if (b.password && b.password.length >= 8) {
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(b.password, 10), id]);
  }
  res.redirect('/admin/customer-users');
});

router.post('/admin/customer-users/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE users SET is_active=false WHERE id=$1 AND customer_id IS NOT NULL', [id]);
  res.redirect('/admin/customer-users');
});

// ── Security log ───────────────────────────────────────────────────────────────
router.get('/admin/security', async (req: Request, res: Response) => {
  const [attempts, topIps] = await Promise.all([
    pool.query('SELECT email, ip, success, created_at FROM login_attempts ORDER BY created_at DESC LIMIT 100'),
    pool.query(`SELECT ip, COUNT(*)::int n, COUNT(*) FILTER (WHERE success=false)::int failed
                FROM login_attempts WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY ip ORDER BY failed DESC, n DESC LIMIT 10`),
  ]);
  res.render('admin/security', { user: req.session.user!, attempts: attempts.rows, topIps: topIps.rows });
});

// ── Email delivery test (Admin → Tools) ───────────────────────────────────────────
// Send a one-off test email to any recipient(s), free-text or pre-filled from one of
// our templates (subject + body editable before sending).
async function buildTestTemplates(): Promise<{ key: string; label: string; subject: string; html: string }[]> {
  const vars = { name: 'Test User', ticket: 'LITS-100000', subject: 'Test enquiry' };
  const statusTpl = async (status: string) => {
    const saved = await getSetting('email_templates', status);
    const body = saved && saved.trim() ? saved : defaultStatusEmail(status);
    return renderTemplate(body, vars);
  };
  const sub = (s: string) => renderTemplate(s, vars).replace(/:\s*$/, '');
  const out: { key: string; label: string; subject: string; html: string }[] = [
    { key: 'blank', label: 'Blank — write your own', subject: '', html: '' },
    { key: 'welcome', label: 'Welcome', subject: 'Welcome to the Lumen MSP Portal', html: welcomeEmailHtml('Test User') },
  ];
  for (const s of STATUS_EMAILS) out.push({ key: 'ticket_' + s.status, label: 'Ticket — ' + s.label, subject: sub(s.subject), html: await statusTpl(s.status) });
  out.push({ key: 'quote', label: 'Quote', subject: 'Your quotation Q-0000', html: quoteEmailHtml({ contactName: 'Test User', quoteNumber: 'Q-0000', title: 'Sample quotation', total: '£1,200.00', validUntil: '30 days', link: config.APP_URL || 'https://portal.lumenmsp.co.uk' }) });
  out.push({ key: 'invoice', label: 'Invoice', subject: 'Invoice INV-0000', html: invoiceEmailHtml({ contactName: 'Test User', invoiceNumber: 'INV-0000', title: 'Sample invoice', total: '£1,200.00', dueDate: '30 days' }) });
  out.push({ key: 'onboarding', label: 'Onboarding form', subject: 'Complete your onboarding form', html: onboardingEmailHtml({ contactName: 'Test User', customerName: 'Sample Customer Ltd', link: (config.APP_URL || 'https://portal.lumenmsp.co.uk') + '/onboard/sample' }) });
  return out;
}

router.get('/admin/email-test', async (req: Request, res: Response) => {
  res.render('admin/email-test', {
    user: req.session.user!, templates: await buildTestTemplates(), graphOn: graphConfigured(),
    fromAddr: config.GRAPH_SEND_FROM || config.FROM_EMAIL,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/admin/email-test', async (req: Request, res: Response) => {
  const raw = String(req.body.to || '');
  const recipients = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const valid = recipients.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const subject = String(req.body.subject || '').trim();
  const body = String(req.body.body || '');
  if (!valid.length) { res.redirect('/admin/email-test?err=' + encodeURIComponent('Enter at least one valid email address.')); return; }
  if (!subject) { res.redirect('/admin/email-test?err=' + encodeURIComponent('Enter a subject.')); return; }
  try {
    await sendMail({ to: valid, subject, html: body });
    const note = graphConfigured()
      ? `Sent to ${valid.length} recipient(s): ${valid.join(', ')}.`
      : `Graph isn't configured, so nothing actually sent — logged to Mail flow only.`;
    res.redirect('/admin/email-test?msg=' + encodeURIComponent(note));
  } catch (e: any) {
    res.redirect('/admin/email-test?err=' + encodeURIComponent('Send failed: ' + (e.message || e)));
  }
});

export default router;
