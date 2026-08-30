import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { logActivity } from '../lib/activity';
import {
  FILE_TYPES, OS_TYPES, RUN_AS, listScripts, getScript, upsertScript, deleteScript, scriptStats,
} from '../lib/scripts';

const router = Router();

// ── Script library ──────────────────────────────────────────────────────────────
// Where Lumen's automation scripts live now that Atera is going. Storage and editing
// only at this point — running them is the agent's job and comes later.

const BACK = '/scripts';
const nz = (v: any): string | null => { const s = String(v ?? '').trim(); return s ? s : null; };

router.get('/scripts', requireAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const [scripts, stats] = await Promise.all([listScripts(q), scriptStats()]);
  res.render('scripts/index', {
    user: req.session.user!, scripts, stats, q,
    fileTypes: FILE_TYPES, osTypes: OS_TYPES, runAs: RUN_AS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.get('/scripts/:id(\\d+)', requireAuth, async (req: Request, res: Response) => {
  const script = await getScript(parseInt(String(req.params.id), 10));
  if (!script) { res.redirect(BACK + '?err=' + encodeURIComponent('That script is gone.')); return; }
  res.render('scripts/show', {
    user: req.session.user!, script,
    fileTypes: FILE_TYPES, osTypes: OS_TYPES, runAs: RUN_AS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

/** The body as a plain file — for anyone who wants to run or diff it outside the Portal. */
router.get('/scripts/:id(\\d+)/raw', requireAuth, async (req: Request, res: Response) => {
  const script = await getScript(parseInt(String(req.params.id), 10));
  if (!script) { res.status(404).send('Not found'); return; }
  const safe = script.name.replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 120) || 'script';
  res.type('text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.${script.fileType}"`);
  res.send(script.body);
});

function inputFrom(b: any) {
  return {
    name: String(b.name ?? ''),
    description: nz(b.description),
    fileType: nz(b.file_type),
    osType: nz(b.os_type),
    body: String(b.body ?? ''),
    runAs: nz(b.run_as),
    arguments: nz(b.arguments),
    maxRuntimeMinutes: b.max_runtime_minutes ? parseInt(String(b.max_runtime_minutes), 10) : null,
    category: nz(b.category),
    source: 'lumen',
    sourceRef: null as string | null,
  };
}

router.post('/scripts', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await upsertScript(inputFrom(req.body), req.session.user!.id);
    await logActivity(req.session.user!.id, 'script_create', 'scripts', r.id, `Script added: ${req.body.name}`);
    res.redirect(`/scripts/${r.id}?msg=` + encodeURIComponent('Saved.'));
  } catch (e: any) {
    res.redirect(BACK + '?err=' + encodeURIComponent(e?.message || 'Could not save that script.'));
  }
});

router.post('/scripts/:id(\\d+)', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const existing = await getScript(id);
  if (!existing) { res.redirect(BACK + '?err=' + encodeURIComponent('That script is gone.')); return; }
  try {
    // An edited script keeps its origin: re-importing from Atera should still find it.
    await upsertScript({ ...inputFrom(req.body), source: existing.source, sourceRef: existing.sourceRef },
      req.session.user!.id);
    await logActivity(req.session.user!.id, 'script_update', 'scripts', id, `Script updated: ${req.body.name}`);
    res.redirect(`/scripts/${id}?msg=` + encodeURIComponent('Saved.'));
  } catch (e: any) {
    res.redirect(`/scripts/${id}?err=` + encodeURIComponent(e?.message || 'Could not save that script.'));
  }
});

router.post('/scripts/:id(\\d+)/delete', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const s = await getScript(id);
  if (s) {
    await deleteScript(id);
    await logActivity(req.session.user!.id, 'script_delete', 'scripts', id, `Script removed: ${s.name}`);
  }
  res.redirect(BACK + '?msg=' + encodeURIComponent('Removed.'));
});

/**
 * Bulk import. Shaped for the Atera lift: the page hands us
 * `{ source: 'atera', scripts: [{ sourceRef, name, description, body, ... }] }`.
 *
 * Keyed on sourceRef so it is safe to run twice — the second run updates rather than
 * duplicating. Every row is reported individually; one bad script must not silently
 * take the other 47 with it.
 */
router.post('/scripts/import', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const source = String(req.body?.source || 'atera').trim().slice(0, 40) || 'atera';
  const items: any[] = Array.isArray(req.body?.scripts) ? req.body.scripts : [];
  if (!items.length) { res.status(400).json({ ok: false, error: 'No scripts in that payload.' }); return; }
  if (items.length > 2000) { res.status(400).json({ ok: false, error: 'Too many scripts in one go.' }); return; }

  let created = 0, updated = 0;
  const failed: Array<{ name: string; error: string }> = [];
  for (const it of items) {
    try {
      const r = await upsertScript({
        name: it?.name, description: it?.description, body: it?.body,
        fileType: it?.fileType, osType: it?.osType, runAs: it?.runAs,
        arguments: it?.arguments, maxRuntimeMinutes: it?.maxRuntimeMinutes,
        category: it?.category, source, sourceRef: it?.sourceRef,
      }, req.session.user!.id);
      if (r.created) created++; else updated++;
    } catch (e: any) {
      failed.push({ name: String(it?.name || '(unnamed)').slice(0, 120), error: e?.message || 'failed' });
    }
  }
  await logActivity(req.session.user!.id, 'script_import', 'scripts', null,
    `Imported from ${source}: ${created} new, ${updated} updated, ${failed.length} failed`);
  res.json({ ok: true, created, updated, failed, total: items.length });
});

export default router;
