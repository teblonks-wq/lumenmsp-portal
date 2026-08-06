import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { bestEolMatch, EolRow } from '../lib/ce';
import { resolvePolicy, nextWindowStart, windowLabel } from '../lib/patch-policy';

// ── Software across the estate ──────────────────────────────────────────────────
// One question, asked three ways: what is installed, what is behind, and what is no
// longer supported. They are genuinely different questions and the answers come from
// different places:
//
//   installed  — agent_software, collected on the agent's daily inventory pass
//   behind     — device_patches rows from WinGet and Chocolatey (the machine's own
//                package managers answer this per machine, far better than a list could)
//   supported  — eol_products, now fed nightly from endoflife.date
//
// That last one is the one people conflate. .NET Runtime 6.0.36 is the newest 6.0 build
// there will ever be: WinGet reports it as up to date, and it went out of support in
// November 2024. "Up to date" and "supported" are not the same fact.

const router = Router();

// Names are matched between two sources that spell things differently — Add/Remove
// Programs says "Microsoft .NET Runtime - 6.0.36 (x64)", WinGet says "Microsoft .NET
// Runtime". Strip everything that is not a letter or digit and compare on the prefix.
const NORM = (col: string) => `lower(regexp_replace(${col}, '[^a-zA-Z0-9]', '', 'g'))`;

/** The best available-update row for a machine's copy of an app. WinGet wins over
 *  Chocolatey when both know about it: WinGet can upgrade software installed any way,
 *  Chocolatey can only upgrade what Chocolatey installed. */
