/**
 * Questionnaire spec suite — the JSON contract and the arithmetic behind the results.
 *
 * Everything under test is pure, so this suite needs no database and no .env. Run with:
 *   npx tsx src/scripts/test-questionnaires.ts     (or: npm run build && node dist/scripts/test-questionnaires.js)
 *
 * What it is guarding, and why each one is here rather than left to a click-through:
 *
 *   P1–P12   parsing and REFUSING a bad spec. The importer's whole job is to say no with a
 *            sentence Terry can act on; a spec that imports and then behaves oddly is worse
 *            than one that never imports.
 *   F1–F6    the freeze rules a poll must obey — a poll is one click in an email, so a
 *            two-question "poll" or a free-text one has to be caught at import, not when
 *            299 people get an unanswerable message.
 *   A1–A14   answer coercion. This is the layer that decides what lands in the database,
 *            and it is the one that is wrong quietly: a rating stored as the string "4"
 *            averages to NaN and the screen still renders.
 *   T1–T10   the tally. Percentages over the wrong denominator look perfectly plausible.
 *   N1–N4    NPS, which is NOT a mean — reporting it as one is the classic way to make a
 *            bad score read as fine.
 */
import {
  parseSpec, coerceAnswer, tallyQuestion, npsScore, answerOptions, generatedOptions,
  SpecError, AnswerError, SPEC_SCHEMA, MAX_QUESTIONS,
  type SpecQuestion,
} from '../lib/questionnaire-spec';
import { CASE_FEEDBACK_SPEC } from '../lib/questionnaires';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
// Asserts that a spec is REFUSED, and that the refusal names the right place.
function refuses(name: string, doc: any, wherePart: string): void {
  try { parseSpec(doc); check(name, false, 'it was accepted'); }
  catch (e: any) {
    const ok = e instanceof SpecError && (e.where + ' ' + e.message).toLowerCase().includes(wherePart.toLowerCase());
    check(name, ok, ok ? '' : `wrong error: ${e.message}`);
  }
}
const q = (over: Partial<SpecQuestion> = {}): SpecQuestion => ({
  key: 'k', type: 'short_text', label: 'L', helpText: null, required: false, scale: null, options: null, allowOther: false, ...over,
});
const base = (over: any = {}) => ({
  schema: SPEC_SCHEMA, key: 'demo', title: 'Demo',
  questions: [{ key: 'a', type: 'short_text', label: 'A' }], ...over,
});

console.log('\n── P: parsing, and refusing what should be refused ───────────────────');
{
  const s = parseSpec(base());
  check('P1 a minimal spec parses', s.key === 'demo' && s.questions.length === 1);
  check('P2 mode defaults to form', s.mode === 'form');
  check('P3 kind defaults to general', s.kind === 'general');
  check('P4 the original JSON is kept verbatim for re-export', JSON.stringify((s.raw as any).key) === '"demo"');

  refuses('P5 a missing schema line is named', { key: 'a', title: 'T', questions: [] }, 'schema');
  refuses('P6 a schema from another tool is refused by name', base({ schema: 'typeform/2' }), 'schema');
  refuses('P7 a key with spaces is refused', base({ key: 'my questionnaire' }), 'key');
  refuses('P8 a missing title is refused', { schema: SPEC_SCHEMA, key: 'k', questions: [{ type: 'short_text', label: 'A' }] }, 'title');
  refuses('P9 no questions at all is refused', base({ questions: [] }), 'questions');
  refuses('P10 two questions sharing a key is refused', base({ questions: [
    { key: 'a', type: 'short_text', label: 'A' }, { key: 'a', type: 'short_text', label: 'B' }] }), 'used twice');
  refuses('P11 a spec of nothing but headings has nothing to answer', base({ questions: [{ type: 'heading', label: 'Section' }] }), 'heading');
  refuses('P12 an absurd number of questions is refused',
    base({ questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ key: 'q' + i, type: 'short_text', label: 'x' })) }), 'too many');

  // Bad JSON reaches this function as a string, because that is what a paste box hands over.
  try { parseSpec('{ not json'); check('P13 a paste that is not JSON says so', false, 'accepted'); }
  catch (e: any) { check('P13 a paste that is not JSON says so', /not valid JSON/i.test(e.message), e.message); }
}

