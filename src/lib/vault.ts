import crypto from 'crypto';
import { config } from '../config';
import { getKeyVaultSecret, keyVaultConfigured } from './azure-keyvault';

// Per-customer credential vault encryption. AES-256-GCM with a 32-byte key from
// VAULT_KEY (base64 or hex). Stored blob format: base64(iv).base64(tag).base64(ciphertext).
// Plaintext is never logged and never leaves the server except on an explicit reveal.

// Filled once at boot from Key Vault (see initVaultKey). Kept in memory only: writing it
// anywhere on disk would undo the entire point of moving it off disk.
let fetchedKey: string | null = null;

/**
 * Load the master key from Azure Key Vault, using the VM's managed identity.
 *
 * Deliberately NEVER throws. If the vault is unreachable - a network blip, a role removed,
 * IMDS not answering because this is somebody's laptop - the Portal falls back to whatever
 * VAULT_KEY is in the environment and says so loudly. A secrets store having a bad ten
 * minutes must not take the whole Portal down with it, and a silent fallback would be
 * worse still: you would never learn that the vault stopped working.
 */
export async function initVaultKey(): Promise<void> {
  if (!keyVaultConfigured()) {
    if (config.VAULT_KEY) console.log('[vault] Key Vault not configured - using VAULT_KEY from the environment.');
    return;
  }
  try {
    fetchedKey = await getKeyVaultSecret(config.AZURE_KEYVAULT_SECRET);
    console.log('[vault] master key loaded from Azure Key Vault (%s).', config.AZURE_KEYVAULT_URL);
    if (config.VAULT_KEY) {
      console.log('[vault] VAULT_KEY is still set in .env - once this has run cleanly a few times, remove it. '
        + 'That removal is the moment the key stops living on disk.');
    }
  } catch (e: any) {
    console.error('[vault] COULD NOT READ THE KEY FROM KEY VAULT: %s', e.message);
    console.error('[vault] falling back to VAULT_KEY from the environment%s.',
      config.VAULT_KEY ? '' : ' - which is NOT SET, so the credential vault is disabled');
  }
}

function key(): Buffer {
  // Key Vault first, environment second. Same key either way - this is about where it
  // is read from, not what it is.
  const raw = fetchedKey || config.VAULT_KEY;
  if (!raw) throw new Error('No master key — set AZURE_KEYVAULT_URL (preferred) or VAULT_KEY in the server .env.');
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
