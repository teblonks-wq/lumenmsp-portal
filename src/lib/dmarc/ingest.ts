import cron from 'node-cron';
import { config } from '../../config';
import {
  graphConfigured, graphListInbox, graphListAttachments, graphEnsureFolder, graphMoveMessage,
} from '../graph';
import { extractXml, parseAggregateReport } from './parse';
import { classifySender, type SenderClass } from './senders';
import { checkDmarcDns } from './dns-check';
import {
  ensureDmarcTables, findDomainForReport, saveReport, enabledDmarcDomains, seenDkimSelectors, saveDnsCheck,
} from './store';

// ── LITS-DMARC: report ingestion job ─────────────────────────────────────────────
// Polls the DMARC collection mailbox (DMARC_MAILBOX, e.g. dmarc@lumenmsp.co.uk) via
// Graph, parses each aggregate-report attachment and stores it against the matching
// monitored domain. Processed mail is filed into a "Processed" folder (the mailsync
// pattern) so the Inbox drains and nothing is read twice; the DB unique constraint
// is a second dedupe layer. Reports for unmonitored domains file into "Unmatched"
// so they're kept but out of the way.

let running = false;

export async function runDmarcIngest(): Promise<{ processed: number; saved: number; skipped: number; errors: number }> {
  const stats = { processed: 0, saved: 0, skipped: 0, errors: 0 };
  const mailbox = (config.DMARC_MAILBOX || '').trim();
  if (!mailbox || !graphConfigured()) return stats;
  if (running) return stats; // don't overlap a slow run
  running = true;
  try {
    await ensureDmarcTables();
    const [processedId, unmatchedId] = await Promise.all([
      graphEnsureFolder(mailbox, 'Processed'),
      graphEnsureFolder(mailbox, 'Unmatched'),
    ]);

    // Inbox drains as we file messages, so loop until it's empty (bounded).
    for (let batch = 0; batch < 10; batch++) {
      const messages = await graphListInbox(mailbox, null, 50);
      if (!messages.length) break;

      for (const msg of messages) {
        stats.processed++;
        let matchedAny = false;
        let sawReport = false;
        try {
          if (msg.hasAttachments) {
            const atts = await graphListAttachments(mailbox, msg.id);
            for (const att of atts) {
              let xmls: string[];
              try { xmls = extractXml(Buffer.from(att.base64, 'base64')); }
              catch { continue; } // not a report payload (signature image etc.)
              for (const xml of xmls) {
                let rep;
                try { rep = parseAggregateReport(xml); }
                catch (e) {
                  stats.errors++;
                  console.error(`[dmarc] unparseable report in "${msg.subject}" from ${msg.from}: ${(e as Error).message}`);
                  continue;
                }
                sawReport = true;
                const dom = await findDomainForReport(rep.policyDomain);
                if (!dom) { console.log(`[dmarc] report for unmonitored domain ${rep.policyDomain} — filed to Unmatched`); continue; }
                matchedAny = true;
                // Classify each unique source IP once (cached rDNS).
                const classes = new Map<string, SenderClass>();
                for (const ip of new Set(rep.records.map((r) => r.sourceIp))) {
                  classes.set(ip, await classifySender(ip));
                }
                const isNew = await saveReport(dom.id, rep, classes);
                if (isNew) stats.saved++; else stats.skipped++;
              }
            }
          }
          await graphMoveMessage(mailbox, msg.id, (sawReport && !matchedAny) ? unmatchedId : processedId);
        } catch (e) {
          stats.errors++;
          console.error(`[dmarc] failed on message "${msg.subject}": ${(e as Error).message}`);
          // Leave the message in the Inbox — the DB dedupe makes a re-run safe.
        }
      }
      if (messages.length < 50) break;
    }
  } finally {
    running = false;
  }
  if (stats.processed) console.log(`[dmarc] ingest: ${stats.processed} message(s), ${stats.saved} new report(s), ${stats.skipped} duplicate(s), ${stats.errors} error(s)`);
  return stats;
}

// Daily sweep: re-run the full DNS check for EVERY monitored domain so all customers
// are checked identically and on the same engine — dashboards and the monthly report
// never rely on someone remembering to click Re-run.
export async function runDmarcDnsSweep(): Promise<void> {
  await ensureDmarcTables();
  const domains = await enabledDmarcDomains();
  let ok = 0;
  for (const d of domains) {
    try {
      const extra = await seenDkimSelectors(d.id).catch(() => [] as string[]);
      const check = await checkDmarcDns(d.domain, extra, d.target_policy);
      if (check) { await saveDnsCheck(d.id, check); ok++; }
    } catch (e) {
      console.error(`[dmarc] DNS sweep failed for ${d.domain}: ${(e as Error).message}`);
    }
  }
  if (domains.length) console.log(`[dmarc] DNS sweep: ${ok}/${domains.length} domain(s) re-checked`);
}

export function startDmarcIngest(): void {
  // DNS sweep needs no Graph/mailbox — schedule it regardless (06:15 daily, before the working day).
  cron.schedule('15 6 * * *', () => { runDmarcDnsSweep().catch((e) => console.error('[dmarc] DNS sweep error:', e.message)); });
  // Also sweep ~2 min after boot, so every domain is re-checked on the current engine
  // straight after a deploy (uniform checks without waiting for 06:15 or a manual Re-run).
  setTimeout(() => { runDmarcDnsSweep().catch((e) => console.error('[dmarc] DNS sweep error:', e.message)); }, 2 * 60 * 1000);
  console.log('✓ DMARC DNS sweep scheduled (06:15 daily + post-boot, all monitored domains)');

  const mailbox = (config.DMARC_MAILBOX || '').trim();
  if (!mailbox) { console.log('· DMARC ingest not started (DMARC_MAILBOX not set)'); return; }
  if (!graphConfigured()) { console.log('· DMARC ingest not started (Graph not configured)'); return; }
  // Receivers send reports roughly daily but at arbitrary times — poll every 30 minutes.
  cron.schedule('*/30 * * * *', () => { runDmarcIngest().catch((e) => console.error('[dmarc] ingest error:', e.message)); });
  // One catch-up pass shortly after boot so a deploy never delays ingestion by half an hour.
  setTimeout(() => { runDmarcIngest().catch((e) => console.error('[dmarc] ingest error:', e.message)); }, 90 * 1000);
  console.log(`✓ DMARC ingest started (${mailbox}, every 30 min)`);
}
