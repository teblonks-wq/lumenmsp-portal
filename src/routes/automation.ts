import { normaliseFilter, filterSql } from '../lib/watchdogs';
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import {
  ACTIONS, CONDITIONS, RECURRENCES, actionDef, createTask, cancelTask, armTask, reconcileTasks,
} from '../lib/automation';
import { listScripts } from '../lib/scripts';
import { logActivity } from '../lib/activity';
import { listCatalogue, getCatalogueItem, saveCatalogueItem, setCatalogueActive, backfillFromPackages, blockedReason, suggestFromEstate } from '../lib/software-catalogue';

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

  // ── Filter by customer ────────────────────────────────────────────────────────
  // A task targets DEVICES, and a device belongs to a customer - so a task has no customer
  // of its own and can legitimately span several. The filter is therefore "tasks with at
  // least one machine at this customer", and the table names the customers a task covers
  // so a filtered row still says whether it reaches anyone else.
  const custId = parseInt(String(req.query.customer || ''), 10);
  const cust = Number.isInteger(custId) && custId > 0 ? custId : null;
  const taskWhere = cust
    ? ` AND EXISTS (SELECT 1 FROM automation_task_devices d
                      JOIN agent_devices ad ON ad.id = d.device_id
                     WHERE d.task_id = t.id AND ad.customer_id = ${cust})`
    : '';

  const SELECT = `SELECT t.id, t.name, t.action, t.condition, t.run_at, t.run_until, t.recurrence, t.recurrence_end,
                         t.series_id, t.status, t.armed_at, t.finished_at, t.created_at,
                         u.display_name AS created_by_name,
                         (SELECT COUNT(*)::int FROM automation_task_devices d WHERE d.task_id=t.id) AS devices,
                         (SELECT COUNT(*)::int FROM automation_task_devices d WHERE d.task_id=t.id AND d.status='done') AS done,
                         (SELECT COUNT(*)::int FROM automation_task_devices d WHERE d.task_id=t.id AND d.status IN ('failed','skipped')) AS failed,
                         (SELECT string_agg(DISTINCT c.name, ', ' ORDER BY c.name)
                            FROM automation_task_devices d
                            JOIN agent_devices ad ON ad.id = d.device_id
                            JOIN customers c ON c.id = ad.customer_id
                           WHERE d.task_id = t.id) AS customer_names,
                         (SELECT COUNT(DISTINCT ad.customer_id)::int
                            FROM automation_task_devices d
                            JOIN agent_devices ad ON ad.id = d.device_id
                           WHERE d.task_id = t.id AND ad.customer_id IS NOT NULL) AS customer_count
                    FROM automation_tasks t
                    LEFT JOIN users u ON u.id = t.created_by`;

  const [upcoming, running, recent, legacy, custList] = await Promise.all([
    pool.query(`${SELECT} WHERE t.status='scheduled'${taskWhere} ORDER BY t.run_at NULLS FIRST, t.id LIMIT 200`),
    pool.query(`${SELECT} WHERE t.status='armed'${taskWhere} ORDER BY t.armed_at DESC LIMIT 100`),
    // Finished work falls off this screen after 48 hours. It is a board of what is
    // HAPPENING; a task that ended on Tuesday sitting under today's is noise that makes
    // the screen less trustworthy, not more complete. Nothing is deleted - the task and
    // its per-machine results stay on its own page and in the history.
    //
    // The cut is made entirely in SQL (NOW() - INTERVAL), never by handing node-pg a JS
    // Date: that is the timestamp-timezone trap this codebase has been bitten by before,
    // and it would silently shift the window by an hour for half the year.
    //
    // created_at is the last-resort basis so a row with no finish stamp - a data fault,
    // but they happen - ages out too instead of sitting there for ever.
    pool.query(`${SELECT} WHERE t.status IN ('done','cancelled')${taskWhere}
                  AND COALESCE(t.finished_at, t.cancelled_at, t.created_at) > NOW() - INTERVAL '48 hours'
                ORDER BY COALESCE(t.finished_at, t.cancelled_at, t.created_at) DESC LIMIT 50`),
    // Reboots and shutdowns scheduled from a device page before this screen existed — and
    // still scheduled that way today. They are real pending work on real machines, so they
    // belong on the one screen that claims to show everything scheduled, even though they
    // are not automation tasks and cannot be edited here.
    pool.query(
      `SELECT ac.id, ac.kind, ac.run_after, ac.requested_at, ad.hostname, ad.id AS device_id,
              c.name AS customer_name, u.display_name AS requested_by_name, ast.id AS asset_id
         FROM agent_commands ac
         LEFT JOIN agent_devices ad ON ad.id = ac.device_id
         LEFT JOIN customers c ON c.id = ad.customer_id
         LEFT JOIN users u ON u.id = ac.requested_by
         LEFT JOIN LATERAL (
           SELECT ca.id FROM customer_assets ca
            WHERE ca.agent_device_id = ac.device_id AND ca.merged_into_id IS NULL AND ca.archived_at IS NULL
            ORDER BY ca.id LIMIT 1
         ) ast ON true
        WHERE ac.kind LIKE 'power.%' AND ac.status='queued' AND ac.run_after IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM automation_task_devices d WHERE d.command_id = ac.id)
          ${cust ? `AND ad.customer_id = ${cust}` : ''}
        ORDER BY ac.run_after LIMIT 100`),
    // Only customers that actually HAVE work on this screen. A dropdown of every customer
    // on the books, most of them with nothing scheduled ever, is a worse way to find
    // Larkmead than scrolling. Note this list is deliberately NOT filtered by `cust` -
    // it has to keep offering the other customers so the filter can be changed.
    pool.query(
      `SELECT c.id, c.name FROM customers c
        WHERE c.deleted_at IS NULL AND EXISTS (
              SELECT 1 FROM agent_devices ad WHERE ad.customer_id = c.id AND (
                    EXISTS (SELECT 1 FROM automation_task_devices d WHERE d.device_id = ad.id)
                 OR EXISTS (SELECT 1 FROM agent_commands ac WHERE ac.device_id = ad.id
                              AND ac.kind LIKE 'power.%' AND ac.status='queued' AND ac.run_after IS NOT NULL)))
        ORDER BY lower(c.name)`),
  ]);

  const custName = cust ? (custList.rows.find((r: any) => Number(r.id) === cust) || {}).name || null : null;

  res.render('automation/tasks', {
    user: req.session.user!, when,
    upcoming: upcoming.rows, running: running.rows, recent: recent.rows, legacy: legacy.rows,
    actions: ACTIONS, customers: custList.rows, filterCustomer: cust, filterCustomerName: custName,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// ── New task ────────────────────────────────────────────────────────────────────

router.get('/automation/scheduled-tasks/new', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [scripts, packages, customers, catalogue] = await Promise.all([
    listScripts(),
    pool.query('SELECT id, name, version FROM agent_packages ORDER BY name'),
    pool.query(
      `SELECT c.id, c.name, COUNT(ad.id)::int AS devices
         FROM customers c JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked IS NOT TRUE
        WHERE c.deleted_at IS NULL GROUP BY c.id, c.name HAVING COUNT(ad.id) > 0 ORDER BY c.name`),
    listCatalogue(),
  ]);
  // Arriving from a selection on /assets: the machines and the action come in on the URL,
  // so picking twelve machines there does not mean finding them again here. Ids are agent
  // device ids, already resolved and filtered by the sender - anything unknown is simply
  // not preselected rather than silently widening the task.
  const seedIds = String(req.query.devices || '').split(',')
    .map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const seedDevices = seedIds.length
    ? (await pool.query(
      `SELECT ad.id, ad.hostname, c.name AS customer_name
         FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
        WHERE ad.id = ANY($1::int[]) AND ad.revoked IS NOT TRUE
        ORDER BY c.name NULLS LAST, ad.hostname`, [seedIds])).rows
    : [];
  const seedAction = ACTIONS.some((a) => a.key === String(req.query.action || '')) ? String(req.query.action) : '';
  // Started from ONE machine's Manage menu on its asset page: the customer travels with it,
  // so the picker below opens showing that site rather than all 200 machines with one ticked.
  const seedCustomerId = parseInt(String(req.query.customer || ''), 10) || null;

  res.render('automation/task-new', {
    user: req.session.user!,
    actions: ACTIONS, conditions: CONDITIONS, recurrences: RECURRENCES,
    scripts: scripts.filter((s) => s.osType === 'windows'),
    packages: packages.rows, customers: customers.rows, catalogue,
    seedDevices, seedAction, seedCustomerId,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

/** The machine picker. Searches hostname, customer and the signed-in user. */
router.get('/automation/devices.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  // Filters (7 Sep 2026: "folders/tags, advanced filters"): customer, tag, type, OS, words, online —
  // the same TargetFilter a watchdog can keep as its scope, so what the picker shows is exactly
  // what a filter-scoped watchdog would watch.
  const f = normaliseFilter({ customerIds: req.query.customer, tagIds: req.query.tag, types: req.query.type, osLike: req.query.os, hostLike: req.query.q, onlineOnly: req.query.online });
  const params: any[] = [];
  const where = ['ad.revoked IS NOT TRUE', 'ad.hostname IS NOT NULL'];
  const extra = f ? filterSql(f, params) : '';
  const { rows } = await pool.query(
    `SELECT ad.id, ad.hostname, ad.device_type, ad.os, ad.logged_in_user, c.name AS customer_name,
            (EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at)) < 180) AS online,
            (SELECT STRING_AGG(t.name, ', ' ORDER BY t.name) FROM customer_assets ca JOIN asset_tag_members m ON m.asset_id = ca.id JOIN asset_tags t ON t.id = m.tag_id WHERE ca.agent_device_id = ad.id) AS tags
       FROM agent_devices ad LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ${where.join(' AND ')}${extra}
      ORDER BY c.name NULLS LAST, ad.hostname LIMIT 400`, params);
  res.json({ ok: true, devices: rows, filter: f });
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
    catalogueId: parseInt(String(b.catalogue_id || ''), 10) || null,
    command: String(b.command || '') || null,
    accountName: String(b.account_name || '') || null,
    delaySeconds: b.delay_seconds != null ? parseInt(String(b.delay_seconds), 10) : null,
  }, req.session.user!.id, req.session.user!.displayName);

  if (!r.ok) { res.redirect('/automation/scheduled-tasks/new?err=' + encodeURIComponent(r.error || 'Could not schedule that.')); return; }
  const extra = (r.occurrences || 1) > 1 ? ` — ${r.occurrences} occurrences scheduled.` : '';
  res.redirect(`/automation/scheduled-tasks/${r.taskId}?msg=` + encodeURIComponent('Scheduled.' + extra));
});

/**
 * The same create, answered as JSON. For the places a task is scheduled from INSIDE another
 * screen — today the device's User Management panel ("Disable at…") — where a redirect to
 * the task page would throw away the panel the person was working in. Same validation,
 * same table, same sweep; the task page link comes back for the panel to show.
 */
router.post('/automation/scheduled-tasks.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const ids = Array.isArray(b.device_ids) ? b.device_ids.map((n: any) => parseInt(String(n), 10)).filter(Boolean)
    : String(b.device_ids || '').split(',').map((s: string) => parseInt(s.trim(), 10)).filter(Boolean);
  const r = await createTask({
    name: String(b.name || ''),
    action: String(b.action || ''),
    condition: String(b.condition || 'datetime'),
    runAtEpoch: parseInt(String(b.run_at_epoch || ''), 10) || null,
    runUntilEpoch: parseInt(String(b.run_until_epoch || ''), 10) || null,
    recurrence: 'none',
    deviceIds: ids,
    scriptId: parseInt(String(b.script_id || ''), 10) || null,
    catalogueId: parseInt(String(b.catalogue_id || ''), 10) || null,
    command: String(b.command || '') || null,
    accountName: String(b.account_name || '') || null,
    delaySeconds: b.delay_seconds != null ? parseInt(String(b.delay_seconds), 10) : null,
  }, req.session.user!.id, req.session.user!.displayName);
  if (!r.ok) { res.status(400).json({ ok: false, error: r.error || 'Could not schedule that.' }); return; }
  res.json({ ok: true, taskId: r.taskId, url: `/automation/scheduled-tasks/${r.taskId}` });
});

// ── Software catalogue ──────────────────────────────────────────────────────────
// The vetted list Automation deploys from. Bitdefender and MeshCentral are refused here by
// lib/software-catalogue.ts — they have their own pipelines and a generic push produces an
// endpoint nobody manages.
router.get('/automation/catalogue', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [items, packages, suggestions] = await Promise.all([
    listCatalogue(true),
    pool.query('SELECT id, name, version, url FROM agent_packages ORDER BY name'),
    suggestFromEstate(),
  ]);
  const edit = req.query.edit ? await getCatalogueItem(parseInt(String(req.query.edit), 10)) : null;
  res.render('automation/catalogue', {
    user: req.session.user!, items, packages: packages.rows, edit, suggestions,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/automation/catalogue', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const id = parseInt(String(b.id || ''), 10) || undefined;
  const r = await saveCatalogueItem({
    name: String(b.name || ''), publisher: String(b.publisher || '') || null,
    category: String(b.category || '') || null, source: String(b.source || ''),
    packageRef: String(b.package_ref || '') || null,
    agentPackageId: parseInt(String(b.agent_package_id || ''), 10) || null,
    installArgs: String(b.install_args || '') || null, notes: String(b.notes || '') || null,
    sortOrder: parseInt(String(b.sort_order || ''), 10) || null,
  }, req.session.user!.id, id);
  if (!r.ok) { res.redirect('/automation/catalogue?err=' + encodeURIComponent(r.error || 'Could not save that.')); return; }
  await logActivity(req.session.user!.id, id ? 'updated' : 'created', 'settings', 0, `Software catalogue: ${id ? 'updated' : 'added'} "${String(b.name || '').slice(0, 60)}"`);
  res.redirect('/automation/catalogue?msg=' + encodeURIComponent(id ? 'Saved.' : 'Added to the catalogue.'));
});

router.post('/automation/catalogue/:id(\\d+)/active', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const on = String((req.body || {}).active) === '1';
  if (id) await setCatalogueActive(id, on);
  res.redirect('/automation/catalogue?msg=' + encodeURIComponent(on ? 'Back in the catalogue.' : 'Retired — it can no longer be scheduled.'));
});

// Add a WinGet suggestion straight from the estate list. The id came from a machine's own
// patch scan, so it is a real id rather than one typed from memory — the whole point.
router.post('/automation/catalogue/add-suggested', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const r = await saveCatalogueItem({
    name: String(b.name || '').slice(0, 120),
    category: 'From the estate',
    source: 'winget',
    packageRef: String(b.package_ref || ''),
    notes: b.devices ? `Seen on ${String(b.devices)} machine(s) when it was added.` : null,
  }, req.session.user!.id);
  if (!r.ok) { res.redirect('/automation/catalogue?err=' + encodeURIComponent(r.error || 'Could not add that.')); return; }
  res.redirect('/automation/catalogue?msg=' + encodeURIComponent(`Added ${String(b.name || 'it')} to the catalogue.`));
});

// Bring every MSI already uploaded into the catalogue, so nothing that used to be
// deployable stops being deployable. Idempotent; never imports blocked software.
router.post('/automation/catalogue/backfill', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const r = await backfillFromPackages();
  res.redirect('/automation/catalogue?msg=' + encodeURIComponent(
    `Brought ${r.added} uploaded package(s) into the catalogue${r.skipped ? `; ${r.skipped} already there or not deployable this way` : ''}.`));
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
            ad.hostname, c.name AS customer_name, ast.id AS asset_id,
            ac.exit_code, ac.status AS command_status, right(COALESCE(ac.output,''), 600) AS output_tail
       FROM automation_task_devices d
       LEFT JOIN agent_devices ad ON ad.id = d.device_id
       LEFT JOIN customers c ON c.id = ad.customer_id
       LEFT JOIN agent_commands ac ON ac.id = d.command_id
       LEFT JOIN LATERAL (
         SELECT ca.id FROM customer_assets ca
          WHERE ca.agent_device_id = d.device_id AND ca.merged_into_id IS NULL AND ca.archived_at IS NULL
          ORDER BY ca.id LIMIT 1
       ) ast ON true
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
