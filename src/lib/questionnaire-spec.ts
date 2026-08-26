// ── Questionnaire spec — the `lits.questionnaire/1` authoring format ──────────
//
// A questionnaire is AUTHORED as JSON off-portal (Claude writes it, Terry pastes it in)
// and IMPORTED here. This file is the whole of the contract: parse, validate, normalise.
//
// It is deliberately pure — no database, no express, no config. Everything the importer
// can get wrong is decided here, which is what makes it testable by assertion rather than
// by clicking through the UI. See src/scripts/test-questionnaires.ts.
//
// The JSON is the AUTHORING format, not the storage format. Once this file has blessed a
// spec, lib/questionnaires.ts materialises it into question ROWS, and answers are stored
// one row per answer. Reporting is then plain SQL. A spec kept as a blob and dug through
// at read time can never answer "average rating by customer" — that was the whole reason
// the diary materialises recurrence rather than storing a rule.

export const SPEC_SCHEMA = 'lits.questionnaire/1';

export const QUESTION_TYPES = [
  'single',      // one option from a list
  'multi',       // any number of options
  'rating',      // 1..scale, scale defaults to 5
  'nps',         // 0..10, fixed
  'yes_no',      // stored as 1 / 0 so it averages like a rating
  'short_text',
  'long_text',
  'heading',     // not a question: a section break on the form
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

// The types a ONE-CLICK poll can carry. A poll's options are links in the email body, so
// anything needing a keyboard is a form, not a poll.
export const POLL_TYPES: QuestionType[] = ['single', 'rating', 'nps', 'yes_no'];

// Types that are answered by picking, and therefore have a fixed set of option values.
export const CHOICE_TYPES: QuestionType[] = ['single', 'multi', 'rating', 'nps', 'yes_no'];

export const MAX_QUESTIONS = 60;
export const MAX_OPTIONS = 20;
export const RATING_MIN_SCALE = 2;
export const RATING_MAX_SCALE = 10;

export interface SpecOption { value: string; label: string; }

export interface SpecQuestion {
  key: string;
  type: QuestionType;
  label: string;
  helpText: string | null;
  required: boolean;
  scale: number | null;          // rating only
  options: SpecOption[] | null;  // single / multi only
  allowOther: boolean;
}

export interface ParsedSpec {
  key: string;
  title: string;
  intro: string | null;
  mode: 'form' | 'poll';
  thankYou: string | null;
  closesAt: string | null;       // 'YYYY-MM-DD', or null
  kind: string;                  // general | case_feedback | systems
  questions: SpecQuestion[];
  raw: unknown;                  // the original JSON, kept verbatim for re-export
}

export class SpecError extends Error {
  readonly where: string;
  constructor(where: string, message: string) {
    // The importer shows this string to Terry and nobody else, so it says what to fix
    // rather than what failed: "questions[2].options — a single-choice question needs
    // at least two options" beats "invalid options".
    super(where ? `${where} — ${message}` : message);
    this.where = where;
    this.name = 'SpecError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Slugs are the join between the JSON and the database, and they end up in URLs, so they
// are kept boring: lowercase, digits, hyphens.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function optional(where: string, v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new SpecError(where, 'must be text');
  const s = v.trim();
  if (!s) return null;
  if (s.length > max) throw new SpecError(where, `is too long (max ${max} characters)`);
  return s;
}

// Accepts 'YYYY-MM-DD' or a full ISO timestamp; returns the day key. Deliberately a STRING
// all the way through — node-pg hands `date` columns back as JS Dates and every string
// comparison against one silently inverts (the OneBoard day-key incident, and why
// tickets.chase_by is TEXT).
function parseCloses(where: string, v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new SpecError(where, "must be a date like '2026-09-30'");
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new SpecError(where, "must be a date like '2026-09-30'");
  const [, y, mo, d] = m;
  const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.getUTCMonth() + 1 !== Number(mo) || probe.getUTCDate() !== Number(d)) {
    throw new SpecError(where, `is not a real date (${y}-${mo}-${d})`);
  }
  return `${y}-${mo}-${d}`;
}

function parseOptions(where: string, v: unknown): SpecOption[] {
  if (!Array.isArray(v) || v.length === 0) throw new SpecError(where, 'needs a list of options');
  if (v.length > MAX_OPTIONS) throw new SpecError(where, `has too many options (max ${MAX_OPTIONS})`);
  const out: SpecOption[] = [];
  const seen = new Set<string>();
  v.forEach((o, i) => {
    let value: string, label: string;
    if (typeof o === 'string') { label = o.trim(); value = label; }
    else if (isObj(o)) {
      label = str(o.label) || str(o.value);
      value = str(o.value) || label;
    } else throw new SpecError(`${where}[${i}]`, 'must be a string or {value,label}');
    if (!label) throw new SpecError(`${where}[${i}]`, 'has no label');
    if (label.length > 200) throw new SpecError(`${where}[${i}]`, 'label is too long (max 200 characters)');
    const k = value.toLowerCase();
    if (seen.has(k)) throw new SpecError(`${where}[${i}]`, `repeats the option "${value}"`);
    seen.add(k);
    out.push({ value, label });
  });
  return out;
}

// Rating and NPS carry generated options so a POLL can render them as links and the
// results panel can count them without special-casing every type.
export function generatedOptions(q: { type: QuestionType; scale: number | null }): SpecOption[] | null {
  if (q.type === 'rating') {
    const n = q.scale || 5;
    return Array.from({ length: n }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
  }
  if (q.type === 'nps') return Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: String(i) }));
  if (q.type === 'yes_no') return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  return null;
}

