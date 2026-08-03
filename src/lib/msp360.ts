import cron from 'node-cron';
import { pool } from '../db/pool';
import { getSetting } from './settings';

// ── MSP360 Managed Backup (mspbackups.com) integration ───────────────────────────
// Pulls backup plan status + consumed storage so the monthly IT Snapshot's
// "Backup & Recovery" section fills itself. REST API at api.mspbackups.com:
//   POST /api/Provider/Login {UserName, Password}  → { access_token } (short-lived)
//   GET  /api/Monitoring                            → latest run of every plan on every endpoint
//   GET  /api/Billing                               → CurrentSpaceUsed + per-user AverageSpace (with CompanyName)
//   GET  /api/Companies                             → provider's companies (Lumen uses SHORT names here)
// Credentials: Settings → Integrations (settings group 'msp360': login/password), falling
// back to env MSP360_USER / MSP360_PASS. Generated in the MBS portal under Settings → General.
//
// Design notes:
// • MSP360 company names are SHORT ("LVG", "CUK") so nothing is matched by name. Staff link
//   companies to Portal customers explicitly via backup_provider_links (on the IT report
//   settings page). The table is provider-agnostic (provider column) and many-to-many, so a
//   customer can have several MSP360 companies AND other providers (Acronis etc.) later.
// • Sync is snapshot-style: backup_plan_status/backup_companies are replaced per provider on
//   each sync (latest state), not accumulated history.

const BASE = 'https://api.mspbackups.com';

async function creds(): Promise<{ user: string; pass: string } | null> {
  const user = ((await getSetting('msp360', 'login').catch(() => '')) || process.env.MSP360_USER || '').trim();
  const pass = ((await getSetting('msp360', 'password').catch(() => '')) || process.env.MSP360_PASS || '').trim();
  return user && pass ? { user, pass } : null;
}

export async function msp360Configured(): Promise<boolean> {
  return !!(await creds());
}

// Short-lived token cache — the API token is temporary, so re-login after 10 minutes.
let _token: { value: string; at: number } | null = null;
async function token(): Promise<string> {
  if (_token && Date.now() - _token.at < 10 * 60 * 1000) return _token.value;
  const c = await creds();
  if (!c) throw new Error('MSP360 is not configured — add the API credentials in Settings → Integrations.');
  const res = await fetch(`${BASE}/api/Provider/Login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ UserName: c.user, Password: c.pass }),
  });
  if (!res.ok) throw new Error(`MSP360 login failed (HTTP ${res.status}) — check the API credentials.`);
  const j: any = await res.json();
  const t = j.access_token || j.AccessToken || '';
  if (!t) throw new Error('MSP360 login returned no token.');
  _token = { value: t, at: Date.now() };
  return t;
}

async function apiGet(path: string): Promise<any> {
  const t = await token();
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MSP360 ${path} failed (HTTP ${res.status})`);
  return res.json();
}

