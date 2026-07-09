import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cron from 'node-cron';
import { config } from '../config';
import { getGroup, setSetting } from './settings';

// Self-contained portal backup: dumps the portal DB, tars the uploaded files, encrypts the
// bundle (AES-256) and uploads it to Azure Blob — all driven from Admin → Backups. Uses the
// box's own tools (pg_dump / tar / openssl / az) so there's no extra Node dependency.

export interface BackupResult { ok: boolean; file?: string; size?: number; error?: string; }
export interface BackupStatus {
  configured: boolean; enabled: boolean; lastRun: string; lastStatus: string;
  lastFile: string; lastSize: number; lastError: string; lastTrigger: string;
  retentionDays: number; hour: number;
  account: string; container: string; prefix: string; keySet: boolean; passSet: boolean; passClue: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ code: -1, out, err: String((e as Error).message) }));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function dumpDb(dbUrl: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Don't pass the password inside the connection URI — pg_dump's URI parser mis-reads special
    // characters (@ / ! etc.) in the password and fails with "could not translate host name".
    // Parse the URL and pass discrete flags + the password via PGPASSWORD, which takes any chars.
    let u: URL;
    try { u = new URL(dbUrl); } catch (e) { reject(new Error('Invalid database URL: ' + (e as Error).message)); return; }
    const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
    const env = { ...process.env, PGPASSWORD: dec(u.password || '') };
    const args = ['-Fc', '--no-owner',
      '-h', u.hostname || 'localhost',
      '-p', u.port || '5432',
      '-U', dec(u.username || ''),
      (u.pathname || '').replace(/^\//, '') || 'postgres'];
    const ws = fs.createWriteStream(outFile);
    const p = spawn('pg_dump', args, { env });
    let err = '';
    p.stdout.pipe(ws);
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('pg_dump failed: ' + err.slice(0, 300)))));
  });
}

function fileDirs(): string[] {
  const root = process.cwd();
  return [
    path.join(root, 'static', 'attachments'),
    path.join(root, 'static', 'branding'),
    path.join(root, 'uploads'),
  ].filter((d) => fs.existsSync(d));
}

async function setStatus(status: string, file: string | null, size: number, error: string | null, trigger: string): Promise<void> {
  await setSetting('backup', 'last_run', new Date().toISOString());
  await setSetting('backup', 'last_status', status);
  await setSetting('backup', 'last_file', file || '');
  await setSetting('backup', 'last_size', String(size || 0));
  await setSetting('backup', 'last_error', error || '');
  await setSetting('backup', 'last_trigger', trigger);
}

let _running = false;
export function backupRunning(): boolean { return _running; }

export async function runBackup(trigger = 'manual'): Promise<BackupResult> {
  if (_running) return { ok: false, error: 'A backup is already running.' };
  const cfg = await getGroup('backup');
  const acct = cfg.az_account || '', key = cfg.az_key || '', cont = cfg.az_container || '';
  const prefix = cfg.az_prefix || 'portal-backups/';
  const pass = cfg.passphrase || '';
  if (!acct || !key || !cont) throw new Error('Azure storage is not configured (account / key / container).');
  if (!pass) throw new Error('Encryption passphrase is not set.');

  _running = true;
  await setStatus('running', null, 0, null, trigger);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lmbk-'));
  let bundle = '';
  try {
    // 1. databases — the portal DB, plus the Insights DB (lumenmsp_insights) when configured,
    //    so one nightly backup covers both. The Insights app's own backup job is now disabled.
    await dumpDb(config.DATABASE_URL, path.join(work, 'portal.dump'));
    if (config.INSIGHTS_DATABASE_URL) {
      await dumpDb(config.INSIGHTS_DATABASE_URL, path.join(work, 'insights.dump'));
    }
    // 2. uploaded files
    const dirs = fileDirs();
    if (dirs.length) {
      const r = await run('tar', ['-czf', path.join(work, 'files.tar.gz'), ...dirs]);
      if (r.code !== 0) throw new Error('tar files failed: ' + r.err.slice(0, 200));
    }
    // 3. .env (secrets live only inside the encrypted bundle)
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) fs.copyFileSync(envPath, path.join(work, 'env.txt'));

    // 4. bundle + encrypt
    bundle = path.join(os.tmpdir(), `lumenmsp-${stamp}.tar.gz`);
    let r = await run('tar', ['-czf', bundle, '-C', work, '.']);
    if (r.code !== 0) throw new Error('bundle failed: ' + r.err.slice(0, 200));
    const enc = bundle + '.enc';
    r = await run('openssl', ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-in', bundle, '-out', enc, '-pass', 'pass:' + pass]);
    try { fs.unlinkSync(bundle); } catch { /* noop */ }
    bundle = enc;
    if (r.code !== 0) throw new Error('encrypt failed: ' + r.err.slice(0, 200));
    const size = fs.statSync(enc).size;

    // 5. upload to Azure Blob
    const blobName = prefix + path.basename(enc);
    r = await run('az', ['storage', 'blob', 'upload', '--account-name', acct, '--account-key', key,
      '--container-name', cont, '--file', enc, '--name', blobName, '--overwrite', '--only-show-errors']);
    if (r.code !== 0) throw new Error('Azure upload failed: ' + (r.err || r.out).slice(0, 300));

    // 6. rotate old blobs
    await rotate(cfg);
    await setStatus('ok', blobName, size, null, trigger);
    return { ok: true, file: blobName, size };
  } catch (e: any) {
    await setStatus('failed', null, 0, e.message, trigger);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* noop */ }
    try { if (bundle && fs.existsSync(bundle)) fs.unlinkSync(bundle); } catch { /* noop */ }
  }
}

