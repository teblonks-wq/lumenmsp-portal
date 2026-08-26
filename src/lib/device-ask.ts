import { pool } from '../db/pool';
import { aiAskCached, parseJsonAnswer, stripTrailingJson } from './ai-compose';

/**
 * Ask Portal — the device-page analyst.
 *
 * An engineer opens a machine and wants the thing nobody has time to do by hand: read its
 * event log, its security state, its patch position, everything we have ever done to it,
 * every case that customer has raised, and say what is actually going on. This assembles
 * that evidence and puts one question to Claude over it.
 *
 * ── Four things shape this file ────────────────────────────────────────────────
 *
 * 1. **Evidence, not vibes.** Every section of the corpus is stamped with WHEN it was
 *    collected, and the system prompt is told to say so. A confident answer built on a
 *    security reading from nine days ago is worse than no answer, because it is the sort of
 *    wrong that gets believed. Freshness travels with the data, not in a footnote.
 *
 * 2. **The event log is not stored.** `events.list` is an on-demand agent command; what we
 *    have is whatever the last pull left in `agent_commands.output`. So the corpus carries
 *    the last pull AND its age, and the UI offers to fetch a fresh one. Terry's call: answer
 *    now from what we have rather than making every question wait a minute on the machine.
 *
 * 3. **Findings are the point, not the answer.** Every saved answer goes into
 *    `device_findings` and is read back into the corpus of every future Ask on that machine
 *    and that customer. That is the "logic file": the second engineer to look at this
 *    machine starts where the first one finished, instead of from nothing.
 *
 * 4. **Secrets never enter the corpus.** BitLocker recovery keys, command payloads (which
 *    carry generated passwords) and tokens are deliberately not selected here — not
 *    redacted afterwards, never fetched. A prompt is not a safe place to put a recovery key,
 *    and the safest way to not leak one is to never load it.
 */

// ── Sizing ──────────────────────────────────────────────────────────────────────
// Generous but bounded. The corpus is cached (see aiAskCached), so a follow-up question on
// the same machine re-uses the prefix and costs almost nothing — which is only true while
// the corpus is byte-identical, so nothing in here may include a clock reading.
const MAX_EVENT_CHARS = 12000;
const MAX_CASE_CHARS = 3000;
const CUSTOMER_CASES = 12;
const MAX_FINDINGS_DEVICE = 12;
const MAX_FINDINGS_CUSTOMER = 8;

export interface DeviceAskResult {
  headline: string;
  answer: string;
  actions: string[];
  evidence: string[];       // what was actually available, and how old — shown under the answer
  usage?: any;
}

export interface DeviceFinding {
  id: number;
  question: string;
  answer: string;
  summary: string | null;
  ticket_id: number | null;
  ticket_number?: string | null;
  author?: string | null;
  created_at: Date;
  hostname?: string | null;
}

const plain = (html: string): string =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const day = (v: any): string => (v ? new Date(v).toISOString().slice(0, 10) : 'unknown');

/** Ages are written in words rather than as a timestamp so the same reading produces the
 *  same corpus text for a few hours — which is what keeps the prompt cache warm across a
 *  run of follow-up questions. */