// ── Schema (raw SQL — mirror in prisma/schema.prisma as no-op models, same as DMARC) ──
export async function ensureBackupTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_provider_links (
      id           SERIAL PRIMARY KEY,
      customer_id  INTEGER NOT NULL,
      provider     TEXT NOT NULL DEFAULT 'msp360',
      external_key TEXT NOT NULL,          -- MSP360 company name (short name)
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (customer_id, provider, external_key)
    );
    CREATE TABLE IF NOT EXISTS backup_companies (
      id            SERIAL PRIMARY KEY,
      provider      TEXT NOT NULL DEFAULT 'msp360',
      external_key  TEXT NOT NULL,         -- company name as the provider knows it
      users         INTEGER DEFAULT 0,
      storage_bytes BIGINT DEFAULT 0,      -- summed AverageSpace of the company's users
      synced_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (provider, external_key)
    );
    CREATE TABLE IF NOT EXISTS backup_plan_status (
      id            SERIAL PRIMARY KEY,
      provider      TEXT NOT NULL DEFAULT 'msp360',
      company       TEXT DEFAULT '',
      user_email    TEXT DEFAULT '',
      computer      TEXT DEFAULT '',
      plan_name     TEXT DEFAULT '',
      plan_type     TEXT DEFAULT '',
      status        TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      last_start    TIMESTAMPTZ,
      next_start    TIMESTAMPTZ,
      data_copied   BIGINT,
      total_data    BIGINT,
      synced_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bps_company ON backup_plan_status (provider, company);
    -- Daily history (append-only): one row per plan per day, so the Portal accrues its own
    -- backup timeline per device — the asset page is heading towards system-of-record status,
    -- so history starts accruing NOW and survives any future RMM/provider switch.
    CREATE TABLE IF NOT EXISTS backup_history (
      id          SERIAL PRIMARY KEY,
      day         DATE NOT NULL,
      provider    TEXT NOT NULL DEFAULT 'msp360',
      company     TEXT DEFAULT '',
      computer    TEXT DEFAULT '',
      plan_name   TEXT DEFAULT '',
      status      TEXT DEFAULT '',
      data_copied BIGINT,
      UNIQUE (day, provider, company, computer, plan_name)
    );
    CREATE INDEX IF NOT EXISTS idx_bh_computer ON backup_history (computer, day DESC);
  `);
}

const ts = (v: any): Date | null => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? d : null; };
const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };

// ── Sync: replace the MSP360 snapshot tables from the live API ───────────────────
export async function syncMsp360(): Promise<{ companies: number; plans: number }> {
  if (!(await msp360Configured())) return { companies: 0, plans: 0 };
  const [companies, monitoring, billing] = await Promise.all([
    apiGet('/api/Companies').catch(() => []),
    apiGet('/api/Monitoring').catch(() => []),
    apiGet('/api/Billing').catch(() => null),
  ]);

  // Storage per company: sum the billing rows' AverageSpace by CompanyName. (Billing is the
  // documented source of consumed space; its CompanyName matches /api/Companies names.)
  const storageByCompany = new Map<string, number>();
  const usersByCompany = new Map<string, number>();
  for (const row of ((billing && (billing.StatisticBilling || billing.statisticBilling)) || [])) {
    const comp = String(row.CompanyName || '').trim();
    if (!comp) continue;
    storageByCompany.set(comp, (storageByCompany.get(comp) || 0) + (num(row.AverageSpace) || 0));
    usersByCompany.set(comp, (usersByCompany.get(comp) || 0) + 1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM backup_companies WHERE provider='msp360'");
    let companyCount = 0;
    for (const cRaw of (Array.isArray(companies) ? companies : [])) {
      const name = String(cRaw.Name || cRaw.name || '').trim();
      if (!name) continue;
      await client.query(
        `INSERT INTO backup_companies (provider, external_key, users, storage_bytes, synced_at)
         VALUES ('msp360', $1, $2, $3, NOW())
         ON CONFLICT (provider, external_key) DO UPDATE SET users=$2, storage_bytes=$3, synced_at=NOW()`,
        [name, usersByCompany.get(name) || 0, storageByCompany.get(name) || 0]);
      companyCount++;
    }
    await client.query("DELETE FROM backup_plan_status WHERE provider='msp360'");
    let planCount = 0;
    for (const m of (Array.isArray(monitoring) ? monitoring : [])) {
      await client.query(
        `INSERT INTO backup_plan_status (provider, company, user_email, computer, plan_name, plan_type, status, error_message, last_start, next_start, data_copied, total_data, synced_at)
         VALUES ('msp360',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [String(m.CompanyName || '').trim(), String(m.UserName || ''), String(m.ComputerName || ''),
         String(m.PlanName || ''), String(m.PlanType ?? ''), String(m.Status ?? ''),
         String(m.ErrorMessage || '').slice(0, 500), ts(m.LastStart), ts(m.NextStart),
         num(m.DataCopied), num(m.TotalData)]);
      planCount++;
      // Append to the permanent history under the RUN's date (LastStart), not the sync
      // date — a 23:00 backup synced at 05:45 next morning belongs to the day it ran.
      // Latest state wins within a day (re-syncs update in place).
      await client.query(
        `INSERT INTO backup_history (day, provider, company, computer, plan_name, status, data_copied)
         VALUES (COALESCE($6::date, CURRENT_DATE), 'msp360', $1, $2, $3, $4, $5)
         ON CONFLICT (day, provider, company, computer, plan_name) DO UPDATE SET status=$4, data_copied=$5`,
        [String(m.CompanyName || '').trim(), String(m.ComputerName || ''), String(m.PlanName || ''),
         String(m.Status ?? ''), num(m.DataCopied), ts(m.LastStart)]);
    }
    await client.query('COMMIT');
    console.log(`[msp360] synced ${companyCount} companies, ${planCount} plan statuses`);
    return { companies: companyCount, plans: planCount };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Read side: everything the IT report needs for one customer ───────────────────
export interface BackupPlanRow {
  provider: string; company: string; computer: string; planName: string; planType: string;
  status: string; errorMessage: string; lastStart: Date | null; nextStart: Date | null;
  dataCopied: number | null; totalData: number | null;
}
export interface BackupSummary {
  providers: string[];
  companies: string[];               // linked provider-side company names
  totalStorageBytes: number;
  plans: BackupPlanRow[];
  okPlans: number; failedPlans: number; otherPlans: number;
  syncedAt: Date | null;
}

