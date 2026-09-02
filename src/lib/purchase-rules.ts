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
  '{"reply":string,"rule":null|{"kind":"suppress"|"context","scope":"supplier"|"global","anomalyKind":string|null,"body":string}}',
  'THE REPLY:',
  '- Two or three sentences at most. Say what you now understand, and what you will do differently.',
  '- If what they said means the finding was wrong, say so plainly. Do not defend it.',
  '- If something they said still worries you, say that too, once, without nagging. You are allowed to disagree.',
  'THE RULE — only when their answer contains a STANDING instruction, not a one-off explanation:',
  '- "suppress" stops this kind of finding for this supplier. Propose it ONLY when they have said the situation is normal and expected, not merely that it is fine this once.',
  '- "context" records a fact to use in future judgements (how a supplier bills, who collects for whom, what a payment really is). Prefer this — it makes the agent better without blinding it.',
  '- anomalyKind must be the kind of the finding being answered, or null to cover every kind for that supplier. Narrow beats broad.',
  '- scope "global" is for something true of the whole ledger. It is rarely right; prefer "supplier".',
  '- body is the rule in one plain sentence, written so it still makes sense to somebody reading it in a year.',
  '- Return rule: null when they are just explaining a one-off, asking a question, or saying something you cannot turn into a standing instruction. Most replies should produce no rule.',
  'Never propose a rule that would suppress a finding about money leaving the business twice.',
].join('\n');

export interface ReplyResult { reply: string; ruleId: number | null; ruleBody: string | null }

export async function replyToAnomaly(
  anomalyId: number, text: string, userId: number, userName: string,
): Promise<ReplyResult> {
  const a = (await pool.query('SELECT * FROM purchase_anomalies WHERE id=$1', [anomalyId])).rows[0];
  if (!a) throw new Error('That finding no longer exists.');

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
  if (r && typeof r.body === 'string' && r.body.trim() && ['suppress', 'context'].includes(String(r.kind))) {
    const scope = r.scope === 'global' ? 'global' : 'supplier';
    // A supplier-scoped rule with no supplier to attach to would apply to nothing, so it
    // becomes global only if Claude actually asked for that; otherwise it is dropped.
    if (scope === 'supplier' && !a.supplier_key) {
      console.warn('[purchase-rules] dropped a supplier-scoped rule with no supplier key on anomaly', anomalyId);
    } else {
      const ins = await pool.query(
        `INSERT INTO purchase_rules (scope, supplier_key, kind, anomaly_kind, body, reason, status, from_anomaly, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8) RETURNING id`,
        [scope, scope === 'global' ? null : a.supplier_key, String(r.kind),
         r.anomalyKind ? String(r.anomalyKind) : null, String(r.body).slice(0, 500),
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
    `SELECT n.*, r.body AS rule_body, r.status AS rule_status, r.kind AS rule_kind
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
