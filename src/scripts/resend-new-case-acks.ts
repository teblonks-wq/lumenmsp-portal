import 'dotenv/config';
import { pool } from '../db/pool';
import { sendTicketStatusEmail } from '../lib/emails';

// ── Resend "new case" acknowledgements to the RIGHT recipient ─────────────────
// One-off repair for cases created from staff-FORWARDED emails before the
// 2026-08-03 mailsync fix: the requester was resolved correctly, but the ack
// email went to the forwarding staff member instead of the customer.
//
// Usage (on the server, from /srv/apps/lumenmsp-portal):
//   node dist/scripts/resend-new-case-acks.js                → DRY RUN: list what would be sent (last 48h)
//   node dist/scripts/resend-new-case-acks.js --send         → actually send (last 48h)
//   node dist/scripts/resend-new-case-acks.js --send LIT-12345 [LIT-12346 …]
//                                                            → send for specific ticket numbers only
//
// The requester email/name is parsed from the ticket's system_log note
// ("… requester set to original sender x@y (Name)"), falling back to the
// linked contact's email. Nothing is written to the database.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const wanted = args.filter((a) => /^LITS?-\d+$/i.test(a)).map((a) => a.toUpperCase());

  const params: any[] = [];
  let where = `t.deleted_at IS NULL AND n.body LIKE 'Created from email forwarded by %'`;
  if (wanted.length) {
    params.push(wanted);
    where += ` AND t.ticket_number = ANY($${params.length})`;
  } else {
    where += ` AND t.created_at > NOW() - INTERVAL '48 hours'`;
  }

  const r = await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, t.created_at, n.body AS note,
            ct.full_name AS contact_name, ct.email AS contact_email
       FROM inbox_tickets t
       JOIN inbox_notes n ON n.ticket_id = t.id AND n.note_type = 'system_log'
       LEFT JOIN customer_contacts ct ON ct.id = t.contact_id
      WHERE ${where}
      ORDER BY t.id`, params);

  if (!r.rows.length) {
    console.log('No matching forwarded-email cases found' + (wanted.length ? ` for ${wanted.join(', ')}` : ' in the last 48 hours') + '.');
    await pool.end();
    return;
  }

  let sent = 0, skipped = 0;
  for (const t of r.rows) {
    // "… requester set to original sender x@y (Name)" — email first, name in parens after it.
    const em = /original sender\s+(\S+@\S+?)(?:\s|$)/i.exec(t.note || '');
    const nm = /original sender\s+\S+\s+\(([^)]+)\)/i.exec(t.note || '');
    const email = (em ? em[1].replace(/[),.;]+$/, '') : '') || t.contact_email || '';
    const name = (nm ? nm[1] : '') || t.contact_name || 'there';
    if (!email) {
      console.log(`SKIP  ${t.ticket_number} — no requester email found (note: ${String(t.note).slice(0, 100)})`);
      skipped++;
      continue;
    }
    if (send) {
      try {
        await sendTicketStatusEmail('new', email, name, t.ticket_number, 'Support', t.subject || '');
        console.log(`SENT  ${t.ticket_number} → ${name} <${email}>  (${t.subject || '(no subject)'})`);
        sent++;
      } catch (e: any) {
        console.log(`FAIL  ${t.ticket_number} → ${email} — ${e?.message || e}`);
        skipped++;
      }
    } else {
      console.log(`WOULD SEND  ${t.ticket_number} → ${name} <${email}>  (${t.subject || '(no subject)'})`);
    }
  }
  console.log(send ? `\nDone: ${sent} sent, ${skipped} skipped.` : `\nDry run only — re-run with --send to actually send.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
