/**
 * Read secrets from Azure Key Vault using the VM's system-assigned managed identity.
 *
 * No SDK on purpose. @azure/identity and @azure/keyvault-secrets pull in a large
 * dependency tree to make two HTTPS calls we can make ourselves, and adding packages to
 * this repo means an npm install in the deploy path for something that has to work at
 * boot before anything else does. Both calls are below and they are the whole protocol.
 *
 * The point of managed identity: there is NO credential anywhere. The VM asks the Azure
 * Instance Metadata Service - a link-local address only reachable from inside the VM -
 * for a token, and Key Vault trusts that token because of the RBAC role assignment. So
 * the master key stops living in a file on disk, which was the actual weakness; the
 * cipher was never the problem.
 */
import { config } from '../config';

const IMDS = 'http://169.254.169.254/metadata/identity/oauth2/token';
const RESOURCE = 'https://vault.azure.net';

let token: { value: string; expires: number } | null = null;

/** Fetch (and cache) a managed-identity access token for Key Vault. */
async function imdsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.expires - 120 > now) return token.value;

  // IMDS is link-local and unreachable from anywhere but the VM itself, so on a dev
  // machine this must fail FAST rather than hang the boot for a minute.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const url = `${IMDS}?api-version=2018-02-01&resource=${encodeURIComponent(RESOURCE)}`;
    const r = await fetch(url, { headers: { Metadata: 'true' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`IMDS ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    if (!j.access_token) throw new Error('IMDS returned no access_token');
    token = { value: j.access_token, expires: parseInt(j.expires_on, 10) || (now + 3000) };
    return token.value;
  } finally { clearTimeout(t); }
}

/** Read one secret's current value. Throws with a message worth reading. */
export async function getKeyVaultSecret(name: string): Promise<string> {
  const base = String(config.AZURE_KEYVAULT_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('AZURE_KEYVAULT_URL is not set.');
  const tok = await imdsToken();
  const r = await fetch(`${base}/secrets/${encodeURIComponent(name)}?api-version=7.4`,
    { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 403) {
    throw new Error('Key Vault refused the read (403). The VM identity needs the '
      + '"Key Vault Secrets User" role ON THE VAULT - subscription Owner is not enough, '
      + 'the data plane is separate.');
  }
  if (!r.ok) throw new Error(`Key Vault ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (!j.value) throw new Error(`Secret "${name}" has no value.`);
  return String(j.value);
}

export function keyVaultConfigured(): boolean {
  return !!String(config.AZURE_KEYVAULT_URL || '').trim();
}