console.log('\n── Q: per-question rules ────────────────────────────────────────────');
{
  refuses('Q1 an unknown type lists the types that do exist', base({ questions: [{ key: 'a', type: 'slider', label: 'A' }] }), 'not a question type');
  refuses('Q2 a single-choice question with one option is refused',
    base({ questions: [{ key: 'a', type: 'single', label: 'A', options: ['only'] }] }), 'at least two');
  refuses('Q3 options on a rating question are refused rather than ignored',
    base({ questions: [{ key: 'a', type: 'rating', label: 'A', options: ['1', '2'] }] }), 'only applies');
  refuses('Q4 a scale on a text question is refused rather than ignored',
    base({ questions: [{ key: 'a', type: 'short_text', label: 'A', scale: 5 }] }), 'only applies');
  refuses('Q5 a scale of 1 is refused (a one-point scale is not a question)',
    base({ questions: [{ key: 'a', type: 'rating', label: 'A', scale: 1 }] }), 'between');
  refuses('Q6 a repeated option value is refused', base({ questions: [
    { key: 'a', type: 'single', label: 'A', options: ['Yes', 'yes'] }] }), 'repeats');
  refuses('Q7 "other" on a rating is refused', base({ questions: [
    { key: 'a', type: 'rating', label: 'A', other: true }] }), 'only applies');

  const s = parseSpec(base({ questions: [{ key: 'a', type: 'rating', label: 'A' }] }));
  check('Q8 a rating with no scale defaults to 5', s.questions[0].scale === 5);

  const t = parseSpec(base({ questions: [{ type: 'short_text', label: 'A' }, { type: 'short_text', label: 'B' }] }));
  check('Q9 questions with no key get a stable positional one', t.questions[0].key === 'q1' && t.questions[1].key === 'q2');

  const o = parseSpec(base({ questions: [{ key: 'a', type: 'single', label: 'A', options: [{ value: 'y', label: 'Yes please' }, 'No'] }] }));
  check('Q10 options accept both {value,label} and a bare string',
    o.questions[0].options![0].value === 'y' && o.questions[0].options![1].value === 'No');

  const h = parseSpec(base({ questions: [{ type: 'heading', label: 'S', required: true }, { key: 'a', type: 'short_text', label: 'A' }] }));
  check('Q11 a heading can never be required (there is nothing to require)', h.questions[0].required === false);
}

console.log('\n── S: the specs we ship ─────────────────────────────────────────────');
{
  // This section exists because the first version of the slug rule rejected underscores,
  // which meant the built-in case-feedback questionnaire could never import and the whole
  // feature was dead on arrival. Anything the Portal ships must parse in its own tests.
  let ok = true, why = '';
  try { parseSpec(CASE_FEEDBACK_SPEC); } catch (e: any) { ok = false; why = e.message; }
  check('S1 the built-in case-feedback spec imports', ok, why);
  check('S2 an underscore is allowed in a kind', parseSpec(base({ kind: 'case_feedback' })).kind === 'case_feedback');
  check('S3 …and in a question key', parseSpec(base({ questions: [{ key: 'job_title', type: 'short_text', label: 'A' }] })).questions[0].key === 'job_title');
  check('S4 …and in the questionnaire key', parseSpec(base({ key: 'systems_review' })).key === 'systems_review');
  refuses('S5 a space is still refused', base({ key: 'systems review' }), 'key');
  refuses('S6 …and so is a capital letter', base({ key: 'Systems' }), 'key');
}

console.log('\n── D: closing dates stay strings ────────────────────────────────────');
{
  const s = parseSpec(base({ closesAt: '2026-09-30' }));
  check('D1 a day key comes back as the same STRING, never a Date',
    s.closesAt === '2026-09-30' && typeof s.closesAt === 'string');
  const iso = parseSpec(base({ closesAt: '2026-09-30T17:00:00Z' }));
  check('D2 a full timestamp is reduced to its day key', iso.closesAt === '2026-09-30');
  refuses('D3 the 31st of September is refused rather than rolled into October', base({ closesAt: '2026-09-31' }), 'not a real date');
  refuses('D4 a British-format date is refused, not silently misread', base({ closesAt: '30/09/2026' }), 'date like');
  check('D5 no closing date is allowed', parseSpec(base()).closesAt === null);
}

