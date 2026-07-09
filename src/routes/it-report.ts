import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendMail } from '../lib/mailer';
import {
  ensureItReportTables, getItConfig, getReportNotes, compileSdmNotes,
  generateItReport, reportDomain, type ItManual,
} from '../lib/it-report/generate';

// Monthly IT Operations & Security Snapshot — staff area. Per-customer config + running
// notes, on-demand preview, and send-now. The monthly auto-run lives in the scheduler.

const router = Router();
const CSP = "default-src 'self' 'unsafe-inline' data: blob: https:; img-src * data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:";

// Previous calendar month [start, end) in UTC, plus a label like "June 2026".
function prevMonth(ref = new Date()): { from: Date; to: Date; label: string } {
  const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));       // 1st of this month
  const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1)); // 1st of last month
  const label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from, to, label };
}
// Explicit month from ?month=YYYY-MM, else previous month.
function periodFromQuery(q: any): { from: Date; to: Date; label: string } {
  const m = String(q.month || '');
  const mm = m.match(/^(\d{4})-(\d{2})$/);
  if (mm) {
    const y = +mm[1], mo = +mm[2] - 1;
    const from = new Date(Date.UTC(y, mo, 1));
    const to = new Date(Date.UTC(y, mo + 1, 1));
    return { from, to, label: from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }
  return prevMonth();
}
function manualFromBody(b: any): ItManual {
  return {
    backupBullets: b.backupBullets || '', backupStatus: b.backupStatus || '',
    patchBullets: b.patchBullets || '', patchStatus: b.patchStatus || '',
    firewallBlocked: b.firewallBlocked || '', endpointThreats: b.endpointThreats || '',
    threatBullets: b.threatBullets || '', threatStatus: b.threatStatus || '',
    deliverabilityPct: b.deliverabilityPct || '',
    vulnProvider: b.vulnProvider || '', vulnTarget: b.vulnTarget || '',
    vulnCriticalCves: b.vulnCriticalCves || '', vulnCves: b.vulnCves || '',
    vulnPorts: b.vulnPorts || '', vulnWebAlerts: b.vulnWebAlerts || '',
    vulnRiskLevel: b.vulnRiskLevel || '', vulnBullets: b.vulnBullets || '', vulnStatus: b.vulnStatus || '',
  };
}
async function customer(id: number): Promise<{ id: number; name: string; entra_tenant_id: string | null } | null> {
  const r = await pool.query('SELECT id, name, entra_tenant_id FROM customers WHERE id=$1', [id]);
  return r.rows[0] || null;
}

// ── List ─────────────────────────────────────────────────────────────────────────
router.get('/it-report', requireAuth, async (req: Request, res: Response) => {
  await ensureItReportTables().catch(() => {});
  const rows = (await pool.query(
    `SELECT c.id, c.name, c.entra_tenant_id,
            cfg.is_active, cfg.auto_send, cfg.recipients, cfg.primary_domain
       FROM customers c
       LEFT JOIN it_report_configs cfg ON cfg.customer_id = c.id
      WHERE c.deleted_at IS NULL AND COALESCE(c.is_placeholder, false) = false
        AND COALESCE(c.is_itsm, false) = true
      ORDER BY (cfg.is_active IS TRUE) DESC, c.name`
  )).rows;
  const { label } = prevMonth();
  res.render('it-report/index', { user: req.session.user, customers: rows, periodLabel: label });
});

// ── Per-customer settings + running notes + recent runs ──────────────────────────
router.get('/it-report/:id', requireAuth, async (req: Request, res: Response) => {
  await ensureItReportTables().catch(() => {});
  const id = parseInt(String(req.params.id), 10);
  const c = await customer(id);
  if (!c) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const cfg = await getItConfig(id);
  // Notes since the start of last month (covers the report you're about to run + this month's running log).
  const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  const notes = (await pool.query(
    'SELECT id, body, author, category, created_at FROM it_report_notes WHERE customer_id=$1 AND created_at >= $2 ORDER BY created_at DESC',
    [id, since]
  )).rows;
  const runs = (await pool.query(
    'SELECT id, period_label, status, created_at, sent_at FROM it_report_runs WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 12',
    [id]
  )).rows;
  res.render('it-report/edit', {
    user: req.session.user, c, cfg, notes, runs,
    periodLabel: prevMonth().label, saved: req.query.saved === '1', err: req.query.err || null,
  });
});

// ── Save config ──────────────────────────────────────────────────────────────────
router.post('/it-report/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const manual = manualFromBody(b);
  await pool.query(
    `INSERT INTO it_report_configs (customer_id, recipients, primary_domain, sdm_notes, manual, auto_send, is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (customer_id) DO UPDATE SET
       recipients=$2, primary_domain=$3, sdm_notes=$4, manual=$5, auto_send=$6, is_active=$7, updated_at=NOW()`,
    [id, b.recipients || '', b.primary_domain || '', b.sdm_notes || '', JSON.stringify(manual), b.auto_send === 'on' || b.auto_send === 'true', b.is_active === 'on' || b.is_active === 'true']
  );
  res.redirect('/it-report/' + id + '?saved=1');
});

