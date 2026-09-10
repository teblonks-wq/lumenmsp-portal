import crypto from 'crypto';
import { config } from '../config';

// ── The "you can book us" link token ────────────────────────────────────────────
//
// Every branded email we send carries a link to the public booking page. The token on
// the end of it says ONLY who we sent it to, so the page can greet them by name and
// pre-fill their details instead of asking a customer of eight years to type their own
// email address again.
//
// Three deliberate limits:
//   1. It identifies a CONTACT. It does not carry a case, a customer id or any claim
//      about what they may book — a forwarded link must not hand a stranger anything.
//   2. It is signed, not looked up. No table, no write on send, no token to expire, and
//      a tampered contact id simply fails the signature and falls back to the plain page.
//   3. It is never a credential. Nothing behind it is private: the public page shows the
//      same services to a signed link and a bare one. Losing it costs nothing.
//
// The signature is keyed on SESSION_SECRET, so rotating that secret invalidates every
// link in flight — links degrade to the anonymous page, which is a nuisance, not a fault.

const KEY = () => String(config.SESSION_SECRET || 'lumen-book');

function sign(contactId: number): string {
  return crypto.createHmac('sha256', KEY()).update(`book:${contactId}`).digest('hex').slice(0, 16);
}

/** The token to hang on a booking link for a known contact. Empty string when we have no contact. */
export function mintBookToken(contactId: number | null | undefined): string {
  const id = Number(contactId);
  return Number.isInteger(id) && id > 0 ? `${id}-${sign(id)}` : '';
}

/** The contact id a token vouches for, or null. Never throws, never queries. */
export function readBookToken(raw: unknown): number | null {
  const m = /^(\d{1,9})-([0-9a-f]{16})$/.exec(String(raw || ''));
  if (!m) return null;
  const id = Number(m[1]);
  const want = Buffer.from(sign(id));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return id;
}

/** The public booking URL, with the contact's token when we know who we are writing to. */
export function bookingUrl(contactId?: number | null, slug?: string | null): string {
  const base = String(config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, '');
  const t = mintBookToken(contactId);
  return `${base}/book${slug ? '/' + encodeURIComponent(slug) : ''}${t ? '?t=' + t : ''}`;
}
