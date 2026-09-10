import { pool } from '../db/pool';
import { config } from '../config';
import { sendMail } from './mailer';
import { londonHM } from './diary';
import { bookingById, entryTickets, BookingDetail } from './booking';

// ── What a booked meeting looks like when it lands ──────────────────────────────
//
// Two things go out, and they are not the same thing:
//
//   1. A REAL calendar request (METHOD:REQUEST, an organiser, an attendee that can
//      RSVP). Outlook shows Accept/Decline and the meeting appears in the person's own
//      diary. This is the part people actually use, so it carries the agenda and the
//      join link — not a link back to a page that carries them.
//   2. A branded email, in the same house style as every other message we send, with the
//      standard signature appended by the mailer.
//
// Both are rebuilt from the entry each time, so a re-send after the agenda changes is an
// UPDATE of the same meeting (same UID, higher SEQUENCE) rather than a second invitation
// sitting next to the first.

const DOMAIN = String(config.FROM_EMAIL || 'sp@lumenmsp.co.uk').split('@').pop() || 'lumenmsp.co.uk';
const APP = String(config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, '');

const esc = (v: any): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** RFC 5545 text escaping: backslash, semicolon, comma, and real newlines. */
const ics = (v: any): string =>
  String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines over 75 octets must be folded, or Outlook truncates the agenda mid-sentence. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const out: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) { out.push(' ' + rest.slice(0, 72)); rest = rest.slice(72); }
  if (rest) out.push(' ' + rest);
  return out.join('\r\n');
}

