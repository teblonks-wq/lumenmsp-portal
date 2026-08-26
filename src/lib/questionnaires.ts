import crypto from 'crypto';
import { pool } from '../db/pool';
import { config } from '../config';
import {
  parseSpec, coerceAnswer, tallyQuestion, npsScore, answerOptions,
  SpecError, AnswerError,
  type ParsedSpec, type SpecQuestion, type QuestionResult, type QuestionType,
} from './questionnaire-spec';

// ── Questionnaires, polls and case feedback ───────────────────────────────────
// The store side of the feature. lib/questionnaire-spec.ts owns the JSON contract and all
// the pure arithmetic; this file owns rows.
//
// Three shapes worth knowing before reading on:
//
//  • IMPORT MATERIALISES. A spec becomes a version row plus one row per question. The
//    original JSON is kept in questionnaire_versions.spec so it can be exported again
//    unchanged, but nothing reads answers out of it.
//
//  • A VERSION IS FROZEN. Re-importing the same key makes version N+1 and leaves N alone,
//    because invites and answers point at a version. Editing question 3 after forty people
//    have answered would otherwise quietly change what those forty were asked.
//
//  • AN INVITE IS THE ATTRIBUTION. One token per person per questionnaire; the token
//    carries contact and customer, so an answer never has to ask "who are you?" and a
//    non-responder is a row you can chase. campaign_id is nullable on purpose — a case
//    close raises an invite with no campaign at all.
//
// Tables are Prisma-schema-managed (schema.prisma). Nothing here creates tables:
// `prisma db push` on deploy DROPS anything the schema does not know about.

export { SpecError, AnswerError };

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportResult {
  questionnaireId: number;
  versionId: number;
  version: number;
  key: string;
  title: string;
  isNew: boolean;          // first time we have seen this key
  questionCount: number;
}

