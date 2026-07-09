import { pool } from '../db/pool';
import { graphListTenantUsers } from './graph';
import { config } from '../config';

export interface DirSyncResult { added: number; updated: number; archived: number; total: number; }

// ── Internal staff sync (Lumen's own tenant → the users table) ──────────────────
// Matches on entra_oid FIRST, so email-domain changes and name changes simply update the
// existing account in place (role/groups/password untouched). New tenant members are added
// as role 'staff'; people disabled/removed in Entra are deactivated here.
// NEVER touched: customer-scoped users, break-glass accounts (hidden_from_lookups), and
// local-only accounts that were never linked to Entra (no entra_oid = stays manual).
export async function syncInternalUsers(): Promise<DirSyncResult> {
  const tenant = config.GRAPH_TENANT_ID;
  if (!tenant) throw new Error('GRAPH_TENANT_ID is not configured.');

  const gusers = await graphListTenantUsers(tenant);
  let added = 0, updated = 0, archived = 0;
  const seen = new Set<string>();

  for (const u of gusers) {
    if (!u.email) continue; // service objects without a mailbox etc.
    seen.add(u.id);
    try {
      const ex = await pool.query(
        `SELECT id, customer_id, hidden_from_lookups FROM users
          WHERE (entra_oid=$1 OR (entra_oid IS NULL AND lower(email)=lower($2))) LIMIT 1`,
        [u.id, u.email]);
      const row = ex.rows[0];
      if (row) {
        if (row.customer_id || row.hidden_from_lookups) continue; // customer user / break-glass — hands off
        await pool.query(
          `UPDATE users SET entra_oid=$2, email=$3, display_name=$4, is_active=$5 WHERE id=$1`,
          [row.id, u.id, u.email.toLowerCase(), u.displayName || u.email, !!u.enabled]);
        updated++;
      } else {
        await pool.query(
          `INSERT INTO users (email, display_name, role, is_active, entra_oid)
           VALUES ($1,$2,'staff',$3,$4)
           ON CONFLICT (email) DO UPDATE SET entra_oid=EXCLUDED.entra_oid, display_name=EXCLUDED.display_name, is_active=EXCLUDED.is_active`,
          [u.email.toLowerCase(), u.displayName || u.email, !!u.enabled, u.id]);
        added++;
      }
    } catch (e: any) {
      console.error(`[dirsync] internal sync failed for ${u.email}:`, e.message);
    }
  }

  // Deactivate previously-synced staff who are no longer in the tenant. Local-only accounts
  // (no entra_oid) are never auto-deactivated — they were never Entra-managed.
  if (seen.size) {
    const gone = await pool.query(
      `UPDATE users SET is_active=false
        WHERE customer_id IS NULL AND hidden_from_lookups=false AND entra_oid IS NOT NULL
          AND is_active=true AND NOT (entra_oid = ANY($1::text[]))
        RETURNING id`,
      [[...seen]]);
    archived = gone.rowCount || 0;
  }

  return { added, updated, archived, total: gusers.length };
}

// Syncs a customer's Entra/M365 directory into their contacts:
// create new, update existing (match by entra_oid then email), and archive
// contacts whose user has left/been disabled.
export async function syncCustomerDirectory(customerId: number): Promise<DirSyncResult> {
  const c = await pool.query('SELECT entra_tenant_id FROM customers WHERE id=$1', [customerId]);
  const tenant = c.rows[0] && c.rows[0].entra_tenant_id;
  if (!tenant) throw new Error('No Entra tenant ID set for this customer.');

  const users = await graphListTenantUsers(tenant);
  let added = 0, updated = 0, archived = 0;
  const seen = new Set<string>();

  for (const u of users) {
    seen.add(u.id);
    const existing = await pool.query(
      `SELECT id, protected FROM customer_contacts
       WHERE customer_id=$1 AND is_third_party=false
         AND (entra_oid=$2 OR (entra_oid IS NULL AND email IS NOT NULL AND lower(email)=lower($3))) LIMIT 1`,
      [customerId, u.id, u.email]
    );
    if (existing.rows.length && existing.rows[0].protected) {
      continue; // protected contact — never touched by the sync
    }
    if (existing.rows.length) {
      await pool.query(
        `UPDATE customer_contacts SET entra_oid=$2, full_name=$3, email=$4,
           job_title=COALESCE(NULLIF($5,''), job_title),
           mobile_phone=COALESCE(NULLIF($6,''), mobile_phone),
           phone=COALESCE(NULLIF($7,''), phone),
           archived=$8, updated_at=NOW() WHERE id=$1`,
        [existing.rows[0].id, u.id, u.displayName, u.email, u.jobTitle, u.mobilePhone, u.businessPhone, !u.enabled]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO customer_contacts (customer_id, entra_oid, full_name, email, job_title, mobile_phone, phone, archived)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [customerId, u.id, u.displayName, u.email, u.jobTitle, u.mobilePhone, u.businessPhone, !u.enabled]
      );
      added++;
    }
  }

  // Archive previously-synced contacts no longer in the directory (user removed).
  const synced = await pool.query(
    'SELECT id, entra_oid FROM customer_contacts WHERE customer_id=$1 AND entra_oid IS NOT NULL AND archived=false AND is_third_party=false AND COALESCE(protected,false)=false', [customerId]
  );
  for (const row of synced.rows) {
    if (!seen.has(row.entra_oid)) {
      await pool.query('UPDATE customer_contacts SET archived=true, updated_at=NOW() WHERE id=$1', [row.id]);
      archived++;
    }
  }

  return { added, updated, archived, total: users.length };
}
