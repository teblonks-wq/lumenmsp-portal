import { sendMail } from './mailer';
import { config } from '../config';
import { getSetting } from './settings';

// Transactional emails (welcome, etc.). Bodies are HTML; the signature is
// appended by the mailer when signatureName is passed.

export function welcomeEmailHtml(toName: string): string {
  const first = (toName || '').trim().split(/\s+/)[0] || 'there';
  const url = config.APP_URL || 'https://portal.lumenmsp.co.uk';
  const shown = url.replace(/^https?:\/\//, '');
  return `
    <p>Hi ${first},</p>
    <p>You've been set up with access to the <strong>Lumen MSP Portal</strong> — tickets, quotes, invoices and customer management, all in one place.</p>
    <p><strong>No password needed</strong> — just sign in with your Microsoft 365 account (the same login you use for email):</p>
    <p><a href="${url}" style="display:inline-block;background:#0ea5b7;color:#fff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:6px;">Sign in to the Portal</a></p>
    <p style="font-size:13px;color:#6b7280;">Or visit <a href="${url}">${shown}</a> and choose “Sign in with Microsoft”.</p>
    <p>Any trouble getting in, just reply to this email and we'll help you out.</p>`;
}

export async function sendWelcomeEmail(toEmail: string, toName: string, fromName?: string): Promise<void> {
  await sendMail({ to: toEmail, subject: 'Welcome to the Lumen MSP Portal', html: welcomeEmailHtml(toName), signatureName: fromName });
}

// Branded quotation email — greeting, optional personal note, a tidy summary
// table and a clear call-to-action button. Renders cleanly even with images off.
export function quoteEmailHtml(opts: {
  contactName?: string; quoteNumber: string; title: string;
  total?: string; validUntil?: string; message?: string; link: string;
}): string {
  const first = (opts.contactName || '').trim().split(/\s+/)[0] || 'there';
  const esc = (s: string) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
  const note = opts.message ? `<p style="margin:0 0 16px;">${esc(opts.message).replace(/\n/g, '<br>')}</p>` : '';
  const rows: [string, string][] = [['Quotation', opts.quoteNumber], ['Subject', opts.title]];
  if (opts.total) rows.push(['Total (inc. VAT)', opts.total]);
  if (opts.validUntil) rows.push(['Valid until', opts.validUntil]);
  const summary = rows.map(([k, v]) =>
    `<tr><td style="padding:5px 18px 5px 0;color:#6b7280;font-size:14px;">${k}</td><td style="padding:5px 0;font-weight:600;font-size:14px;">${esc(v)}</td></tr>`).join('');
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 14px;">Hi ${esc(first)},</p>
    ${note}
    <p style="margin:0 0 16px;">Thank you for considering Lumen IT Solutions. Your quotation is ready — a summary is below, and you can review the full details and accept it online using the button.</p>
    <table style="border-collapse:collapse;margin:0 0 22px;">${summary}</table>
    <p style="margin:0 0 24px;">
      <a href="${opts.link}" style="display:inline-block;background:#0ea5b7;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:6px;font-size:15px;">View &amp; respond to your quote</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:13px;">If you have any questions about this quotation, just reply to this email and we'll be glad to help.</p>`;
}

// Branded invoice email — greeting, summary and a note that the PDF is attached.
export function invoiceEmailHtml(opts: {
  contactName?: string; invoiceNumber: string; title: string;
  total?: string; dueDate?: string; directDebit?: boolean; message?: string;
}): string {
  const first = (opts.contactName || '').trim().split(/\s+/)[0] || 'there';
  const esc = (s: string) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
  const note = opts.message ? `<p style="margin:0 0 16px;">${esc(opts.message).replace(/\n/g, '<br>')}</p>` : '';
  const rows: [string, string][] = [['Invoice', opts.invoiceNumber], ['For', opts.title]];
  if (opts.total) rows.push(['Amount due', opts.total]);
  if (opts.dueDate) rows.push(['Due date', opts.dueDate]);
  const summary = rows.map(([k, v]) =>
    `<tr><td style="padding:5px 18px 5px 0;color:#6b7280;font-size:14px;">${k}</td><td style="padding:5px 0;font-weight:600;font-size:14px;">${esc(v)}</td></tr>`).join('');
  const payLine = opts.directDebit
    ? `<p style="margin:0 0 16px;">No action is needed — this invoice will be collected automatically by Direct Debit on or shortly after the due date.</p>`
    : `<p style="margin:0 0 16px;">Our bank details are on the invoice. Please quote <strong>${esc(opts.invoiceNumber)}</strong> as the payment reference.</p>`;
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 14px;">Hi ${esc(first)},</p>
    ${note}
    <p style="margin:0 0 16px;">Please find your invoice from Lumen IT Solutions attached as a PDF. A summary is below.</p>
    <table style="border-collapse:collapse;margin:0 0 20px;">${summary}</table>
    ${payLine}
    <p style="margin:0;color:#6b7280;font-size:13px;">Any questions about this invoice, just reply to this email and we'll be glad to help.</p>`;
}

// Onboarding form invite — friendly note + a button to the secure form.
export function onboardingEmailHtml(opts: { contactName?: string; customerName: string; link: string }): string {
  const first = (opts.contactName || '').trim().split(/\s+/)[0] || 'there';
  const esc = (s: string) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 14px;">Hi ${esc(first)},</p>
    <p style="margin:0 0 16px;">Welcome aboard! To get <strong>${esc(opts.customerName)}</strong> set up correctly, please take a couple of minutes to complete our short onboarding form. It asks for your registered business details and the right people for us to contact about invoices, contracts and day-to-day support.</p>
    <p style="margin:0 0 24px;">
      <a href="${opts.link}" style="display:inline-block;background:#0ea5b7;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:6px;font-size:15px;">Complete your onboarding form</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:13px;">The link is unique to your account. Any questions, just reply to this email.</p>`;
}

// ── Ticket status emails ────────────────────────────────────────────────────────
// The emails support sends to the customer as a ticket moves through each status.
// Templates support {{name}} (contact) and {{ticket}} (ticket number).

// System-sent status emails (auto). Update / Awaiting-customer are agent-written
// (the reply they type), and Awaiting-3rd-party / Closed send nothing.
export const STATUS_EMAILS: { status: string; label: string; subject: string }[] = [
  { status: 'new',      label: 'New — acknowledgement', subject: "We've received your request [{{ticket}}]: {{subject}}" },
  { status: 'resolved', label: 'Resolved — good news',  subject: "Your ticket {{ticket}} is resolved: {{subject}}" },
];

export function defaultStatusEmail(status: string): string {
  switch (status) {
    case 'new':
    case 'open':
      return `<p>Hi {{name}},</p><p>Thanks for getting in touch — we've logged your request as ticket <strong>{{ticket}}</strong>:</p><p style="margin:8px 0 8px 12px;border-left:3px solid #0ea5b7;padding-left:12px;"><strong>{{subject}}</strong></p><p>A member of our support team will be with you shortly.</p>`;
    case 'in_progress':
      return `<p>Hi {{name}},</p><p>Just to let you know we're now actively working on ticket <strong>{{ticket}}</strong>. We'll keep you updated as it progresses.</p>`;
    case 'pending':
      return `<p>Hi {{name}},</p><p>We're waiting on a little more information from you to move ticket <strong>{{ticket}}</strong> forward. Please reply when you have a moment and we'll pick it straight back up.</p>`;
    case 'resolved':
      return `<p>Hi {{name}},</p><p>We believe ticket <strong>{{ticket}}</strong> is now resolved. If everything's working as expected there's nothing more you need to do — if not, just reply and we'll reopen it.</p>`;
    case 'closed':
      return `<p>Hi {{name}},</p><p>Ticket <strong>{{ticket}}</strong> has now been closed. Thanks for working with us — reply any time if you need further help.</p>`;
    default:
      return `<p>Hi {{name}},</p><p>There's an update on your ticket <strong>{{ticket}}</strong>.</p>`;
  }
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] != null ? vars[k] : ''));
}

// Sends an auto status email (new / resolved) to the customer, using the saved
// template if present. No-op if the status isn't a system-sent one or there's no recipient.
export async function sendTicketStatusEmail(
  status: string, toEmail: string | null, toName: string, ticketNumber: string, fromName?: string, caseSubject?: string,
): Promise<void> {
  const def = STATUS_EMAILS.find((s) => s.status === status);
  if (!def || !toEmail) return;
  const saved = await getSetting('email_templates', status);
  const tpl = saved && saved.trim() ? saved : defaultStatusEmail(status);
  const vars = { name: toName || 'there', ticket: ticketNumber || '', subject: (caseSubject || '').trim() };
  // Tidy any "[TICKET]: " trailing separator if the case has no subject.
  const subjectLine = renderTemplate(def.subject, vars).replace(/:\s*$/, '');
  await sendMail({ to: toEmail, subject: subjectLine, html: renderTemplate(tpl, vars), signatureName: fromName, autoSubmitted: true });
}
