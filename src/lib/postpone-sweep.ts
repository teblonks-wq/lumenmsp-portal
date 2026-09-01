import cron from 'node-cron';
import { pool } from '../db/pool';

// Every minute: any 'postponed' case whose time has arrived flips back to
// awaiting_engineer so it reappears in the engineer's queue.
export function startPostponeSweep(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const r = await pool.query(
        `UPDATE inbox_tickets
            SET status='awaiting_engineer', postponed_until=NULL, activity_status='awaiting_tech', updated_at=NOW()
          WHERE status='postponed' AND postponed_until IS NOT NULL AND postponed_until <= NOW() AND deleted_at IS NULL
          RETURNING id`
      );
      for (const row of r.rows) {
        await pool.query(
          `INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1, NULL, 'system_log', $2)`,
          [row.id, 'Postpone time reached — returned to Awaiting engineer']
        ).catch(() => {});
      }
      if (r.rowCount) console.log(`[postpone] ${r.rowCount} ticket(s) returned to awaiting_engineer`);

      // 48h timer: cases parked on the customer or a 3rd party with no response flip back to the
      // engineer's queue so nothing gets forgotten. A case the customer DID answer never reaches
      // this sweep: the reply moves it to 'update_required' and clears postponed_until.
      // Cases parked on the customer or a third party come back so nothing is forgotten.
      // A third-party case with a CHASE DATE comes back on that date — and must not be
      // labelled "no response within 48h", which would be a lie about a five-day wait.
      const a = await pool.query(
        `UPDATE inbox_tickets
            SET status='awaiting_engineer', postponed_until=NULL, activity_status='awaiting_tech', updated_at=NOW()
          WHERE status IN ('awaiting_customer','awaiting_3rd_party') AND postponed_until IS NOT NULL
            AND postponed_until <= NOW() AND deleted_at IS NULL
          RETURNING id, chase_by, third_party_id,
                    (SELECT name FROM suppliers WHERE id = inbox_tickets.third_party_id) AS tp_name`
      );
      for (const row of a.rows) {
        const body = row.chase_by
          ? `Chase date reached${row.tp_name ? ' — time to go back at ' + row.tp_name : ''} — returned to Awaiting engineer`
          : 'No response within 48h — returned to Awaiting engineer';
        await pool.query(
          `INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1, NULL, 'system_log', $2)`,
          [row.id, body]
        ).catch(() => {});
      }
      if (a.rowCount) console.log(`[postpone] ${a.rowCount} awaiting-party ticket(s) returned to awaiting_engineer (48h)`);
    } catch (e) { console.error('[postpone] sweep failed:', (e as Error).message); }
  });
  console.log('[postpone] sweep started — checking every minute');
}
