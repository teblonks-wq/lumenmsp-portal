/**
 * Restore inline images on existing helpdesk messages.
 *
 * Graph reports hasAttachments=false for emails whose only attachments are inline
 * images, so historic messages were stored with their cid: links unrewritten and
 * the pictures never downloaded. The originals are still in the synced mailbox, so
 * this script re-fetches each affected message's attachments, saves them, rewrites
 * the stored HTML to the saved URLs, and neutralises anything unrecoverable.
 *
 * Usage (on the server, after a deploy):
 *   node dist/scripts/restore-inline-images.js          # fix everything
 *   node dist/scripts/restore-inline-images.js --dry    # report only, change nothing
 *
 * Universal: walks inbox_messages AND communications for every customer alike.
 */
import { pool } from '../db/pool';
import { config } from '../config';
import { graphListAttachments } from '../lib/graph';
import { saveGraphAttachments } from '../lib/attachments';
import { rewriteCids, stripDeadCids } from '../lib/mailsync';

const DRY = process.argv.includes('--dry');

async function main(): Promise<void> {
  let fixed = 0, dead = 0, failed = 0;

  // ── inbox_messages (helpdesk cases) ──
  const msgs = (await pool.query(
    `SELECT id, mailbox, graph_message_id, body_html FROM inbox_messages
      WHERE body_html LIKE '%cid:%' AND graph_message_id IS NOT NULL ORDER BY id`)).rows;
  console.log(`inbox_messages with cid: references: ${msgs.length}`);
  for (const m of msgs) {
    const mailbox = m.mailbox || config.GRAPH_SYNC_MAILBOX;
    let html = String(m.body_html || '');
    try {
      const atts = await graphListAttachments(mailbox, m.graph_message_id);
      const saved = DRY ? [] : saveGraphAttachments(atts);
      const rewritten = DRY ? html : stripDeadCids(rewriteCids(html, saved));
      if (DRY) {
        const inline = atts.filter((a) => a.isInline && a.contentId).length;
        console.log(`  [dry] message ${m.id}: ${inline} inline image(s) recoverable`);
        continue;
      }
      if (rewritten !== html) {
        await pool.query('UPDATE inbox_messages SET body_html=$1 WHERE id=$2', [rewritten, m.id]);
        if (/image unavailable/.test(rewritten) && !/static\/attachments/.test(rewritten)) dead++; else fixed++;
        console.log(`  message ${m.id}: restored`);
      }
    } catch (e: any) {
      // Original email gone from the mailbox — nothing to fetch; tidy the broken imgs.
      failed++;
      if (!DRY) {
        const tidied = stripDeadCids(html);
        if (tidied !== html) await pool.query('UPDATE inbox_messages SET body_html=$1 WHERE id=$2', [tidied, m.id]);
      }
      console.log(`  message ${m.id}: original not retrievable (${(e.message || '').slice(0, 80)}) — placeholders applied`);
    }
  }

  // ── communications (quote/invoice/customer threads ingested from email) ──
  const comms = (await pool.query(
    `SELECT id, external_id, body FROM communications
      WHERE body LIKE '%cid:%' AND external_id IS NOT NULL AND direction='inbound' ORDER BY id`)).rows;
  console.log(`communications with cid: references: ${comms.length}`);
  for (const c of comms) {
    let html = String(c.body || '');
    try {
      const atts = await graphListAttachments(config.GRAPH_SYNC_MAILBOX, c.external_id);
      const saved = DRY ? [] : saveGraphAttachments(atts);
      const rewritten = DRY ? html : stripDeadCids(rewriteCids(html, saved));
      if (DRY) { console.log(`  [dry] comm ${c.id}: ${atts.filter((a) => a.isInline).length} inline image(s) recoverable`); continue; }
      if (rewritten !== html) {
        await pool.query('UPDATE communications SET body=$1 WHERE id=$2', [rewritten, c.id]);
        fixed++;
        console.log(`  comm ${c.id}: restored`);
      }
    } catch (e: any) {
      failed++;
      if (!DRY) {
        const tidied = stripDeadCids(html);
        if (tidied !== html) await pool.query('UPDATE communications SET body=$1 WHERE id=$2', [tidied, c.id]);
      }
      console.log(`  comm ${c.id}: original not retrievable — placeholders applied`);
    }
  }

  console.log(`\nDone. restored: ${fixed} · unrecoverable (placeholders): ${failed + dead}${DRY ? ' (DRY RUN — nothing changed)' : ''}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