// Every option a question can be answered with — authored for single/multi, generated for
// the scales. Used by the poll renderer and by the results aggregation.
export function answerOptions(q: Pick<SpecQuestion, 'type' | 'scale' | 'options'>): SpecOption[] {
  if (q.type === 'single' || q.type === 'multi') return q.options || [];
  return generatedOptions({ type: q.type, scale: q.scale }) || [];
}

function parseQuestion(where: string, v: unknown, index: number): SpecQuestion {
  if (!isObj(v)) throw new SpecError(where, 'must be an object');
  const type = (str(v.type) || 'short_text') as QuestionType;
  if (!QUESTION_TYPES.includes(type)) {
    throw new SpecError(`${where}.type`, `"${type}" is not a question type. Use one of: ${QUESTION_TYPES.join(', ')}`);
  }
  const label = str(v.label) || str(v.text) || str(v.question);
  if (!label) throw new SpecError(`${where}.label`, 'is required');
  if (label.length > 500) throw new SpecError(`${where}.label`, 'is too long (max 500 characters)');

  const key = str(v.key) || `q${index + 1}`;
  if (!SLUG.test(key)) {
    throw new SpecError(`${where}.key`, `"${key}" must be lowercase letters, numbers and hyphens`);
  }

  let scale: number | null = null;
  if (type === 'rating') {
    const raw = v.scale === undefined || v.scale === null ? 5 : v.scale;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n < RATING_MIN_SCALE || n > RATING_MAX_SCALE) {
      throw new SpecError(`${where}.scale`, `must be a whole number between ${RATING_MIN_SCALE} and ${RATING_MAX_SCALE}`);
    }
    scale = n;
  } else if (v.scale !== undefined && v.scale !== null) {
    throw new SpecError(`${where}.scale`, `only applies to a rating question, not ${type}`);
  }

  let options: SpecOption[] | null = null;
  if (type === 'single' || type === 'multi') {
    options = parseOptions(`${where}.options`, v.options);
    if (options.length < 2) throw new SpecError(`${where}.options`, 'needs at least two options');
  } else if (v.options !== undefined && v.options !== null) {
    throw new SpecError(`${where}.options`, `only applies to single- and multi-choice questions, not ${type}`);
  }

  const allowOther = v.other === true || v.allowOther === true;
  if (allowOther && !(type === 'single' || type === 'multi')) {
    throw new SpecError(`${where}.other`, `only applies to single- and multi-choice questions, not ${type}`);
  }

  // A heading is a label on the page, so "required" would mean nothing.
  const required = type === 'heading' ? false : v.required === true;

  return {
    key, type, label,
    helpText: optional(`${where}.help`, v.help ?? v.helpText, 500),
    required, scale, options, allowOther,
  };
}