// Validate a spec and store it as a NEW version. Safe to call repeatedly: each call adds
// a version and repoints `current_version_id`; previous versions and their answers stand.
export async function importSpec(input: unknown, userId: number | null): Promise<ImportResult> {
  const spec = parseSpec(input);          // throws SpecError — the caller shows the message

  const existing = await pool.query('SELECT id, kind FROM questionnaires WHERE key=$1', [spec.key]);
  let questionnaireId: number;
  const isNew = existing.rows.length === 0;
  if (isNew) {
    const r = await pool.query(
      `INSERT INTO questionnaires (key, title, kind, status, created_by) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
      [spec.key, spec.title, spec.kind, userId]
    );
    questionnaireId = r.rows[0].id;
  } else {
    questionnaireId = existing.rows[0].id;
    await pool.query('UPDATE questionnaires SET title=$1, kind=$2, updated_at=now() WHERE id=$3',
      [spec.title, spec.kind, questionnaireId]);
  }

  const vmax = await pool.query('SELECT COALESCE(MAX(version),0)::int AS v FROM questionnaire_versions WHERE questionnaire_id=$1', [questionnaireId]);
  const version = vmax.rows[0].v + 1;

  const v = await pool.query(
    `INSERT INTO questionnaire_versions (questionnaire_id, version, title, intro, mode, thank_you, closes_at, spec)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [questionnaireId, version, spec.title, spec.intro, spec.mode, spec.thankYou,
     spec.closesAt ? spec.closesAt + 'T23:59:59Z' : null, JSON.stringify(spec.raw)]
  );
  const versionId: number = v.rows[0].id;

  for (let i = 0; i < spec.questions.length; i++) {
    const q = spec.questions[i];
    await pool.query(
      `INSERT INTO questionnaire_questions (version_id, ord, key, type, label, help_text, required, scale, options, allow_other)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [versionId, i, q.key, q.type, q.label, q.helpText, q.required, q.scale,
       q.options ? JSON.stringify(q.options) : null, q.allowOther]
    );
  }

  await pool.query('UPDATE questionnaires SET current_version_id=$1, updated_at=now() WHERE id=$2', [versionId, questionnaireId]);

  return { questionnaireId, versionId, version, key: spec.key, title: spec.title, isNew, questionCount: spec.questions.length };
}

// ── Reading a version back ────────────────────────────────────────────────────

export interface LoadedVersion {
  versionId: number;
  questionnaireId: number;
  key: string;
  kind: string;
  version: number;
  title: string;
  intro: string | null;
  mode: 'form' | 'poll';
  thankYou: string | null;
  closesAt: Date | null;
  questions: SpecQuestion[];
  spec: unknown;
}

function questionFromRow(r: any): SpecQuestion {
  return {
    key: r.key, type: r.type as QuestionType, label: r.label,
    helpText: r.help_text, required: !!r.required, scale: r.scale,
    options: r.options ? (typeof r.options === 'string' ? JSON.parse(r.options) : r.options) : null,
    allowOther: !!r.allow_other,
  };
}

export async function loadVersion(versionId: number): Promise<LoadedVersion | null> {
  const { rows } = await pool.query(
    `SELECT v.*, q.key, q.kind FROM questionnaire_versions v
     JOIN questionnaires q ON q.id = v.questionnaire_id WHERE v.id=$1`, [versionId]);
  if (!rows.length) return null;
  const v = rows[0];
  const qs = await pool.query('SELECT * FROM questionnaire_questions WHERE version_id=$1 ORDER BY ord ASC', [versionId]);
  return {
    versionId, questionnaireId: v.questionnaire_id, key: v.key, kind: v.kind, version: v.version,
    title: v.title, intro: v.intro, mode: v.mode, thankYou: v.thank_you, closesAt: v.closes_at,
    questions: qs.rows.map(questionFromRow),
    spec: typeof v.spec === 'string' ? JSON.parse(v.spec) : v.spec,
  };
}

export async function listQuestionnaires(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT q.*, v.version AS current_version, v.mode, v.closes_at,
            (SELECT COUNT(*)::int FROM questionnaire_invites i WHERE i.version_id = q.current_version_id) AS invited,
            (SELECT COUNT(*)::int FROM questionnaire_responses r WHERE r.version_id = q.current_version_id) AS responded,
            (SELECT COUNT(*)::int FROM questionnaire_versions vv WHERE vv.questionnaire_id = q.id) AS versions
     FROM questionnaires q
     LEFT JOIN questionnaire_versions v ON v.id = q.current_version_id
     WHERE q.status='active'
     ORDER BY q.updated_at DESC`);
  return rows;
}

// ── Invites ───────────────────────────────────────────────────────────────────

export interface InviteInput {
  versionId: number;
  contactId?: number | null;
  customerId?: number | null;
  email?: string | null;
  fullName?: string | null;
  customerName?: string | null;
  campaignId?: number | null;
  ticketId?: number | null;
}

// Mint an invite and return its token. For a case (ticketId set) the unique index makes
// this idempotent: the second call returns the FIRST token, so re-closing a case can never
// ask the customer twice.
export async function createInvite(input: InviteInput): Promise<{ id: number; token: string; fresh: boolean }> {
  if (input.ticketId) {
    const seen = await pool.query('SELECT id, token FROM questionnaire_invites WHERE ticket_id=$1', [input.ticketId]);
    if (seen.rows.length) return { id: seen.rows[0].id, token: seen.rows[0].token, fresh: false };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO questionnaire_invites (version_id, campaign_id, ticket_id, contact_id, customer_id, email, full_name, customer_name, token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (ticket_id) DO NOTHING
     RETURNING id, token`,
    [input.versionId, input.campaignId ?? null, input.ticketId ?? null, input.contactId ?? null,
     input.customerId ?? null, input.email ?? null, input.fullName ?? null, input.customerName ?? null, token]
  );
  if (rows.length) return { id: rows[0].id, token: rows[0].token, fresh: true };
  // Lost a race on the same case — take the row that won.
  const won = await pool.query('SELECT id, token FROM questionnaire_invites WHERE ticket_id=$1', [input.ticketId]);
  return { id: won.rows[0].id, token: won.rows[0].token, fresh: false };
}

export async function markInviteSent(inviteId: number): Promise<void> {
  await pool.query('UPDATE questionnaire_invites SET sent_at=COALESCE(sent_at, now()) WHERE id=$1', [inviteId]);
}

export interface InviteContext {
  invite: any;
  version: LoadedVersion;
  response: any | null;
  closed: boolean;
}

export async function inviteByToken(token: string): Promise<InviteContext | null> {
  const { rows } = await pool.query('SELECT * FROM questionnaire_invites WHERE token=$1', [token]);
  if (!rows.length) return null;
  const invite = rows[0];
  const version = await loadVersion(invite.version_id);
  if (!version) return null;
  const resp = await pool.query('SELECT * FROM questionnaire_responses WHERE invite_id=$1', [invite.id]);
  const closed = !!version.closesAt && version.closesAt.getTime() < Date.now();
  return { invite, version, response: resp.rows[0] || null, closed };
}

export async function markOpened(inviteId: number): Promise<void> {
  await pool.query('UPDATE questionnaire_invites SET opened_at=COALESCE(opened_at, now()) WHERE id=$1', [inviteId]);
}

export function publicLink(token: string): string {
  return config.APP_URL.replace(/\/+$/, '') + '/q/' + token;
}

// A poll option's one-click URL. The GET behind it records NOTHING — see routes: it lands
// on a page that posts. Mail scanners follow links; they do not submit forms.
export function pollOptionLink(token: string, value: string): string {
  return publicLink(token) + '/a/' + encodeURIComponent(value);
}

// ── Recording answers ─────────────────────────────────────────────────────────

// Record a set of answers against an invite. Idempotent per invite: a second submission
// updates the SAME response rather than creating a rival one, so "one token, one response"
// holds even when somebody reloads or comes back to add a comment.
export async function recordAnswers(
  token: string,
  submitted: Record<string, unknown>,
): Promise<{ responseId: number; version: LoadedVersion; invite: any }> {
  const ctx = await inviteByToken(token);
  if (!ctx) throw new AnswerError('This link is not valid.');
  if (ctx.closed) throw new AnswerError('This questionnaire has closed.');
  const { invite, version } = ctx;

  // Coerce EVERYTHING before writing anything: a half-saved response is worse than a
  // rejected one, because it reads as a real answer.
  const staged: { q: SpecQuestion; a: ReturnType<typeof coerceAnswer> }[] = [];
  for (const q of version.questions) {
    if (q.type === 'heading') continue;
    // A key that is absent entirely (a poll answering one question, a partial save) is
    // left alone rather than treated as blank — otherwise saving a comment would wipe
    // the rating that came in with the first click.
    if (!(q.key in submitted)) continue;
    staged.push({ q, a: coerceAnswer(q, submitted[q.key]) });
  }

  // Required questions must be present across what is stored AND what has just arrived.
  const already = ctx.response
    ? (await pool.query(
        `SELECT qq.key FROM questionnaire_answers a JOIN questionnaire_questions qq ON qq.id=a.question_id
         WHERE a.response_id=$1`, [ctx.response.id])).rows.map((r: any) => r.key)
    : [];
  const have = new Set<string>(already);
  staged.forEach((s) => { if (s.a) have.add(s.q.key); else have.delete(s.q.key); });
  const missing = version.questions.filter((q) => q.required && q.type !== 'heading' && !have.has(q.key));
  if (missing.length) throw new AnswerError(`Please answer: ${missing[0].label}`);

  let responseId: number;
  if (ctx.response) {
    responseId = ctx.response.id;
  } else {
    const r = await pool.query(
      `INSERT INTO questionnaire_responses (version_id, invite_id, contact_id, customer_id, ticket_id, assigned_user_id)
       VALUES ($1,$2,$3,$4,$5,(SELECT assigned_user_id FROM inbox_tickets WHERE id=$5))
       RETURNING id`,
      [version.versionId, invite.id, invite.contact_id, invite.customer_id, invite.ticket_id]
    );
    responseId = r.rows[0].id;
  }

  const qidByKey = new Map<string, number>(
    (await pool.query('SELECT id, key FROM questionnaire_questions WHERE version_id=$1', [version.versionId]))
      .rows.map((r: any) => [r.key, r.id])
  );

  for (const { q, a } of staged) {
    const qid = qidByKey.get(q.key)!;
    if (!a) { await pool.query('DELETE FROM questionnaire_answers WHERE response_id=$1 AND question_id=$2', [responseId, qid]); continue; }
    await pool.query(
      `INSERT INTO questionnaire_answers (response_id, question_id, value_text, value_num, value_json)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (response_id, question_id) DO UPDATE
         SET value_text=EXCLUDED.value_text, value_num=EXCLUDED.value_num, value_json=EXCLUDED.value_json`,
      [responseId, qid, a.text, a.num, a.json ? JSON.stringify(a.json) : null]
    );
  }

  // Denormalise the case-feedback rating and comment so scoring by engineer or customer is
  // one cheap query. The answer rows above remain the record of what was actually asked.
  const rating = staged.find((s) => (s.q.type === 'rating' || s.q.type === 'nps') && s.a)?.a?.num ?? null;
  const comment = staged.find((s) => s.q.type === 'long_text' && s.a)?.a?.text
    ?? staged.find((s) => s.q.type === 'short_text' && s.a)?.a?.text ?? null;
  if (rating !== null) await pool.query('UPDATE questionnaire_responses SET rating=$2 WHERE id=$1', [responseId, Math.round(rating)]);
  if (comment !== null) await pool.query('UPDATE questionnaire_responses SET comment=$2 WHERE id=$1', [responseId, comment]);

  const done = version.questions.filter((q) => q.type !== 'heading' && q.required).every((q) => have.has(q.key))
    && version.questions.some((q) => q.type !== 'heading' && have.has(q.key));
  if (done) {
    await pool.query('UPDATE questionnaire_responses SET completed_at=COALESCE(completed_at, now()) WHERE id=$1', [responseId]);
    await pool.query('UPDATE questionnaire_invites SET completed_at=COALESCE(completed_at, now()) WHERE id=$1', [invite.id]);
  }

  return { responseId, version, invite };
}

// The customer's own tick: may we quote this on the website? Stored separately from the
// answers because it is a permission, not an opinion — and because withdrawing it must be
// able to happen later without touching what they said.
export async function setPublishConsent(responseId: number, consent: boolean): Promise<void> {
  await pool.query(
    `UPDATE questionnaire_responses
        SET publish_consent=$2,
            publish_state = CASE WHEN $2 THEN (CASE WHEN publish_state='none' THEN 'pending' ELSE publish_state END)
                                 ELSE 'none' END
      WHERE id=$1`,
    [responseId, consent]
  );
}

// ── Results ───────────────────────────────────────────────────────────────────

export interface VersionResults {
  version: LoadedVersion;
  invited: number;
  responded: number;
  completed: number;
  responseRate: number;
  questions: QuestionResult[];
  nps: number | null;
  byCustomer: { customerId: number | null; customerName: string; invited: number; responded: number; avgRating: number | null }[];
  outstanding: { email: string | null; fullName: string | null; customerName: string | null; sentAt: Date | null }[];
}

export async function resultsFor(versionId: number, customerId?: number | null): Promise<VersionResults | null> {
  const version = await loadVersion(versionId);
  if (!version) return null;
  const custWhere = customerId ? ' AND customer_id=$2' : '';
  const args: any[] = customerId ? [versionId, customerId] : [versionId];

  const inv = await pool.query(`SELECT COUNT(*)::int n FROM questionnaire_invites WHERE version_id=$1${custWhere}`, args);
  const res = await pool.query(
    `SELECT COUNT(*)::int n, COUNT(completed_at)::int done FROM questionnaire_responses WHERE version_id=$1${custWhere}`, args);

  const ans = await pool.query(
    `SELECT qq.key, a.value_text, a.value_num, a.value_json
       FROM questionnaire_answers a
       JOIN questionnaire_questions qq ON qq.id = a.question_id
       JOIN questionnaire_responses r ON r.id = a.response_id
      WHERE r.version_id=$1${customerId ? ' AND r.customer_id=$2' : ''}
      ORDER BY a.id DESC`, args);

  const byKey = new Map<string, { text: string | null; num: number | null; json: string[] | null }[]>();
  for (const r of ans.rows as any[]) {
    const list = byKey.get(r.key) || [];
    list.push({
      text: r.value_text, num: r.value_num === null ? null : Number(r.value_num),
      json: r.value_json ? (typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json) : null,
    });
    byKey.set(r.key, list);
  }
  const questions = version.questions.map((q) => tallyQuestion(q, byKey.get(q.key) || []));

  const npsQ = version.questions.find((q) => q.type === 'nps');
  const nps = npsQ ? npsScore((byKey.get(npsQ.key) || []).map((r) => r.num).filter((n): n is number => n !== null)) : null;

  const cust = await pool.query(
    `SELECT i.customer_id, COALESCE(i.customer_name,'(no customer)') AS customer_name,
            COUNT(DISTINCT i.id)::int AS invited,
            COUNT(DISTINCT r.id)::int AS responded,
            ROUND(AVG(r.rating)::numeric, 2) AS avg_rating
       FROM questionnaire_invites i
       LEFT JOIN questionnaire_responses r ON r.invite_id = i.id
      WHERE i.version_id=$1
      GROUP BY i.customer_id, i.customer_name
      ORDER BY customer_name ASC`, [versionId]);

  const out = await pool.query(
    `SELECT i.email, i.full_name, i.customer_name, i.sent_at
       FROM questionnaire_invites i
       LEFT JOIN questionnaire_responses r ON r.invite_id = i.id
      WHERE i.version_id=$1 AND r.id IS NULL
      ORDER BY i.customer_name ASC, i.full_name ASC`, [versionId]);

  const invited = inv.rows[0].n, responded = res.rows[0].n;
  return {
    version, invited, responded, completed: res.rows[0].done,
    responseRate: invited ? Math.round((responded / invited) * 1000) / 10 : 0,
    questions, nps,
    byCustomer: cust.rows.map((r: any) => ({
      customerId: r.customer_id, customerName: r.customer_name,
      invited: r.invited, responded: r.responded,
      avgRating: r.avg_rating === null ? null : Number(r.avg_rating),
    })),
    outstanding: out.rows.map((r: any) => ({ email: r.email, fullName: r.full_name, customerName: r.customer_name, sentAt: r.sent_at })),
  };
}

// One row per response, one column per question — the shape a spreadsheet expects.
export async function resultsCsv(versionId: number): Promise<string> {
  const version = await loadVersion(versionId);
  if (!version) return '';
  const cols = version.questions.filter((q) => q.type !== 'heading');
  const { rows } = await pool.query(
    `SELECT r.id, r.submitted_at, r.completed_at, i.customer_name, i.full_name, i.email, r.ticket_id
       FROM questionnaire_responses r LEFT JOIN questionnaire_invites i ON i.id = r.invite_id
      WHERE r.version_id=$1 ORDER BY r.submitted_at ASC`, [versionId]);
  const ans = await pool.query(
    `SELECT a.response_id, qq.key, a.value_text
       FROM questionnaire_answers a JOIN questionnaire_questions qq ON qq.id=a.question_id
       JOIN questionnaire_responses r ON r.id=a.response_id WHERE r.version_id=$1`, [versionId]);
  const byResp = new Map<number, Record<string, string>>();
  for (const a of ans.rows as any[]) {
    const m = byResp.get(a.response_id) || {};
    m[a.key] = a.value_text || '';
    byResp.set(a.response_id, m);
  }
  const q = (s: any) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const head = ['Submitted', 'Completed', 'Customer', 'Name', 'Email', 'Case', ...cols.map((c) => c.label)];
  const lines = [head.map(q).join(',')];
  for (const r of rows as any[]) {
    const m = byResp.get(r.id) || {};
    lines.push([
      r.submitted_at ? new Date(r.submitted_at).toISOString() : '',
      r.completed_at ? new Date(r.completed_at).toISOString() : '',
      r.customer_name || '', r.full_name || '', r.email || '', r.ticket_id || '',
      ...cols.map((c) => m[c.key] || ''),
    ].map(q).join(','));
  }
  return lines.join('\r\n');
}

// ── Sending a questionnaire to one customer's contacts ────────────────────────
// The Mass Mailer's default-domain rule is right for estate-wide marketing and WRONG here:
// it excludes the 18 customers with no default domain, and the Systems Questionnaire has to
// be able to reach every user at whichever customer is being reviewed.
export async function customerAudience(customerId: number): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT cc.id AS contact_id, cc.full_name, lower(cc.email) AS email, cc.job_title,
            c.id AS customer_id, c.name AS customer_name
       FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
      WHERE cc.customer_id=$1 AND cc.archived=false
        AND cc.email IS NOT NULL AND cc.email <> ''
        AND NOT COALESCE(cc.marketing_opt_out,false)
      ORDER BY cc.is_primary DESC, cc.full_name ASC`, [customerId]);
  return rows;
}

// ── Case feedback ─────────────────────────────────────────────────────────────

export const CASE_FEEDBACK_KEY = 'case-feedback';
// Five closures on a busy day must not be five emails at one person.
export const FEEDBACK_MIN_GAP_DAYS = 7;

// The stock two-question spec. Rating is answered by ONE CLICK in the closure email; the
// comment is collected on the thank-you page afterwards, so a rating banks even when
// nobody types anything.
export const CASE_FEEDBACK_SPEC = {
  schema: 'lits.questionnaire/1',
  key: CASE_FEEDBACK_KEY,
  kind: 'case_feedback',
  title: 'How did we do?',
  mode: 'form',
  intro: 'One question about the case we have just closed. It takes a few seconds and it goes straight to the team.',
  thankYou: 'Thank you — that is genuinely useful.',
  questions: [
    { key: 'rating', type: 'rating', scale: 5, label: 'How would you rate the support you received?', required: true },
    { key: 'comment', type: 'long_text', label: 'Anything you would like to add?' },
  ],
};

// Make sure the stock questionnaire exists and return its current version id.
export async function ensureCaseFeedback(): Promise<number> {
  const { rows } = await pool.query('SELECT current_version_id FROM questionnaires WHERE key=$1', [CASE_FEEDBACK_KEY]);
  if (rows.length && rows[0].current_version_id) return rows[0].current_version_id;
  const r = await importSpec(CASE_FEEDBACK_SPEC, null);
  return r.versionId;
}

export interface FeedbackInvite { token: string; inviteId: number; questions: SpecQuestion[]; fresh: boolean; }

// Decide whether this case should ask for feedback, and mint the invite if so.
// Returns null when it should not ask — the caller then sends the ordinary closure email.
//
// Reasons not to ask, in order: no contact to ask, they have muted feedback (a flag of its
// own — muting marketing must NOT mute this, and vice versa), we asked them recently, or
// this case has already been asked about (the unique index on ticket_id, so a re-open and
// re-close is silent).
export async function maybeInviteCaseFeedback(ticketId: number): Promise<FeedbackInvite | null> {
  const t = (await pool.query(
    `SELECT t.id, t.customer_id, t.contact_id, cc.full_name, cc.email, c.name AS customer_name,
            COALESCE(cc.feedback_opt_out,false) AS muted, cc.last_feedback_ask_at
       FROM inbox_tickets t
       LEFT JOIN customer_contacts cc ON cc.id = t.contact_id
       LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.id=$1`, [ticketId])).rows[0];
  if (!t || !t.contact_id || !t.email) return null;
  if (t.muted) return null;

  const already = await pool.query('SELECT id FROM questionnaire_invites WHERE ticket_id=$1', [ticketId]);
  if (already.rows.length) return null;

  if (t.last_feedback_ask_at) {
    const gapMs = Date.now() - new Date(t.last_feedback_ask_at).getTime();
    if (gapMs < FEEDBACK_MIN_GAP_DAYS * 86400_000) return null;
  }

  const versionId = await ensureCaseFeedback();
  const version = await loadVersion(versionId);
  if (!version) return null;

  const inv = await createInvite({
    versionId, ticketId, contactId: t.contact_id, customerId: t.customer_id,
    email: t.email, fullName: t.full_name, customerName: t.customer_name,
  });
  if (!inv.fresh) return null;

  await markInviteSent(inv.id);
  await pool.query('UPDATE customer_contacts SET last_feedback_ask_at=now() WHERE id=$1', [t.contact_id]);
  return { token: inv.token, inviteId: inv.id, questions: version.questions, fresh: true };
}

export async function muteFeedbackForContact(contactId: number): Promise<void> {
  await pool.query('UPDATE customer_contacts SET feedback_opt_out=true, feedback_opt_out_at=now() WHERE id=$1', [contactId]);
}

// ── The Case Feedback screen ──────────────────────────────────────────────────

export interface FeedbackFilters {
  rating?: number | null;
  customerId?: number | null;
  engineerId?: number | null;
  from?: string | null;         // 'YYYY-MM-DD'
  to?: string | null;
  hasComment?: boolean;
  consented?: boolean;
  unactioned?: boolean;
  publishState?: string | null;
}

export async function feedbackRows(f: FeedbackFilters = {}): Promise<any[]> {
  const where: string[] = ['q.kind = $1'];
  const args: any[] = ['case_feedback'];
  const add = (sql: string, v: any) => { args.push(v); where.push(sql.replace('$n', '$' + args.length)); };

  if (f.rating) add('r.rating = $n', f.rating);
  if (f.customerId) add('r.customer_id = $n', f.customerId);
  if (f.engineerId) add('r.assigned_user_id = $n', f.engineerId);
  if (f.from) add("r.submitted_at >= $n::date", f.from);
  if (f.to) add("r.submitted_at < ($n::date + INTERVAL '1 day')", f.to);
  if (f.publishState) add('r.publish_state = $n', f.publishState);
  if (f.hasComment) where.push("COALESCE(r.comment,'') <> ''");
  if (f.consented) where.push('r.publish_consent = true');
  if (f.unactioned) where.push('r.actioned = false');

  const { rows } = await pool.query(
    `SELECT r.*, i.full_name, i.email, i.customer_name, t.ticket_number, t.subject,
            u.display_name AS engineer
       FROM questionnaire_responses r
       JOIN questionnaire_versions v ON v.id = r.version_id
       JOIN questionnaires q ON q.id = v.questionnaire_id
       LEFT JOIN questionnaire_invites i ON i.id = r.invite_id
       LEFT JOIN inbox_tickets t ON t.id = r.ticket_id
       LEFT JOIN users u ON u.id = r.assigned_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.submitted_at DESC
      LIMIT 500`, args);
  return rows;
}

export interface FeedbackScore { id: number | null; name: string; responses: number; average: number | null; low: number; }

async function scoreBy(column: 'assigned_user_id' | 'customer_id', label: string, from?: string | null, to?: string | null): Promise<FeedbackScore[]> {
  const args: any[] = ['case_feedback'];
  const clauses = ['q.kind = $1', 'r.rating IS NOT NULL'];
  if (from) { args.push(from); clauses.push(`r.submitted_at >= $${args.length}::date`); }
  if (to) { args.push(to); clauses.push(`r.submitted_at < ($${args.length}::date + INTERVAL '1 day')`); }
  const { rows } = await pool.query(
    `SELECT r.${column} AS id, COALESCE(${label}, '(unassigned)') AS name,
            COUNT(*)::int AS responses,
            ROUND(AVG(r.rating)::numeric, 2) AS average,
            COUNT(*) FILTER (WHERE r.rating <= 2)::int AS low
       FROM questionnaire_responses r
       JOIN questionnaire_versions v ON v.id = r.version_id
       JOIN questionnaires q ON q.id = v.questionnaire_id
       LEFT JOIN users u ON u.id = r.assigned_user_id
       LEFT JOIN questionnaire_invites i ON i.id = r.invite_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY r.${column}, ${label}
      ORDER BY average DESC NULLS LAST, responses DESC`, args);
  return rows.map((r: any) => ({ id: r.id, name: r.name, responses: r.responses, average: r.average === null ? null : Number(r.average), low: r.low }));
}

export async function feedbackScores(from?: string | null, to?: string | null): Promise<{ byEngineer: FeedbackScore[]; byCustomer: FeedbackScore[] }> {
  return {
    byEngineer: await scoreBy('assigned_user_id', 'u.display_name', from, to),
    byCustomer: await scoreBy('customer_id', 'i.customer_name', from, to),
  };
}

// ── Website testimonials — two gates ──────────────────────────────────────────
// Gate 1 is the customer's own tick (publish_consent). Gate 2 is a human at Lumen pressing
// approve. Neither alone is enough, and a five-star rating is not consent.

export async function approveForWebsite(
  responseId: number, userId: number, attribution: 'full' | 'partial' | 'anonymous', text: string,
): Promise<void> {
  const r = (await pool.query(
    `SELECT r.publish_consent, r.comment, i.full_name, i.customer_name, t.customer_id
       FROM questionnaire_responses r
       LEFT JOIN questionnaire_invites i ON i.id = r.invite_id
       LEFT JOIN inbox_tickets t ON t.id = r.ticket_id
      WHERE r.id=$1`, [responseId])).rows[0];
  if (!r) throw new Error('Feedback not found.');
  // The hard gate. Refusing here rather than in the UI means no future screen, script or
  // bulk action can publish something the customer did not agree to.
  if (!r.publish_consent) throw new Error('That customer has not agreed to their comment being used on the website.');

  const name = attribution === 'full'
    ? [r.full_name, r.customer_name].filter(Boolean).join(', ')
    : attribution === 'partial'
      ? [(r.full_name ? 'A customer' : null), r.customer_name].filter(Boolean).join(', ') || 'A Lumen customer'
      : 'A Lumen customer';

  await pool.query(
    `UPDATE questionnaire_responses
        SET publish_state='approved', publish_name=$2, publish_text=$3, published_at=now(), approved_by=$4
      WHERE id=$1`,
    [responseId, name, (text || r.comment || '').trim(), userId]
  );
}

// Withdrawal must be able to happen at any time, and must drop the quote from the feed on
// the website's next build. The published text is KEPT so there is a record of what went out.
export async function withdrawFromWebsite(responseId: number): Promise<void> {
  await pool.query("UPDATE questionnaire_responses SET publish_state='withdrawn' WHERE id=$1", [responseId]);
}

export async function setActioned(responseId: number, userId: number, actioned: boolean): Promise<void> {
  await pool.query(
    `UPDATE questionnaire_responses SET actioned=$2, actioned_by=$3, actioned_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1`,
    [responseId, actioned, userId]);
}

// What the website is allowed to bake in. BOTH gates in the WHERE clause, deliberately —
// the endpoint is the last line of defence and it does not trust its callers.
export async function publishedTestimonials(limit = 24): Promise<{ quote: string; name: string; rating: number | null; date: string }[]> {
  const { rows } = await pool.query(
    `SELECT r.publish_text, r.publish_name, r.rating, r.published_at
       FROM questionnaire_responses r
      WHERE r.publish_state='approved' AND r.publish_consent=true
        AND COALESCE(r.publish_text,'') <> ''
      ORDER BY r.published_at DESC
      LIMIT $1`, [limit]);
  return rows.map((r: any) => ({
    quote: r.publish_text,
    name: r.publish_name || 'A Lumen customer',
    rating: r.rating === null ? null : Number(r.rating),
    date: r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '',
  }));
}

export { answerOptions };
