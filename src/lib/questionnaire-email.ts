import { answerOptions, type SpecQuestion } from './questionnaire-spec';
import { pollOptionLink, publicLink } from './questionnaires';

// ── Rendering a poll into an email ────────────────────────────────────────────
// A one-click poll is answered by clicking a LINK in the message, which is why its
// response rate beats a form's several times over. The link lands on a page that posts —
// the GET behind it records nothing at all, because mail scanners follow links (they do
// not submit forms), and a scanner answering on the customer's behalf is not feedback.

const esc = (s: string): string =>
  String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

// Big enough to hit on a phone, plain enough to survive Outlook.
function optionButton(href: string, label: string, wide: boolean): string {
  return `<a href="${esc(href)}" style="display:inline-block;margin:0 6px 8px 0;padding:${wide ? '10px 20px' : '10px 15px'};`
    + `background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;color:#0f172a;`
    + `text-decoration:none;font-size:15px;font-weight:600;min-width:${wide ? '0' : '38px'};text-align:center;">${esc(label)}</a>`;
}

export interface PollBlockOpts {
  heading?: string | null;   // overrides the question label
  footnote?: string | null;  // the attribution line — see the note below
  moreLabel?: string | null; // link to the full page, for anything that needs a keyboard
}

// The block that goes into a campaign email or a case closure email.
export function pollBlockHtml(token: string, q: SpecQuestion, opts: PollBlockOpts = {}): string {
  const opt = answerOptions(q);
  if (!opt.length) return '';
  const scale = q.type === 'rating' || q.type === 'nps';
  const buttons = opt.map((o) => optionButton(pollOptionLink(token, o.value), o.label, !scale)).join('');

  // Ends of a scale get named. "4 out of 5" means nothing without knowing which end is good.
  const ends = scale
    ? `<div style="margin:2px 0 0;color:#94a3b8;font-size:12px;">`
      + `<span>${q.type === 'nps' ? 'Not at all likely' : 'Poor'}</span>`
      + `<span style="float:right;">${q.type === 'nps' ? 'Extremely likely' : 'Excellent'}</span></div>`
    : '';

  // Attribution is stated, not buried. If people do not know their name is on it they
  // answer politely, and polite feedback is worth nothing.
  const foot = opts.footnote === null ? '' :
    `<p style="margin:14px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">`
    + esc(opts.footnote || 'Your answer is linked to your name so we can follow it up. It takes one click — nothing else to fill in.')
    + (opts.moreLabel ? ` <a href="${esc(publicLink(token))}" style="color:#0ea5b7;">${esc(opts.moreLabel)}</a>.` : '')
    + `</p>`;

  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin:26px 0 0;"><tr><td
      style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;">
      <p style="margin:0 0 14px;font-size:16px;font-weight:600;color:#0f172a;">${esc(opts.heading || q.label)}</p>
      <div>${buttons}</div>${ends}${foot}
    </td></tr></table>`;
}

// The same ask for a channel with no HTML — WhatsApp and Teams cases. One short line and
// one link; a wall of numbered links in a chat window reads as spam.
export function pollBlockText(token: string, q: SpecQuestion, heading?: string): string {
  return `\n\n${heading || q.label}\n${publicLink(token)}`;
}
