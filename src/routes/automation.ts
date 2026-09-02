import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import {
  ACTIONS, CONDITIONS, RECURRENCES, actionDef, createTask, cancelTask, armTask, reconcileTasks,
} from '../lib/automation';
import { listScripts } from '../lib/scripts';

const router = Router();

// ── Automation ──────────────────────────────────────────────────────────────────
// The home for everything the Portal does to machines on its own: the script library,
// scheduled tasks, Windows Update policy and software deployment. Scripts, Patching and
// Software keep their own URLs — they are linked from here rather than moved, because
// every asset page, every email and every bookmark points at the paths they already have,
// and a tidier URL is not worth a hundred dead links.

const BACK = '/automation/scheduled-tasks';

/** "Tue 18 Aug, 08:00" — one wording everywhere, always Europe/London. */
function when(d: Date | string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// ── /automation ─────────────────────────────────────────────────────────────────
// Automation is a nav SECTION, not a page. The four screens under it are the navigation,
// so a hub page would only be a second, worse copy of the sidebar. The route stays as a
// redirect because links to it exist - in the changelog, in the daily log, and in whatever
// anyone bookmarked between this shipping and the nav changing.
router.get('/automation', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.redirect('/automation/scheduled-tasks');
});

// ── The list ────────────────────────────────────────────────────────────────────

