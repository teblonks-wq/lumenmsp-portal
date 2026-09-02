import { pool } from '../db/pool';
import { aiAskText, parseJsonAnswer } from './ai-compose';

// ── Answering the agent back ────────────────────────────────────────────────────
// Terry, 2 Sep 2026: "we need to be able to reply to Claude's concerns — have it consider
// what we've said, give feedback, and add to rules."
//
// The anomaly list was one-way: it told you things and you could only dismiss them. But a
// dismissal throws away the REASON, so the same finding comes back next month and gets
// dismissed again. A reply keeps the reason and turns it into something the agent honours.
//
// The loop: you answer in your own words → Claude reads the answer against what it already
// knows about that supplier and replies → where the answer contains a STANDING instruction
// it proposes a rule → you accept or reject it.
//
// A proposed rule is never applied on its own. A rule that suppresses a finding is a
// deliberate blind spot, and one Claude over-generalised from a passing remark would hide
// real money quietly. So the rule is written down, shown, and waits for a person.

export interface RuleRow {
  id: number; scope: string; supplier_key: string | null; kind: string;
  anomaly_kind: string | null; body: string; reason: string | null;
  status: string; from_anomaly: number | null; created_at: string;
}

export async function activeRules(): Promise<RuleRow[]> {
  return (await pool.query("SELECT * FROM purchase_rules WHERE status='active' ORDER BY id")
    .catch(() => ({ rows: [] as any[] }))).rows;
}

export async function listRules(status?: string): Promise<RuleRow[]> {
  return (await pool.query(
    status ? 'SELECT * FROM purchase_rules WHERE status=$1 ORDER BY id DESC'
           : 'SELECT * FROM purchase_rules ORDER BY id DESC',
    status ? [status] : []
  ).catch(() => ({ rows: [] as any[] }))).rows;
}

/** Does an active rule say not to raise this finding? Returns the rule that says so. */
export function suppressedBy(rules: RuleRow[], kind: string, supplierKey: string | null): RuleRow | null {
  for (const r of rules) {
    if (r.kind !== 'suppress') continue;
    if (r.anomaly_kind && r.anomaly_kind !== kind) continue;
    if (r.scope === 'global') return r;
    if (!r.supplier_key || !supplierKey) continue;
    const a = r.supplier_key.toLowerCase(), b = supplierKey.toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) return r;
  }
  return null;
}

/** The standing facts a human has given us about a supplier, for Claude's corpus. */
export function contextFor(rules: RuleRow[], supplierKey: string | null): string[] {
  return rules
    .filter((r) => r.kind === 'context')
    .filter((r) => r.scope === 'global' || (!!supplierKey && !!r.supplier_key &&
      (r.supplier_key.toLowerCase().includes(supplierKey.toLowerCase()) || supplierKey.toLowerCase().includes(r.supplier_key.toLowerCase()))))
    .map((r) => r.body);
}

