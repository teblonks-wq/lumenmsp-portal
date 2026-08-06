import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { judge, refreshStaleServers } from '../lib/server-facts';

// ── Servers ─────────────────────────────────────────────────────────────────────
// The same agent as everywhere else, running in server mode. Nothing here is a separate
// product: a machine is a server if Windows says so, and that turns on a set of
// collectors that a workstation would have nothing to answer.
//
// Everything is read-only. The judgements come from src/lib/server-facts.ts, so what
// counts as a problem is a Portal change, not a rollout to every domain controller.

const router = Router();

// Roles worth naming on the list. The raw list from Get-WindowsFeature runs to dozens of
// entries nobody cares about, and "AD-Domain-Services, DNS, DHCP, FileAndStorage-Services,
// Print-Services, Web-Server" tells you nothing you can scan.
const ROLE_LABEL: Record<string, string> = {
  'AD-Domain-Services': 'Active Directory',
  'DNS': 'DNS',
  'DHCP': 'DHCP',
  'Hyper-V': 'Hyper-V',
  'Web-Server': 'IIS',
  'RDS-RD-Server': 'Remote Desktop',
  'Print-Services': 'Print',
  'FS-FileServer': 'File server',
  'Remote-Desktop-Services': 'Remote Desktop',
  'ADCS-Cert-Authority': 'Certificate Authority',
  'Routing': 'Routing / RAS',
};

export function prettyRoles(roles: string | null, sqlInstances = 0): string[] {
  const list = String(roles || '').split(',').map((r) => r.trim()).filter(Boolean);
  const out = list.map((r) => ROLE_LABEL[r]).filter(Boolean) as string[];
  if (sqlInstances > 0) out.push('SQL Server');
  return Array.from(new Set(out));
}

// ── List ────────────────────────────────────────────────────────────────────────
router.get('/servers', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  try {
    // Top up anything stale before drawing the page. Deliberately not awaited into the
    // response beyond queueing: the commands run on the machines in their own time and
    // the numbers fill in on the next visit.
    const queued = await refreshStaleServers().catch(() => 0);

    const params: any[] = [];
    const where: string[] = ['ad.revoked = false',
      "(LOWER(COALESCE(ad.os,'')) LIKE '%server%' OR sf.device_id IS NOT NULL)"];
    if (customerId) { params.push(customerId); where.push(`ad.customer_id = $${params.length}`); }

    const rows = (await pool.query(
      `SELECT ad.id, ad.hostname, ad.os, ad.customer_id, c.name AS customer_name,
              EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS seen_secs,
              sf.server_role, sf.roles, sf.domain, sf.sql_instances, sf.vm_count,
              sf.alerts, sf.error, sf.collected_at,
              EXTRACT(EPOCH FROM (NOW() - sf.collected_at))::int AS facts_age_secs
         FROM agent_devices ad
         LEFT JOIN customers c ON c.id = ad.customer_id
         LEFT JOIN server_facts sf ON sf.device_id = ad.id
        WHERE ${where.join(' AND ')}
        ORDER BY sf.alerts DESC NULLS LAST, c.name NULLS LAST, ad.hostname`, params)).rows;

    for (const r of rows) r.role_labels = prettyRoles(r.roles, Number(r.sql_instances || 0));

    const customers = (await pool.query(
      `SELECT DISTINCT c.id, c.name FROM agent_devices ad
         JOIN customers c ON c.id = ad.customer_id
        WHERE ad.revoked = false AND LOWER(COALESCE(ad.os,'')) LIKE '%server%'
        ORDER BY c.name`)).rows;

    const summary = {
      servers: rows.length,
      reported: rows.filter((r: any) => r.collected_at).length,
      dcs: rows.filter((r: any) => String(r.server_role || '') === 'domain controller').length,
      sql: rows.reduce((a: number, r: any) => a + Number(r.sql_instances || 0), 0),
      vms: rows.reduce((a: number, r: any) => a + Number(r.vm_count || 0), 0),
      alerts: rows.reduce((a: number, r: any) => a + Number(r.alerts || 0), 0),
    };

    res.render('servers', {
      user: req.session.user!, rows, customers, customerId, summary, queued,
      msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    console.error('[servers] list failed:', e.message);
    res.render('servers', {
      user: req.session.user!, rows: [], customers: [], customerId,
      summary: { servers: 0, reported: 0, dcs: 0, sql: 0, vms: 0, alerts: 0 }, queued: 0,
      msg: null, error: e.message,
    });
  }
});

// ── One server ──────────────────────────────────────────────────────────────────
router.get('/servers/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const device = (await pool.query(
      `SELECT ad.*, c.name AS customer_name,
              EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS seen_secs
         FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
        WHERE ad.id=$1`, [id])).rows[0];
    if (!device) { res.redirect('/servers?msg=' + encodeURIComponent('No such machine.')); return; }

    const sf = (await pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - collected_at))::int AS age_secs
         FROM server_facts WHERE device_id=$1`, [id])).rows[0] || null;

    const pending = (await pool.query(
      `SELECT 1 FROM agent_commands WHERE device_id=$1 AND kind='server.facts'
        AND status IN ('queued','running') LIMIT 1`, [id])).rows.length > 0;

    const facts = sf?.facts || null;
    res.render('server-detail', {
      user: req.session.user!, device, sf, facts,
      alerts: judge(facts), roleLabels: prettyRoles(sf?.roles || null, Number(sf?.sql_instances || 0)),
      pending, msg: req.query.msg || null,
    });
  } catch (e: any) {
    console.error('[servers] detail failed:', e.message);
    res.redirect('/servers?msg=' + encodeURIComponent('Could not open that server: ' + e.message));
  }
});

router.post('/servers/:id/refresh', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const already = (await pool.query(
      `SELECT 1 FROM agent_commands WHERE device_id=$1 AND kind='server.facts'
        AND status IN ('queued','running') LIMIT 1`, [id])).rows.length;
    if (!already) {
      await pool.query(
        `INSERT INTO agent_commands (device_id, kind, status, requested_by)
         VALUES ($1,'server.facts','queued',$2)`, [id, req.session.user!.id]);
      await logActivity(req.session.user!.id, 'server_facts', 'agent_devices', id, 'Requested a server scan');
    }
    res.redirect(`/servers/${id}?msg=` + encodeURIComponent(
      already ? 'Already queued — it will report on its next check-in.'
              : 'Asked the server to report. On a machine that is switched on this takes a minute or two; a domain with a lot of objects takes longer.'));
  } catch (e: any) {
    res.redirect(`/servers/${id}?msg=` + encodeURIComponent('Could not queue: ' + e.message));
  }
});

export default router;
