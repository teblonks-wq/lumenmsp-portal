/**
 * Questionnaire DB suite — the invariants that only exist in Postgres.
 *
 * STATUS: written and RUN GREEN 2026-08-26 against a throwaway Postgres 16 (timezone=UTC).
 * It caught a real one on its first run: the slug rule rejected underscores, so the built-in
 * `case_feedback` questionnaire could never import and the whole feature was dead on arrival.
 *
 * It refuses to touch the live database. Point it at a THROWAWAY one:
 *
 *   QTEST_DATABASE_URL=postgres://user:pass@localhost:5432/qtest npx tsx src/scripts/test-questionnaires-db.ts
 *
 * The throwaway server MUST run `timezone=UTC` — a Europe/London test server makes every
 * closes_at assertion read an hour out and the failures look like logic bugs.
 *
 * Create the tables first with:  DATABASE_URL=$QTEST_DATABASE_URL npx prisma db push
 *
 * What it guards, none of which the pure suite can see:
 *   V1–V4  a version is FROZEN — re-importing bumps the version and leaves the old
 *          questions and their answers exactly as they were.
 *   I1–I5  one invite per case, forever. A re-open and re-close must be silent.
 *   R1–R5  one response per token, and a later comment ADDS to it rather than wiping the
 *          rating that arrived with the first click.
 *   C1–C4  the two website gates. This is the one that matters most: no consent, no
 *          publication, whoever asks and however they ask.
 *   E1–E7  the case-feedback rules: asked once per case, never when muted, never twice in
 *          a week, and a re-close stays silent.
 *   X1–X2  test invites are excluded from every count.
 */
import { Client } from 'pg';