// ── Claude considers the reply ──────────────────────────────────────────────────
const REPLY_SYSTEM = [
  'You are the purchase agent for a UK IT company (Lumen IT Solutions). A colleague has replied to a finding you raised about their purchase ledger.',
  'Read what they said, take it at face value — they know their own business far better than you do — and answer them.',
  'Return STRICT JSON only:',
  '{"reply":string,"rule":null|{"kind":"suppress"|"context"|"category","scope":"supplier"|"global","anomalyKind":string|null,"body":string,"conditions":string[],"categoryName":string|null}}',
  'THE REPLY — this is read on a busy screen, so:',
  '- TWO SENTENCES MAXIMUM. One is better. No preamble, no restating what they told you.',
  '- Say only what is NEW: what you now understand, or what you still need.',
  '- NEVER repeat a concern you have already raised earlier in this conversation. If you already asked for the invoice number, do not ask again.',
  '- NEVER claim you will do something you cannot do. You do not pay invoices, progress payments, chase suppliers or process anything. You read documents, match them to payments, and raise findings. Saying "I will progress this for payment" is a lie.',
  '- You may disagree, once, briefly.',
  'THE RULE — only when their answer is a STANDING instruction, not a one-off explanation:',
  '- "category" when they have told you how this kind of spend should be CODED ("these are Hardware Cost of Sale"). Set categoryName to the category they named, exactly as they said it. This is the most useful kind — prefer it whenever a coding is stated.',
  '- "context" records a fact for future judgements (how a supplier bills, who collects for whom, what a payment really is).',
  '- "suppress" stops a kind of finding for a supplier. Propose it ONLY when they have said the situation is normal and expected, never merely fine this once.',
  '- anomalyKind must be the kind of the finding being answered, or null for every kind. Narrow beats broad.',
  '- scope "global" is for something true of the whole ledger. Rarely right; prefer "supplier".',
  '- body: ONE plain sentence, under 25 words, still meaningful to somebody reading it in a year.',
  '- conditions: 2 to 4 short phrases, each a SINGLE testable condition under which this rule applies (e.g. "Supplier is Giacom", "Invoice is for hardware, not monthly comms", "Amount exceeds the usual monthly range"). A person reads these before accepting, so each must be checkable, not a restatement of the body.',
  '- Return rule: null when they are explaining a one-off, asking a question, or saying something you cannot turn into a standing instruction. MOST replies should produce no rule.',
  '- If a rule already standing says substantially the same thing, return null. Do not propose a variation of a rule that exists.',
  'Never propose a rule that would suppress a finding about money leaving the business twice.',
].join('\n');

// ── Not saying the same thing twice ─────────────────────────────────────────────
// Seen live 2026-09-02: one finding collected SEVEN identical replies and EIGHT nearly
// identical rules. Two causes, both fixed here and in the UI:
//   • the Claude call takes several seconds and the button gave no sign of working, so it
//     was pressed again — and again;
//   • each in-flight call was told "do not propose a rule that already exists", but none of
//     them could see the others, so they all proposed the same rule at once.
// A prompt cannot fix a race. These checks can.

/** Overlap of significant words, 0-1, measured against the SHORTER text (containment).
 *  Containment rather than Jaccard on purpose: a reworded rule is often longer or shorter
 *  than the one it repeats, and dividing by the longer text hides that they say the same
 *  thing. Measured on the eight real rules of 2 Sep, rewordings of one fact score 0.38-0.75
 *  while genuinely unrelated rules score 0.00 — so the thresholds below sit in a wide gap,
 *  not on a knife edge. */
export function similarity(a: string, b: string): number {
  const words = (x: string) => new Set(
    String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !['this','that','with','from','they','will','have','been','also','when','than','both','which','their','there'].includes(w))
  );
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

const SAME_RULE = 0.35;      // a reworded version of a rule we already hold (unrelated = 0.00)
const SAME_REPLY = 0.8;      // the same thing said twice (a typo variant scores 0.86)
const SAME_REPLY_SECS = 120;
const MAX_RULES_PER_SUPPLIER_KIND = 3;  // a hard stop on accumulation, whatever the wording