// Parse and validate a spec. Throws SpecError with a message written for the person
// pasting the JSON in. `raw` comes back untouched so the original can be stored and
// handed back out again unchanged.
export function parseSpec(input: unknown): ParsedSpec {
  let doc = input;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); }
    catch (e: any) { throw new SpecError('', `that is not valid JSON (${e.message})`); }
  }
  if (!isObj(doc)) throw new SpecError('', 'the file must be a JSON object');

  const schema = str(doc.schema);
  if (!schema) throw new SpecError('schema', `is missing — the first line should be "schema": "${SPEC_SCHEMA}"`);
  if (schema !== SPEC_SCHEMA) throw new SpecError('schema', `is "${schema}"; this Portal reads "${SPEC_SCHEMA}"`);

  const key = str(doc.key);
  if (!key) throw new SpecError('key', "is required — a short slug like \"systems-review-2026\"");
  if (!SLUG.test(key)) throw new SpecError('key', `"${key}" must be lowercase letters, numbers and hyphens`);

  const title = str(doc.title);
  if (!title) throw new SpecError('title', 'is required');
  if (title.length > 200) throw new SpecError('title', 'is too long (max 200 characters)');

  const modeRaw = str(doc.mode) || 'form';
  if (modeRaw !== 'form' && modeRaw !== 'poll') throw new SpecError('mode', `must be "form" or "poll", not "${modeRaw}"`);
  const mode = modeRaw as 'form' | 'poll';

  const kind = str(doc.kind) || 'general';
  if (!SLUG.test(kind)) throw new SpecError('kind', `"${kind}" must be lowercase letters, numbers and hyphens`);

  const qsRaw = doc.questions;
  if (!Array.isArray(qsRaw) || qsRaw.length === 0) throw new SpecError('questions', 'needs at least one question');
  if (qsRaw.length > MAX_QUESTIONS) throw new SpecError('questions', `has too many questions (max ${MAX_QUESTIONS})`);

  const questions = qsRaw.map((q, i) => parseQuestion(`questions[${i}]`, q, i));

  const seen = new Set<string>();
  questions.forEach((q, i) => {
    if (seen.has(q.key)) throw new SpecError(`questions[${i}].key`, `"${q.key}" is used twice — every question needs its own key`);
    seen.add(q.key);
  });

  const answerable = questions.filter((q) => q.type !== 'heading');
  if (!answerable.length) throw new SpecError('questions', 'are all headings — there is nothing to answer');

  // A poll is one click in an email. Two questions is a form, however short.
  if (mode === 'poll') {
    if (questions.length !== 1) {
      throw new SpecError('questions', `a poll asks exactly one question (this one has ${questions.length}). Use "mode": "form" for more.`);
    }
    if (!POLL_TYPES.includes(answerable[0].type)) {
      throw new SpecError('questions[0].type',
        `a poll is answered by clicking a link, so it must be one of: ${POLL_TYPES.join(', ')}. "${answerable[0].type}" needs a form.`);
    }
  }

  return {
    key, title, mode, kind, questions,
    intro: optional('intro', doc.intro, 2000),
    thankYou: optional('thankYou', doc.thankYou ?? doc.thank_you, 1000),
    closesAt: parseCloses('closesAt', doc.closesAt ?? doc.closes_at),
    raw: doc,
  };
}

// ── Answers ───────────────────────────────────────────────────────────────────
// One shape in, one row out. `text` is what gets shown, `num` is what gets averaged,
// `json` carries a multi-select. Returning all three keeps the answer table honest:
// a rating is a number AND its label, never a number pretending to be a string.
export interface CoercedAnswer { text: string | null; num: number | null; json: string[] | null; }

export class AnswerError extends Error {}

