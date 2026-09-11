/**
 * The subject line an outgoing side conversation carries.
 *
 * Until now it was the case's own subject, verbatim: "LITS-102570: printer keeps going
 * offline". That is the CUSTOMER'S words, and a side convo goes to a third party -
 * Openreach, a carrier, a supplier - who should be reading ours. So the composer lets
 * it be typed.
 *
 * The one thing it may not lose is the case token. Inbound mail is matched back to a
 * case by /LITS-\d+/ against the SUBJECT and nothing else (lib/mailsync.ts): strip the
 * token and the supplier's reply lands in the unmatched inbox with the thread broken,
 * which is precisely the failure this feature must not introduce. So whatever is typed,
 * the token goes back on the front unless it is already somewhere in the line.
 */
export function sideConvoSubject(typed: any, ticketNumber: string, caseSubject: string): string {
  const clean = String(typed == null ? '' : typed).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const num = String(ticketNumber || '').trim();
  const fallback = num ? (num + (caseSubject ? ': ' + caseSubject : '')) : (caseSubject || 'Lumen IT');
  const base = clean || fallback;
  if (!num) return base;
  const tokenRe = new RegExp('\\b' + num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return tokenRe.test(base) ? base : num + ': ' + base;
}
