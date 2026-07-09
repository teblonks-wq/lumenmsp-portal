import nodemailer from 'nodemailer';
import { config } from '../config';
import { pool } from '../db/pool';
import { graphConfigured, graphSendMail, GraphAttachment } from './graph';
import { getSignatureHtml } from './signature';

async function logEmail(
  to: string, from: string, subject: string, status: string, error: string | null,
  body: string | null, attachments: string[],
): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO email_log (to_email, from_email, subject, status, error, body, attachments) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [to || null, from || null, subject || null, status, error, body || null, attachments.length ? JSON.stringify(attachments) : null]
    );
  } catch (e) { console.error('[mailer] email_log write failed:', (e as Error).message); }
}

// When Graph is configured, mail sends for real via Microsoft Graph
// (app-only, sending as a shared mailbox). When it isn't, we fall back to
// nodemailer's jsonTransport so dev doesn't fail on missing creds.

let _transport: nodemailer.Transporter | null = null;
function jsonTransport(): nodemailer.Transporter {
  if (!_transport) _transport = nodemailer.createTransport({ jsonTransport: true });
  return _transport;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;                 // send-as mailbox (shared) or agent address
  cc?: string | string[];
  bcc?: string | string[];
  signatureName?: string;        // if set, append the signature with this sender name
  attachments?: GraphAttachment[];
  autoSubmitted?: boolean;       // mark machine-generated (status acks) so other systems don't auto-reply
}

// Wrap an agent-composed message so every customer-facing email renders at a consistent 11pt,
// regardless of how large the composer shows it on screen. Applied to outbound case replies.
export function customerEmailHtml(inner: string): string {
  return `<div style="font-size:11pt;font-family:'Segoe UI',Arial,sans-serif;line-height:1.5;color:#1f2937;">${inner || ''}</div>`;
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const html = msg.signatureName ? msg.html + (await getSignatureHtml(msg.signatureName)) : msg.html;
  const toStr = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
  const fromAddr = msg.from || config.GRAPH_SEND_FROM || config.FROM_EMAIL;
  const attNames = (msg.attachments || []).map((a) => a.filename);

  if (graphConfigured()) {
    try {
      await graphSendMail({ from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, html, attachments: msg.attachments, autoSubmitted: msg.autoSubmitted });
    } catch (e) {
      await logEmail(toStr, fromAddr, msg.subject, 'failed', (e as Error).message, html, attNames);
      throw e;
    }
    await logEmail(toStr, fromAddr, msg.subject, 'sent', null, html, attNames);
    return;
  }

  // Fallback: serialise only (no real send) so local dev keeps working.
  await jsonTransport().sendMail({
    from: `"${config.FROM_NAME}" <${fromAddr}>`,
    to: toStr, subject: msg.subject, html, text: msg.text,
  });
  await logEmail(toStr, fromAddr, msg.subject, 'not_sent', 'Graph not configured', html, attNames);
  console.warn('[mailer] Graph not configured — email serialised, not sent:', msg.subject);
}
