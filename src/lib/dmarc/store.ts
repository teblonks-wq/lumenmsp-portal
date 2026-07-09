import { pool } from '../../db/pool';
import type { ParsedReport } from './parse';
import type { SenderClass } from './senders';
import type { DmarcDnsCheck } from './dns-check';

// ── LITS-DMARC: storage + queries ────────────────────────────────────────────────
// Raw-SQL managed tables (ensureDmarcTables), declared in prisma/schema.prisma as
// no-op models so `prisma db push --accept-data-loss` KEEPS them on deploy — the
// same social_posts/it_report lesson. If you change DDL here, mirror it in the schema.

export async function ensureDmarcTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dmarc_domains (
      id                 SERIAL PRIMARY KEY,
      customer_id        INTEGER,
      domain             TEXT NOT NULL UNIQUE,
      monitoring_enabled BOOLEAN DEFAULT true,
      policy             TEXT DEFAULT '',
      target_policy      TEXT DEFAULT 'none',
      score              INTEGER,
      last_check         JSONB DEFAULT '{}'::jsonb,
      last_checked_at    TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dmarc_reports (
      id                 SERIAL PRIMARY KEY,
      domain_id          INTEGER NOT NULL,
      report_id          TEXT NOT NULL,
      org_name           TEXT DEFAULT '',
      org_email          TEXT DEFAULT '',
      date_begin         TIMESTAMPTZ,
      date_end           TIMESTAMPTZ,
      policy_published   JSONB DEFAULT '{}'::jsonb,
      record_count       INTEGER DEFAULT 0,
      message_count      INTEGER DEFAULT 0,
      received_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (domain_id, org_name, report_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain ON dmarc_reports (domain_id, date_begin DESC);
    CREATE TABLE IF NOT EXISTS dmarc_records (
      id                 SERIAL PRIMARY KEY,
      report_id          INTEGER NOT NULL,
      domain_id          INTEGER NOT NULL,
      date_begin         TIMESTAMPTZ,
      source_ip          TEXT NOT NULL,
      count              INTEGER DEFAULT 1,
      disposition        TEXT DEFAULT 'none',
      dkim_aligned       BOOLEAN DEFAULT false,
      spf_aligned        BOOLEAN DEFAULT false,
      dkim_result        TEXT DEFAULT '',
      dkim_selector      TEXT DEFAULT '',
      spf_result         TEXT DEFAULT '',
      header_from        TEXT DEFAULT '',
      envelope_from      TEXT DEFAULT '',
      ptr                TEXT DEFAULT '',
      sender_name        TEXT DEFAULT '',
      sender_known       BOOLEAN DEFAULT false,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dmarc_records_domain ON dmarc_records (domain_id, date_begin DESC);
    ALTER TABLE dmarc_records ADD COLUMN IF NOT EXISTS dkim_selector TEXT DEFAULT '';
    ALTER TABLE dmarc_domains ADD COLUMN IF NOT EXISTS target_policy TEXT DEFAULT 'none';
  `);
}

// Selectors actually seen signing for this domain (from report auth_results) — fed
// back into the DNS check so we detect DKIM keys we'd never guess from a static list.
export async function seenDkimSelectors(domainId: number): Promise<string[]> {
  const r = await pool.query(
    `SELECT DISTINCT dkim_selector FROM dmarc_records WHERE domain_id=$1 AND dkim_selector <> '' LIMIT 50`,
    [domainId]);
  return r.rows.map((x: any) => x.dkim_selector);
}

export interface DmarcDomainRow {
  id: number; customer_id: number | null; domain: string; monitoring_enabled: boolean;
  policy: string; target_policy: string; score: number | null; last_check: any; last_checked_at: Date | null;
  customer_name?: string | null;
}

export async function listDmarcDomains(): Promise<(DmarcDomainRow & {
  reports_30d: number; volume_30d: number; aligned_30d: number; last_report_at: Date | null;
})[]> {
  const r = await pool.query(`
    SELECT d.*, c.name AS customer_name,
           COALESCE(s.reports_30d, 0)  AS reports_30d,
           COALESCE(v.volume_30d, 0)   AS volume_30d,
           COALESCE(v.aligned_30d, 0)  AS aligned_30d,
           s.last_report_at
      FROM dmarc_domains d
      LEFT JOIN customers c ON c.id = d.customer_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS reports_30d, MAX(received_at) AS last_report_at
          FROM dmarc_reports r WHERE r.domain_id = d.id AND r.date_begin > NOW() - INTERVAL '30 days'
      ) s ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(count), 0)::int AS volume_30d,
               COALESCE(SUM(count) FILTER (WHERE dkim_aligned OR spf_aligned), 0)::int AS aligned_30d
          FROM dmarc_records x WHERE x.domain_id = d.id AND x.date_begin > NOW() - INTERVAL '30 days'
      ) v ON true
     ORDER BY d.monitoring_enabled DESC, d.domain`
  );
  return r.rows;
}

// All actively monitored domains — used by the daily DNS sweep so every domain
// gets re-checked uniformly, not just when someone clicks Re-run.
export async function enabledDmarcDomains(): Promise<{ id: number; domain: string; target_policy: string }[]> {
  const r = await pool.query(
    "SELECT id, domain, COALESCE(target_policy, 'none') AS target_policy FROM dmarc_domains WHERE monitoring_enabled = true ORDER BY id");
  return r.rows;
}

export async function getDmarcDomain(id: number): Promise<DmarcDomainRow | null> {
  const r = await pool.query(
    'SELECT d.*, c.name AS customer_name FROM dmarc_domains d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id=$1', [id]);
  return r.rows[0] || null;
}

export async function findDomainForReport(policyDomain: string): Promise<DmarcDomainRow | null> {
  if (!policyDomain) return null;
  // Exact match first; else the report is for a subdomain of a monitored domain.
  const r = await pool.query(
    `SELECT * FROM dmarc_domains WHERE monitoring_enabled = true AND ($1 = domain OR $1 LIKE '%.' || domain)
      ORDER BY LENGTH(domain) DESC LIMIT 1`, [policyDomain]);
  return r.rows[0] || null;
}

export async function addDmarcDomain(domain: string, customerId: number | null): Promise<number> {
  const r = await pool.query(
    `INSERT INTO dmarc_domains (domain, customer_id) VALUES ($1, $2)
     ON CONFLICT (domain) DO UPDATE SET monitoring_enabled = true, customer_id = COALESCE(EXCLUDED.customer_id, dmarc_domains.customer_id), updated_at = NOW()
     RETURNING id`, [domain, customerId]);
  return r.rows[0].id;
}

export async function saveDnsCheck(domainId: number, check: DmarcDnsCheck): Promise<void> {
  await pool.query(
    `UPDATE dmarc_domains SET policy=$2, score=$3, last_check=$4, last_checked_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [domainId, check.dmarc.policy || '', check.score, JSON.stringify(check)]);
}

