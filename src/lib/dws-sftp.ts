import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { pool } from '../db/pool';
import { ingestCallCsv } from './calls-ingest';
import { applyAllCustomerRanges } from './comms-billing';
import { importGiacomServicesCsv, looksLikeServicesCsv } from './giacom-comms-import';

// DWS / Giacom bill-run ingest over SFTP.
// Strategy: LEAVE files on the server (never delete) and TRACK what we've ingested
// in dws_files, so each file is processed exactly once and runs are idempotent +
// re-runnable. Downloaded files are kept in a NON-public storage dir for audit.
//
// External libs loaded via require so the build doesn't depend on their type defs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SftpClient: any = require('ssh2-sftp-client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse: csvParse } = require('csv-parse/sync');

const STORE_DIR = path.join(process.cwd(), 'storage', 'dws-billruns'); // NOT under /static
fs.mkdirSync(STORE_DIR, { recursive: true });

export function dwsConfigured(): boolean {
  return !!(config.DWS_SFTP_HOST && config.DWS_SFTP_USER && config.DWS_SFTP_PASS);
}

export interface DwsFetchResult { found: number; downloaded: number; skipped: number; errors: number; entries: string[] }

// Recursively walks the SFTP tree from `remoteDir`, downloads any file we haven't
// seen, records it (+ detected CSV columns) and LEAVES it on the server.
export async function fetchDwsBillRuns(remoteDir: string = config.DWS_REMOTE_DIR || '/Monthly'): Promise<DwsFetchResult> {
  const res: DwsFetchResult = { found: 0, downloaded: 0, skipped: 0, errors: 0, entries: [] };
  if (!dwsConfigured()) return res;

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: config.DWS_SFTP_HOST, port: config.DWS_SFTP_PORT,
      username: config.DWS_SFTP_USER, password: config.DWS_SFTP_PASS,
      readyTimeout: 20000,
    });
    try { console.log('[dws] connected; base dir:', await sftp.realPath('.')); } catch { /* ignore */ }

    // Collect regular files anywhere under remoteDir (depth-limited).
    const collected: { name: string; path: string; size: number; mtime: number }[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
      let entries: any[] = [];
      try { entries = await sftp.list(dir); } catch (e) { console.error('[dws] list failed', dir, (e as Error).message); return; }
      for (const e of entries) {
        if (e.name === '.' || e.name === '..') continue;
        const full = (dir.replace(/\/$/, '') || '') + '/' + e.name;
        if (depth === 0) res.entries.push(e.type === 'd' ? e.name + '/' : e.name);
        if (e.type === '-') collected.push({ name: e.name, path: full, size: e.size || 0, mtime: e.modifyTime || 0 });
        else if (e.type === 'd' && depth < 4) await walk(full, depth + 1);
      }
    }
    await walk(remoteDir, 0);
    res.found = collected.length;
    if (!collected.length) console.log('[dws] no files found. Top-level entries:', res.entries.join(', ') || '(empty)');

    // Newest first + per-run cap so a deep history backlog is pulled in safe batches
    // (re-run / nightly cron chips through the rest).
    collected.sort((a, b) => b.mtime - a.mtime);
    const batch = collected.slice(0, config.DWS_MAX_PER_RUN || 50);

    const done = new Set((await pool.query('SELECT filename FROM dws_files')).rows.map((r: any) => r.filename));

    for (const f of batch) {
      if (done.has(f.name)) { res.skipped++; continue; }
      const remote = f.path;
      const localPath = path.join(STORE_DIR, f.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
      try {
        await sftp.fastGet(remote, localPath); // download only — file stays on the server
        const buf = fs.readFileSync(localPath);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');

        // Best-effort column detection for CSVs so we can map the format later.
        let columns: string | null = null;
        let rows = 0;
        let status = 'downloaded';
        if (/\.csv$/i.test(f.name)) {
          try {
            const recs: any[] = csvParse(buf, { columns: true, skip_empty_lines: true, relax_column_count: true });
            rows = recs.length;
            columns = recs.length ? Object.keys(recs[0]).join(', ') : (buf.toString('utf8').split(/\r?\n/)[0] || '');
            status = 'parsed';
            // If it's an itemized-calls file, ingest it straight into call_records.
            try {
              const ing = await ingestCallCsv(buf, f.name);
              if (ing) { rows = ing.inserted; status = 'calls_ingested'; console.log(`[dws] ingested ${ing.inserted} calls (${ing.matched} matched) from ${f.name}`); }
            } catch (e) { console.error('[dws] call ingest failed for', f.name, (e as Error).message); }
            // If it's a SERVICES file, import it straight into the register (per-period replace,
            // never clobbers other months) — a new month's bill data lands hands-off at 05:30.
            if (status !== 'calls_ingested' && /_Services\.csv$/i.test(f.name) && looksLikeServicesCsv(buf)) {
              try {
                const imp = await importGiacomServicesCsv(buf);
                rows = imp.inserted; status = 'services_imported';
                console.log(`[dws] imported ${imp.inserted} service lines (${imp.matched} matched) from ${f.name} — period(s) ${imp.periods.join(', ')}${imp.refreshedProjections.length ? '; re-projected ' + imp.refreshedProjections.join(', ') : ''}`);
              } catch (e) { console.error('[dws] services import failed for', f.name, (e as Error).message); }
            }
          } catch {
            columns = (buf.toString('utf8').split(/\r?\n/)[0] || '').slice(0, 500);
          }
        }

        await pool.query(
          `INSERT INTO dws_files (filename, remote_path, size, hash, status, rows_parsed, columns)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (filename) DO NOTHING`,
          [f.name, remote, f.size || null, hash, status, rows, columns]
        );
        res.downloaded++;
      } catch (e) {
        res.errors++;
        console.error('[dws] file failed:', f.name, (e as Error).message);
        try {
          await pool.query(
            `INSERT INTO dws_files (filename, remote_path, status, error) VALUES ($1,$2,'error',$3)
             ON CONFLICT (filename) DO NOTHING`,
            [f.name, remote, (e as Error).message.slice(0, 400)]
          );
        } catch { /* ignore */ }
      }
    }
  } finally {
    try { await sftp.end(); } catch { /* ignore */ }
  }
  // New records in → auto-allocate any CLIs/calls that fall in a customer's stored number range.
  if (res.downloaded > 0) {
    try { const a = await applyAllCustomerRanges(); console.log(`[dws] range auto-allocate: ${a.lines} line(s), ${a.calls} call(s) across ${a.ranges} range(s)`); }
    catch (e) { console.error('[dws] range auto-allocate failed:', (e as Error).message); }
  }
  return res;
}

