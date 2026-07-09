import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// One-off (re-runnable) data migration: legacy MySQL `lumenmsp` → Postgres `lumenmsp_portal`.
// Customer domain only: customers + contacts + sites + domains + external_ids.
// - Preserves original IDs (so principal/billing/service_contact_id + FKs line up).
// - Drops tenant_id and all call hooks (icalls_code, icalls_tasks).
// - Idempotent: upserts on id, then resets Postgres sequences.
//
// Reads legacy MySQL connection from env (set these in .env):
//   LEGACY_MYSQL_HOST (default localhost), LEGACY_MYSQL_PORT (3306),
//   LEGACY_MYSQL_USER, LEGACY_MYSQL_PASSWORD, LEGACY_MYSQL_DATABASE (default lumenmsp)
// Target Postgres comes from DATABASE_URL.

const b = (v: unknown): boolean => v === 1 || v === true || v === '1';
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.LEGACY_MYSQL_USER) throw new Error('LEGACY_MYSQL_USER not set');

  const my = await mysql.createConnection({
    host:     process.env.LEGACY_MYSQL_HOST || 'localhost',
    port:     Number(process.env.LEGACY_MYSQL_PORT || 3306),
    user:     process.env.LEGACY_MYSQL_USER,
    password: process.env.LEGACY_MYSQL_PASSWORD || '',
    database: process.env.LEGACY_MYSQL_DATABASE || 'lumenmsp',
    dateStrings: false,
  });

  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pg.connect();

  const counts: Record<string, number> = {};

  try {
    // ── customers ───────────────────────────────────────────────────────────
    const [customers] = await my.query('SELECT * FROM customers') as [any[], any];
    for (const c of customers) {
      await client.query(
        `INSERT INTO customers
          (id, account_number, name, status, website, domain, phone, email,
           is_itsm, is_placeholder, has_internet, has_phones, has_cloud,
           address_line_1, address_line_2, city, county, postcode, logo_path, notes, lead_source,
           atera_customer_id, quickbooks_customer_id, gocardless_mandate_id,
           principal_contact_id, billing_contact_id, service_contact_id,
           created_by, created_at, updated_at, deleted_at, deleted_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 $22,$23,$24,$25,$26,$27,$28,
                 COALESCE($29, NOW()), COALESCE($30, NOW()), $31, $32)
         ON CONFLICT (id) DO UPDATE SET
           account_number=EXCLUDED.account_number, name=EXCLUDED.name, status=EXCLUDED.status,
           website=EXCLUDED.website, domain=EXCLUDED.domain, phone=EXCLUDED.phone, email=EXCLUDED.email,
           is_itsm=EXCLUDED.is_itsm, is_placeholder=EXCLUDED.is_placeholder, has_internet=EXCLUDED.has_internet,
           has_phones=EXCLUDED.has_phones, has_cloud=EXCLUDED.has_cloud,
           address_line_1=EXCLUDED.address_line_1, address_line_2=EXCLUDED.address_line_2,
           city=EXCLUDED.city, county=EXCLUDED.county, postcode=EXCLUDED.postcode,
           logo_path=EXCLUDED.logo_path, notes=EXCLUDED.notes, lead_source=EXCLUDED.lead_source,
           atera_customer_id=EXCLUDED.atera_customer_id, quickbooks_customer_id=EXCLUDED.quickbooks_customer_id,
           gocardless_mandate_id=EXCLUDED.gocardless_mandate_id,
           principal_contact_id=EXCLUDED.principal_contact_id, billing_contact_id=EXCLUDED.billing_contact_id,
           service_contact_id=EXCLUDED.service_contact_id, created_by=EXCLUDED.created_by,
           created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at,
           deleted_at=EXCLUDED.deleted_at, deleted_by_user_id=EXCLUDED.deleted_by_user_id`,
        [
          n(c.id), c.account_number || null, c.name, c.status || 'lead', c.website, c.domain, c.phone, c.email,
          b(c.is_itsm), b(c.is_placeholder), b(c.has_internet), b(c.has_phones), b(c.has_cloud),
          c.address_line_1, c.address_line_2, c.city, c.county, c.postcode, c.logo_path, c.notes, c.lead_source,
          c.atera_customer_id, c.quickbooks_customer_id, c.gocardless_mandate_id,
          n(c.principal_contact_id), n(c.billing_contact_id), n(c.service_contact_id),
          n(c.created_by), c.created_at, c.updated_at, c.deleted_at, n(c.deleted_by_user_id),
        ]
      );
    }
    counts.customers = customers.length;

    // ── customer_contacts ─────────────────────────────────────────────────────
    const [contacts] = await my.query('SELECT * FROM customer_contacts') as [any[], any];
    for (const r of contacts) {
      await client.query(
        `INSERT INTO customer_contacts
          (id, customer_id, atera_contact_id, full_name, email, phone, mobile_phone,
           job_title, department, is_primary, is_third_party, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()), COALESCE($13, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, atera_contact_id=EXCLUDED.atera_contact_id,
           full_name=EXCLUDED.full_name, email=EXCLUDED.email, phone=EXCLUDED.phone,
           mobile_phone=EXCLUDED.mobile_phone, job_title=EXCLUDED.job_title, department=EXCLUDED.department,
           is_primary=EXCLUDED.is_primary, is_third_party=EXCLUDED.is_third_party, updated_at=EXCLUDED.updated_at`,
        [
          n(r.id), n(r.customer_id), r.atera_contact_id, r.full_name, r.email, r.phone, r.mobile_phone,
          r.job_title, r.department, b(r.is_primary), b(r.is_third_party), r.created_at, r.updated_at,
        ]
      );
    }
    counts.customer_contacts = contacts.length;

    // ── customer_sites ────────────────────────────────────────────────────────
    const [sites] = await my.query('SELECT * FROM customer_sites') as [any[], any];
    for (const r of sites) {
      await client.query(
        `INSERT INTO customer_sites
          (id, customer_id, site_name, site_code, address_line_1, address_line_2, city, county,
           postcode, country, site_phone, site_email, notes, is_primary, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15, NOW()), COALESCE($16, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, site_name=EXCLUDED.site_name, site_code=EXCLUDED.site_code,
           address_line_1=EXCLUDED.address_line_1, address_line_2=EXCLUDED.address_line_2, city=EXCLUDED.city,
           county=EXCLUDED.county, postcode=EXCLUDED.postcode, country=EXCLUDED.country,
           site_phone=EXCLUDED.site_phone, site_email=EXCLUDED.site_email, notes=EXCLUDED.notes,
           is_primary=EXCLUDED.is_primary, updated_at=EXCLUDED.updated_at`,
        [
          n(r.id), n(r.customer_id), r.site_name, r.site_code, r.address_line_1, r.address_line_2, r.city, r.county,
          r.postcode, r.country, r.site_phone, r.site_email, r.notes, b(r.is_primary), r.created_at, r.updated_at,
        ]
      );
    }
    counts.customer_sites = sites.length;

    // ── customer_domains ──────────────────────────────────────────────────────
    const [domains] = await my.query('SELECT * FROM customer_domains') as [any[], any];
    for (const r of domains) {
      await client.query(
        `INSERT INTO customer_domains (id, customer_id, domain, is_primary, created_at, updated_at)
         VALUES ($1,$2,$3,$4, COALESCE($5, NOW()), COALESCE($6, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, domain=EXCLUDED.domain,
           is_primary=EXCLUDED.is_primary, updated_at=EXCLUDED.updated_at`,
        [n(r.id), n(r.customer_id), r.domain, b(r.is_primary), r.created_at, r.updated_at]
      );
    }
    counts.customer_domains = domains.length;

    // ── customer_external_ids ─────────────────────────────────────────────────
    const [extIds] = await my.query('SELECT * FROM customer_external_ids') as [any[], any];
    for (const r of extIds) {
      await client.query(
        `INSERT INTO customer_external_ids (id, customer_id, source_system, external_id, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6, NOW()), COALESCE($7, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id, source_system=EXCLUDED.source_system,
           external_id=EXCLUDED.external_id, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at`,
        [n(r.id), n(r.customer_id), r.source_system, r.external_id, r.metadata ?? null, r.created_at, r.updated_at]
      );
    }
    counts.customer_external_ids = extIds.length;

    // ── Reset sequences so future inserts don't collide with preserved IDs ────
    for (const t of ['customers', 'customer_contacts', 'customer_sites', 'customer_domains', 'customer_external_ids']) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`
      );
    }

    console.log('✓ Migration complete:', counts);
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
