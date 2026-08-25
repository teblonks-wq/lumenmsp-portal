import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import {
  THIRD_PARTY_CATEGORIES, listThirdParties, getThirdParty, waitingOnThirdParties, chaseByDefault,
} from '../lib/third-party';

const router = Router();

// ── Third parties ───────────────────────────────────────────────────────────────
// One screen with two halves: WHO we wait on, and WHAT is waiting on them right now.
// They belong together — a directory nobody looks at is how the old "awaiting 3rd
// party" black hole formed in the first place.

const nz = (v: any): string | null => { const s = String(v ?? '').trim(); return s ? s.slice(0, 400) : null; };
const numOrNull = (v: any): number | null => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };

router.get('/third-parties', requireAuth, async (req: Request, res: Response) => {
  const showArchived = String(req.query.archived || '') === '1';
  const [parties, waiting] = await Promise.all([listThirdParties(showArchived), waitingOnThirdParties()]);

  // Group the waiting cases under the party they sit with. Cases with NOBODY attached get
  // their own group at the top — they are the ones that used to disappear.
  const groups: Array<{ id: number | null; name: string; cases: typeof waiting }> = [];
  const byId = new Map<string, number>();
  for (const c of waiting) {
    const key = c.thirdPartyId == null ? 'none' : String(c.thirdPartyId);
    if (!byId.has(key)) {
      byId.set(key, groups.length);
      groups.push({ id: c.thirdPartyId, name: c.thirdPartyName || 'Nobody named yet', cases: [] });
    }
    groups[byId.get(key)!].cases.push(c);
  }
  groups.sort((a, b) => (a.id === null ? -1 : b.id === null ? 1 : b.cases.length - a.cases.length));

  res.render('third-party/index', {
    user: req.session.user!, parties, waiting, groups, showArchived,
    categories: THIRD_PARTY_CATEGORIES,
    overdue: waiting.filter(c => c.overdue).length,
    unnamed: waiting.filter(c => c.unnamed).length,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

const BACK = '/third-parties';

function fields(b: any): any[] {
  return [
    nz(b.name), nz(b.category), nz(b.contact_name), nz(b.email), nz(b.support_email),
    nz(b.phone), nz(b.support_phone), nz(b.url), nz(b.portal_url), nz(b.account_ref),
    numOrNull(b.typical_days), nz(b.escalation_note), nz(b.notes),
  ];
}

router.post('/third-parties', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const f = fields(req.body);
  if (!f[0]) { res.redirect(BACK + '?err=' + encodeURIComponent('A third party needs a name.')); return; }
  // An existing supplier of the same name is FLAGGED, never duplicated — two records for
  // one company is exactly what keeping this in `suppliers` avoids.
  const existing = (await pool.query('SELECT id, is_third_party FROM suppliers WHERE lower(name)=lower($1) LIMIT 1', [f[0]])).rows[0];
  if (existing) {
    await pool.query(`UPDATE suppliers SET is_third_party=true, is_active=true, category=COALESCE($2, category),
                             support_email=COALESCE($3, support_email), support_phone=COALESCE($4, support_phone),
                             portal_url=COALESCE($5, portal_url), typical_days=COALESCE($6, typical_days),
                             escalation_note=COALESCE($7, escalation_note)
                       WHERE id=$1`, [existing.id, f[1], f[4], f[6], f[8], f[10], f[11]]);
    await logActivity(req.session.user!.id, 'third_party_flag', 'suppliers', existing.id, `${f[0]} marked as a third party`);
    res.redirect(BACK + '?msg=' + encodeURIComponent(`${f[0]} was already on the supplier list — marked as a third party rather than added twice.`));
    return;
  }
  const ins = await pool.query(
    `INSERT INTO suppliers (name, category, contact_name, email, support_email, phone, support_phone,
                            url, portal_url, account_ref, typical_days, escalation_note, notes, is_third_party)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) RETURNING id`, f);
  await logActivity(req.session.user!.id, 'third_party_create', 'suppliers', ins.rows[0].id, `Third party added: ${f[0]}`);
  res.redirect(BACK + '?msg=' + encodeURIComponent(`${f[0]} added.`));
});

router.post('/third-parties/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const f = fields(req.body);
  if (!id || !f[0]) { res.redirect(BACK + '?err=' + encodeURIComponent('A third party needs a name.')); return; }
  await pool.query(
    `UPDATE suppliers SET name=$1, category=$2, contact_name=$3, email=$4, support_email=$5, phone=$6,
            support_phone=$7, url=$8, portal_url=$9, account_ref=$10, typical_days=$11, escalation_note=$12,
            notes=$13, updated_at=NOW()
      WHERE id=$14`, [...f, id]);
  await logActivity(req.session.user!.id, 'third_party_update', 'suppliers', id, `Third party updated: ${f[0]}`);
  res.redirect(BACK + '?msg=' + encodeURIComponent('Saved.'));
});

// Archiving hides a third party from the picker. It is REFUSED while cases still sit on
// them — hiding the name off a live case is how the black hole re-forms.
router.post('/third-parties/:id/archive', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const tp = id ? await getThirdParty(id) : null;
  if (!tp) { res.redirect(BACK + '?err=' + encodeURIComponent('That third party is gone.')); return; }
  const open = (await pool.query(
    `SELECT COUNT(*)::int n FROM inbox_tickets
      WHERE third_party_id=$1 AND status='awaiting_3rd_party' AND deleted_at IS NULL`, [id])).rows[0].n;
  if (open > 0) {
    res.redirect(BACK + '?err=' + encodeURIComponent(
      `${tp.name} still has ${open} case${open === 1 ? '' : 's'} waiting on them — move those on first.`));
    return;
  }
  await pool.query('UPDATE suppliers SET is_active=false, updated_at=NOW() WHERE id=$1', [id]);
  await logActivity(req.session.user!.id, 'third_party_archive', 'suppliers', id, `Third party archived: ${tp.name}`);
  res.redirect(BACK + '?msg=' + encodeURIComponent(`${tp.name} archived — existing history keeps the name.`));
});

router.post('/third-parties/:id/restore', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query('UPDATE suppliers SET is_active=true, is_third_party=true, updated_at=NOW() WHERE id=$1', [id]);
  res.redirect(BACK + '?msg=' + encodeURIComponent('Back on the list.'));
});

/** JSON for the composer: the picker plus each party's typical turnaround. */
router.get('/third-parties.json', requireAuth, async (_req: Request, res: Response) => {
  const parties = await listThirdParties(false);
  res.json({
    parties: parties.map(p => ({ id: p.id, name: p.name, typicalDays: p.typicalDays,
      chaseBy: chaseByDefault(p.typicalDays), portalUrl: p.portalUrl })),
    fallbackChaseBy: chaseByDefault(3),
  });
});

export default router;
