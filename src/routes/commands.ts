import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { reapStaleCommands } from '../lib/agent-commands';

// ── Where has my command got to? ────────────────────────────────────────────────
// Every "Collect", "Refresh" and "Install" button in the Portal queues an agent command
// and then says nothing until you think to reload. That is indistinguishable from the
// button not having worked, which is exactly how a broken collection went unnoticed for
// an afternoon. One endpoint, one shared tracker, every button.

const router = Router();

/** A friendly name per kind, so the tracker can say what is happening. */
const KIND_LABEL: Record<string, string> = {
  'gpo.inventory': 'Reading Group Policy',
  'gpo.deploy': 'Working on the deployment policy',
  'server.facts': 'Collecting server facts',
  'ce.assess': 'Running the Cyber Essentials checks',
  'mesh.install': 'Installing remote access',
  'patch.scan': 'Scanning for updates',
  'patch.scan.apps': 'Scanning for application updates',
  'patch.install': 'Installing updates',
  'inventory.software': 'Listing installed software',
  'software.install': 'Installing software',
  'software.uninstall': 'Removing software',
  'agent.update': 'Updating the agent',
};

router.get('/commands/:id/status.json', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(400).json({ ok: false, error: 'no command' }); return; }
  try {
    // A command orphaned by an agent restart should read as failed here rather than
    // spinning forever in the browser.
    await reapStaleCommands();

    const r = (await pool.query(
      `SELECT ac.id, ac.kind, ac.status, ac.exit_code, ac.progress, ac.progress_pct,
              ac.requested_at, ac.started_at, ac.finished_at,
              EXTRACT(EPOCH FROM (NOW() - ac.requested_at))::int AS age_secs,
              EXTRACT(EPOCH FROM (NOW() - COALESCE(ac.progress_at, ac.started_at)))::int AS quiet_secs,
              length(ac.output) AS output_len,
              right(COALESCE(ac.output,''), 400) AS output_tail,
              ad.hostname,
              EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at))::int AS device_seen_secs
         FROM agent_commands ac
         LEFT JOIN agent_devices ad ON ad.id = ac.device_id
        WHERE ac.id = $1`, [id])).rows[0];
    if (!r) { res.status(404).json({ ok: false, error: 'unknown command' }); return; }

    const status = String(r.status || '');
    const done = status === 'done' || status === 'failed';

    // "Queued" on a machine that is switched off is not the same as "queued, about to
    // run", and the difference is the whole reason someone stands there waiting.
    const offline = r.device_seen_secs == null || Number(r.device_seen_secs) > 180;

    res.json({
      ok: true,
      id: r.id,
      kind: r.kind,
      label: KIND_LABEL[String(r.kind)] || 'Working',
      status,
      done,
      failed: status === 'failed',
      exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
      pct: r.progress_pct === null || r.progress_pct === undefined ? null : Number(r.progress_pct),
      progress: String(r.progress || '').slice(-400) || null,
      hostname: r.hostname || null,
      deviceOffline: status === 'queued' ? offline : false,
      ageSecs: Number(r.age_secs) || 0,
      quietSecs: r.quiet_secs == null ? null : Number(r.quiet_secs),
      outputLen: r.output_len == null ? 0 : Number(r.output_len),
      outputTail: done ? String(r.output_tail || '').trim() || null : null,
    });
  } catch (e: any) {
    console.error('[commands] status failed:', e.message);
    res.status(500).json({ ok: false, error: 'could not read that command' });
  }
});

export default router;
