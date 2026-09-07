import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { listScripts } from '../lib/scripts';
import {
  KINDS, HEAL_TYPES, listWatchdogs, getWatchdog, createWatchdog, updateWatchdog, setEnabled, deleteWatchdog,
  checkNow, healNow, watchdogDetail, WatchdogInput, filterWords, normaliseFilter,
} from '../lib/watchdogs';
import { lookupServices, servicesOnMachines, inventoryStats } from '../lib/services-inventory';

// ── Watchdogs — under Automation ────────────────────────────────────────────────
// The board lists every watchdog with what it is finding right now; a watchdog's own page
// is the per-machine truth plus the story of what was done about it. Admin-only, like the
// rest of Automation: a watchdog can restart services and machines on its own.

const router = Router();
const BACK = '/automation/watchdogs';

router.get('/automation/watchdogs', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const dogs = await listWatchdogs();
  const failing = (await pool.query(
    `SELECT s.watchdog_id, s.device_id, s.detail, s.failing_since, s.heal_count, s.escalated_at, w.name, w.severity, ad.hostname, c.name AS customer_name
       FROM watchdog_states s JOIN watchdogs w ON w.id=s.watchdog_id JOIN agent_devices ad ON ad.id=s.device_id
       LEFT JOIN customers c ON c.id=ad.customer_id
      WHERE s.status='failing' AND w.enabled AND w.deleted_at IS NULL
      ORDER BY (w.severity='critical') DESC, s.failing_since NULLS LAST LIMIT 200`)).rows;
  res.render('automation/watchdogs', {
    user: req.session.user!, dogs, failing, kinds: KINDS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

async function formLocals(req: Request, existing: any | null) {
  const [scripts, customers] = await Promise.all([
    listScripts(),
    pool.query(
      `SELECT c.id, c.name, COUNT(ad.id)::int AS devices
         FROM customers c JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked IS NOT TRUE
        WHERE c.deleted_at IS NULL GROUP BY c.id, c.name HAVING COUNT(ad.id) > 0 ORDER BY c.name`),
  ]);
  const seedDevices = existing
    ? (await pool.query(
      `SELECT ad.id, ad.hostname FROM watchdog_targets t JOIN agent_devices ad ON ad.id=t.device_id WHERE t.watchdog_id=$1 ORDER BY ad.hostname`, [existing.id])).rows
    : [];
  const [tags, types, inventory] = await Promise.all([
    pool.query(`SELECT t.id, t.name, COUNT(m.asset_id)::int AS n FROM asset_tags t LEFT JOIN asset_tag_members m ON m.tag_id = t.id GROUP BY t.id, t.name ORDER BY t.name`).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT device_type AS t, COUNT(*)::int AS n FROM agent_devices WHERE revoked IS NOT TRUE AND device_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`).catch(() => ({ rows: [] as any[] })),
    inventoryStats().catch(() => ({ machines: 0, services: 0, newest: null })),
  ]);
  return {
    user: req.session.user!, kinds: KINDS, healTypes: HEAL_TYPES,
    scripts: scripts.filter((s) => s.osType === 'windows'), customers: customers.rows,
    tags: tags.rows, deviceTypes: types.rows, inventory,
    existing, seedDevices, notice: req.query.msg || null, error: req.query.err || null,
  };
}

/** Service lookup across the estate (or chosen machines / one customer): names, display names, machine counts. */
router.get('/automation/watchdogs/services.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const deviceIds = String(req.query.device_ids || '').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
  const rows = await lookupServices({ q: String(req.query.q || '').trim(), deviceIds, customerId: parseInt(String(req.query.customer || ''), 10) || null, limit: 40 });
  res.json({ ok: true, services: rows, inventory: await inventoryStats() });
});

/** Which of the chosen machines actually have each named service — shown before the watchdog is saved. */
router.get('/automation/watchdogs/check-services.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const deviceIds = String(req.query.device_ids || '').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
  const names = String(req.query.names || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const known = (await pool.query(`SELECT DISTINCT device_id FROM device_services WHERE device_id = ANY($1::int[])`, [deviceIds])).rows.map((r) => Number(r.device_id));
  res.json({ ok: true, inventoried: known, coverage: await servicesOnMachines(known, names) });
});

router.get('/automation/watchdogs/new', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  res.render('automation/watchdog-new', await formLocals(req, null));
});

/** The form posts JSON (one field) — the heal list and params are nested, and a flat form cannot say that cleanly. */
function inputFromBody(b: any): WatchdogInput {
  let j: any = {};
  try { j = typeof b.spec === 'string' ? JSON.parse(b.spec) : (b.spec || {}); } catch { j = {}; }
  return {
    name: String(j.name || b.name || ''), kind: String(j.kind || ''), params: j.params || {},
    scope: String(j.scope || 'devices'), customerId: j.customerId ? Number(j.customerId) : null,
    deviceIds: Array.isArray(j.deviceIds) ? j.deviceIds.map(Number) : String(b.device_ids || '').split(',').map((s: string) => parseInt(s, 10)).filter(Boolean),
    severity: String(j.severity || 'warning'), intervalMinutes: Number(j.intervalMinutes || 15),
    heal: Array.isArray(j.heal) ? j.heal : [], healMaxPerDay: Number(j.healMaxPerDay ?? 3), healCooldownMinutes: Number(j.healCooldownMinutes ?? 30),
    escalateCase: j.escalateCase !== false, notes: j.notes ? String(j.notes) : null,
  };
}

router.post('/automation/watchdogs', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const r = await createWatchdog(inputFromBody(req.body || {}), req.session.user!.id);
  if (!r.ok) { res.redirect(BACK + '/new?err=' + encodeURIComponent(r.error || 'Could not save that.')); return; }
  await logActivity(req.session.user!.id, 'watchdog_create', 'watchdogs', r.id!, `Watchdog created: ${String((req.body || {}).name || '').slice(0, 80)}`);
  res.redirect(`${BACK}/${r.id}?msg=` + encodeURIComponent('Watching. The first check runs within a minute.'));
});

router.get('/automation/watchdogs/:id(\\d+)', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const w = await getWatchdog(id);
  if (!w) { res.redirect(BACK + '?err=' + encodeURIComponent('That watchdog is gone.')); return; }
  const detail = await watchdogDetail(id);
  const customer = w.customerId ? (await pool.query('SELECT name FROM customers WHERE id=$1', [w.customerId])).rows[0] : null;
  const scriptNames = new Map<number, string>();
  for (const h of w.heal) if (h.type === 'script' && h.scriptId) {
    const s = (await pool.query('SELECT name FROM scripts WHERE id=$1', [h.scriptId])).rows[0];
    if (s) scriptNames.set(Number(h.scriptId), s.name);
  }
  let scopeWords: string | null = null;
  if (w.scope === 'filter') {
    const f = normaliseFilter(w.params?.filter);
    const [cn, tn] = await Promise.all([
      f?.customerIds?.length ? pool.query('SELECT id, name FROM customers WHERE id = ANY($1::int[])', [f.customerIds]) : Promise.resolve({ rows: [] as any[] }),
      f?.tagIds?.length ? pool.query('SELECT id, name FROM asset_tags WHERE id = ANY($1::int[])', [f.tagIds]) : Promise.resolve({ rows: [] as any[] }),
    ]);
    scopeWords = filterWords(f, { customers: new Map(cn.rows.map((r: any) => [Number(r.id), String(r.name)])), tags: new Map(tn.rows.map((r: any) => [Number(r.id), String(r.name)])) });
  }
  res.render('automation/watchdog', {
    user: req.session.user!, w, states: detail?.states || [], events: detail?.events || [], kinds: KINDS, healTypes: HEAL_TYPES, scopeWords,
    customerName: customer?.name || null, scriptNames: Object.fromEntries(scriptNames),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.get('/automation/watchdogs/:id(\\d+)/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const w = await getWatchdog(id);
  if (!w) { res.redirect(BACK + '?err=' + encodeURIComponent('That watchdog is gone.')); return; }
  res.render('automation/watchdog-new', await formLocals(req, w));
});

router.post('/automation/watchdogs/:id(\\d+)', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await updateWatchdog(id, inputFromBody(req.body || {}));
  if (!r.ok) { res.redirect(`${BACK}/${id}/edit?err=` + encodeURIComponent(r.error || 'Could not save that.')); return; }
  await logActivity(req.session.user!.id, 'watchdog_update', 'watchdogs', id, 'Watchdog changed');
  res.redirect(`${BACK}/${id}?msg=` + encodeURIComponent('Saved. Checks start again from now.'));
});

router.post('/automation/watchdogs/:id(\\d+)/enabled', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const on = String((req.body || {}).on) === '1';
  await setEnabled(id, on);
  await logActivity(req.session.user!.id, 'watchdog_toggle', 'watchdogs', id, on ? 'Watchdog switched on' : 'Watchdog switched off');
  res.redirect(`${BACK}/${id}?msg=` + encodeURIComponent(on ? 'Switched on.' : 'Switched off — its alerts are closed.'));
});

router.post('/automation/watchdogs/:id(\\d+)/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await deleteWatchdog(id);
  await logActivity(req.session.user!.id, 'watchdog_delete', 'watchdogs', id, 'Watchdog removed');
  res.redirect(BACK + '?msg=' + encodeURIComponent('Removed. Its history is kept.'));
});

router.post('/automation/watchdogs/:id(\\d+)/check-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await checkNow(id);
  res.redirect(`${BACK}/${id}?msg=` + encodeURIComponent('Checking now — give it a minute, longer for machines that are slow to answer.'));
});

router.post('/automation/watchdogs/:id(\\d+)/heal-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const deviceId = parseInt(String((req.body || {}).device_id), 10);
  const out = await healNow(id, deviceId, req.session.user!.displayName || 'staff');
  await logActivity(req.session.user!.id, 'watchdog_heal', 'watchdogs', id, `Heal now on device ${deviceId}: ${out.slice(0, 160)}`);
  res.redirect(`${BACK}/${id}?msg=` + encodeURIComponent(out));
});

export default router;