console.log('\n── F: what a one-click poll is allowed to be ────────────────────────');
{
  const p = parseSpec(base({ mode: 'poll', questions: [{ key: 'r', type: 'rating', label: 'How was it?' }] }));
  check('F1 a single rating is a valid poll', p.mode === 'poll');
  refuses('F2 two questions is not a poll, and the message says so',
    base({ mode: 'poll', questions: [{ key: 'a', type: 'rating', label: 'A' }, { key: 'b', type: 'rating', label: 'B' }] }), 'exactly one question');
  refuses('F3 free text cannot be a poll — you cannot type into an email link',
    base({ mode: 'poll', questions: [{ key: 'a', type: 'long_text', label: 'A' }] }), 'needs a form');
  refuses('F4 multi-select cannot be a poll (one click means one answer)',
    base({ mode: 'poll', questions: [{ key: 'a', type: 'multi', label: 'A', options: ['x', 'y'] }] }), 'needs a form');
  refuses('F5 an unknown mode is refused', base({ mode: 'survey' }), 'must be');
  const yn = parseSpec(base({ mode: 'poll', questions: [{ key: 'a', type: 'yes_no', label: 'A' }] }));
  check('F6 yes/no is a valid poll', yn.questions[0].type === 'yes_no');
}

console.log('\n── G: generated option sets ─────────────────────────────────────────');
{
  check('G1 a 5-point rating generates 1..5', JSON.stringify(generatedOptions({ type: 'rating', scale: 5 })!.map((o) => o.value)) === '["1","2","3","4","5"]');
  check('G2 NPS is 0..10 — eleven points, not ten', generatedOptions({ type: 'nps', scale: null })!.length === 11);
  check('G3 …and starts at zero', generatedOptions({ type: 'nps', scale: null })![0].value === '0');
  check('G4 yes/no generates two', answerOptions(q({ type: 'yes_no' })).length === 2);
  check('G5 free text has no options at all', answerOptions(q({ type: 'long_text' })).length === 0);
}

console.log('\n── A: coercing what a customer sent ─────────────────────────────────');
{
  const rating = q({ key: 'r', type: 'rating', scale: 5 });
  const a = coerceAnswer(rating, '4')!;
  check('A1 a rating is stored as a NUMBER, not the string that arrived', a.num === 4 && typeof a.num === 'number');
  check('A2 …and keeps its label for display', a.text === '4');
  try { coerceAnswer(rating, '9'); check('A3 a rating outside the scale is rejected', false, 'accepted'); }
  catch (e: any) { check('A3 a rating outside the scale is rejected', e instanceof AnswerError); }
  try { coerceAnswer(rating, 'drop table'); check('A4 junk in a scale field is rejected', false, 'accepted'); }
  catch (e: any) { check('A4 junk in a scale field is rejected', e instanceof AnswerError); }

  const yn = q({ type: 'yes_no' });
  check('A5 yes becomes 1 so it averages like a rating', coerceAnswer(yn, 'yes')!.num === 1);
  check('A6 no becomes 0, not null — null would drop it from the mean', coerceAnswer(yn, 'no')!.num === 0);

  const single = q({ type: 'single', options: [{ value: 'a', label: 'Office' }, { value: 'b', label: 'Home' }] });
  check('A7 a choice is matched case-insensitively', coerceAnswer(single, 'A')!.text === 'a');
  try { coerceAnswer(single, 'Mars'); check('A8 a value that is not on the list is rejected', false, 'accepted'); }
  catch (e: any) { check('A8 a value that is not on the list is rejected', e instanceof AnswerError); }

  const other = q({ type: 'single', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], allowOther: true });
  check('A9 …unless the question allows "other"', coerceAnswer(other, 'Something else')!.text === 'Something else');

  const multi = q({ type: 'multi', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] });
  const m = coerceAnswer(multi, ['x', 'y'])!;
  check('A10 a multi-select is stored as an ARRAY, so each pick can be counted', JSON.stringify(m.json) === '["x","y"]');
  check('A11 …with a readable copy alongside it', m.text === 'x, y');
  check('A12 a repeated pick is counted once', JSON.stringify(coerceAnswer(multi, ['x', 'x'])!.json) === '["x"]');
  check('A13 a single value for a multi question still works', JSON.stringify(coerceAnswer(multi, 'y')!.json) === '["y"]');

  check('A14 a blank optional answer is nothing, not an empty string',
    coerceAnswer(q({ type: 'short_text' }), '   ') === null);
  try { coerceAnswer(q({ type: 'short_text', required: true, label: 'Your name' }), ''); check('A15 a blank REQUIRED answer is refused by label', false, 'accepted'); }
  catch (e: any) { check('A15 a blank REQUIRED answer is refused by label', /Your name/.test(e.message), e.message); }
  check('A16 a heading is never an answer', coerceAnswer(q({ type: 'heading' }), 'x') === null);
  check('A17 long text is capped rather than refused', (coerceAnswer(q({ type: 'long_text' }), 'x'.repeat(9000))!.text || '').length === 5000);
}