// Persists one parsed aggregate report. Returns false when it was a duplicate
// (same domain + org + report_id) — the unique constraint is the dedupe.
export async function saveReport(domainId: number, rep: ParsedReport, classes: Map<string, SenderClass>): Promise<boolean> {
  const messageCount = rep.records.reduce((a, r) => a + r.count, 0);
  const ins = await pool.query(
    `INSERT INTO dmarc_reports (domain_id, report_id, org_name, org_email, date_begin, date_end, policy_published, record_count, message_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (domain_id, org_name, report_id) DO NOTHING
     RETURNING id`,
    [domainId, rep.reportId, rep.orgName, rep.orgEmail, rep.dateBegin, rep.dateEnd,
     JSON.stringify(rep.policyPublished || {}), rep.records.length, messageCount]);
  if (!ins.rows[0]) return false; // duplicate — records already stored
  const reportRowId = ins.rows[0].id;
  for (const rec of rep.records) {
    const cls = classes.get(rec.sourceIp) || { name: rec.sourceIp, known: false, ptr: '' };
    await pool.query(
      `INSERT INTO dmarc_records (report_id, domain_id, date_begin, source_ip, count, disposition,
         dkim_aligned, spf_aligned, dkim_result, dkim_selector, spf_result, header_from, envelope_from, ptr, sender_name, sender_known)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [reportRowId, domainId, rep.dateBegin, rec.sourceIp, rec.count, rec.disposition,
       rec.dkimAligned, rec.spfAligned, rec.dkimResult, rec.dkimSelector, rec.spfResult, rec.headerFrom, rec.envelopeFrom,
       cls.ptr, cls.name, cls.known]);
  }
  return true;
}

// ── Dashboard summaries ──────────────────────────────────────────────────────────
export interface DmarcSourceAgg {
  sender_name: string; sender_known: boolean; ips: number; volume: number;
  aligned: number; dkim_pass: number; spf_pass: number; quarantined: number; rejected: number;
}
export interface DmarcDaily { day: string; volume: number; aligned: number; }

export async function domainSummary(domainId: number, days: number): Promise<{
  totals: { volume: number; aligned: number; failed: number; sources: number; reports: number };
  sources: DmarcSourceAgg[];
  daily: DmarcDaily[];
  recentReports: any[];
}> {
  const interval = `${Math.max(1, Math.min(365, days))} days`;
  const [tot, src, day, reps] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(count),0)::int AS volume,
              COALESCE(SUM(count) FILTER (WHERE dkim_aligned OR spf_aligned),0)::int AS aligned,
              COALESCE(SUM(count) FILTER (WHERE NOT dkim_aligned AND NOT spf_aligned),0)::int AS failed,
              COUNT(DISTINCT source_ip)::int AS sources
         FROM dmarc_records WHERE domain_id=$1 AND date_begin > NOW() - $2::interval`, [domainId, interval]),
    pool.query(
      `SELECT sender_name, BOOL_OR(sender_known) AS sender_known,
              COUNT(DISTINCT source_ip)::int AS ips, SUM(count)::int AS volume,
              SUM(count) FILTER (WHERE dkim_aligned OR spf_aligned)::int AS aligned,
              SUM(count) FILTER (WHERE dkim_result='pass')::int AS dkim_pass,
              SUM(count) FILTER (WHERE spf_result='pass')::int AS spf_pass,
              SUM(count) FILTER (WHERE disposition='quarantine')::int AS quarantined,
              SUM(count) FILTER (WHERE disposition='reject')::int AS rejected
         FROM dmarc_records WHERE domain_id=$1 AND date_begin > NOW() - $2::interval
        GROUP BY sender_name ORDER BY SUM(count) DESC LIMIT 100`, [domainId, interval]),
    pool.query(
      `SELECT TO_CHAR(date_begin AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              SUM(count)::int AS volume,
              SUM(count) FILTER (WHERE dkim_aligned OR spf_aligned)::int AS aligned
         FROM dmarc_records WHERE domain_id=$1 AND date_begin > NOW() - $2::interval
        GROUP BY 1 ORDER BY 1`, [domainId, interval]),
    pool.query(
      `SELECT org_name, report_id, date_begin, date_end, message_count, received_at
         FROM dmarc_reports WHERE domain_id=$1 ORDER BY received_at DESC LIMIT 15`, [domainId]),
  ]);
  const t = tot.rows[0] || { volume: 0, aligned: 0, failed: 0, sources: 0 };
  const reports = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM dmarc_reports WHERE domain_id=$1 AND date_begin > NOW() - $2::interval`,
    [domainId, interval])).rows[0].n;
  return { totals: { ...t, reports }, sources: src.rows, daily: day.rows, recentReports: reps.rows };
}

// ── Monthly IT report integration ────────────────────────────────────────────────
// Summary for a customer's primary domain over the report period. Null when the
// domain isn't monitored (the report then just shows the plain DNS table as before).
export interface DmarcMonthSummary {
  domain: string; policy: string; score: number | null;
  volume: number; aligned: number; alignedPct: number; failed: number;
  sources: number; unknownFailingSources: string[];
}

export async function getDmarcMonthSummary(domain: string, from: Date, to: Date): Promise<DmarcMonthSummary | null> {
  const d = (domain || '').trim().toLowerCase();
  if (!d) return null;
  const dom = (await pool.query('SELECT * FROM dmarc_domains WHERE domain=$1 AND monitoring_enabled=true', [d])).rows[0];
  if (!dom) return null;
  const [tot, bad] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(count),0)::int AS volume,
              COALESCE(SUM(count) FILTER (WHERE dkim_aligned OR spf_aligned),0)::int AS aligned,
              COUNT(DISTINCT source_ip)::int AS sources
         FROM dmarc_records WHERE domain_id=$1 AND date_begin >= $2 AND date_begin < $3`, [dom.id, from, to]),
    pool.query(
      `SELECT sender_name, SUM(count)::int AS volume
         FROM dmarc_records
        WHERE domain_id=$1 AND date_begin >= $2 AND date_begin < $3
          AND NOT dkim_aligned AND NOT spf_aligned AND NOT sender_known
        GROUP BY sender_name ORDER BY SUM(count) DESC LIMIT 5`, [dom.id, from, to]),
  ]);
  const t = tot.rows[0];
  const volume = t.volume || 0;
  const aligned = t.aligned || 0;
  return {
    domain: d, policy: dom.policy || '', score: dom.score,
    volume, aligned, failed: volume - aligned,
    alignedPct: volume ? Math.round((aligned / volume) * 1000) / 10 : 0,
    sources: t.sources || 0,
    unknownFailingSources: bad.rows.map((r: any) => `${r.sender_name} (${r.volume})`),
  };
}