// Coerce a submitted value against its question. Throws AnswerError with a message a
// CUSTOMER will read, so it never mentions keys, types or the database.
export function coerceAnswer(q: SpecQuestion, raw: unknown): CoercedAnswer | null {
  const empty: CoercedAnswer = { text: null, num: null, json: null };

  if (q.type === 'heading') return null;

  const blank = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())
    || (Array.isArray(raw) && raw.length === 0);
  if (blank) {
    if (q.required) throw new AnswerError(`Please answer: ${q.label}`);
    return null;
  }

  if (q.type === 'short_text' || q.type === 'long_text') {
    const s = String(raw).trim();
    const max = q.type === 'short_text' ? 500 : 5000;
    return { ...empty, text: s.slice(0, max) };
  }

  if (q.type === 'multi') {
    const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).trim()).filter(Boolean);
    const valid = new Set((q.options || []).map((o) => o.value.toLowerCase()));
    const chosen: string[] = [];
    for (const v of list) {
      if (valid.has(v.toLowerCase())) {
        const opt = (q.options || []).find((o) => o.value.toLowerCase() === v.toLowerCase())!;
        if (!chosen.includes(opt.value)) chosen.push(opt.value);
      } else if (q.allowOther) {
        const other = v.slice(0, 200);
        if (!chosen.includes(other)) chosen.push(other);
      } else {
        throw new AnswerError(`"${v.slice(0, 60)}" is not one of the choices for: ${q.label}`);
      }
    }
    if (!chosen.length) {
      if (q.required) throw new AnswerError(`Please answer: ${q.label}`);
      return null;
    }
    return { text: chosen.join(', '), num: null, json: chosen };
  }

  // Everything left is a single pick.
  const v = String(raw).trim();
  const opts = answerOptions(q);
  const hit = opts.find((o) => o.value.toLowerCase() === v.toLowerCase());
  if (!hit) {
    if (q.type === 'single' && q.allowOther) return { ...empty, text: v.slice(0, 200) };
    throw new AnswerError(`"${v.slice(0, 60)}" is not one of the choices for: ${q.label}`);
  }
  if (q.type === 'rating' || q.type === 'nps') return { text: hit.label, num: Number(hit.value), json: null };
  if (q.type === 'yes_no') return { text: hit.label, num: hit.value === 'yes' ? 1 : 0, json: null };
  return { ...empty, text: hit.value };
}

// ── Results ───────────────────────────────────────────────────────────────────
export interface OptionTally { value: string; label: string; count: number; pct: number; }
export interface QuestionResult {
  key: string; type: QuestionType; label: string;
  answered: number;
  tally: OptionTally[];        // choice questions
  average: number | null;      // rating / nps / yes_no
  texts: string[];             // free text, newest first (capped by the caller)
}

// Turn raw answer rows into something a page can render. Kept pure so the numbers can be
// asserted rather than eyeballed on a chart.
export function tallyQuestion(
  q: SpecQuestion,
  rows: { text: string | null; num: number | null; json: string[] | null }[],
): QuestionResult {
  const base: QuestionResult = { key: q.key, type: q.type, label: q.label, answered: 0, tally: [], average: null, texts: [] };
  if (q.type === 'heading') return base;

  if (q.type === 'short_text' || q.type === 'long_text') {
    base.texts = rows.map((r) => (r.text || '').trim()).filter(Boolean);
    base.answered = base.texts.length;
    return base;
  }

  const opts = answerOptions(q);
  const counts = new Map<string, number>();
  opts.forEach((o) => counts.set(o.value, 0));
  const extras: string[] = [];   // "other" answers, which have no option row

  let answered = 0, sum = 0, sumN = 0;
  for (const r of rows) {
    const picks = r.json && r.json.length ? r.json : (r.text ? [r.text] : []);
    if (!picks.length && r.num === null) continue;
    answered++;
    if (r.num !== null) { sum += r.num; sumN++; }
    for (const p of picks) {
      // A rating stores its LABEL as text ("4"), which is also its value.
      const hit = opts.find((o) => o.value === p || o.label === p);
      const k = hit ? hit.value : p;
      if (!hit && !extras.includes(p)) extras.push(p);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  const order = [...opts.map((o) => o.value), ...extras];
  base.answered = answered;
  base.tally = order.map((value) => {
    const label = opts.find((o) => o.value === value)?.label ?? value;
    const count = counts.get(value) || 0;
    return { value, label, count, pct: answered ? Math.round((count / answered) * 1000) / 10 : 0 };
  });
  base.average = sumN ? Math.round((sum / sumN) * 100) / 100 : null;
  return base;
}

// NPS is not an average — it is promoters minus detractors, as a whole-number percentage.
// Reporting it as "mean 7.8" is the classic way to make a bad score look fine.
export function npsScore(nums: number[]): number | null {
  if (!nums.length) return null;
  const promoters = nums.filter((n) => n >= 9).length;
  const detractors = nums.filter((n) => n <= 6).length;
  return Math.round(((promoters - detractors) / nums.length) * 100);
}