const UPDATE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT p.update_id, p.source, p.current_version, p.available_version, p.title
      FROM device_patches p
     WHERE p.device_id = s.device_id
       AND p.source IN ('winget','choco')
       AND length(${NORM('p.title')}) > 3
       AND ${NORM('s.name')} LIKE ${NORM('p.title')} || '%'
     ORDER BY (p.source = 'winget') DESC, length(p.title) DESC
     LIMIT 1
  ) up ON true`;

async function activeEol(): Promise<EolRow[]> {
  return (await pool.query(
    `SELECT id, category, vendor, name, match_type, match_value, version_max,
            eol_date, severity, action, replacement, guidance, ce_control
       FROM eol_products WHERE active = true`)).rows as EolRow[];
}

// ── Catalogue ───────────────────────────────────────────────────────────────────
router.get('/software', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  const q = String(req.query.q || '').trim();
  const only = String(req.query.only || ''); // '' | outdated | eol

  try {
    const params: any[] = [];
    const where: string[] = ['ad.revoked = false'];
    if (customerId) { params.push(customerId); where.push(`ad.customer_id = $${params.length}`); }
    if (q) { params.push('%' + q + '%'); where.push(`(s.name ILIKE $${params.length} OR s.publisher ILIKE $${params.length})`); }

    const rows = (await pool.query(
      `SELECT s.name,
              MIN(s.publisher) AS publisher,
              count(DISTINCT s.device_id)::int AS devices,
              count(DISTINCT COALESCE(s.version,''))::int AS versions,
              MAX(s.version) AS newest_installed,
              MIN(s.version) AS oldest_installed,
              count(DISTINCT up.update_id) FILTER (WHERE up.update_id IS NOT NULL)::int AS outdated,
              MAX(up.available_version) AS available,
              MIN(up.source) AS up_source
         FROM agent_software s
         JOIN agent_devices ad ON ad.id = s.device_id
         ${UPDATE_LATERAL}
        WHERE ${where.join(' AND ')}
        GROUP BY s.name
        ORDER BY count(DISTINCT up.update_id) DESC, count(DISTINCT s.device_id) DESC, s.name
        LIMIT 500`, params)).rows;

    // End-of-life is judged here rather than in SQL: the rules are the same ones the
    // Cyber Essentials engine uses, and having two implementations of "is this row a
    // match" is how they drift apart.
    const eol = await activeEol();
    const today = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      const hit = bestEolMatch(eol, r.name, r.newest_installed || null);
      r.eol = hit ? { name: hit.name, date: hit.eol_date ? String(hit.eol_date).slice(0, 10) : null, action: hit.action, guidance: hit.guidance, replacement: hit.replacement } : null;
      r.eol_past = !!(r.eol && r.eol.date && r.eol.date <= today);
    }

    const filtered = only === 'outdated' ? rows.filter((r: any) => r.outdated > 0)
      : only === 'eol' ? rows.filter((r: any) => r.eol_past)
      : rows;

    const customers = (await pool.query(
      `SELECT c.id, c.name, count(DISTINCT ad.id)::int AS devices
         FROM customers c JOIN agent_devices ad ON ad.customer_id = c.id AND ad.revoked = false
        WHERE c.deleted_at IS NULL GROUP BY c.id, c.name ORDER BY c.name`)).rows;

    const summary = {
      titles: rows.length,
      outdated: rows.filter((r: any) => r.outdated > 0).length,
      eol: rows.filter((r: any) => r.eol_past).length,
      installs: rows.reduce((a: number, r: any) => a + Number(r.devices), 0),
    };

    res.render('software', {
      user: req.session.user!, rows: filtered, customers, customerId, q, only, summary,
      msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    console.error('[software] catalogue failed:', e.message);
    res.render('software', {
      user: req.session.user!, rows: [], customers: [], customerId, q, only,
      summary: { titles: 0, outdated: 0, eol: 0, installs: 0 }, msg: null, error: e.message,
    });
  }
});

// ── One title, everywhere it is installed ───────────────────────────────────────
// Query string rather than a path segment: these names contain dots, slashes, brackets
// and the odd trademark symbol, and none of that survives a URL path cleanly.
router.get('/software/app', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const name = String(req.query.name || '').trim();
  const customerId = parseInt(String(req.query.customer || ''), 10) || null;
  if (!name) { res.redirect('/software'); return; }

  try {
    const params: any[] = [name];
    const where: string[] = ['ad.revoked = false', 's.name = $1'];
    if (customerId) { params.push(customerId); where.push(`ad.customer_id = $${params.length}`); }

    const installs = (await pool.query(
      `SELECT ad.id AS device_id, ad.hostname, ad.os, ad.customer_id, ad.patch_excluded,
              c.name AS customer_name, s.version, s.publisher, s.install_date,
              up.update_id, up.source AS up_source, up.available_version, up.current_version,
              EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS seen_secs
         FROM agent_software s
         JOIN agent_devices ad ON ad.id = s.device_id
         LEFT JOIN customers c ON c.id = ad.customer_id
         ${UPDATE_LATERAL}
        WHERE ${where.join(' AND ')}
        ORDER BY (up.update_id IS NULL), c.name NULLS LAST, ad.hostname`, params)).rows;

    const eol = await activeEol();
    const newest = installs.map((i: any) => i.version).filter(Boolean).sort().pop() || null;
    const hit = bestEolMatch(eol, name, newest);
    const today = new Date().toISOString().slice(0, 10);

    const byCustomer: Record<string, { name: string; id: number | null; total: number; outdated: number }> = {};
    for (const i of installs) {
      const k = String(i.customer_id || 'none');
      if (!byCustomer[k]) byCustomer[k] = { name: i.customer_name || 'Unassigned', id: i.customer_id || null, total: 0, outdated: 0 };
      byCustomer[k].total++;
      if (i.update_id) byCustomer[k].outdated++;
    }

    res.render('software-app', {
      user: req.session.user!, name, installs, customerId,
      customers: Object.values(byCustomer).sort((a, b) => a.name.localeCompare(b.name)),
      eol: hit || null,
      eolPast: !!(hit && hit.eol_date && String(hit.eol_date).slice(0, 10) <= today),
      outdated: installs.filter((i: any) => i.update_id).length,
      msg: req.query.msg || null, error: null,
    });
  } catch (e: any) {
    console.error('[software] app view failed:', e.message);
    res.redirect('/software?msg=' + encodeURIComponent('Could not open that title: ' + e.message));
  }
});

// ── Push the update ─────────────────────────────────────────────────────────────
// Queues one command per machine per title. Machines that are off keep the command and
// take it when they come back.
//
// "when" is the one real decision here. Now means the next check-in — a minute or so on
// a machine that is on. Window means hold it until the maintenance window in that
// machine's patch policy, which is the right answer for a server in the middle of the
// afternoon and overkill for a laptop.
interface QueueOpts {
  names: string[];
  customerId: number | null;
  deviceIds: number[] | null;
  userId: number;
  when: 'now' | 'window';
}

async function queueUpdates(o: QueueOpts): Promise<{ queued: number; held: number; skipped: number; machines: number }> {
  const params: any[] = [o.names];
  const where: string[] = ['ad.revoked = false', 's.name = ANY($1::text[])', 'up.update_id IS NOT NULL'];
  if (o.customerId) { params.push(o.customerId); where.push(`ad.customer_id = $${params.length}`); }
  if (o.deviceIds && o.deviceIds.length) { params.push(o.deviceIds); where.push(`ad.id = ANY($${params.length}::int[])`); }

  const targets = (await pool.query(
    `SELECT DISTINCT ad.id AS device_id, ad.patch_excluded, s.name,
            up.update_id, up.source AS up_source
       FROM agent_software s
       JOIN agent_devices ad ON ad.id = s.device_id
       ${UPDATE_LATERAL}
      WHERE ${where.join(' AND ')}`, params)).rows;

  let queued = 0, held = 0, skipped = 0;
  const seen = new Set<string>();
  const machines = new Set<number>();
  // One policy lookup per machine rather than per row — a machine with eight outdated
  // titles should not mean eight identical trips to the database.
  const windowFor = new Map<number, Date | null>();

  for (const t of targets) {
    const key = `${t.device_id}:${t.update_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.patch_excluded) { skipped++; continue; }

    let at: Date | null = null;
    if (o.when === 'window') {
      if (!windowFor.has(t.device_id)) windowFor.set(t.device_id, nextWindowStart(await resolvePolicy(t.device_id)));
      at = windowFor.get(t.device_id) || null;
    }
    if (at) held++; else queued++;
    machines.add(t.device_id);

    // update_id is namespaced at ingest ("winget:Microsoft.DotNet.Runtime.6") so a WinGet
    // id can never collide with a Chocolatey one. The package manager wants the bare id.
    const bare = String(t.update_id).replace(/^(winget|choco):/, '');
    await pool.query(
      `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by, run_after)
       VALUES ($1,$2,$3,'queued',$4,$5)`,
      [t.device_id, t.up_source === 'choco' ? 'choco.upgrade' : 'winget.upgrade',
       JSON.stringify({ id: bare, name: t.name }), o.userId, at]);
  }

  return { queued, held, skipped, machines: machines.size };
}

