/**
 * Licence allocation + renewal early warning.
 *
 * Two features, one suite, because they answer halves of the same question: Giacom tells
 * us what a customer is BILLED for, Graph tells us who is actually SITTING on it, and the
 * renewal date is the only moment either number can be changed.
 *
 * The parts worth testing are the pure ones — the two places this can quietly be wrong:
 *
 *   M1–M12  offer-name → SKU matching. Giacom and Microsoft use different vocabularies
 *           for the same product and neither carries the other's key, so the friendly
 *           name is the only bridge. A WRONG pairing is worse than no pairing: it puts a
 *           confident seat-drift number on screen that nobody can trace. These check it
 *           pairs what it should and, just as hard, refuses what it shouldn't.
 *   D1–D8   the day arithmetic. "7 days out" must not become 6 because the sweep ran in
 *           the afternoon, and must not become 8 across a BST boundary.
 *   S1–S7   stage banding. The TIGHTEST crossed stage wins — a row 12 days out is a
 *           30-day warning, not a 60-day one, or the escalation never escalates.
 *   K1–K3   the diary day key, including the BST edges where a UTC date is the wrong day.
 *
 * Run: npm run test:renewals
 */
import { normaliseOffer, matchSku } from '../lib/licence-allocation';
import { stageFor, daysBetween, dayKeyOf, STAGES } from '../lib/renewal-watch';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A realistic tenant: the pools an SMB customer actually holds.
const SKUS = [
  { skuId: 'a1', partNumber: 'SPB', name: 'Microsoft 365 Business Premium', total: 25, assigned: 22, spare: 3 },
  { skuId: 'a2', partNumber: 'O365_BUSINESS_ESSENTIALS', name: 'Microsoft 365 Business Basic', total: 10, assigned: 9, spare: 1 },
  { skuId: 'a3', partNumber: 'EXCHANGESTANDARD', name: 'Exchange Online (Plan 1)', total: 4, assigned: 4, spare: 0 },
  { skuId: 'a4', partNumber: 'MCOEV', name: 'Teams Phone', total: 6, assigned: 5, spare: 1 },
  { skuId: 'a5', partNumber: 'AAD_PREMIUM', name: 'Entra ID P1', total: 25, assigned: 25, spare: 0 },
];

console.log('\nMatching Giacom offer names to Graph SKUs');
{
  const m = (offer: string) => { const i = matchSku(offer, SKUS as any); return i < 0 ? null : SKUS[i].partNumber; };

  check('M1 the plain name pairs', m('Microsoft 365 Business Premium') === 'SPB');
  // The shape Giacom actually ships: the billing term bolted onto the product name.
  check('M2 an annual-commitment suffix is ignored',
        m('Microsoft 365 Business Premium (Annual Commitment - Monthly Billing)') === 'SPB',
        String(m('Microsoft 365 Business Premium (Annual Commitment - Monthly Billing)')));
  check('M3 a monthly-billing suffix is ignored',
        m('Microsoft 365 Business Basic (Monthly Commitment)') === 'O365_BUSINESS_ESSENTIALS');
  check('M4 case and spacing do not matter', m('  MICROSOFT 365  BUSINESS   PREMIUM ') === 'SPB');
  check('M5 the raw part number pairs too', m('SPB') === 'SPB');
  check('M6 a bracketed plan number survives', m('Exchange Online (Plan 1)') === 'EXCHANGESTANDARD',
        String(m('Exchange Online (Plan 1)')));
  check('M7 an NCE label is noise, not signal', m('Microsoft 365 Business Premium NCE') === 'SPB');

  // Basic must never win Premium. Both contain "microsoft 365 business", and the longest
  // candidate is tried first precisely so the more specific pool takes it.
  check('M8 Premium is not mistaken for Basic', m('Microsoft 365 Business Premium') !== 'O365_BUSINESS_ESSENTIALS');
  check('M9 Basic is not mistaken for Premium', m('Microsoft 365 Business Basic') === 'O365_BUSINESS_ESSENTIALS');

  // Refusing is a feature. An unmatched offer is shown as unmatched, never guessed onto
  // a pool it does not belong to.
  check('M10 an unknown product refuses rather than guessing', m('Adobe Creative Cloud All Apps') === null,
        String(m('Adobe Creative Cloud All Apps')));
  check('M11 empty and junk refuse', m('') === null && m('   ') === null && m('---') === null);
  check('M12 a too-short fragment cannot pair by containment', m('P1') === null, String(m('P1')));

  check('M13 normalisation strips parens, punctuation and noise words',
        normaliseOffer('Microsoft 365 Business Premium (Annual Commitment — Monthly Billing) - CSP')
          === 'microsoft 365 business premium',
        normaliseOffer('Microsoft 365 Business Premium (Annual Commitment — Monthly Billing) - CSP'));
  check('M14 a "+" in a product name is preserved', normaliseOffer('Office 365 E5 + Teams').includes('+'));
}

