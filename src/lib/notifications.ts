import { pool } from '../db/pool';
import { sendTeamsNotice } from './teams';
import { config } from '../config';

// Creates a notification for a user. Never throws.
export async function notify(
  userId: number | null | undefined,
  title: string,
  opts: { body?: string; link?: string; type?: string } = {},
): Promise<void> {
  if (!userId) return;
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)',
      [userId, opts.type || 'info', title, opts.body || null, opts.link || null]
    );
  } catch (e) { console.error('[notify] failed:', (e as Error).message); }
}

// Alerts every member of a group (support | sales), in-app + Teams.
// `link` is relative (e.g. /quotes/5).
export async function alertGroup(group: 'support' | 'sales', title: string, body: string, link: string): Promise<void> {
  try {
    const col = group === 'sales' ? 'sales_group' : 'support_group';
    const staff = await pool.query(
      `SELECT id, email FROM users WHERE is_active=true AND customer_id IS NULL AND ${col}=true`
    );
    const tasks: Promise<any>[] = [];
    for (const s of staff.rows) {
      tasks.push(notify(s.id, title, { body, link, type: 'action' }));
      if (s.email) tasks.push(sendTeamsNotice({ toEmail: s.email, title, text: body, link: config.APP_URL + link }));
    }
    await Promise.allSettled(tasks);
  } catch (e) { console.error('[alertGroup] failed:', (e as Error).message); }
}