export function ageWords(v: any): string {
  if (!v) return 'never';
  const secs = (Date.now() - new Date(v).getTime()) / 1000;
  if (secs < 3600) return 'within the last hour';
  if (secs < 86400) return `about ${Math.round(secs / 3600)} hours ago`;
  const d = Math.round(secs / 86400);
  if (d <= 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  if (d <= 60) return `about ${Math.round(d / 7)} weeks ago`;
  return `about ${Math.round(d / 30)} months ago`;
}

// ── Corpus ──────────────────────────────────────────────────────────────────────

/**
 * Every section is independently try/caught. A device page that cannot answer because one
 * optional table is not migrated yet is a worse outcome than an answer that says "no
 * BitLocker data available" — so a section that fails becomes a line saying it failed, and
 * the rest of the evidence still reaches the model.
 */
export async function buildDeviceCorpus(
  assetId: number,
  opts: { ticketId?: number | null } = {},
): Promise<{ corpus: string; evidence: string[]; asset: any }> {
  const asset = (await pool.query(
    `SELECT a.*, c.name AS customer_name, ac.full_name AS assigned_name
       FROM customer_assets a
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN customer_contacts ac ON ac.id = a.assigned_contact_id
      WHERE a.id = $1`, [assetId])).rows[0];
  if (!asset) throw new Error('Device not found.');

  const parts: string[] = [];
  const evidence: string[] = [];

  // ── The machine ──────────────────────────────────────────────────────────────
  const hw = [
    `Name the customer uses: ${asset.friendly_name || '(none set)'}`,
    `Hostname: ${asset.hostname || 'unknown'}`,
    `Customer: ${asset.customer_name || 'not matched to a customer'}`,
    `Assigned to: ${asset.assigned_name || 'nobody — unallocated'}`,
    `Last signed-in user: ${asset.last_login_user || 'unknown'}`,
    `Type: ${asset.device_type || 'unknown'}`,
    `Make/model: ${[asset.manufacturer, asset.model].filter(Boolean).join(' ') || 'unknown'}`,
    `Serial: ${asset.serial_number || 'unknown'}`,
    `OS: ${asset.os || 'unknown'} ${asset.os_version || ''}`.trim(),
    `CPU: ${asset.cpu || 'unknown'}`,
    `RAM: ${asset.ram_gb ? asset.ram_gb + ' GB' : 'unknown'}`,
    `Domain/workgroup: ${asset.domain_or_workgroup || 'unknown'}`,
    `IP addresses: ${asset.ip_addresses || 'unknown'}`,
    `Record owner: ${(asset.data_source === 'agent' || asset.agent_device_id) ? 'our own agent' : 'Atera import (no agent installed)'}`,
    `Last seen: ${ageWords(asset.last_seen_at)}`,
    `Last reboot: ${asset.last_reboot_at ? ageWords(asset.last_reboot_at) : 'unknown'}`,
  ];
  if (asset.warranty_end || asset.warranty_level) {
    const endsIn = asset.warranty_end
      ? Math.round((new Date(asset.warranty_end).getTime() - Date.now()) / 86400000) : null;
    hw.push(`Warranty: ${asset.warranty_level || 'cover recorded'} — `
      + (endsIn == null ? 'no end date'
        : endsIn < 0 ? `EXPIRED ${Math.abs(endsIn)} days ago (${day(asset.warranty_end)})`
        : `runs out in about ${endsIn} days (${day(asset.warranty_end)})`)
      + ` [source: ${asset.warranty_source || 'unknown'}]`);
  } else {
    hw.push('Warranty: not known — nothing recorded against this machine.');
  }
  parts.push('=== THE MACHINE ===\n' + hw.join('\n'));

  const deviceId: number | null = asset.agent_device_id || null;

  // ── Security ─────────────────────────────────────────────────────────────────
  // security_json is what the agent's security collector last reported: the registered AV
  // products, firewall state, Defender state. NOT trusted blindly — see
  // wsc-registrations-are-not-installs; the model is told what the reading actually means.
  try {
    const d = deviceId
      ? (await pool.query(
          `SELECT security_json, security_at, patch_pending, reboot_required, patch_scan_at,
                  patch_last_installed, agent_version, logged_in_user, disk_info, last_seen_at
             FROM agent_devices WHERE id = $1`, [deviceId])).rows[0]
      : null;
    if (!d) {
      parts.push('=== SECURITY ===\nNo LumenMSP Agent on this machine, so the Portal has NO security reading for it at all. Anything about its protection is unknown, not "fine".');
      evidence.push('No agent — no security data');
    } else {
      const sec = typeof d.security_json === 'string' ? JSON.parse(d.security_json || '{}') : (d.security_json || {});
      const lines = [
        `Reading collected: ${ageWords(d.security_at)}`,
        `Agent version: ${d.agent_version || 'unknown'}`,
        `Raw security report: ${JSON.stringify(sec).slice(0, 4000)}`,
      ];
      parts.push('=== SECURITY (as the agent last reported it) ===\n' + lines.join('\n'));
      evidence.push(`Security reading ${ageWords(d.security_at)}`);

      parts.push('=== PATCHING ===\n' + [
        `Last patch scan: ${ageWords(d.patch_scan_at)}`,
        `Patches pending: ${d.patch_pending == null ? 'unknown' : d.patch_pending}`,
        `Reboot required: ${d.reboot_required ? 'YES' : 'no'}`,
        `Last patch installed: ${d.patch_last_installed ? ageWords(d.patch_last_installed) : 'unknown'}`,
      ].join('\n'));

      if (d.disk_info) {
        parts.push('=== DISKS (agent reading) ===\n' + String(typeof d.disk_info === 'string' ? d.disk_info : JSON.stringify(d.disk_info)).slice(0, 1200));
      }
    }
  } catch (e: any) {
    parts.push('=== SECURITY ===\n(could not be read: ' + e.message + ')');
  }

  // ── Bitdefender deployment ───────────────────────────────────────────────────
  try {
    if (deviceId) {
      const dep = (await pool.query(
        `SELECT state, last_error, av_before, av_after, agent_seen_at, gz_seen_at, attempts, requested_at
           FROM security_deployments WHERE device_id = $1`, [deviceId])).rows[0];
      if (dep) {
        parts.push('=== BITDEFENDER DEPLOYMENT ===\n' + [
          `State: ${dep.state}`,
          `  (state meanings: "protected" = our agent sees Bitdefender AND GravityZone has the endpoint enrolled;`,
          `   "installed" = only our agent sees it, GravityZone has NOT confirmed — this is NOT a finished install;`,
          `   "failed" = it did not work, see the error.)`,
          `AV before the install: ${dep.av_before || 'unknown'}`,
          `AV now: ${dep.av_after || 'unknown'}`,
          `Attempts: ${dep.attempts ?? 'unknown'}`,
          `Agent last confirmed: ${ageWords(dep.agent_seen_at)}`,
          `GravityZone last saw it: ${dep.gz_seen_at ? ageWords(dep.gz_seen_at) : 'never'}`,
          dep.last_error ? `Last error: ${String(dep.last_error).slice(0, 600)}` : '',
        ].filter(Boolean).join('\n'));
      }
    }
  } catch { /* table may not exist on an older database */ }

  // ── BitLocker: STATUS ONLY. The recovery keys are deliberately not selected. ──
  try {
    if (deviceId) {
      const bl = (await pool.query(
        `SELECT mount_point, protection_status, lock_status, encryption_method, volume_type, collected_at
           FROM asset_bitlocker_keys WHERE device_id = $1 ORDER BY mount_point`, [deviceId])).rows;
      if (bl.length) {
        parts.push('=== ENCRYPTION (BitLocker) ===\n(Recovery keys are deliberately NOT included here.)\n'
          + bl.map((v: any) => `${v.mount_point} ${v.volume_type || ''}: protection ${v.protection_status || 'unknown'}, ${v.lock_status || 'unknown'}, ${v.encryption_method || 'method unknown'} (read ${ageWords(v.collected_at)})`).join('\n'));
      }
    }
  } catch { /* optional */ }

  // ── Pending patches ──────────────────────────────────────────────────────────
  try {
    if (deviceId) {
      const p = (await pool.query(
        `SELECT title, severity FROM device_patches WHERE device_id = $1
          ORDER BY CASE LOWER(COALESCE(severity,'')) WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, title
          LIMIT 40`, [deviceId])).rows;
      if (p.length) {
        parts.push('=== PATCHES WAITING ===\n' + p.map((x: any) => `- [${x.severity || 'unclassified'}] ${x.title}`).join('\n'));
      }
    }
  } catch { /* optional */ }

  // ── Event log: the last pull, and how old it is ──────────────────────────────
  // payload is NOT selected: it carries transient secrets on other command kinds and there
  // is no reason for this query to be the exception.
  try {
    if (deviceId) {
      const ev = (await pool.query(
        `SELECT output, finished_at, requested_at, status
           FROM agent_commands
          WHERE device_id = $1 AND kind = 'events.list' AND status = 'done' AND output IS NOT NULL
          ORDER BY COALESCE(finished_at, requested_at) DESC LIMIT 1`, [deviceId])).rows[0];
      if (ev) {
        const when = ageWords(ev.finished_at || ev.requested_at);
        parts.push(`=== WINDOWS EVENT LOG (last pulled ${when}) ===\n`
          + `IMPORTANT: this is a SNAPSHOT taken ${when}, not live. Anything that happened since is not here.\n`
          + String(ev.output).slice(0, MAX_EVENT_CHARS));
        evidence.push(`Event log pulled ${when}`);
      } else {
        parts.push('=== WINDOWS EVENT LOG ===\nNever pulled for this machine. There is no event-log evidence available — say so rather than reasoning as if the log were clean.');
        evidence.push('Event log: never pulled');
      }
    }
  } catch { /* optional */ }

  // ── What we have done to this machine ────────────────────────────────────────
  try {
    if (deviceId) {
      const cmds = (await pool.query(
        `SELECT kind, status, exit_code, requested_at, finished_at
           FROM agent_commands WHERE device_id = $1
          ORDER BY requested_at DESC LIMIT 25`, [deviceId])).rows;
      if (cmds.length) {
        parts.push('=== WHAT WE HAVE DONE TO THIS MACHINE (most recent first) ===\n'
          + cmds.map((c: any) => `${day(c.requested_at)} ${c.kind} — ${c.status}${c.exit_code != null ? ` (exit ${c.exit_code})` : ''}`).join('\n'));
      }
    }
  } catch { /* optional */ }

  // ── The case the engineer tagged, in full ────────────────────────────────────
  if (opts.ticketId) {
    try {
      const t = (await pool.query(
        `SELECT t.id, t.ticket_number, t.subject, t.description, t.status, t.category, t.created_at,
                c.name AS customer_name
           FROM inbox_tickets t LEFT JOIN customers c ON c.id = t.customer_id
          WHERE t.id = $1`, [opts.ticketId])).rows[0];
      if (t) {
        const body = await caseThread(t.id, 8000);
        parts.push(`=== THE CASE THE ENGINEER ATTACHED — read this as the reason for the question ===\n`
          + `[CASE ${t.ticket_number}] ${t.subject || '(no subject)'}\n`
          + `Customer: ${t.customer_name || 'unassigned'} | Status: ${t.status} | Opened: ${day(t.created_at)}\n`
          + (t.description ? `Description: ${plain(t.description)}\n` : '')
          + body);
        evidence.push(`Case ${t.ticket_number} attached`);
      }
    } catch { /* optional */ }
  }

  // ── This customer's case history ─────────────────────────────────────────────
  // Cases naming this machine come first: a case that says the hostname is far more likely
  // to be about it than the customer's most recent case happens to be.
  try {
    if (asset.customer_id) {
      const names = [asset.hostname, asset.friendly_name].filter(Boolean).map((x: string) => '%' + x + '%');
      const rows = (await pool.query(
        `SELECT t.id, t.ticket_number, t.subject, t.description, t.status, t.category, t.created_at,
                (t.contact_id IS NOT NULL AND t.contact_id = $2) AS same_person,
                ($3::text[] IS NOT NULL AND (
                   t.subject ILIKE ANY($3::text[]) OR t.description ILIKE ANY($3::text[])
                )) AS names_the_machine
           FROM inbox_tickets t
          WHERE t.customer_id = $1 AND t.deleted_at IS NULL AND t.is_spam = false
          ORDER BY names_the_machine DESC, same_person DESC, t.created_at DESC
          LIMIT $4`,
        [asset.customer_id, asset.assigned_contact_id || -1, names.length ? names : null, CUSTOMER_CASES])).rows;
      if (rows.length) {
        const blocks: string[] = [];
        for (const r of rows) {
          const head = `[CASE ${r.ticket_number}] ${r.subject || '(no subject)'}\n`
            + `  Status: ${r.status} | Category: ${r.category || '-'} | Opened: ${day(r.created_at)}`
            + (r.names_the_machine ? ' | NAMES THIS MACHINE' : '')
            + (r.same_person ? ' | raised by the person this machine is assigned to' : '')
            + (r.description ? `\n  ${plain(r.description).slice(0, 700)}` : '');
          const thread = await caseThread(r.id, MAX_CASE_CHARS - head.length);
          blocks.push(head + (thread ? '\n' + thread : ''));
        }
        parts.push(`=== THIS CUSTOMER'S RECENT CASES (${asset.customer_name}) ===\n` + blocks.join('\n\n---\n\n'));
        evidence.push(`${rows.length} of this customer's cases read`);
      } else {
        parts.push(`=== THIS CUSTOMER'S RECENT CASES ===\nNone on record for ${asset.customer_name}.`);
      }
    }
  } catch (e: any) {
    parts.push('=== THIS CUSTOMER\'S RECENT CASES ===\n(could not be read: ' + e.message + ')');
  }

  // ── The logic file: what previous Asks concluded ─────────────────────────────
  // This is what makes the feature compound instead of repeating itself. Findings on THIS
  // machine first, then anything learned elsewhere at the same customer — a fault that has
  // been diagnosed once on a sister machine is the single most useful thing to know.
  try {
    const [mine, theirs] = await Promise.all([
      pool.query(
        `SELECT f.question, f.summary, f.answer, f.created_at, u.display_name AS author, t.ticket_number
           FROM device_findings f
           LEFT JOIN users u ON u.id = f.user_id
           LEFT JOIN inbox_tickets t ON t.id = f.ticket_id
          WHERE f.asset_id = $1 ORDER BY f.created_at DESC LIMIT $2`, [assetId, MAX_FINDINGS_DEVICE]),
      asset.customer_id
        ? pool.query(
            `SELECT f.summary, f.answer, f.created_at, a.hostname, a.friendly_name, u.display_name AS author
               FROM device_findings f
               JOIN customer_assets a ON a.id = f.asset_id
               LEFT JOIN users u ON u.id = f.user_id
              WHERE f.customer_id = $1 AND f.asset_id <> $2
              ORDER BY f.created_at DESC LIMIT $3`, [asset.customer_id, assetId, MAX_FINDINGS_CUSTOMER])
        : Promise.resolve({ rows: [] } as any),
    ]);
    if (mine.rows.length) {
      parts.push('=== WHAT WE HAVE ALREADY WORKED OUT ABOUT THIS MACHINE ===\n'
        + '(Saved findings from previous questions. Treat these as prior work by a colleague: build on them, and say so if new evidence contradicts one.)\n'
        + mine.rows.map((f: any) =>
            `- ${day(f.created_at)}${f.author ? ' · ' + f.author : ''}${f.ticket_number ? ' · case ' + f.ticket_number : ''}\n`
            + `  Asked: ${f.question}\n  Found: ${String(f.summary || f.answer).slice(0, 900)}`).join('\n'));
      evidence.push(`${mine.rows.length} previous finding${mine.rows.length === 1 ? '' : 's'} on this machine`);
    }
    if (theirs.rows.length) {
      parts.push('=== FINDINGS ON THIS CUSTOMER\'S OTHER MACHINES ===\n'
        + theirs.rows.map((f: any) =>
            `- ${day(f.created_at)} · ${f.friendly_name || f.hostname || 'a machine'}: ${String(f.summary || f.answer).slice(0, 500)}`).join('\n'));
      evidence.push(`${theirs.rows.length} finding${theirs.rows.length === 1 ? '' : 's'} from their other machines`);
    }
  } catch { /* table appears with the next prisma db push */ }

  return { corpus: parts.join('\n\n'), evidence, asset };
}

/** Messages + engineers' notes for one case, oldest first, trimmed to fit. */
async function caseThread(ticketId: number, room: number): Promise<string> {
  if (room <= 0) return '';
  const [msgs, notes] = await Promise.all([
    pool.query(
      `SELECT message_direction, from_name, from_email, body_html, body_text,
              COALESCE(received_at, created_at) AS at
         FROM inbox_messages WHERE ticket_id = $1 ORDER BY at`, [ticketId]),
    pool.query(
      `SELECT n.body, n.created_at AS at, u.display_name AS author
         FROM inbox_notes n LEFT JOIN users u ON u.id = n.user_id
        WHERE n.ticket_id = $1 AND n.note_type <> 'system_log' ORDER BY n.created_at`, [ticketId]),
  ]);
  const lines: string[] = [];
  for (const m of msgs.rows) {
    const t = plain(m.body_html || '') || String(m.body_text || '');
    if (!t) continue;
    lines.push(`  ${m.message_direction === 'outbound' ? 'Lumen' : (m.from_name || m.from_email || 'customer')} (${day(m.at)}): ${t}`);
  }
  for (const n of notes.rows) {
    const t = plain(n.body || '');
    if (t) lines.push(`  NOTE ${n.author || 'system'} (${day(n.at)}): ${t}`);
  }
  let body = lines.join('\n');
  if (body.length > room) body = body.slice(0, room) + '\n  …(rest of this case trimmed)…';
  return body;
}

// ── The question ────────────────────────────────────────────────────────────────

export const SYSTEM = [
  'You are a senior support engineer at Lumen IT Solutions, a UK managed-service provider, looking at ONE customer machine with an engineer who is about to do something about it.',
  'You are given everything the Portal holds on that machine: hardware, security reading, patch position, Bitdefender deployment state, encryption status, the last Windows event-log pull, every remote action taken on it, that customer\'s case history, and any findings previous engineers saved.',
  '',
  'How to answer:',
  '- LEAD WITH THE ANSWER. One sentence, then the reasoning. Never open with a restatement of the question.',
  '- CITE THE EVIDENCE. Name the event ID, the case number, the state, the date. "There are errors in the log" is worthless; "Event 7000, the Bitdefender service failing to start, eleven times since Tuesday" is the job.',
  '- AGE IS PART OF THE EVIDENCE. Each section says when it was collected. If your conclusion rests on a reading that is days old, say that plainly and say what a fresh pull would settle. Never present a stale reading as current.',
  '- ABSENCE IS NOT HEALTH. "Never pulled", "no agent", "unknown" mean we do not know. They never mean the machine is fine. Say what is missing and what would answer it.',
  '- CONNECT IT TO THE CASE HISTORY where there is a real connection — the same fault on this machine before, the same fault on a sister machine, a pattern at this customer. Only when it is genuinely the same thing; a coincidence of words is not a pattern.',
  '- BUILD ON PREVIOUS FINDINGS rather than repeating them. If new evidence contradicts a saved finding, say so explicitly — that is the most valuable thing you can tell anyone.',
  '- NEVER INVENT. No event IDs, case numbers, dates or products that are not in the evidence. If the evidence does not answer the question, say what is missing.',
  '- Bitdefender state "installed" is NOT a finished install: it means our agent sees it but GravityZone has not confirmed enrolment. Do not report it as protected.',
  '- British English. Direct, no preamble, no flattery, no "I hope this helps".',
  '',
  'Reply with STRICT JSON only, no markdown fences:',
  '{"headline":"one sentence, the answer itself","answer":"2-5 short paragraphs, plain text, \\n between paragraphs","actions":["what to actually do, most useful first"]}',
  'actions may be an empty array when there is genuinely nothing to do. Never pad it.',
].join('\n');

export async function askDevice(
  assetId: number,
  question: string,
  opts: { ticketId?: number | null } = {},
): Promise<DeviceAskResult> {
  const { corpus, evidence } = await buildDeviceCorpus(assetId, opts);
  const { text, usage } = await aiAskCached(SYSTEM, corpus, `QUESTION: ${question}`, { maxTokens: 2000, strong: true });
  const parsed = parseJsonAnswer<any>(text, { headline: '', answer: stripTrailingJson(text), actions: [] });
  return {
    headline: String(parsed.headline || '').slice(0, 400),
    answer: String(parsed.answer || stripTrailingJson(text)).slice(0, 8000),
    actions: (Array.isArray(parsed.actions) ? parsed.actions : []).slice(0, 8).map((a: any) => String(a).slice(0, 300)),
    evidence,
    usage,
  };
}

// ── The logic file ──────────────────────────────────────────────────────────────

export async function saveFinding(p: {
  assetId: number; customerId: number | null; deviceId: number | null;
  question: string; headline: string; answer: string; ticketId: number | null; userId: number | null;
}): Promise<number> {
  const r = await pool.query(
    `INSERT INTO device_findings (asset_id, customer_id, device_id, question, summary, answer, ticket_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.assetId, p.customerId, p.deviceId, p.question.slice(0, 1000),
     (p.headline || '').slice(0, 1000) || null, p.answer.slice(0, 20000), p.ticketId, p.userId]);
  return r.rows[0].id;
}

export async function listFindings(assetId: number, limit = 50): Promise<DeviceFinding[]> {
  try {
    return (await pool.query(
      `SELECT f.id, f.question, f.answer, f.summary, f.ticket_id, f.created_at,
              t.ticket_number, u.display_name AS author
         FROM device_findings f
         LEFT JOIN inbox_tickets t ON t.id = f.ticket_id
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.asset_id = $1 ORDER BY f.created_at DESC LIMIT $2`, [assetId, limit])).rows;
  } catch { return []; }
}

export async function deleteFinding(id: number): Promise<void> {
  await pool.query('DELETE FROM device_findings WHERE id = $1', [id]);
}