console.log('\nDay arithmetic');
{
  const D = (s: string) => new Date(s + 'T00:00:00Z');
  check('D1 same day is 0', daysBetween(D('2026-08-28'), D('2026-08-28')) === 0);
  check('D2 tomorrow is 1', daysBetween(D('2026-08-28'), D('2026-08-29')) === 1);
  check('D3 the past is negative', daysBetween(D('2026-08-28'), D('2026-08-21')) === -7);
  check('D4 null target is null', daysBetween(D('2026-08-28'), null) === null);
  // The bug this exists to stop: an afternoon sweep must not shave a day off.
  check('D5 the time of day does not change the answer',
        daysBetween(new Date('2026-08-28T16:45:00Z'), new Date('2026-09-04T02:00:00Z')) === 7,
        String(daysBetween(new Date('2026-08-28T16:45:00Z'), new Date('2026-09-04T02:00:00Z'))));
  check('D6 …in either direction across a day',
        daysBetween(new Date('2026-08-28T01:00:00Z'), new Date('2026-09-04T23:00:00Z')) === 7);
  check('D7 it counts across a month end', daysBetween(D('2026-08-28'), D('2026-09-28')) === 31);
  // The clocks go back on 25 Oct 2026. A naive ms/86400000 gives 30.04 days here.
  check('D8 the BST→GMT change does not add or lose a day',
        daysBetween(D('2026-10-11'), D('2026-11-10')) === 30,
        String(daysBetween(D('2026-10-11'), D('2026-11-10'))));
}

console.log('\nStage banding');
{
  check('S1 the stages are 60, 30 and 7', JSON.stringify([...STAGES]) === '[60,30,7]');
  check('S2 90 days out is in no band yet', stageFor(90) === null);
  check('S3 exactly 60 is the 60-day warning', stageFor(60) === '60');
  check('S4 45 days is still the 60-day band', stageFor(45) === '60');
  // The escalation only escalates if the tightest crossed stage wins.
  check('S5 12 days is the 30-day warning, not the 60', stageFor(12) === '30', String(stageFor(12)));
  check('S6 exactly 7 is the final warning', stageFor(7) === '7');
  check('S7 today still warns; yesterday does not', stageFor(0) === '7' && stageFor(-1) === null);
  check('S8 no renewal date means no stage', stageFor(null) === null);
  check('S9 61 days is one day too early', stageFor(61) === null);
}

console.log('\nDiary day keys');
{
  check('K1 a midday date is its own day', dayKeyOf(new Date('2026-08-28T12:00:00Z')) === '2026-08-28');
  // 23:30 UTC in August is 00:30 the NEXT day in London — a UTC-based key files the task
  // on the wrong day, which for a 7-day warning is a whole warning wasted.
  check('K2 late evening in BST lands on the London day',
        dayKeyOf(new Date('2026-08-28T23:30:00Z')) === '2026-08-29',
        dayKeyOf(new Date('2026-08-28T23:30:00Z')));
  check('K3 in GMT the London day matches UTC',
        dayKeyOf(new Date('2026-12-28T23:30:00Z')) === '2026-12-28',
        dayKeyOf(new Date('2026-12-28T23:30:00Z')));
  check('K4 the format is exactly YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dayKeyOf(new Date())));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