// MonitoringPlanStatus (verified against the live API + docs, Aug 2026):
//   0 Success · 1 Overdue · 2 Error · 3 Running · 4 Unknown · 5 Interrupted
//   6 UnexpectedlyClosed · 7 Warning
export const PLAN_STATUS_LABELS: Record<string, string> = {
  '0': 'Success', '1': 'Overdue', '2': 'Error', '3': 'Running',
  '4': 'Unknown', '5': 'Interrupted', '6': 'Unexpectedly closed', '7': 'Warning',
};
// MonitoringPlanType — backup flavours only (restores/consistency checks are filtered
// out of the report's plan table; a restore isn't a "backup plan health" row).
export const BACKUP_PLAN_TYPES = new Set(['1', '3', '5', '7', '9', '11', '14', '16']);
export const PLAN_TYPE_LABELS: Record<string, string> = {
  '1': 'Backup', '3': 'File backup', '5': 'VM backup', '7': 'SQL backup',
  '9': 'Exchange backup', '11': 'Image-based backup', '14': 'EC2 backup', '16': 'Hyper-V backup',
};

export function planStatusLabel(status: string): string {
  return PLAN_STATUS_LABELS[String(status).trim()] || String(status || 'n/a');
}
export function planTypeLabel(t: string): string {
  return PLAN_TYPE_LABELS[String(t).trim()] || '';
}
export function classifyPlanStatus(status: string): 'ok' | 'failed' | 'other' {
  const s = String(status || '').trim();
  if (s === '0') return 'ok';                                  // Success
  if (s === '1' || s === '2' || s === '5' || s === '6') return 'failed'; // Overdue/Error/Interrupted/UnexpectedlyClosed
  return 'other';                                              // Running/Unknown/Warning
}

export async function getBackupSummaryForCustomer(customerId: number): Promise<BackupSummary | null> {
  try {
    const links = (await pool.query(
      'SELECT provider, external_key FROM backup_provider_links WHERE customer_id=$1', [customerId])).rows;
    if (!links.length) return null;
    const keys = links.map((l: any) => l.external_key);
    const [comp, plans] = await Promise.all([
      pool.query(
        `SELECT provider, external_key, storage_bytes, synced_at FROM backup_companies
          WHERE (provider, external_key) IN (SELECT provider, external_key FROM backup_provider_links WHERE customer_id=$1)`,
        [customerId]),
      pool.query(
        `SELECT provider, company, computer, plan_name, plan_type, status, error_message,
                last_start, next_start, data_copied, total_data
           FROM backup_plan_status
          WHERE (provider, company) IN (SELECT provider, external_key FROM backup_provider_links WHERE customer_id=$1)
            AND plan_type = ANY($2)
          ORDER BY computer, plan_name`, [customerId, [...BACKUP_PLAN_TYPES]]),
    ]);
    const rows: BackupPlanRow[] = plans.rows.map((p: any) => ({
      provider: p.provider, company: p.company, computer: p.computer, planName: p.plan_name,
      planType: p.plan_type, status: p.status, errorMessage: p.error_message,
      lastStart: p.last_start, nextStart: p.next_start,
      dataCopied: p.data_copied == null ? null : Number(p.data_copied),
      totalData: p.total_data == null ? null : Number(p.total_data),
    }));
    let ok = 0, failed = 0, other = 0;
    for (const r of rows) {
      const c = classifyPlanStatus(r.status);
      if (c === 'ok') ok++; else if (c === 'failed') failed++; else other++;
    }
    const totalStorageBytes = comp.rows.reduce((a: number, c: any) => a + Number(c.storage_bytes || 0), 0);
    const syncedAt = comp.rows.length ? comp.rows.map((c: any) => c.synced_at).sort().pop() : null;
    if (!rows.length && !totalStorageBytes) return null; // linked but nothing synced yet
    return {
      providers: [...new Set(links.map((l: any) => l.provider === 'msp360' ? 'MSP360' : l.provider))],
      companies: keys, totalStorageBytes, plans: rows,
      okPlans: ok, failedPlans: failed, otherPlans: other, syncedAt,
    };
  } catch { return null; } // tables may not exist yet — the report falls back to manual
}