// One-shot backfill: walk the ENTIRE DWS tree (no per-run cap, no skip) and ingest every
// itemized-calls CSV into call_records. Idempotent per file. Use to pull the full history.
export async function backfillDwsCalls(remoteDir: string = config.DWS_REMOTE_DIR || '/Monthly'): Promise<{ files: number; callFiles: number; inserted: number; matched: number; errors: number }> {
  const res = { files: 0, callFiles: 0, inserted: 0, matched: 0, errors: 0 };
  if (!dwsConfigured()) return res;
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: config.DWS_SFTP_HOST, port: config.DWS_SFTP_PORT, username: config.DWS_SFTP_USER, password: config.DWS_SFTP_PASS, readyTimeout: 20000 });
    const collected: { name: string; path: string }[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
      let entries: any[] = [];
      try { entries = await sftp.list(dir); } catch (e) { console.error('[dws] backfill list failed', dir, (e as Error).message); return; }
      for (const e of entries) {
        if (e.name === '.' || e.name === '..') continue;
        const full = (dir.replace(/\/$/, '') || '') + '/' + e.name;
        if (e.type === '-') collected.push({ name: e.name, path: full });
        else if (e.type === 'd' && depth < 4) await walk(full, depth + 1);
      }
    }
    await walk(remoteDir, 0);
    res.files = collected.length;
    for (const f of collected) {
      if (!/\.csv$/i.test(f.name)) continue;
      const localPath = path.join(STORE_DIR, f.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
      try {
        await sftp.fastGet(f.path, localPath);
        const buf = fs.readFileSync(localPath);
        const ing = await ingestCallCsv(buf, f.name);
        if (ing) {
          res.callFiles++; res.inserted += ing.inserted; res.matched += ing.matched;
          await pool.query(
            `INSERT INTO dws_files (filename, remote_path, status, rows_parsed) VALUES ($1,$2,'calls_ingested',$3)
             ON CONFLICT (filename) DO UPDATE SET status='calls_ingested', rows_parsed=EXCLUDED.rows_parsed, ingested_at=NOW()`,
            [f.name, f.path, ing.inserted]
          );
        }
      } catch (e) { res.errors++; console.error('[dws] backfill failed', f.name, (e as Error).message); }
    }
  } finally { try { await sftp.end(); } catch { /* ignore */ } }
  try { const a = await applyAllCustomerRanges(); console.log(`[dws] range auto-allocate: ${a.lines} line(s), ${a.calls} call(s) across ${a.ranges} range(s)`); }
  catch (e) { console.error('[dws] range auto-allocate failed:', (e as Error).message); }
  console.log(`[dws] backfill: ${res.callFiles} call file(s), ${res.inserted} calls, ${res.matched} matched, ${res.errors} errors`);
  return res;
}

let _started = false;
export function startDwsSync(): void {
  if (_started) return;
  _started = true;
  // Daily at 05:30 — bill runs are monthly, but a daily idempotent check costs nothing.
  cron.schedule('30 5 * * *', () => {
    fetchDwsBillRuns()
      .then((r) => { if (r.downloaded) console.log(`[dws] fetched ${r.downloaded} new bill-run file(s) (${r.skipped} skipped)`); })
      .catch((e) => console.error('[dws] fetch error:', e.message));
  });
  console.log('[dws] bill-run SFTP check scheduled (05:30 daily)');
}
