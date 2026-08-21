import 'dotenv/config';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { config } from '../config';
import { getKeyVaultSecret, keyVaultConfigured } from '../lib/azure-keyvault';

// Rotate the credential-vault master key: decrypt every stored secret with the OLD key and
// re-encrypt with a NEW one.
//
// Why this has to exist before anyone changes that key: AES-256-GCM authenticates before
// it decrypts, so a wrong key does not garble the password - it throws. Swap the key in
// Key Vault with 180 customer credentials encrypted under the old one and all 180 are
// permanently unreadable. There is no partial recovery and no way back without the old key.
//
// SAFETY, in the order it matters:
//   1. DRY RUN BY DEFAULT. Nothing is written unless you pass --commit.
//   2. EVERY row is decrypted and re-encrypted in memory FIRST. If a single row fails, the
//      whole rotation aborts having changed nothing - a half-rotated table is the one
//      outcome worse than not rotating.
//   3. One transaction, with the rows locked, so a credential saved mid-run cannot be
//      written with the old key and then orphaned.
//   4. Plaintext is never printed, never logged, never written to disk.
//
// Run on the server:
//   node dist/scripts/rotate-vault-key.js                      # dry run, proves it can
//   NEW_VAULT_KEY=<base64-32-bytes> node dist/scripts/rotate-vault-key.js --commit
//
// Generate a new key with:  openssl rand -base64 32

interface Target { table: string; col: string; label: string }
const TARGETS: Target[] = [
  { table: 'customer_credentials',        col: 'secret_encrypted', label: 'customer credentials' },
  { table: 'supplier_credentials',        col: 'secret_encrypted', label: 'supplier credentials' },
  { table: 'network_device_credentials',  col: 'secret_enc',       label: 'network device credentials' },
];

function toKey(raw: string, what: string): Buffer {
  if (!raw) throw new Error(`${what} is empty.`);
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${what} must decode to 32 bytes (got ${buf.length}).`);
  return buf;
}
function dec(blob: string, key: Buffer): string {
  const [iv, tag, data] = String(blob).split('.');
  if (!iv || !tag || !data) throw new Error('malformed blob');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
function enc(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), out.toString('base64')].join('.');
}

async function currentKeyRaw(): Promise<string> {
  if (keyVaultConfigured()) {
    try { return await getKeyVaultSecret(config.AZURE_KEYVAULT_SECRET); }
    catch (e: any) { console.log('  (Key Vault unreadable: %s - falling back to VAULT_KEY)', e.message); }
  }
  return config.VAULT_KEY;
}

async function main() {
  const commit = process.argv.includes('--commit');
  console.log('=== Vault key rotation ===');
  console.log(commit ? 'MODE: COMMIT - changes will be written.' : 'MODE: dry run - nothing will be written.');

  const oldKey = toKey(await currentKeyRaw(), 'the current key');
  const newRaw = process.env.NEW_VAULT_KEY || '';
  const newKey = newRaw ? toKey(newRaw, 'NEW_VAULT_KEY') : null;
  if (commit && !newKey) throw new Error('--commit needs NEW_VAULT_KEY set. Generate one with: openssl rand -base64 32');
  if (newKey && newKey.equals(oldKey)) throw new Error('NEW_VAULT_KEY is the same as the current key - nothing to do.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let total = 0, failed = 0;
    const plan: Array<{ t: Target; id: number; blob: string }> = [];

    for (const t of TARGETS) {
      // A table that does not exist yet is not an error - network_device_credentials is
      // new and may be empty or absent on an older database.
      const exists = (await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS ok`, [t.table])).rows[0].ok;
      if (!exists) { console.log('- %s: table not present, skipped', t.label); continue; }

      // FOR UPDATE: a credential saved while this runs would otherwise be written with the
      // old key after we had read the table, and be unreadable the moment the key changes.
      const rows = (await client.query(
        `SELECT id, ${t.col} AS blob FROM ${t.table} WHERE ${t.col} IS NOT NULL AND ${t.col} <> '' FOR UPDATE`)).rows;

      let ok = 0;
      for (const r of rows) {
        try { dec(r.blob, oldKey); ok++; plan.push({ t, id: Number(r.id), blob: r.blob }); }
        catch { failed++; console.log('  ! %s id=%s WILL NOT DECRYPT with the current key', t.table, r.id); }
      }
      total += rows.length;
      console.log('- %s: %d row(s), %d decrypt cleanly', t.label, rows.length, ok);
    }

    if (failed) {
      await client.query('ROLLBACK');
      console.log('\nABORTED: %d row(s) do not decrypt with the current key.', failed);
      console.log('Rotating now would make them permanently unreadable. Investigate those rows first.');
      process.exit(2);
    }

    console.log('\n%d secret(s) verified against the current key.', total);
    if (!commit) {
      await client.query('ROLLBACK');
      console.log('Dry run only - nothing changed.');
      console.log('To rotate:  NEW_VAULT_KEY=$(openssl rand -base64 32) node dist/scripts/rotate-vault-key.js --commit');
      return;
    }

    for (const p of plan) {
      const plain = dec(p.blob, oldKey);
      await client.query(`UPDATE ${p.t.table} SET ${p.t.col} = $1 WHERE id = $2`, [enc(plain, newKey!), p.id]);
    }
    await client.query('COMMIT');
    console.log('COMMITTED: %d secret(s) re-encrypted with the new key.', plan.length);
    console.log('\nNOW, IN THIS ORDER - the database is already on the new key, so until you do this');
    console.log('the running Portal cannot read any of them:');
    console.log('  1. Add the new key to Key Vault as a NEW VERSION of "%s".', config.AZURE_KEYVAULT_SECRET);
    console.log('  2. Update VAULT_KEY in .env to the new key (the fallback must agree).');
    console.log('  3. pm2 restart lumenmsp-portal');
    console.log('  4. Open a stored credential in the Portal and reveal it. If it shows, you are done.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw e;
  } finally { client.release(); }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