// ── Add / delete a running note ──────────────────────────────────────────────────
router.post('/it-report/:id/note', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const wantsJson = String(req.headers.accept || '').includes('json');
  const body = String(req.body.body || '').trim();
  let note: any = null;
  if (body) {
    const author = req.session.user?.displayName || req.session.user?.email || '';
    const r = await pool.query(
      'INSERT INTO it_report_notes (customer_id, body, author, category) VALUES ($1,$2,$3,$4) RETURNING id, body, author, created_at',
      [id, body.slice(0, 2000), author, String(req.body.category || 'observation').slice(0, 40)]);
    note = r.rows[0];
  }
  if (wantsJson) { res.json({ ok: true, note }); return; }
  res.redirect('/it-report/' + id);
});
router.post('/it-report/:id/note/:noteId/delete', requireAuth, async (req: Request, res: Response) => {
  await pool.query('DELETE FROM it_report_notes WHERE id=$1 AND customer_id=$2', [parseInt(String(req.params.noteId), 10), parseInt(String(req.params.id), 10)]);
  if (String(req.headers.accept || '').includes('json')) { res.json({ ok: true }); return; }
  res.redirect('/it-report/' + req.params.id);
});

// ── Preview → stores a draft and serves it with a "Send to customer" button, so what you
//    review is exactly what gets emailed (no regeneration between preview and send). ──────────
router.get('/it-report/:id/preview', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const c = await customer(id);
  if (!c) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const cfg = await getItConfig(id);
  const { from, to, label } = periodFromQuery(req.query);
  try {
    const notes = await getReportNotes(id, from, to);
    const sdmNotes = compileSdmNotes(cfg?.sdm_notes || '', notes);
    const { html, subject } = await generateItReport({
      customerId: id, customerName: c.name, tenant: c.entra_tenant_id, domain: await reportDomain(id, cfg?.primary_domain),
      from, to, periodLabel: label, sdmNotes, manual: cfg?.manual || {},
      useClaude: req.query.noai !== '1', preparedBy: 'Lumen IT Solutions',
    });
    // Refresh this period's DRAFT with the exact HTML shown, so Send emails the reviewed copy.
    await pool.query("DELETE FROM it_report_runs WHERE customer_id=$1 AND period_start=$2 AND status='draft'", [id, from]);
    const ins = await pool.query(
      `INSERT INTO it_report_runs (customer_id, period_start, period_end, period_label, sdm_notes, manual, subject, html, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING id`,
      [id, from, to, label, sdmNotes, JSON.stringify(cfg?.manual || {}), subject, html]
    );
    const runId = ins.rows[0].id;
    const recipients = String(cfg?.recipients || '').split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
    const csrf = (res.locals as any).csrfToken || '';
    const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[ch]);
    const sendCtl = recipients.length
      ? `<form method="post" action="/it-report/${id}/send-draft" style="margin:0;" onsubmit="return confirm('Email this exact report to ${recipients.length} recipient(s) now?');"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="runId" value="${runId}"><button style="padding:8px 16px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;">&#9993; Send to customer</button></form>`
      : `<span style="font-size:13px;color:#fbbf24;">Add a recipient in Settings to enable sending</span>`;
    // Staff wrapper: the iframe shows the EXACT customer copy; the Send control lives outside it,
    // so it never becomes part of what the customer receives.
    const wrapper = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview — ${esc(c.name)}</title>
<style>*{box-sizing:border-box}html,body{height:100%}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
.pbar{flex:0 0 auto;background:#0f172a;color:#fff;display:flex;align-items:center;gap:14px;padding:10px 18px}
.pbar .t{flex:1;font-weight:600;font-size:14px}.pbar .t small{display:block;color:#94a3b8;font-weight:400;font-size:12px}
.pbar .close{background:#334155;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:14px}
iframe{flex:1 1 auto;width:100%;border:0;background:#f0f2f5}</style></head>
<body><div class="pbar"><div class="t">Preview — ${esc(c.name)} · ${esc(label)}<small>This is exactly what the customer receives. Sending controls are staff-only and are not part of the report.</small></div>
${sendCtl}<button class="close" onclick="window.close()">Close</button></div>
<iframe src="/it-report/run/${runId}" title="Customer report"></iframe></body></html>`;
    res.setHeader('Content-Security-Policy', CSP);
    res.send(wrapper);
  } catch (e: any) {
    res.status(500).render('error', { message: 'Report generation failed: ' + (e.message || e).slice(0, 200) });
  }
});

// ── Send the exact previewed draft ───────────────────────────────────────────────
router.post('/it-report/:id/send-draft', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const runId = parseInt(String(req.body.runId), 10);
  const cfg = await getItConfig(id);
  const recipients = String(cfg?.recipients || '').split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
  if (!recipients.length) { res.redirect('/it-report/' + id + '?err=' + encodeURIComponent('Add at least one recipient email first.')); return; }
  const run = (await pool.query('SELECT subject, html FROM it_report_runs WHERE id=$1 AND customer_id=$2', [runId, id])).rows[0];
  if (!run || !run.html) { res.redirect('/it-report/' + id + '?err=' + encodeURIComponent('Preview expired — please preview again, then send.')); return; }
  let sent = 0;
  for (const to of recipients) { try { await sendMail({ to, subject: run.subject, html: run.html }); sent++; } catch { /* keep going */ } }
  await pool.query('UPDATE it_report_runs SET status=$1, sent_at=NOW() WHERE id=$2', [sent ? 'sent' : 'failed', runId]);
  res.redirect('/it-report/' + id + (sent ? '?saved=1' : '?err=' + encodeURIComponent('Send failed — check mail settings.')));
});

// ── View a stored run (staff) ────────────────────────────────────────────────────
router.get('/it-report/run/:runId', requireAuth, async (req: Request, res: Response) => {
  const r = (await pool.query('SELECT html FROM it_report_runs WHERE id=$1', [parseInt(String(req.params.runId), 10)])).rows[0];
  if (!r || !r.html) { res.status(404).render('error', { message: 'Report not found.' }); return; }
  res.setHeader('Content-Security-Policy', CSP);
  res.send(r.html);
});

// ── Send now (generate + email + record the run) ─────────────────────────────────
router.post('/it-report/:id/send', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const c = await customer(id);
  if (!c) { res.status(404).json({ ok: false, error: 'Customer not found' }); return; }
  const cfg = await getItConfig(id);
  const recipients = String(cfg?.recipients || '').split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
  if (!recipients.length) { res.redirect('/it-report/' + id + '?err=' + encodeURIComponent('Add at least one recipient email first.')); return; }
  const { from, to, label } = periodFromQuery(req.query);
  try {
    const notes = await getReportNotes(id, from, to);
    const sdmNotes = compileSdmNotes(cfg?.sdm_notes || '', notes);
    const { html, subject } = await generateItReport({
      customerId: id, customerName: c.name, tenant: c.entra_tenant_id, domain: await reportDomain(id, cfg?.primary_domain),
      from, to, periodLabel: label, sdmNotes, manual: cfg?.manual || {}, preparedBy: 'Lumen IT Solutions',
    });
    let sent = 0;
    for (const to2 of recipients) { try { await sendMail({ to: to2, subject, html }); sent++; } catch { /* keep going */ } }
    await pool.query(
      `INSERT INTO it_report_runs (customer_id, period_start, period_end, period_label, sdm_notes, manual, subject, html, status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [id, from, to, label, sdmNotes, JSON.stringify(cfg?.manual || {}), subject, html, sent ? 'sent' : 'failed']
    );
    res.redirect('/it-report/' + id + '?saved=1');
  } catch (e: any) {
    res.redirect('/it-report/' + id + '?err=' + encodeURIComponent((e.message || 'Send failed').slice(0, 160)));
  }
});

export default router;