const stamp = (epochSecs: number): string =>
  new Date(epochSecs * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface InviteInput {
  entryId: number;
  summary: string;
  start: number; end: number;
  organiserName: string; organiserEmail: string;
  attendeeName: string; attendeeEmail: string;
  description: string;
  location: string;
  sequence: number;
  cancel?: boolean;
}

export function buildIcs(inp: InviteInput): string {
  const uid = `lumen-booking-${inp.entryId}@${DOMAIN}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lumen IT Solutions//LumenMSP Portal//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${inp.cancel ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(inp.sequence))}`,
    `DTSTAMP:${stamp(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${stamp(inp.start)}`,
    `DTEND:${stamp(inp.end)}`,
    `SUMMARY:${ics(inp.summary)}`,
    `DESCRIPTION:${ics(inp.description)}`,
    inp.location ? `LOCATION:${ics(inp.location)}` : '',
    `ORGANIZER;CN=${ics(inp.organiserName)}:mailto:${inp.organiserEmail}`,
    `ATTENDEE;CN=${ics(inp.attendeeName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${inp.attendeeEmail}`,
    `STATUS:${inp.cancel ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    // A reminder 15 minutes out. People book a fortnight ahead and then forget.
    ...(inp.cancel ? [] : ['BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n');
}

// ── The branded email body ──────────────────────────────────────────────────────

function detailRow(label: string, value: string): string {
  return `<tr><td style="padding:5px 16px 5px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(label)}</td>`
       + `<td style="padding:5px 0;font-size:14px;color:#111827;">${value}</td></tr>`;
}

function bodyHtml(b: BookingDetail, cases: Array<{ ticketNumber: string; subject: string }>, opts: {
  intro: string; cancelled?: boolean;
}): string {
  const when = `${b.whenText}–${londonHM(b.end)}`;
  const where = b.joinUrl
    ? 'Microsoft Teams'
    : (b.locationText || (b.kind === 'onsite' ? 'At your site' : 'Remote'));

  const joinBtn = b.joinUrl && !opts.cancelled
    ? `<p style="margin:18px 0;"><a href="${esc(b.joinUrl)}" style="background:#0e7490;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Join the Teams meeting</a></p>`
    : (b.wantsTeams && !opts.cancelled
        ? '<p style="margin:16px 0;color:#b45309;font-size:13.5px;">The Teams joining link will follow before the meeting.</p>'
        : '');

  const agenda = b.agenda && !opts.cancelled
    ? `<div style="margin-top:20px;padding:14px 16px;background:#f8fafc;border-left:3px solid #0e7490;border-radius:0 8px 8px 0;">
         <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#0e7490;margin-bottom:6px;">Agenda</div>
         <div style="font-size:13.5px;color:#374151;line-height:1.6;">${esc(b.agenda).replace(/\n/g, '<br>')}</div>
       </div>`
    : '';

  const caseList = cases.length && !opts.cancelled
    ? `<div style="margin-top:16px;">
         <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;margin-bottom:6px;">Cases we will cover</div>
         <ul style="margin:0;padding-left:20px;font-size:13.5px;color:#374151;line-height:1.7;">
           ${cases.map(c => `<li><strong>${esc(c.ticketNumber)}</strong> — ${esc(c.subject)}</li>`).join('')}
         </ul>
       </div>`
    : '';

  const manage = b.cancelToken && !opts.cancelled
    ? `<p style="margin-top:22px;font-size:12.5px;color:#6b7280;">Need to move it or cancel? <a href="${APP}/book/manage/${esc(b.cancelToken)}" style="color:#0e7490;">Manage this booking</a> — no sign-in needed.</p>`
    : '';

  return `
    <p style="font-size:14px;color:#111827;margin:0 0 16px;">${esc(opts.intro)}</p>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${detailRow('What', `<strong>${esc(b.serviceName)}</strong>`)}
      ${detailRow('When', `<strong>${esc(when)}</strong>`)}
      ${detailRow('Where', esc(where))}
      ${b.staff ? detailRow('With', esc(b.staff)) : ''}
    </table>
    ${joinBtn}
    ${agenda}
    ${caseList}
    ${manage}`;
}

// ── Sending ─────────────────────────────────────────────────────────────────────

async function sequenceOf(entryId: number): Promise<number> {
  // A monotonically rising number derived from the row itself: seconds since it was
  // created. Every save bumps updated_at, so an updated invite always outranks the one
  // already in the attendee's calendar — which is what makes it an update and not a
  // duplicate meeting.
  const r = await pool.query(
    `SELECT GREATEST(0, EXTRACT(EPOCH FROM (updated_at - created_at))::bigint) AS seq FROM diary_entries WHERE id=$1`,
    [entryId]);
  return Number(r.rows[0]?.seq || 0);
}

export type BookingMailKind = 'confirmed' | 'updated' | 'cancelled';

const INTRO: Record<BookingMailKind, (b: BookingDetail) => string> = {
  confirmed: (b) => `Your booking is confirmed${b.staff ? ` with ${b.staff}` : ''}. The calendar invitation is attached — accept it and it will sit in your own diary.`,
  updated:   () => 'Your booking has been updated. The attached invitation replaces the one already in your calendar.',
  cancelled: () => 'Your booking has been cancelled and the time released. Nothing further is needed from you.',
};

const SUBJECT: Record<BookingMailKind, string> = {
  confirmed: 'Confirmed', updated: 'Updated', cancelled: 'Cancelled',
};

/**
 * Send the branded email plus the calendar request for one booking. Never throws: a
 * confirmation that fails to send must not roll back a booking that was genuinely made.
 */
export async function sendBookingMail(entryId: number, kind: BookingMailKind = 'confirmed'): Promise<void> {
  try {
    const b = await bookingById(entryId);
    if (!b) return;
    const to = (b.bookedByEmail || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;

    const cases = await entryTickets(entryId);
    const organiserEmail = config.GRAPH_SEND_FROM || config.FROM_EMAIL || `sp@${DOMAIN}`;
    const when = `${b.whenText}–${londonHM(b.end)}`;

    const descParts = [
      b.agenda ? `Agenda:\n${b.agenda}` : '',
      cases.length ? `Cases:\n${cases.map(c => `- ${c.ticketNumber}: ${c.subject}`).join('\n')}` : '',
      b.joinUrl ? `Join: ${b.joinUrl}` : '',
      b.cancelToken ? `Manage this booking: ${APP}/book/manage/${b.cancelToken}` : '',
      'Booked with Lumen IT Solutions.',
    ].filter(Boolean);

    const icsText = buildIcs({
      entryId, summary: `${b.serviceName} — Lumen IT Solutions`,
      start: b.start, end: b.end,
      organiserName: b.staff || 'Lumen IT Solutions', organiserEmail,
      attendeeName: b.bookedByName || to, attendeeEmail: to,
      description: descParts.join('\n\n'),
      location: b.joinUrl || b.locationText || (b.kind === 'onsite' ? 'At your site' : 'Remote'),
      sequence: await sequenceOf(entryId),
      cancel: kind === 'cancelled',
    });

    await sendMail({
      to,
      subject: `${SUBJECT[kind]}: ${b.serviceName} — ${when}`,
      html: bodyHtml(b, cases, { intro: INTRO[kind](b), cancelled: kind === 'cancelled' }),
      signatureName: b.staff ? b.staff.split(',')[0].trim() : 'The Lumen MSP Team',
      autoSubmitted: true,
      attachments: [{
        filename: kind === 'cancelled' ? 'cancelled.ics' : 'invite.ics',
        contentType: `text/calendar; method=${kind === 'cancelled' ? 'CANCEL' : 'REQUEST'}; charset=utf-8`,
        base64: Buffer.from(icsText, 'utf8').toString('base64'),
      }],
    });
  } catch (e: any) {
    console.error('[booking] confirmation email failed:', e?.message || e);
  }
}

/** Tell the staff member a stranger has just put something in their diary. */
export async function notifyStaffOfBooking(entryId: number): Promise<void> {
  try {
    const b = await bookingById(entryId);
    if (!b) return;
    const r = await pool.query(
      `SELECT u.email, u.display_name FROM diary_entry_people p JOIN users u ON u.id = p.user_id
        WHERE p.entry_id = $1`, [entryId]);
    if (!r.rows.length) return;
    const who = [b.bookedByName, b.customerName || null].filter(Boolean).join(' · ');
    const unplaced = b.customerName
      ? ''
      : '<p style="color:#b45309;font-size:13px;margin:12px 0 0;">We could not match this booker to a customer — open the diary entry and set one.</p>';
    await sendMail({
      to: r.rows.map((x: any) => x.email),
      subject: `New booking: ${b.serviceName} — ${b.whenText}`,
      html: `<p style="font-size:14px;">${esc(who || 'Someone')} has booked <strong>${esc(b.serviceName)}</strong>.</p>
             <table cellpadding="0" cellspacing="0">
               ${detailRow('When', `<strong>${esc(b.whenText)}–${esc(londonHM(b.end))}</strong>`)}
               ${detailRow('Contact', esc(b.bookedByEmail || '—'))}
               ${detailRow('Company', esc(b.customerName || '(unmatched)'))}
             </table>
             ${unplaced}
             <p style="margin-top:16px;"><a href="${APP}/diary/booking/${b.id}" style="background:#0e7490;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Open it — add the agenda and tag the cases</a></p>`,
      autoSubmitted: true,
    });
  } catch (e: any) {
    console.error('[booking] staff notification failed:', e?.message || e);
  }
}

