import { config } from '../config';
import { getSetting } from './settings';

// Outbound email signature. The sender's name is injected dynamically; no personal
// email or mobile is shown. A custom signature saved in Branding (settings group
// 'branding', key 'email_signature') overrides the default below — use {{name}}
// in that template for the sender's name.

const CONTACT_URL = 'https://www.lumenmsp.co.uk/contact/';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// Cyber Readiness banner — uses the hosted banner image if one is configured,
// otherwise an HTML recreation. Whole banner links to the contact page.
function bannerHtml(imgUrl: string): string {
  const inner = imgUrl
    ? `<img src="${imgUrl}" alt="Book your free Cyber Readiness Assessment" style="display:block;border:0;width:100%;max-width:520px;border-radius:8px;">`
    : `<table cellpadding="0" cellspacing="0" style="margin-top:14px;width:100%;max-width:520px;border-radius:8px;overflow:hidden;background:#0b3a5b;background:linear-gradient(90deg,#0b3a5b,#0e7490);">
        <tr>
          <td style="padding:14px 16px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;vertical-align:middle;">
            <div style="font-size:12px;opacity:.85;">Don't forget to book your</div>
            <div style="font-size:18px;font-weight:700;line-height:1.2;">Cyber Readiness Assessment</div>
            <div style="font-size:12px;opacity:.85;margin-bottom:9px;">free to all support customers</div>
            <span style="display:inline-block;background:#22d3ee;color:#04303a;font-weight:700;font-size:12px;padding:7px 16px;border-radius:20px;">BOOK CYBER REVIEW &rsaquo;</span>
          </td>
          <td style="padding:10px 16px;text-align:right;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:11px;white-space:nowrap;vertical-align:middle;">
            <div style="font-weight:700;letter-spacing:.5px;">CYBER ESSENTIALS</div>
            <div style="opacity:.85;">IASME Certified &#10003;</div>
          </td>
        </tr>
      </table>`;
  return `<a href="${CONTACT_URL}" style="text-decoration:none;display:block;margin-top:14px;">${inner}</a>`;
}

const DISCLAIMER =
  'Email Disclaimer &ndash; Lumen IT Solutions Limited &ndash; This email and any attachments are confidential and may contain privileged information. ' +
  'If you are not the intended recipient, please notify the sender immediately and delete this email from your system. Any unauthorized use, disclosure, ' +
  'copying, or distribution of this email or its contents is strictly prohibited. While we take reasonable precautions to ensure emails are free from viruses ' +
  'and malware, Lumen IT Solutions Limited accepts no liability for any damage caused by email transmission. It is the recipient’s responsibility to check ' +
  'for potential threats. Lumen IT Solutions Limited is a company registered in England and Wales under company number 14951068. Our registered office is at ' +
  'Gemini House, Hargreaves Road, Groundwell Industrial Estate, Swindon, England, SN25 5AZ. If you have received this email in error or require assistance, ' +
  'please contact us at <a href="mailto:sp@lumenmsp.co.uk" style="color:#9ca3af;">sp@lumenmsp.co.uk</a>.';

// Default signature (used when no custom one is saved in Branding).
export function buildSignatureHtml(senderName: string, bannerImg = ''): string {
  const name = escapeHtml((senderName || 'The Lumen MSP Team').trim());
  return `
  <br>
  <table cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333333;line-height:1.5;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:18px;max-width:560px;">
    <tr><td>
      Kind regards,<br><br>
      <strong style="font-size:15px;color:#111111;">${name}</strong><br>
      <span style="color:#6b7280;">Lumen IT Solutions</span>
      <table cellpadding="0" cellspacing="0" style="font-size:13px;margin-top:10px;">
        <tr><td style="padding:1px 12px 1px 0;color:#6b7280;">Tel:</td><td><a href="tel:03333350170" style="color:#0e7490;text-decoration:none;">0333 3350170</a></td></tr>
        <tr><td style="padding:1px 12px 1px 0;color:#6b7280;">Email:</td><td><a href="mailto:sp@lumenmsp.co.uk" style="color:#0e7490;text-decoration:none;">sp@lumenmsp.co.uk</a></td></tr>
        <tr><td style="padding:1px 12px 1px 0;color:#6b7280;">Web:</td><td><a href="https://www.lumenmsp.co.uk" style="color:#0e7490;text-decoration:none;">www.lumenmsp.co.uk</a></td></tr>
      </table>
      ${bannerHtml(bannerImg)}
      <div style="margin-top:14px;border-top:1px solid #e5e7eb;padding-top:9px;color:#9ca3af;font-size:10px;line-height:1.55;">${DISCLAIMER}</div>
    </td></tr>
  </table>`;
}

// Returns the effective signature: a custom one from Branding if set (with {{name}}
// substituted), otherwise the default. Always awaited from the mailer.
export async function getSignatureHtml(senderName: string): Promise<string> {
  const name = (senderName || 'The Lumen MSP Team').trim();
  const custom = await getSetting('branding', 'email_signature');
  if (custom && custom.trim()) {
    return custom.replace(/\{\{\s*name\s*\}\}/gi, escapeHtml(name));
  }
  const bannerImg = (await getSetting('branding', 'email_banner_url')) || '';
  return buildSignatureHtml(senderName, bannerImg);
}