function queueMessage(r: { queued: number; held: number; skipped: number; machines: number }, titles: number): string {
  if (!r.queued && !r.held) return 'Nothing to do — no machine in that scope has an update waiting.';
  let m = `Queued ${r.queued + r.held} update${r.queued + r.held === 1 ? '' : 's'} across ${r.machines} machine${r.machines === 1 ? '' : 's'}`;
  m += titles > 1 ? ` for ${titles} titles.` : '.';
  if (r.held) m += ` ${r.held} held until their maintenance window opens.`;
  if (r.skipped) m += ` ${r.skipped} skipped — excluded from patching.`;
  m += ' Machines that are switched off will pick it up when they come back.';
  return m;
}

// One title: everywhere, one customer, or the machines you ticked.
router.post('/software/update', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const name = String(req.body.name || '').trim();
  const scope = String(req.body.scope || 'selected'); // selected | all-outdated | customer
  const customerId = parseInt(String(req.body.customer_id || ''), 10) || null;
  const when = String(req.body.when || 'now') === 'window' ? 'window' : 'now';
  const picked = (Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : [])
    .map((v: any) => parseInt(String(v), 10)).filter((n: number) => !!n);

  const back = '/software/app?name=' + encodeURIComponent(name) + (customerId && scope !== 'customer' ? '&customer=' + customerId : '');
  const go = (m: string) => res.redirect(back + '&msg=' + encodeURIComponent(m));
  if (!name) { res.redirect('/software'); return; }

  try {
    if (scope === 'selected' && !picked.length) { go('Nothing was ticked.'); return; }
    if (scope === 'customer' && !customerId) { go('Pick a customer first.'); return; }

    const r = await queueUpdates({
      names: [name],
      customerId: scope === 'customer' ? customerId : null,
      deviceIds: scope === 'selected' ? picked : null,
      userId: user.id, when,
    });
    await logActivity(user.id, 'software_update', null, null,
      `Queued "${name}" updates on ${r.machines} machine(s)`);
    go(queueMessage(r, 1));
  } catch (e: any) {
    console.error('[software] update failed:', e.message);
    go('Could not queue: ' + e.message);
  }
});

// Several titles at once, straight from the catalogue — the same fix on eight products is
// one job, and asking someone to open eight pages to do it is how it does not get done.
router.post('/software/bulk-update', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const raw = req.body.names;
  const names = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((v: any) => String(v)).filter(Boolean);
  const customerId = parseInt(String(req.body.customer_id || ''), 10) || null;
  const when = String(req.body.when || 'now') === 'window' ? 'window' : 'now';

  const qs = new URLSearchParams();
  if (customerId) qs.set('customer', String(customerId));
  if (req.body.q) qs.set('q', String(req.body.q));
  if (req.body.only) qs.set('only', String(req.body.only));
  const go = (m: string) => {
    qs.set('msg', m);
    res.redirect('/software?' + qs.toString());
  };

  if (!names.length) { go('Nothing was ticked.'); return; }

  try {
    const r = await queueUpdates({ names, customerId, deviceIds: null, userId: user.id, when });
    await logActivity(user.id, 'software_update', null, null,
      `Queued updates for ${names.length} title(s) across ${r.machines} machine(s)`);
    go(queueMessage(r, names.length));
  } catch (e: any) {
    console.error('[software] bulk update failed:', e.message);
    go('Could not queue: ' + e.message);
  }
});

export default router;