async function rotate(cfg: Record<string, string>): Promise<void> {
  const days = parseInt(cfg.retention_days || '30', 10);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const prefix = cfg.az_prefix || 'portal-backups/';
  const r = await run('az', ['storage', 'blob', 'list', '--account-name', cfg.az_account, '--account-key', cfg.az_key,
    '--container-name', cfg.az_container, '--prefix', prefix, '--query', `[?properties.lastModified < '${cutoff}'].name`, '-o', 'tsv', '--only-show-errors']);
  if (r.code !== 0) return;
  const names = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    await run('az', ['storage', 'blob', 'delete', '--account-name', cfg.az_account, '--account-key', cfg.az_key,
      '--container-name', cfg.az_container, '--name', n, '--only-show-errors']);
  }
}

export async function listBackups(): Promise<{ name: string; size: number; modified: string }[]> {
  const cfg = await getGroup('backup');
  if (!cfg.az_account || !cfg.az_key || !cfg.az_container) return [];
  const prefix = cfg.az_prefix || 'portal-backups/';
  const r = await run('az', ['storage', 'blob', 'list', '--account-name', cfg.az_account, '--account-key', cfg.az_key,
    '--container-name', cfg.az_container, '--prefix', prefix,
    '--query', '[].{name:name, size:properties.contentLength, modified:properties.lastModified}', '-o', 'json', '--only-show-errors']);
  if (r.code !== 0) return [];
  try {
    const list = JSON.parse(r.out) as { name: string; size: number; modified: string }[];
    return list.sort((a, b) => (b.modified || '').localeCompare(a.modified || '')).slice(0, 60);
  } catch { return []; }
}

export async function backupStatus(): Promise<BackupStatus> {
  const c = await getGroup('backup');
  return {
    configured: !!(c.az_account && c.az_key && c.az_container && c.passphrase),
    enabled: c.enabled === 'true',
    lastRun: c.last_run || '', lastStatus: c.last_status || '', lastFile: c.last_file || '',
    lastSize: parseInt(c.last_size || '0', 10), lastError: c.last_error || '', lastTrigger: c.last_trigger || '',
    retentionDays: parseInt(c.retention_days || '30', 10), hour: parseInt(c.hour || '2', 10),
    account: c.az_account || '', container: c.az_container || '', prefix: c.az_prefix || 'portal-backups/',
    keySet: !!c.az_key, passSet: !!c.passphrase, passClue: c.pass_clue || '',
  };
}

let _started = false;
export function startBackupCron(): void {
  if (_started) return;
  _started = true;
  // Check hourly; run once when the clock hits the configured hour (so the time is editable in the UI).
  cron.schedule('30 * * * *', async () => {
    try {
      const c = await getGroup('backup');
      if (c.enabled !== 'true') return;
      if (new Date().getHours() !== parseInt(c.hour || '2', 10)) return;
      const r = await runBackup('scheduled');
      if (r.ok) console.log('[backup] scheduled OK —', r.file);
      else console.error('[backup] scheduled FAILED —', r.error);
    } catch (e) { console.error('[backup] cron error:', (e as Error).message); }
  });
  console.log('[backup] scheduler started');
}
