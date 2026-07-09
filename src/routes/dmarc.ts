import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { config } from '../config';
import { checkDmarcDns, dmarcMailbox } from '../lib/dmarc/dns-check';
import { runDmarcIngest } from '../lib/dmarc/ingest';
import {
  ensureDmarcTables, listDmarcDomains, getDmarcDomain, addDmarcDomain, saveDnsCheck, domainSummary,
  seenDkimSelectors,
} from '../lib/dmarc/store';

// ── LITS-DMARC — staff area ──────────────────────────────────────────────────────
// Domain list + per-domain dashboard (sources, alignment, volume) fed by the
// aggregate-report ingest job. DNS checks run live from here; the same data feeds
// the customer's monthly IT Snapshot (DNS & Email Security section).

const router = Router();

function cleanDomain(s: string): string {
  return (s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

// ── List ─────────────────────────────────────────────────────────────────────────
router.get('/dmarc', requireAuth, async (req: Request, res: Response) => {
  await ensureDmarcTables().catch(() => {});
  const domains = await listDmarcDomains();
  // Unmonitored customer domains → one-click add. The CUSTOMER record is the source
  // of truth (customer_domains, primary first); IT-report primary_domain is only a
  // fallback for customers with no domains recorded.
  const suggestions = (await pool.query(
    `SELECT DISTINCT ON (domain) customer_id, name, domain, is_primary FROM (
        SELECT c.id AS customer_id, c.name, LOWER(TRIM(cd.domain)) AS domain, COALESCE(cd.is_primary, false) AS is_primary
          FROM customer_domains cd JOIN customers c ON c.id = cd.customer_id
         WHERE c.deleted_at IS NULL AND COALESCE(TRIM(cd.domain), '') <> ''
        UNION
        SELECT c.id, c.name, LOWER(TRIM(cfg.primary_domain)), false
          FROM it_report_configs cfg JOIN customers c ON c.id = cfg.customer_id
         WHERE c.deleted_at IS NULL AND COALESCE(TRIM(cfg.primary_domain), '') <> ''
      ) s
      WHERE domain LIKE '%.%' AND domain NOT IN (SELECT domain FROM dmarc_domains)
      ORDER BY domain, is_primary DESC`
  )).rows;
  const customers = (await pool.query(
    "SELECT id, name FROM customers WHERE deleted_at IS NULL AND COALESCE(is_placeholder,false)=false ORDER BY name"
  )).rows;
  res.render('dmarc/index', {
    user: req.session.user, domains, suggestions, customers,
    mailbox: dmarcMailbox(), mailboxConfigured: !!(config.DMARC_MAILBOX && config.GRAPH_TENANT_ID),
    ran: req.query.ran === '1', added: req.query.added === '1', err: req.query.err || null,
  });
});

// ── Add a domain (form or one-click suggestion) ───────────────────────────────────
router.post('/dmarc/add', requireAuth, async (req: Request, res: Response) => {
  const domain = cleanDomain(String(req.body.domain || ''));
  const customerId = req.body.customer_id ? parseInt(String(req.body.customer_id), 10) || null : null;
  if (!domain || !domain.includes('.')) { res.redirect('/dmarc?err=' + encodeURIComponent('Enter a valid domain.')); return; }
  await ensureDmarcTables().catch(() => {});
  const id = await addDmarcDomain(domain, customerId);
  const check = await checkDmarcDns(domain).catch(() => null);
  if (check) await saveDnsCheck(id, check);
  res.redirect(`/dmarc/${id}`);
});

// ── Set the agreed target policy (p=) — re-checks so advice reflects the new target ──
router.post('/dmarc/:id/target', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const target = String(req.body.target_policy || 'none').toLowerCase();
  if (!['none', 'quarantine', 'reject'].includes(target)) { res.redirect(`/dmarc/${id}`); return; }
  const dom = await getDmarcDomain(id);
  if (!dom) { res.status(404).render('error', { message: 'Domain not found.' }); return; }
  await pool.query('UPDATE dmarc_domains SET target_policy=$2, updated_at=NOW() WHERE id=$1', [id, target]);
  const extra = await seenDkimSelectors(id).catch(() => [] as string[]);
  const check = await checkDmarcDns(dom.domain, extra, target).catch(() => null);
  if (check) await saveDnsCheck(id, check);
  res.redirect(`/dmarc/${id}?checked=1`);
});

// ── Per-domain dashboard ──────────────────────────────────────────────────────────
router.get('/dmarc/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const dom = await getDmarcDomain(id);
  if (!dom) { res.status(404).render('error', { message: 'Domain not found.' }); return; }
  const days = Math.max(1, Math.min(365, parseInt(String(req.query.days || '30'), 10) || 30));
  const summary = await domainSummary(id, days);
  res.render('dmarc/domain', {
    user: req.session.user, dom, days, summary,
    check: (dom.last_check && typeof dom.last_check === 'object' && dom.last_check.domain) ? dom.last_check : null,
    mailbox: dmarcMailbox(),
    checked: req.query.checked === '1',
  });
});

// ── Re-run the DNS check ──────────────────────────────────────────────────────────
router.post('/dmarc/:id/check', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const dom = await getDmarcDomain(id);
  if (!dom) { res.status(404).render('error', { message: 'Domain not found.' }); return; }
  // Probe the common selector list PLUS any selectors seen in this domain's reports.
  const extra = await seenDkimSelectors(id).catch(() => [] as string[]);
  const check = await checkDmarcDns(dom.domain, extra, dom.target_policy || 'none').catch(() => null);
  if (check) await saveDnsCheck(id, check);
  res.redirect(`/dmarc/${id}?checked=1`);
});

// ── Pause/resume monitoring (reversible — nothing is ever deleted) ────────────────
router.post('/dmarc/:id/toggle', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE dmarc_domains SET monitoring_enabled = NOT monitoring_enabled, updated_at=NOW() WHERE id=$1', [id]);
  res.redirect(`/dmarc/${id}`);
});

// ── Delete a domain from monitoring (Terry-approved 2026-07-08). Removes the domain
// AND its report data — the in-UI confirm states the report count before it happens.
router.post('/dmarc/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('DELETE FROM dmarc_records WHERE domain_id=$1', [id]);
  await pool.query('DELETE FROM dmarc_reports WHERE domain_id=$1', [id]);
  await pool.query('DELETE FROM dmarc_domains WHERE id=$1', [id]);
  res.redirect('/dmarc');
});

// ── Manual ingest run (testing / impatience) ──────────────────────────────────────
router.post('/dmarc/run-ingest', requireAuth, async (req: Request, res: Response) => {
  runDmarcIngest().catch((e) => console.error('[dmarc] manual ingest error:', e.message));
  res.redirect('/dmarc?ran=1');
});

export default router;
