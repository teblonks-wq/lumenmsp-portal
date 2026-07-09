import crypto from 'crypto';
import { config } from '../config';

// Per-customer credential vault encryption. AES-256-GCM with a 32-byte key from
// VAULT_KEY (base64 or hex). Stored blob format: base64(iv).base64(tag).base64(ciphertext).
// Plaintext is never logged and never leaves the server except on an explicit reveal.

function key(): Buffer {
  const raw = config.VAULT_KEY;
  if (!raw) throw new Error('VAULT_KEY is not set — the password vault is disabled until a key is configured in the server .env.');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('VAULT_KEY must decode to 32 bytes (use a base64 or hex 256-bit key).');
  return buf;
}

export function vaultConfigured(): boolean {
  try { key(); return true; } catch { return false; }
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, dataB64] = String(blob).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed secret.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
