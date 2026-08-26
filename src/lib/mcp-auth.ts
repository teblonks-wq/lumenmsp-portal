import crypto from 'crypto';
import { pool } from '../db/pool';

// ── Who is on the other end of the MCP connector ──────────────────────────────
//
// The connector used to be a single shared secret in a URL. That made the audit log
// anonymous (every line looked like Terry) and made revoking one person mean rotating
// the token and reconnecting everyone. This module replaces it with named principals.
//
// Two ways in, and the difference is the whole point:
//
//   • MCP_TOKEN in the server .env — the OWNER's token. Always valid, not listed or
//     revocable from the UI (rotate the .env and restart to kill it), and the only
//     principal that could ever be handed a write tool.
//   • A row in mcp_tokens — a DELEGATED token, one per person, issued at /mcp-tokens.
//     Named, revoked with one click, attributed by name on every line of mcp_call_log,
//     and READ-ONLY: can_write defaults false and the admin screen offers no way to set
//     it true, so a delegated token cannot reach a write tool even if one is added
//     later. Same posture as the agent-tools / server-fix registries: named, audited,
//     reversible.
//
// The token itself is NEVER stored — only its sha256. A lost token is re-issued, not
// recovered.

export type Principal = {
  label: string;          // the identity stamped on every call in mcp_call_log
  tokenId: number | null; // null = the env token (nothing in mcp_tokens to point at)
  canWrite: boolean;
};

export const OWNER_LABEL = 'Owner (env token)';

export const sha256hex = (s: string): string =>
  crypto.createHash('sha256').update(String(s)).digest('hex');

// base64url so the token survives being a URL path segment untouched.
export const mintToken = (): string => crypto.randomBytes(32).toString('base64url');

export function envTokenOk(supplied: string, secretRaw = process.env.MCP_TOKEN): boolean {
  const secret = (secretRaw || '').trim();
  if (!secret || !supplied) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function resolvePrincipal(supplied: unknown): Promise<Principal | null> {
  if (typeof supplied !== 'string' || !supplied) return null;
  if (envTokenOk(supplied)) return { label: OWNER_LABEL, tokenId: null, canWrite: true };
  // Delegated token. The lookup is by hash, so an unknown token costs one indexed SELECT
  // and the comparison happens inside the index — the secret is never compared
  // byte-by-byte in our own code. revoked_at IS NULL is the revocation, and there is no
  // cache in front of it, so Revoke takes effect on the very next call.
  try {
    const r = await pool.query(
      `SELECT id, label, can_write FROM mcp_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1`, [sha256hex(supplied)]);
    if (!r.rows.length) return null;
    return { label: String(r.rows[0].label), tokenId: Number(r.rows[0].id), canWrite: r.rows[0].can_write === true };
  } catch (e: any) {
    // If the table is missing (new code, old database) the owner is still fine — the env
    // token is checked and returned above, before we ever reach this query.
    console.error('[mcp] token lookup failed:', e.message);
    return null;
  }
}

// The read-only guarantee, as one decision in one place. Today no tool declares
// writes:true, so this can only ever matter in future — which is exactly why it is here
// now rather than being remembered later.
export const mayCall = (p: Principal, toolWrites: boolean | undefined): boolean =>
  !toolWrites || p.canWrite === true;

// Usage stamp. Fire-and-forget: it must never slow down or break a call.
export function touchToken(tokenId: number | null, ip: string | null): void {
  if (tokenId == null) return;
  pool.query(
    `UPDATE mcp_tokens SET last_used_at = now(), last_ip = $2, call_count = call_count + 1 WHERE id = $1`,
    [tokenId, ip]
  ).catch((e) => console.error('[mcp] token touch failed:', e.message));
}

// ── Issue / revoke ────────────────────────────────────────────────────────────
export type IssueResult = { ok: true; id: number; token: string } | { ok: false; error: string };

export async function issueToken(label: string, note: string | null, createdBy: string | null): Promise<IssueResult> {
  const name = String(label || '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'Give the token a name — it is what appears against every call in the log.' };
  // The label IS the identity in the audit log, so two live tokens may not share one.
  const dupe = await pool.query('SELECT 1 FROM mcp_tokens WHERE label=$1 AND revoked_at IS NULL', [name]);
  if (dupe.rows.length) return { ok: false, error: `There is already a live token named "${name}". Revoke it first, or use a different name.` };
  const token = mintToken();
  // can_write is written false explicitly rather than left to the column default: the
  // read-only promise should be visible at the one place tokens are created.
  const r = await pool.query(
    `INSERT INTO mcp_tokens (label, token_hash, prefix, can_write, note, created_by)
     VALUES ($1,$2,$3,false,$4,$5) RETURNING id`,
    [name, sha256hex(token), token.slice(0, 8), note, createdBy]);
  return { ok: true, id: Number(r.rows[0].id), token };
}

export async function revokeToken(id: number, revokedBy: string | null): Promise<string | null> {
  const r = await pool.query(
    `UPDATE mcp_tokens SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING label`, [id, revokedBy]);
  return r.rows.length ? String(r.rows[0].label) : null;
}