router.get('/automation/scheduled-tasks', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  // Read the outcomes back first, so the page is never a minute behind the sweep.
  await reconcileTasks().catch(() => {});

  const SELECT = `SELECT t.id, t.name, t.action, t.condition, t.run_at, t.run_until, t.recurrence, t.recurrence_end,
                         t.series_id, t.status, t.armed_at, t.finished_at, t.created_at,
                         u.display_name AS created_by_name,
                         (SELECT COUNT(*)::int FROM automation_task_devices d WHERE d.task_id=t.id) AS devices,
                         (SELECT COUNT(*)::int FROM automation_task_devices d WHERE d.task_id=t.id AND d.status='done') AS done,
                         (SELECT COUNT(*)::int FROM automation_task_devices d WHERE d.task_id=t.id AND d.status IN ('failed','skipped')) AS failed
                    FROM automation_tasks t
                    LEFT JOIN users u ON u.id = t.created_by`;

  const [upcoming, running, recent, legacy] = await Promise.all([
    pool.query(`${SELECT} WHERE t.status='scheduled' ORDER BY t.run_at NULLS FIRST, t.id LIMIT 200`),
    pool.query(`${SELECT} WHERE t.status='armed' ORDER BY t.armed_at DESC LIMIT 100`),
    pool.query(`${SELECT} WHERE t.status IN ('done','cancelled') ORDER BY COALESCE(t.finished_at, t.cancelled_at) DESC LIMIT 50`),
    // Reboots and shutdowns scheduled from a device page before this screen existed — and
    // still scheduled that way today. They are real pending work on real machines, so they
    // belong on the one screen that claims to show everything scheduled, even though they
    // are not automation tasks and cannot be edited here.
    pool.query(
      `SELECT ac.id, ac.kind, ac.run_after, ac.requested_at, ad.hostname, ad.id AS device_id,
              c.name AS customer_name, u.display_name AS requested_by_name
         FROM agent_commands ac
         LEFT JOIN agent_devices ad ON ad.id = ac.device_id
         LEFT JOIN customers c ON c.id = ad.customer_id
         LEFT JOIN users u ON u.id = ac.requested_by
        WHERE ac.kind LIKE 'power.%' AND ac.status='queued' AND ac.run_after IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM automation_task_devices d WHERE d.command_id = ac.id)
        ORDER BY ac.run_after LIMIT 100`),
  ]);

  res.render('automation/tasks', {
    user: req.session.user!, when,
    upcoming: upcoming.rows, running: running.rows, recent: recent.rows, legacy: legacy.rows,
    actions: ACTIONS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── New task ────────────────────────────────────────────────────────────────────

router.get('/automation/scheduled-tasks/new', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [scripts, packages, customers] = await Promise.all([
    listScripts(),
    pool.query('SELECT id, name, version FROM agent_packages ORDER BY name'),
    pool.query(
      `SELECT c.id, c.name, COUNT(ad.id)::int AS devices
         FROM customers c JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked IS NOT TRUE
        WHERE c.deleted_at IS NULL GROUP BY c.id, c.name HAVING COUNT(ad.id) > 0 ORDER BY c.name`),
  ]);
  res.render('automation/task-new', {
    user: req.session.user!,
    actions: ACTIONS, conditions: CONDITIONS, recurrences: RECURRENCES,
    scripts: scripts.filter((s) => s.osType === 'windows'),
    packages: packages.rows, customers: customers.rows,
    notice: null, error: req.query.err || null,
  });
});

/** The machine picker. Searches hostname, customer and the signed-in user. */
router.get('/automation/devices.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const customerId = parseInt(String(req.query.customer || ''), 10) || 0;
  const params: any[] = [];
  const where: string[] = ['ad.revoked IS NOT TRUE', 'ad.hostname IS NOT NULL'];
  if (customerId) { params.push(customerId); where.push('ad.customer_id = $' + params.length); }
  if (q) {
    params.push('%' + q + '%');
    where.push(`(ad.hostname ILIKE $${params.length} OR c.name ILIKE $${params.length} OR ad.logged_in_user ILIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT ad.id, ad.hostname, ad.device_type, ad.os, ad.logged_in_user, c.name AS customer_name,
            (EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at)) < 180) AS online
       FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name NULLS LAST, ad.hostname LIMIT 400`, params);
  res.json({ ok: true, devices: rows });
});

router.post('/automation/scheduled-tasks', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const ids = String(b.device_ids || '').split(',').map((s: string) => parseInt(s.trim(), 10)).filter(Boolean);
  // The browser sends a local datetime string; it means Europe/London, which is what the
  // hidden epoch field carries. Never re-parse the text server-side — that is how a 02:00
  // reboot becomes 01:00 for half the year.
  const epoch = parseInt(String(b.run_at_epoch || ''), 10) || null;

  const r = await createTask({
    name: String(b.name || ''),
    action: String(b.action || ''),
    condition: String(b.condition || 'next_contact'),
    runAtEpoch: epoch,
    runUntilEpoch: parseInt(String(b.run_until_epoch || ''), 10) || null,
    recurrence: String(b.recurrence || 'none'),
    recurrenceEnd: String(b.recurrence_end || '') || null,
    deviceIds: ids,
    scriptId: parseInt(String(b.script_id || ''), 10) || null,
    packageId: parseInt(String(b.package_id || ''), 10) || null,
    delaySeconds: b.delay_seconds != null ? parseInt(String(b.delay_seconds), 10) : null,
  }, req.session.user!.id, req.session.user!.displayName);

  if (!r.ok) { res.redirect('/automation/scheduled-tasks/new?err=' + encodeURIComponent(r.error || 'Could not schedule that.')); return; }
  const extra = (r.occurrences || 1) > 1 ? ` — ${r.occurrences} occurrences scheduled.` : '';
  res.redirect(`/automation/scheduled-tasks/${r.taskId}?msg=` + encodeURIComponent('Scheduled.' + extra));
});

// ── One task ────────────────────────────────────────────────────────────────────

router.get('/automation/scheduled-tasks/:id(\\d+)', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await reconcileTasks().catch(() => {});
  const task = (await pool.query(
    `SELECT t.*, u.display_name AS created_by_name FROM automation_tasks t
       LEFT JOIN users u ON u.id = t.created_by WHERE t.id=$1`, [id])).rows[0];
  if (!task) { res.redirect(BACK + '?err=' + encodeURIComponent('That task is gone.')); return; }

  const devices = (await pool.query(
    `SELECT d.id, d.device_id, d.status, d.error, d.finished_at, d.command_id,
            ad.hostname, c.name AS customer_name,
            ac.exit_code, ac.status AS command_status, right(COALESCE(ac.output,''), 600) AS output_tail
       FROM automation_task_devices d
       LEFT JOIN agent_devices ad ON ad.id = d.device_id
       LEFT JOIN customers c ON c.id = ad.customer_id
       LEFT JOIN agent_commands ac ON ac.id = d.command_id
      WHERE d.task_id=$1 ORDER BY c.name NULLS LAST, ad.hostname`, [id])).rows;

  const siblings = task.series_id
    ? (await pool.query(
      `SELECT id, run_at, status FROM automation_tasks WHERE series_id=$1 AND id <> $2
        ORDER BY run_at LIMIT 60`, [task.series_id, id])).rows
    : [];

  res.render('automation/task', {
    user: req.session.user!, when, task, devices, siblings,
    def: actionDef(task.action),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/automation/scheduled-tasks/:id(\\d+)/cancel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const whole = String(req.body?.series || '') === '1';
  const r = await cancelTask(id, req.session.user!.id, whole);
  const msg = r.alreadyRunning
    ? `Cancelled. ${r.alreadyRunning} machine${r.alreadyRunning === 1 ? ' was' : 's were'} already running it and could not be stopped.`
    : 'Cancelled.';
  res.redirect(BACK + '?msg=' + encodeURIComponent(msg));
});

/** Send it now, ahead of its time. Useful when a maintenance window opens early. */
router.post('/automation/scheduled-tasks/:id(\\d+)/run-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await armTask(id);
  res.redirect(`/automation/scheduled-tasks/${id}?msg=` +
    encodeURIComponent(`Sent to ${r.queued} machine${r.queued === 1 ? '' : 's'}` + (r.skipped ? `, ${r.skipped} skipped.` : '.')));
});

export default router;