const URL = process.env.QTEST_DATABASE_URL || '';
if (!URL) {
  console.error('\nRefusing to run: set QTEST_DATABASE_URL to a THROWAWAY database.');
  console.error('This suite writes and deletes rows; it must never be pointed at the live Portal.\n');
  process.exit(2);
}
// Belt and braces: the live database is called `portal`. Refuse it by name as well.
if (/\/portal(\?|$)/.test(URL)) {
  console.error('\nRefusing to run against a database called "portal".\n');
  process.exit(2);
}
process.env.DATABASE_URL = URL;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: URL });
  await db.connect();

  const tz = (await db.query('SHOW timezone')).rows[0].TimeZone || (await db.query('SHOW timezone')).rows[0].timezone;
  if (String(tz).toLowerCase() !== 'utc') {
    console.error(`\nThis server runs timezone=${tz}. Run the throwaway Postgres with timezone=UTC or every date assertion reads an hour out.\n`);
    process.exit(2);
  }

  // Wipe only OUR tables, children first.
  const reset = async () => {
    await db.query(`TRUNCATE questionnaire_answers, questionnaire_responses, questionnaire_invites,
                    questionnaire_questions, questionnaire_versions, questionnaires RESTART IDENTITY CASCADE`);
  };
  await reset();

  // The lib is imported AFTER DATABASE_URL is set, so its pool connects to the throwaway.
  const Q = await import('../lib/questionnaires');

  const spec = (over: any = {}) => ({
    schema: 'lits.questionnaire/1', key: 'demo', title: 'Demo', mode: 'form',
    questions: [
      { key: 'rating', type: 'rating', scale: 5, label: 'How was it?', required: true },
      { key: 'comment', type: 'long_text', label: 'Anything to add?' },
    ], ...over,
  });

  console.log('\n── V: a version is frozen ───────────────────────────────────────────');
  {
    const v1 = await Q.importSpec(spec(), null);
    check('V1 the first import is version 1', v1.version === 1 && v1.isNew);

    const inv = await Q.createInvite({ versionId: v1.versionId, email: 'a@b.co', fullName: 'Ann', customerName: 'Larkmead' });
    await Q.recordAnswers(inv.token, { rating: '5' });

    const v2 = await Q.importSpec(spec({ questions: [
      { key: 'rating', type: 'rating', scale: 10, label: 'Rewritten question', required: true }] }), null);
    check('V2 re-importing the same key makes version 2, not a second questionnaire',
      v2.version === 2 && v2.questionnaireId === v1.questionnaireId);

    const old = await Q.loadVersion(v1.versionId);
    check('V3 the OLD version still asks the old question at the old scale',
      old!.questions[0].label === 'How was it?' && old!.questions[0].scale === 5,
      old!.questions[0].label + ' / ' + old!.questions[0].scale);

    const res = await Q.resultsFor(v1.versionId);
    check('V4 …and the answer given against it is untouched', res!.responded === 1 && res!.questions[0].average === 5);
  }

  console.log('\n── I: one invite per case, forever ──────────────────────────────────');
  await reset();
  {
    const v = await Q.importSpec(spec({ key: 'cf' }), null);
    // A stand-in case row: the invite only needs the id to exist as a number.
    const a = await Q.createInvite({ versionId: v.versionId, ticketId: 4242, email: 'a@b.co' });
    check('I1 the first ask mints a token', a.fresh && !!a.token);
    const b = await Q.createInvite({ versionId: v.versionId, ticketId: 4242, email: 'a@b.co' });
    check('I2 asking again about the SAME case returns the first token', !b.fresh && b.token === a.token);
    const n = await db.query('SELECT COUNT(*)::int n FROM questionnaire_invites WHERE ticket_id=4242');
    check('I3 …and creates no second row', n.rows[0].n === 1, String(n.rows[0].n));

    const c = await Q.createInvite({ versionId: v.versionId, ticketId: 4243, email: 'a@b.co' });
    check('I4 a different case gets its own token', c.token !== a.token);

    // Two invites with no case at all must NOT collide — a nullable unique column treats
    // NULLs as distinct, which is exactly what campaign sends rely on.
    const d = await Q.createInvite({ versionId: v.versionId, email: 'x@y.co' });
    const e = await Q.createInvite({ versionId: v.versionId, email: 'z@y.co' });
    check('I5 campaign invites (no case) never collide with each other', d.token !== e.token);
  }

  console.log('\n── R: one response per token, and a comment ADDS to it ───────────────');
  await reset();
  {
    const v = await Q.importSpec(spec({ key: 'r' }), null);
    const inv = await Q.createInvite({ versionId: v.versionId, email: 'a@b.co', fullName: 'Ann' });

    await Q.recordAnswers(inv.token, { rating: '4' });
    const r1 = await db.query('SELECT COUNT(*)::int n FROM questionnaire_responses');
    check('R1 the first click creates one response', r1.rows[0].n === 1);

    // The failure this guards: a comment posted later arriving as "rating not supplied"
    // and blanking the rating that was already banked.
    await Q.recordAnswers(inv.token, { comment: 'It was quick.' });
    const r2 = await db.query('SELECT id, rating, comment FROM questionnaire_responses');
    check('R2 the comment does not create a rival response', r2.rows.length === 1);
    check('R3 …and the rating survives it', Number(r2.rows[0].rating) === 4, String(r2.rows[0].rating));
    check('R4 …and the comment is stored', r2.rows[0].comment === 'It was quick.');

    // Changing your mind updates the same answer row rather than stacking a second.
    await Q.recordAnswers(inv.token, { rating: '2' });
    const a = await db.query(`SELECT COUNT(*)::int n FROM questionnaire_answers a
      JOIN questionnaire_questions q ON q.id=a.question_id WHERE q.key='rating'`);
    check('R5 changing an answer updates the row, never stacks a second', a.rows[0].n === 1, String(a.rows[0].n));
  }

  console.log('\n── C: the two website gates ─────────────────────────────────────────');
  await reset();
  {
    const v = await Q.importSpec(spec({ key: 'cf2', kind: 'case_feedback' }), null);
    const inv = await Q.createInvite({ versionId: v.versionId, email: 'a@b.co', fullName: 'Ann', customerName: 'Larkmead' });
    await Q.recordAnswers(inv.token, { rating: '5', comment: 'Sorted in ten minutes.' });
    const rid = (await db.query('SELECT id FROM questionnaire_responses')).rows[0].id;

    // Gate 1. Five stars and a lovely comment are still not permission.
    let refused = false;
    try { await Q.approveForWebsite(rid, 1, 'partial', 'Sorted in ten minutes.'); }
    catch { refused = true; }
    check('C1 a five-star comment CANNOT be published without the tick', refused);
    check('C2 …and nothing leaked into the public feed', (await Q.publishedTestimonials()).length === 0);

    await Q.setPublishConsent(rid, true);
    await Q.approveForWebsite(rid, 1, 'partial', 'Sorted in ten minutes.');
    const live = await Q.publishedTestimonials();
    check('C3 with the tick AND approval it appears, attributed as chosen',
      live.length === 1 && live[0].quote === 'Sorted in ten minutes.' && /Larkmead/.test(live[0].name), JSON.stringify(live));

    await Q.withdrawFromWebsite(rid);
    const after = await Q.publishedTestimonials();
    check('C4 withdrawing removes it from the feed', after.length === 0);
    const kept = (await db.query('SELECT publish_text FROM questionnaire_responses WHERE id=$1', [rid])).rows[0];
    check('C5 …but what was published is KEPT, so the withdrawal can be evidenced',
      kept.publish_text === 'Sorted in ten minutes.');

    // Consent withdrawn by the customer must also close the gate again.
    await Q.setPublishConsent(rid, false);
    let refused2 = false;
    try { await Q.approveForWebsite(rid, 1, 'full', 'x'); } catch { refused2 = true; }
    check('C6 consent taken back closes the gate again', refused2);
  }

  console.log('\n── E: the case-feedback rules ───────────────────────────────────────');
  await reset();
  {
    await db.query('TRUNCATE customer_contacts, customers, inbox_tickets RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO customers (id, name) VALUES (1,'Larkmead')`);
    await db.query(`INSERT INTO customer_contacts (id, customer_id, full_name, email) VALUES
      (1,1,'Ann','ann@larkmead.co'), (2,1,'Bob','bob@larkmead.co'), (3,1,'Cara','cara@larkmead.co')`);
    await db.query(`INSERT INTO inbox_tickets (id, customer_id, contact_id, ticket_number, subject) VALUES
      (100,1,1,'LITS-100','Printer'), (101,1,1,'LITS-101','Email'),
      (102,1,2,'LITS-102','VPN'), (103,1,3,'LITS-103','Laptop'), (104,1,NULL,'LITS-104','No contact')`);

    // This is the exact path the underscore bug killed: ensureCaseFeedback() imports the
    // built-in spec, and it threw before ever reaching the invite.
    const vid = await Q.ensureCaseFeedback();
    check('E1 the built-in case-feedback questionnaire seeds itself', !!vid);
    const again = await Q.ensureCaseFeedback();
    check('E2 …once, not on every closed case', again === vid);

    const first = await Q.maybeInviteCaseFeedback(100);
    check('E3 a closed case with a contact is asked', !!first && !!first.token);

    const reclose = await Q.maybeInviteCaseFeedback(100);
    check('E4 re-opening and re-closing the SAME case is silent', reclose === null);

    // Same contact, a second case closed the same day. Five closures must not be five emails.
    const second = await Q.maybeInviteCaseFeedback(101);
    check('E5 the same person is not asked twice in a week', second === null);

    await Q.muteFeedbackForContact(2);
    check('E6 a contact who asked us to stop is never asked', await Q.maybeInviteCaseFeedback(102) === null);

    check('E7 a case with no contact is skipped rather than crashing', await Q.maybeInviteCaseFeedback(104) === null);

    // A different person at the same customer is unaffected by Ann's rate limit.
    check('E8 a different person is still asked', !!(await Q.maybeInviteCaseFeedback(103)));

    const asked = await db.query('SELECT last_feedback_ask_at FROM customer_contacts WHERE id=1');
    check('E9 the ask is stamped on the contact, which is what the rate limit reads', !!asked.rows[0].last_feedback_ask_at);
  }

  console.log('\n── X: a test send never inflates its own numbers ────────────────────');
  await reset();
  {
    const v = await Q.importSpec(spec({ key: 'x' }), null);
    const real = await Q.createInvite({ versionId: v.versionId, email: 'a@b.co' });
    const test = await Q.createInvite({ versionId: v.versionId, email: 'terry@lumen', isTest: true });
    await Q.recordAnswers(real.token, { rating: '3' });
    await Q.recordAnswers(test.token, { rating: '5' });

    const res = await Q.resultsFor(v.versionId);
    check('X1 the test invite is not counted as invited', res!.invited === 1, String(res!.invited));
    check('X2 …nor its answer as a response', res!.responded === 1, String(res!.responded));
    check('X3 …and it does not move the average', res!.questions[0].average === 3, String(res!.questions[0].average));
  }

  await db.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
