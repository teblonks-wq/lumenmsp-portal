/**
 * The side-convo subject rule, tested on its own.
 *
 * It earns a test because its failure is SILENT: get it wrong and the email still sends,
 * still looks right, and the supplier's reply simply never comes back to the case. That
 * is a class of bug nobody notices for a fortnight.
 *
 * Run:  ./node_modules/.bin/tsc -p tsconfig.json --outDir /tmp/sstest
 *       node /tmp/sstest/scripts/test-side-subject.js
 */
import { sideConvoSubject } from '../lib/side-subject';

// The one regex that matters - lib/mailsync.ts matches an inbound reply with exactly this.
const MAILSYNC = /LITS-\d+/i;

let pass = 0, fail = 0;
function check(name: string, got: string, want: string) {
  if (got === want) { pass++; return; }
  fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}
function matches(name: string, subject: string) {
  if (MAILSYNC.test(subject)) { pass++; return; }
  fail++; console.error(`FAIL ${name} - mailsync would NOT match ${JSON.stringify(subject)}`);
}

const N = 'LITS-102570';

// Nothing typed: the old behaviour, unchanged.
check('empty falls back', sideConvoSubject('', N, 'Printer offline'), 'LITS-102570: Printer offline');
check('null falls back', sideConvoSubject(null, N, 'Printer offline'), 'LITS-102570: Printer offline');
check('no case subject', sideConvoSubject('', N, ''), 'LITS-102570');

// Typed, token missing: it goes back on the front.
check('token restored', sideConvoSubject('Line fault at Cholsey', N, 'Printer offline'),
  'LITS-102570: Line fault at Cholsey');

// Typed, token already there: left exactly as typed, wherever it sits.
check('token kept in front', sideConvoSubject('LITS-102570 - line fault', N, 'x'), 'LITS-102570 - line fault');
check('token kept at the end', sideConvoSubject('Line fault (ref LITS-102570)', N, 'x'), 'Line fault (ref LITS-102570)');
check('token kept lowercase', sideConvoSubject('lits-102570 line fault', N, 'x'), 'lits-102570 line fault');

// A DIFFERENT case number is not our token - ours still has to be added, or the reply
// would be filed against somebody else's case.
check('other case number is not ours', sideConvoSubject('Re: LITS-99999 line fault', N, 'x'),
  'LITS-102570: Re: LITS-99999 line fault');

// A longer number that merely STARTS with ours must not count as a match, or the reply
// goes to the wrong case. This is what the word boundary is for.
check('prefix is not a match', sideConvoSubject('about LITS-1025701', N, 'x'),
  'LITS-102570: about LITS-1025701');

// Newlines are a header-injection shape; they never reach the subject.
check('newlines flattened', sideConvoSubject('Line fault\nBcc: someone@example.com', N, 'x'),
  'LITS-102570: Line fault Bcc: someone@example.com');

// Overlong input is capped, and the token still survives on the front.
const long = 'x'.repeat(400);
const capped = sideConvoSubject(long, N, 'y');
check('capped length', String(capped.length), String(('LITS-102570: ' + 'x'.repeat(200)).length));

// No ticket number on the case at all: never crash, never invent one.
check('no number, typed', sideConvoSubject('Line fault', '', 'Printer offline'), 'Line fault');
check('no number, empty', sideConvoSubject('', '', 'Printer offline'), 'Printer offline');
check('no number, nothing', sideConvoSubject('', '', ''), 'Lumen IT');

// The whole point: whatever comes out, mailsync can match it back.
for (const typed of ['', 'Line fault at Cholsey', 'Re: LITS-99999 line fault', 'LITS-102570 - line fault',
                     'about LITS-1025701', 'Line fault\nBcc: x@y.z', long]) {
  matches('round-trip ' + JSON.stringify(typed.slice(0, 24)), sideConvoSubject(typed, N, 'Printer offline'));
}

console.log(`side-subject: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