// Companies available to link (for the settings UI), with current link state per customer.
export async function listBackupCompanies(customerId: number): Promise<{
  provider: string; external_key: string; users: number; storage_bytes: number;
  linked_customer_id: number | null; linked_here: boolean;
}[]> {
  const r = await pool.query(
    `SELECT bc.provider, bc.external_key, bc.users, bc.storage_bytes,
            l.customer_id AS linked_customer_id
       FROM backup_companies bc
       LEFT JOIN backup_provider_links l ON l.provider = bc.provider AND l.external_key = bc.external_key
      ORDER BY bc.external_key`);
  return r.rows.map((row: any) => ({
    provider: row.provider, external_key: row.external_key,
    users: row.users, storage_bytes: Number(row.storage_bytes || 0),
    linked_customer_id: row.linked_customer_id,
    linked_here: row.linked_customer_id === customerId,
  }));
}

// ── Asset-page integration: backup state per DEVICE ───────────────────────────────
// MSP360's ComputerName and Atera's hostname are the same machine name in practice
// (AMR-S1, LAR-DENTAL…), so devices match case-insensitively on hostname. No link
// table needed at device level — the company link governs the customer level.
export async function getBackupForComputer(hostname: string): Promise<BackupPlanRow[]> {
  const h = String(hostname || '').trim();
  if (!h) return [];
  try {
    const r = await pool.query(
      `SELECT provider, company, computer, plan_name, plan_type, status, error_message,
              last_start, next_start, data_copied, total_data
         FROM backup_plan_status
        WHERE LOWER(computer) = LOWER($1) AND plan_type = ANY($2)
        ORDER BY plan_name`, [h, [...BACKUP_PLAN_TYPES]]);
    return r.rows.map((p: any) => ({
      provider: p.provider, company: p.company, computer: p.computer, planName: p.plan_name,
      planType: p.plan_type, status: p.status, errorMessage: p.error_message,
      lastStart: p.last_start, nextStart: p.next_start,
      dataCopied: p.data_copied == null ? null : Number(p.data_copied),
      totalData: p.total_data == null ? null : Number(p.total_data),
    }));
  } catch { return []; }
}

// Worst backup state per computer (lower-cased hostname → ok/failed/other) for list badges.
// One grouped query, not per-row — the assets list can have hundreds of devices.
export async function backupStateByComputer(): Promise<Record<string, 'ok' | 'failed' | 'other'>> {
  const out: Record<string, 'ok' | 'failed' | 'other'> = {};
  try {
    const r = await pool.query(
      `SELECT LOWER(computer) AS comp, ARRAY_AGG(status) AS statuses
         FROM backup_plan_status WHERE computer <> '' AND plan_type = ANY($1)
        GROUP BY LOWER(computer)`, [[...BACKUP_PLAN_TYPES]]);
    for (const row of r.rows) {
      const classes = (row.statuses as string[]).map(classifyPlanStatus);
      out[row.comp] = classes.includes('failed') ? 'failed' : classes.includes('other') ? 'other' : 'ok';
    }
  } catch { /* tables may not exist yet */ }
  return out;
}

// Recent daily history for one device (newest first) — feeds the asset page's timeline.
export async function getBackupHistoryForComputer(hostname: string, days = 14): Promise<{
  day: string; planName: string; status: string; dataCopied: number | null;
}[]> {
  const h = String(hostname || '').trim();
  if (!h) return [];
  try {
    const r = await pool.query(
      `SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day, plan_name, status, data_copied
         FROM backup_history
        WHERE LOWER(computer) = LOWER($1) AND day > CURRENT_DATE - $2::int
        ORDER BY day DESC, plan_name`, [h, days]);
    return r.rows.map((x: any) => ({
      day: x.day, planName: x.plan_name, status: x.status,
      dataCopied: x.data_copied == null ? null : Number(x.data_copied),
    }));
  } catch { return []; }
}

export function fmtBytes(n: number): string {
  if (!n) return '0';
  const tb = n / 1024 ** 4, gb = n / 1024 ** 3, mb = n / 1024 ** 2;
  if (tb >= 1) return tb.toFixed(2) + ' TB';
  if (gb >= 1) return gb.toFixed(gb >= 100 ? 0 : 1) + ' GB';
  return Math.max(1, Math.round(mb)) + ' MB';
}

// ── Scheduler: nightly at 05:45 (after MSP360's daily storage refresh), plus one run
// shortly after boot so a fresh deploy isn't empty until tomorrow. ─────────────────
let _started = false;
export function startMsp360Sync(): void {
  if (_started) return;
  _started = true;
  ensureBackupTables().catch((e) => console.error('[msp360] ensure tables failed:', e.message));
  cron.schedule('45 5 * * *', () => { syncMsp360().catch((e) => console.error('[msp360] sync failed:', e.message)); });
  setTimeout(() => {
    msp360Configured().then((ok) => { if (ok) syncMsp360().catch((e) => console.error('[msp360] boot sync failed:', e.message)); });
  }, 30 * 1000);
  console.log('✓ MSP360 backup sync scheduled (05:45 daily)');
}
