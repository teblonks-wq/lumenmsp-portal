import crypto from 'crypto';
import { getGroup } from './settings';

// WhatsApp Business Platform via Meta's Cloud API (direct). Config lives in settings group
// 'whatsapp' (managed in Settings → Integrations). Outbound free-form text only works inside
// the 24h customer-service window; outside it Meta requires an approved template.
const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WaConfig {
  phoneNumberId: string;   // the Cloud API phone number id (NOT the display number)
  token: string;           // permanent system-user access token
  verifyToken: string;     // our chosen webhook verify token
  appSecret: string;       // Meta app secret — verifies inbound payload signatures
  businessNumber: string;  // display number, for showing in the UI
  wabaId: string;          // WhatsApp Business Account id — for the template Management API
}

export async function whatsappConfig(): Promise<WaConfig> {
  const g = await getGroup('whatsapp');
  return {
    phoneNumberId: g.phone_number_id || '',
    token: g.access_token || '',
    verifyToken: g.verify_token || '',
    appSecret: g.app_secret || '',
    businessNumber: g.business_number || '',
    wabaId: g.waba_id || '',
  };
}

export async function whatsappConfigured(): Promise<boolean> {
  const c = await whatsappConfig();
  return !!(c.phoneNumberId && c.token);
}

// Normalise a number to Meta's wa_id form (country code + number, digits only). Assumes UK
// for bare 0-prefixed numbers.
export function normaliseWaNumber(raw: string): string {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 11) d = '44' + d.slice(1); // UK
  return d;
}

// Rough HTML → plain text for WhatsApp (no markup support).
export function htmlToPlain(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3?9;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Verify an inbound webhook payload signature (X-Hub-Signature-256). Returns true if no app
// secret is configured (so it doesn't hard-block before setup), else checks the HMAC.
export function verifyWaSignature(appSecret: string, rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!appSecret) return true;
  if (!rawBody || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header)); } catch { return false; }
}

export interface WaMedia { ok: boolean; buffer?: Buffer; mime?: string; error?: string; }

// Download an inbound media object (image / document / audio / video / sticker). Meta sends a
// media *id* on the webhook — you must (1) resolve the id to a short-lived URL, then (2) fetch
// that URL with the Bearer token. Both calls need the access token.
export async function fetchWhatsAppMedia(mediaId: string): Promise<WaMedia> {
  const c = await whatsappConfig();
  if (!c.token) return { ok: false, error: 'WhatsApp not configured' };
  if (!mediaId) return { ok: false, error: 'No media id' };
  try {
    const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${c.token}` } });
    const mj: any = await meta.json().catch(() => ({}));
    if (!meta.ok || !mj.url) return { ok: false, error: mj?.error?.message || ('media meta HTTP ' + meta.status) };
    const bin = await fetch(mj.url, { headers: { Authorization: `Bearer ${c.token}` } });
    if (!bin.ok) return { ok: false, error: 'media download HTTP ' + bin.status };
    const buffer = Buffer.from(await bin.arrayBuffer());
    return { ok: true, buffer, mime: mj.mime_type || bin.headers.get('content-type') || 'application/octet-stream' };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export interface WaSendResult { ok: boolean; id?: string; error?: string; reEngagement?: boolean; }

// Send an approved template message (works outside the 24h window / to start a conversation).
export async function sendWhatsAppTemplate(to: string, name: string, lang: string, bodyParams: string[]): Promise<WaSendResult> {
  const c = await whatsappConfig();
  if (!c.phoneNumberId || !c.token) return { ok: false, error: 'WhatsApp not configured' };
  const num = normaliseWaNumber(to);
  if (!num) return { ok: false, error: 'No valid recipient number' };
  const components = bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: String(p).slice(0, 1024) })) }] : [];
  try {
    const res = await fetch(`${GRAPH}/${c.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'template', template: { name, language: { code: lang }, components } }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.error_user_msg || data?.error?.message || ('HTTP ' + res.status) };
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

// Send a free-form text message (only valid inside the 24h window).
export async function sendWhatsAppText(to: string, body: string): Promise<WaSendResult> {
  const c = await whatsappConfig();
  if (!c.phoneNumberId || !c.token) return { ok: false, error: 'WhatsApp not configured' };
  const num = normaliseWaNumber(to);
  if (!num) return { ok: false, error: 'No valid recipient number' };
  try {
    const res = await fetch(`${GRAPH}/${c.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'text', text: { preview_url: false, body: body.slice(0, 4096) } }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data?.error?.code;
      // 131047 = "re-engagement message" — outside the 24h window, a template is required.
      return { ok: false, error: data?.error?.message || ('HTTP ' + res.status), reEngagement: code === 131047 };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (e: any) { return { ok: false, error: e.message }; }
}