console.log('\n── T: the tally, and its denominator ────────────────────────────────');
{
  const rating = q({ key: 'r', type: 'rating', scale: 5 });
  const r = tallyQuestion(rating, [
    { text: '5', num: 5, json: null }, { text: '5', num: 5, json: null },
    { text: '3', num: 3, json: null }, { text: '1', num: 1, json: null },
  ]);
  check('T1 every point on the scale is listed, including the unused ones', r.tally.length === 5);
  check('T2 counts land on the right points', r.tally[4].count === 2 && r.tally[2].count === 1 && r.tally[0].count === 1);
  check('T3 an unused point reads 0, not missing', r.tally[1].count === 0);
  check('T4 the average is over the answers, not the scale', r.average === 3.5, String(r.average));
  check('T5 percentages are over who answered', r.tally[4].pct === 50, String(r.tally[4].pct));
  check('T6 answered counts responses, not picks', r.answered === 4);

  // A multi-select's picks OUTNUMBER its responses. Dividing by picks would quietly turn
  // "three of four people said Email" into a smaller, wronger number.
  const multi = q({ key: 'm', type: 'multi', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] });
  const mr = tallyQuestion(multi, [
    { text: 'x, y', num: null, json: ['x', 'y'] },
    { text: 'x', num: null, json: ['x'] },
  ]);
  check('T7 a multi-select counts every pick', mr.tally[0].count === 2 && mr.tally[1].count === 1);
  check('T8 …but the denominator stays the number of PEOPLE', mr.answered === 2 && mr.tally[0].pct === 100, String(mr.tally[0].pct));

  const other = q({ key: 'm', type: 'multi', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], allowOther: true });
  const or = tallyQuestion(other, [{ text: 'Printing', num: null, json: ['Printing'] }]);
  check('T9 an "other" answer gets its own row rather than being dropped',
    or.tally.length === 3 && or.tally[2].label === 'Printing');

  const txt = tallyQuestion(q({ key: 't', type: 'long_text' }), [
    { text: 'It is slow', num: null, json: null }, { text: '   ', num: null, json: null },
  ]);
  check('T10 free text collects the words and ignores the blanks', txt.texts.length === 1 && txt.answered === 1);

  const none = tallyQuestion(rating, []);
  check('T11 no answers gives 0%, never a division by zero', none.average === null && none.tally[0].pct === 0);
  check('T12 a heading tallies to nothing', tallyQuestion(q({ type: 'heading' }), []).answered === 0);
}

console.log('\n── N: NPS is not an average ─────────────────────────────────────────');
{
  check('N1 all promoters is +100', npsScore([9, 10, 10]) === 100);
  check('N2 all detractors is -100', npsScore([0, 3, 6]) === -100);
  check('N3 sevens and eights count for neither side', npsScore([7, 8, 7, 8]) === 0);
  // The case that catches a mean pretending to be NPS: mean 7.6 reads "fine", NPS is 0.
  check('N4 a comfortable-looking mean can still be an NPS of zero', npsScore([9, 9, 6, 6, 8]) === 0, String(npsScore([9, 9, 6, 6, 8])));
  check('N5 nothing to score is null, not zero', npsScore([]) === null);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