/** Has this person just said this? Catches a double-click and an impatient re-press. */
async function isRepeatReply(anomalyId: number, text: string): Promise<boolean> {
  const recent = (await pool.query(
    `SELECT body FROM purchase_anomaly_notes
      WHERE anomaly_id=$1 AND is_claude=false AND created_at > NOW() - ($2 || ' seconds')::interval
      ORDER BY id DESC LIMIT 3`, [anomalyId, String(SAME_REPLY_SECS)]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  return recent.some((n: any) => similarity(n.body, text) >= SAME_REPLY);
}

/** Do we already hold a rule that says this? Checks proposed ones too — that is the race. */
async function alreadyRuled(supplierKey: string | null, kind: string, body: string): Promise<boolean> {
  const rows = (await pool.query(
    `SELECT body FROM purchase_rules
      WHERE status IN ('active','proposed') AND kind=$1
        AND (supplier_key IS NOT DISTINCT FROM $2 OR scope='global')`, [kind, supplierKey]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  // Enough is enough. Three rules of one kind about one supplier is already more than
  // anybody will read; a fourth phrasing of the same idea is noise however it is worded.
  if (rows.length >= MAX_RULES_PER_SUPPLIER_KIND) return true;
  return rows.some((r: any) => similarity(r.body, body) >= SAME_RULE);
}

export interface ReplyResult { reply: string; ruleId: number | null; ruleBody: string | null; repeat?: boolean }

export async function replyToAnomaly(
  anomalyId: number, text: string, userId: number, userName: string,
): Promise<ReplyResult> {
  const a = (await pool.query('SELECT * FROM purchase_anomalies WHERE id=$1', [anomalyId])).rows[0];
  if (!a) throw new Error('That finding no longer exists.');
  if (await isRepeatReply(anomalyId, text)) {
    return { reply: '', ruleId: null, ruleBody: null, repeat: true };
  }

  await pool.query(
    'INSERT INTO purchase_anomaly_notes (anomaly_id, is_claude, author_id, author_name, body) VALUES ($1,false,$2,$3,$4)',
    [anomalyId, userId, userName, text.slice(0, 4000)]
  );

  // Everything Claude needs to answer well: the finding, the thread so far, what we already
  // know about the supplier, and the rules already standing — so it does not propose one twice.
  const prior = (await pool.query(
    'SELECT is_claude, author_name, body FROM purchase_anomaly_notes WHERE anomaly_id=$1 ORDER BY id', [anomalyId]
  )).rows;
  const profile = a.supplier_key
    ? (await pool.query('SELECT * FROM purchase_supplier_profiles WHERE supplier_key=$1', [a.supplier_key]).catch(() => ({ rows: [] as any[] }))).rows[0]
    : null;
  const rules = await activeRules();

  const money = (v: any) => (v == null ? '—' : '£' + Math.abs(Number(v)).toFixed(2));
  const lines: string[] = [];
  lines.push('THE FINDING');
  lines.push(`  Kind: ${a.kind} | Severity: ${a.severity} | Amount: ${money(a.amount)}`);
  lines.push(`  ${a.title}`);
  if (a.detail) lines.push(`  ${a.detail}`);
  if (profile) {
    lines.push('');
    lines.push('WHAT WE HAVE LEARNED ABOUT THIS SUPPLIER (from confirmed matches)');
    lines.push(`  Seen ${profile.match_count} time(s); typical ${money(profile.avg_amount)} (range ${money(profile.min_amount)}–${money(profile.max_amount)}); last ${money(profile.last_amount)}`);
    if (profile.cadence_days != null) lines.push(`  Bills roughly every ${profile.cadence_days} days`);
    if (profile.avg_lag_days != null) lines.push(`  Collects about ${profile.avg_lag_days} days after the invoice date`);
  }
  const standing = rules.filter((r) => r.scope === 'global' || (a.supplier_key && r.supplier_key && r.supplier_key.toLowerCase() === String(a.supplier_key).toLowerCase()));
  if (standing.length) {
    lines.push('');
    lines.push('RULES ALREADY STANDING (do not propose these again)');
    standing.forEach((r) => lines.push(`  [${r.kind}] ${r.body}`));
  }
  lines.push('');
  lines.push('THE CONVERSATION');
  prior.forEach((n: any) => lines.push(`  ${n.is_claude ? 'You' : (n.author_name || 'Colleague')}: ${n.body}`));
  lines.push('');
  lines.push('Answer the last message.');

  let parsed: { reply?: string; rule?: any } | null = null;
  try { parsed = parseJsonAnswer<any>(await aiAskText(REPLY_SYSTEM, lines.join('\n'), 800), null); }
  catch (e) { console.error('[purchase-rules] reply failed:', (e as Error).message); }

  const replyText = (parsed && typeof parsed.reply === 'string' && parsed.reply.trim())
    ? parsed.reply.trim()
    : 'Noted — I could not reach Claude to think this through, so nothing has been added to the rules. Your note is saved on the finding.';

  let ruleId: number | null = null, ruleBody: string | null = null;
  const r = parsed && parsed.rule;
  if (r && typeof r.body === 'string' && r.body.trim() && ['suppress', 'context', 'category'].includes(String(r.kind))) {
    const scope = r.scope === 'global' ? 'global' : 'supplier';
    // A supplier-scoped rule with no supplier to attach to would apply to nothing, so it
    // becomes global only if Claude actually asked for that; otherwise it is dropped.
    if (scope === 'supplier' && !a.supplier_key) {
      console.warn('[purchase-rules] dropped a supplier-scoped rule with no supplier key on anomaly', anomalyId);
    } else if (await alreadyRuled(scope === 'global' ? null : a.supplier_key, String(r.kind), String(r.body))) {
      // A rule saying this already exists or is already waiting. Silently not proposing it
      // again is the whole point — eight rewordings of one fact is not a rule set.
      console.log('[purchase-rules] skipped a duplicate rule proposal on anomaly', anomalyId);
    } else {
      const conds = Array.isArray(r.conditions)
        ? r.conditions.map((c: any) => String(c).slice(0, 160)).filter(Boolean).slice(0, 5)
        : [];
      const ins = await pool.query(
        `INSERT INTO purchase_rules (scope, supplier_key, kind, anomaly_kind, body, conditions,
                                     category_name, reason, status, from_anomaly, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9,$10) RETURNING id`,
        [scope, scope === 'global' ? null : a.supplier_key, String(r.kind),
         r.anomalyKind ? String(r.anomalyKind) : null, String(r.body).slice(0, 500),
         conds.length ? JSON.stringify(conds) : null,
         r.categoryName ? String(r.categoryName).slice(0, 120) : null,
         text.slice(0, 500), anomalyId, userId]
      );
      ruleId = ins.rows[0].id; ruleBody = String(r.body);
    }
  }

  await pool.query(
    'INSERT INTO purchase_anomaly_notes (anomaly_id, is_claude, body, rule_id) VALUES ($1,true,$2,$3)',
    [anomalyId, replyText, ruleId]
  );
  return { reply: replyText, ruleId, ruleBody };
}

export async function notesFor(anomalyIds: number[]): Promise<Record<number, any[]>> {
  if (!anomalyIds.length) return {};
  const rows = (await pool.query(
    `SELECT n.*, r.body AS rule_body, r.status AS rule_status, r.kind AS rule_kind,
            r.conditions, r.category_name AS rule_category
       FROM purchase_anomaly_notes n LEFT JOIN purchase_rules r ON r.id = n.rule_id
      WHERE n.anomaly_id = ANY($1) ORDER BY n.id`, [anomalyIds]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  const out: Record<number, any[]> = {};
  for (const n of rows) (out[n.anomaly_id] = out[n.anomaly_id] || []).push(n);
  return out;
}

/** Accepting a rule is the moment it starts affecting what you are shown. */
export async function setRuleStatus(id: number, status: 'active' | 'rejected'): Promise<void> {
  await pool.query(
    "UPDATE purchase_rules SET status=$1, activated_at=CASE WHEN $1='active' THEN NOW() ELSE NULL END WHERE id=$2",
    [status, id]
  );
}

/** Coding a human dictated ("these are Hardware Cost of Sale"), for the categoriser. */
export function categoryRuleFor(rules: RuleRow[], supplierKey: string | null): { name: string; body: string } | null {
  for (const r of rules) {
    if (r.kind !== 'category' || !(r as any).category_name) continue;
    if (r.scope === 'global') return { name: (r as any).category_name, body: r.body };
    if (!r.supplier_key || !supplierKey) continue;
    const a = r.supplier_key.toLowerCase(), b = supplierKey.toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) return { name: (r as any).category_name, body: r.body };
  }
  return null;
}

/** Parse the stored conditions back out for display. Never throws on bad data. */
export function conditionsOf(rule: any): string[] {
  try { const v = JSON.parse(rule?.conditions || '[]'); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}
