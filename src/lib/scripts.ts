import { pool } from '../db/pool';

// ── Script library ──────────────────────────────────────────────────────────────
// Atera is being retired and its script library goes with it. These are OUR scripts:
// the 48 that lived under Atera's "Team scripts", plus whatever we write from here on.
// Atera's 1,106-strong shared library is deliberately NOT mirrored — the Portal is a
// single-tenant tool for Lumen, so a community library would be dead weight.

export const FILE_TYPES = ['ps1', 'bat', 'cmd', 'sh', 'py', 'vbs'] as const;
export const OS_TYPES = ['windows', 'macos', 'linux'] as const;
export const RUN_AS = ['system', 'current_user'] as const;

export interface ScriptRow {
  id: number;
  name: string;
  description: string | null;
  fileType: string;
  osType: string;
  body: string;
  runAs: string;
  arguments: string | null;
  maxRuntimeMinutes: number | null;
  category: string | null;
  source: string;
  sourceRef: string | null;
  reviewVerdict: string | null;
  reviewHeadline: string | null;
  reviewSummary: string | null;
  reviewFindings: Array<{ severity: string; line: number | null; note: string }> | null;
  reviewedAt: Date | null;
  reviewedHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  lines: number;
  bytes: number;
}

const SELECT = `
  SELECT id, name, description, file_type AS "fileType", os_type AS "osType", body,
         run_as AS "runAs", arguments, max_runtime_minutes AS "maxRuntimeMinutes",
         category, source, source_ref AS "sourceRef",
         review_verdict AS "reviewVerdict", review_headline AS "reviewHeadline",
         review_summary AS "reviewSummary", review_findings AS "reviewFindings",
         reviewed_at AS "reviewedAt", reviewed_hash AS "reviewedHash",
         created_at AS "createdAt", updated_at AS "updatedAt"
    FROM scripts`;

function decorate(r: any): ScriptRow {
  const body = String(r.body ?? '');
  return { ...r, lines: body ? body.split(/\r\n|\r|\n/).length : 0, bytes: Buffer.byteLength(body, 'utf8') };
}

export async function listScripts(q?: string): Promise<ScriptRow[]> {
  const term = String(q ?? '').trim();
  // The body is searched as well as the name. Half the reason to keep these in one place
  // is being able to ask "which script touches this registry key" without opening 48 files.
  const rows = term
    ? (await pool.query(
        `${SELECT} WHERE deleted_at IS NULL
            AND (name ILIKE $1 OR description ILIKE $1 OR body ILIKE $1)
          ORDER BY lower(name)`, [`%${term}%`])).rows
    : (await pool.query(`${SELECT} WHERE deleted_at IS NULL ORDER BY lower(name)`)).rows;
  return rows.map(decorate);
}

export async function getScript(id: number): Promise<ScriptRow | null> {
  const r = (await pool.query(`${SELECT} WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
  return r ? decorate(r) : null;
}

export interface ScriptInput {
  name: string;
  description?: string | null;
  fileType?: string | null;
  osType?: string | null;
  body: string;
  runAs?: string | null;
  arguments?: string | null;
  maxRuntimeMinutes?: number | null;
  category?: string | null;
  source?: string | null;
  sourceRef?: string | null;
}

const oneOf = (v: any, allowed: readonly string[], dflt: string): string => {
  const s = String(v ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? s : dflt;
};

/**
 * Insert or update by (source, sourceRef). Returns which it did so an import can report
 * "12 added, 36 already here" rather than a bare count that hides a double-import.
 */
export async function upsertScript(
  input: ScriptInput, userId?: number | null,
): Promise<{ id: number; created: boolean }> {
  const name = String(input.name ?? '').trim().slice(0, 200);
  if (!name) throw new Error('A script needs a name.');
  const body = String(input.body ?? '');
  if (!body.trim()) throw new Error(`"${name}" has no script body.`);

  const vals = [
    name,
    input.description ? String(input.description).slice(0, 2000) : null,
    oneOf(input.fileType, FILE_TYPES, 'ps1'),
    oneOf(input.osType, OS_TYPES, 'windows'),
    body,
    oneOf(input.runAs, RUN_AS, 'system'),
    input.arguments ? String(input.arguments).slice(0, 2000) : null,
    Number.isFinite(Number(input.maxRuntimeMinutes)) && Number(input.maxRuntimeMinutes) > 0
      ? Math.min(Math.round(Number(input.maxRuntimeMinutes)), 1440) : null,
    input.category ? String(input.category).slice(0, 120) : null,
    String(input.source ?? 'lumen').trim().slice(0, 40) || 'lumen',
    input.sourceRef ? String(input.sourceRef).trim().slice(0, 120) : null,
    userId ?? null,
  ];

  // No sourceRef means it is a Portal-native script — nothing to match on, always an insert.
  if (!vals[10]) {
    const ins = await pool.query(
      `INSERT INTO scripts (name, description, file_type, os_type, body, run_as, arguments,
                            max_runtime_minutes, category, source, source_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, vals);
    return { id: ins.rows[0].id, created: true };
  }

  const existing = (await pool.query(
    'SELECT id FROM scripts WHERE source = $1 AND source_ref = $2 LIMIT 1', [vals[9], vals[10]])).rows[0];

  if (existing) {
    await pool.query(
      `UPDATE scripts SET name=$1, description=$2, file_type=$3, os_type=$4, body=$5, run_as=$6,
              arguments=$7, max_runtime_minutes=$8, category=$9, deleted_at=NULL, updated_at=NOW()
        WHERE id=$10`, [...vals.slice(0, 9), existing.id]);
    return { id: existing.id, created: false };
  }

  const ins = await pool.query(
    `INSERT INTO scripts (name, description, file_type, os_type, body, run_as, arguments,
                          max_runtime_minutes, category, source, source_ref, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, vals);
  return { id: ins.rows[0].id, created: true };
}

/** Soft delete — a script someone ran last week should not vanish from the audit trail. */
export async function deleteScript(id: number): Promise<void> {
  await pool.query('UPDATE scripts SET deleted_at = NOW() WHERE id = $1', [id]);
}

export interface ScriptStats {
  total: number; fromAtera: number; ownWork: number; bytes: number;
  broken: number; warn: number; ok: number; unreviewed: number;
}

export async function scriptStats(): Promise<ScriptStats> {
  const r = (await pool.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE source = 'atera')::int "fromAtera",
            COUNT(*) FILTER (WHERE source <> 'atera')::int "ownWork",
            COALESCE(SUM(octet_length(body)), 0)::int bytes,
            COUNT(*) FILTER (WHERE review_verdict = 'broken')::int broken,
            COUNT(*) FILTER (WHERE review_verdict = 'warn')::int warn,
            COUNT(*) FILTER (WHERE review_verdict = 'ok')::int ok,
            COUNT(*) FILTER (WHERE reviewed_at IS NULL)::int unreviewed
       FROM scripts WHERE deleted_at IS NULL`)).rows[0];
  return r;
}
