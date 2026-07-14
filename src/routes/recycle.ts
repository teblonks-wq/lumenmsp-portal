import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { restoreRow } from '../lib/recycle';

const router = Router();

// Whitelisted sections — table/column names are interpolated, so this map is the
// only source of those values (never user input). The :section param is validated against it.
// title/sub are raw SQL expressions; `join` adds an optional LEFT JOIN; `linkId` is the
// column whose value forms the link (defaults to t.id), and `hash` appends a deep-link anchor.
interface Section { table: string; label: string; title: string; sub: string; join?: string; link: string; linkId?: string; hash?: string }
const SECTIONS: Record<string, Section> = {
  customers:   { table: 'customers',            label: 'Customers',   title: 't.name',            sub: 't.account_number', link: '/customers/' },
  leads:       { table: 'leads',                label: 'Leads',       title: 'c.name',            sub: 't.status',         join: 'LEFT JOIN customers c ON c.id = t.customer_id', link: '/leads/' },
  quotes:      { table: 'quotes',               label: 'Quotes',      title: 't.quote_number',    sub: 't.title',          link: '/quotes/' },
  invoices:    { table: 'invoices',             label: 'Invoices',    title: 't.invoice_number',  sub: 't.title',          link: '/invoices/' },
  contracts:   { table: 'contracts',            label: 'Contracts',   title: 't.contract_number', sub: 't.title',          link: '/contracts/' },
  tickets:     { table: 'inbox_tickets',        label: 'Tickets',     title: 't.ticket_number',   sub: 't.subject',        link: '/tickets/' },
  credentials: { table: 'customer_credentials', label: 'Passwords',   title: 't.name',            sub: 'c.name',           join: 'LEFT JOIN customers c ON c.id = t.customer_id', link: '/customers/', linkId: 't.customer_id', hash: '#passwords' },
  chats:       { table: 'chat_sessions',        label: 'Website chats', title: "COALESCE(NULLIF(t.name,''), NULLIF(t.email,''), 'Visitor')", sub: 't.department', link: '/chat/' },
};

// Snapshot-based sections (recycle_items) — deleted rows are stored as a copy and restored by
// re-inserting them. Keyed by entity_type.
const SNAPSHOT_SECTIONS: Record<string, string> = {
  comms_line: 'Comms lines',
  inbox_message: 'Chat messages (WhatsApp / Teams)',
};

router.get('/recycle-bin', requireAuth, async (req: Request, res: Response) => {
  const sections = [];
  for (const key of Object.keys(SECTIONS)) {
    const s = SECTIONS[key];
    const { rows } = await pool.query(
      `SELECT t.id, ${s.title} AS title, ${s.sub} AS sub, t.deleted_at, u.display_name AS deleted_by, ${s.linkId || 't.id'} AS link_id
       FROM ${s.table} t LEFT JOIN users u ON u.id = t.deleted_by_user_id ${s.join || ''}
       WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 100`
    );
    rows.forEach((r: any) => { r.href = s.link + r.link_id + (s.hash || ''); });
    sections.push({ key, label: s.label, link: s.link, rows });
  }
  for (const key of Object.keys(SNAPSHOT_SECTIONS)) {
    const rec = (await pool.query(
      `SELECT ri.id, ri.label AS title, ri.sublabel AS sub, ri.deleted_at, u.display_name AS deleted_by
         FROM recycle_items ri LEFT JOIN users u ON u.id = ri.deleted_by_user_id
        WHERE ri.entity_type=$1 AND ri.restored_at IS NULL ORDER BY ri.deleted_at DESC LIMIT 100`, [key]
    )).rows;
    sections.push({ key, label: SNAPSHOT_SECTIONS[key], link: '', rows: rec });
  }
  res.render('recycle-bin', { user: req.session.user!, sections, error: req.query.error || '' });
});

router.post('/recycle-bin/:section/:id/restore', requireAuth, async (req: Request, res: Response) => {
  const section = String(req.params.section);
  const id = parseInt(String(req.params.id), 10);
  // Snapshot-restored sections re-insert the row from its saved copy.
  if (SNAPSHOT_SECTIONS[section]) {
    await restoreRow(id);
    await logActivity(req.session.user!.id, 'restored', section, id, `Restored ${SNAPSHOT_SECTIONS[section]} item #${id}`);
    res.redirect('/recycle-bin'); return;
  }
  const s = SECTIONS[section];
  if (!s) { res.redirect('/recycle-bin'); return; }
  await pool.query(`UPDATE ${s.table} SET deleted_at=NULL, deleted_by_user_id=NULL WHERE id=$1`, [id]);
  await logActivity(req.session.user!.id, 'restored', section, id, `Restored ${s.label} #${id}`);
  res.redirect('/recycle-bin');
});

router.post('/recycle-bin/:section/empty', requireAuth, async (req: Request, res: Response) => {
  const section = String(req.params.section);
  if (SNAPSHOT_SECTIONS[section]) {
    const del = await pool.query('DELETE FROM recycle_items WHERE entity_type=$1 AND restored_at IS NULL', [section]);
    await logActivity(req.session.user!.id, 'emptied', section, null, `Emptied ${SNAPSHOT_SECTIONS[section]} bin (${del.rowCount} removed)`);
    res.redirect('/recycle-bin'); return;
  }
  const s = SECTIONS[section];
  if (!s) { res.redirect('/recycle-bin'); return; }
  try {
    const del = await pool.query(`DELETE FROM ${s.table} WHERE deleted_at IS NOT NULL`);
    await logActivity(req.session.user!.id, 'emptied', section, null, `Emptied ${s.label} bin (${del.rowCount} removed)`);
    res.redirect('/recycle-bin');
  } catch (e) {
    console.error('[recycle] empty failed:', (e as Error).message);
    res.redirect('/recycle-bin?error=' + encodeURIComponent(s.label + ' could not be emptied — some items are still linked to live records.'));
  }
});

export default router;
