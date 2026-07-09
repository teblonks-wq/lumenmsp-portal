import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse } = require('csv-parse/sync');

// Imports itemized call records (CDRs) for billing. Handles the landline format
// (Customer CLI / Telephone Number / Call Date / Duration / Sales Price) and the
// mobile format (MOBILE NUMBER / DIALLED / EVENT DATE / DURATION / Cost). Each call's
// line CLI is mapped to a customer via the CLI directory (customer_external_ids 'cli').
// Idempotent per file (re-running the same file replaces its rows).
//
// Usage:  node dist/scripts/import-calls.js "<calls.csv>"

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };
const pick = (r: any, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); } return ''; };
function durToSec(d: string): number {
  d = String(d || '').trim(); if (!d) return 0;
  if (d.indexOf(':') >= 0) { const p = d.split(':').map(Number); if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2]; if (p.length === 2) return p[0]*60 + p[1]; }
  return parseInt(d, 10) || 0;
}
function parseWhen(dateStr: string, timeStr: string): Date | null {
  const d = String(dateStr || '').trim(); const t = String(timeStr || '').trim();
  let iso: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) iso = d.slice(0, 10);
  else { const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) iso = `${m[3]}-${m[2]}-${m[1]}`; }
  if (!iso) return null;
  const tt = /^\d{2}:\d{2}/.test(t) ? (t.slice(0, 8).length === 5 ? t.slice(0, 5) + ':00' : t.slice(0, 8)) : '00:00:00';
  const dt = new Date(iso + 'T' + tt + 'Z'); return isNaN(dt.getTime()) ? null : dt;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set (check .env).'); process.exit(1); }
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage: import-calls.js "<calls.csv>"'); process.exit(1); }

  const recs: any[] = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const base = path.basename(file);
  const isMobile = recs.length > 0 && recs[0]['MOBILE NUMBER'] !== undefined;
  const source = isMobile ? 'mobile' : 'landline';

  // CLI → customer directory (normalise: strip whitespace).
  const dir = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='cli'")).rows
    .forEach((r: any) => dir.set(String(r.external_id).replace(/\s+/g, ''), r.customer_id));

  const client = await pool.connect();
  let inserted = 0, matched = 0;
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM call_records WHERE source_file=$1", [base]);
    for (const r of recs) {
      const cli = pick(r, ['Customer CLI', 'MOBILE NUMBER']).replace(/\s+/g, '');
      if (!cli) continue;
      const dialled = pick(r, ['Telephone Number', 'DIALLED']);
      const callAt = parseWhen(pick(r, ['Call Date', 'EVENT DATE']), pick(r, ['Call Time', 'TIME']));
      const dur = durToSec(pick(r, ['Duration', 'DURATION']));
      const desc = pick(r, ['Description', 'NETWORK']);
      const cost = num(pick(r, ['Sales Price', 'Cost']));
      const cid = dir.get(cli) ?? null;
      const period = callAt ? callAt.toISOString().slice(0, 7) : null;
      if (cid) matched++;
      await client.query(
        `INSERT INTO call_records (source, source_file, cli, customer_id, dialled, call_at, duration_sec, description, cost, billing_period)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [source, base, cli, cid, dialled || null, callAt, dur, desc || null, cost, period]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  console.log(`✓ Calls import (${source}) ${base}: ${inserted} calls, ${matched} mapped to a customer via CLI.`);
  await pool.end();
}

main().catch((e) => { console.error('Calls import failed:', e); process.exit(1); });
