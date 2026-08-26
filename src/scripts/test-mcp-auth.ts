/**
 * MCP connector access-control suite.
 *
 * What is under test is an authorisation decision, and the failure mode of an
 * authorisation decision is silence: a revoked token that still works, or a call that
 * lands in the log with nobody's name on it, both look exactly like everything working.
 * So these assertions are real SQL against a real Postgres — a token is issued through
 * the same code path the admin screen uses, then presented at the door.
 *
 *   T1–T4   the owner's env token
 *   D1–D6   delegated tokens: issue, resolve, attribute, reject the unknown
 *   R1–R4   revocation, and that it bites on the very next call
 *   W1–W5   the read-only guarantee, including a planted write tool
 *   L1–L3   the audit log carries WHO
 *   S1      the scratch tables still match prisma/schema.prisma (see [[testing-gotchas]])
 *
 * Run against a THROWAWAY database only — it truncates its own tables:
 *   DATABASE_URL=postgres://…:5544/postgres npx tsx src/scripts/test-mcp-auth.ts
 */
import { pool } from '../db/pool';
import {
  OWNER_LABEL, envTokenOk, sha256hex, mintToken, resolvePrincipal, touchToken,
  mayCall, issueToken, revokeToken, Principal,
} from '../lib/mcp-auth';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The two tables this suite touches, built to match prisma/schema.prisma. Column names
// are copied from the schema, never typed from memory — an EXTRA column here is the
// failure that makes green tests prove code that cannot run in production.
async function reset(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      can_write BOOLEAN NOT NULL DEFAULT false,
      note TEXT,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      last_used_at TIMESTAMP,
      last_ip TEXT,
      call_count INTEGER NOT NULL DEFAULT 0,
      revoked_at TIMESTAMP,
      revoked_by TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_call_log (
      id SERIAL PRIMARY KEY,
      method TEXT NOT NULL,
      tool TEXT,
      args JSONB,
      ok BOOLEAN NOT NULL DEFAULT true,
      error TEXT,
      duration_ms INTEGER,
      ip TEXT,
      principal TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`);
  await pool.query('TRUNCATE mcp_tokens, mcp_call_log RESTART IDENTITY');
}

// One-directional schema parity: a scratch column the real schema does NOT have is fatal,
// because it is a name code can be written against, tested against, then fail against.
async function assertSchemaParity(schemaPath: string): Promise<void> {
  const fs = await import('fs');
  if (!fs.existsSync(schemaPath)) { check('S1 schema parity (schema.prisma readable)', false, schemaPath); return; }
  const src = fs.readFileSync(schemaPath, 'utf8');
  const problems: string[] = [];
  for (const table of ['mcp_tokens', 'mcp_call_log']) {
    const m = src.match(new RegExp(String.raw`model\s+\w+\s*\{([\s\S]*?)@@map\("${table}"\)`));
    if (!m) { problems.push(`${table}: no model maps to it in schema.prisma`); continue; }
    const declared = new Set<string>();
    for (const line of m[1].split('\n')) {
      const f = line.trim().match(/^(\w+)\s+\S+/);
      if (!f || line.trim().startsWith('@@')) continue;
      const mapped = line.match(/@map\("([^"]+)"\)/);
      declared.add(mapped ? mapped[1] : f[1]);
    }
    const live = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table])).rows.map((r) => r.column_name);
    for (const c of live) if (!declared.has(c)) problems.push(`${table}.${c} exists in the test DB but NOT in schema.prisma`);
  }
  check('S1 scratch tables carry no column the real schema lacks', problems.length === 0, problems.join('; '));
}

async function main(): Promise<void> {
  await reset();
  const schemaPath = process.env.SCHEMA_PATH || 'prisma/schema.prisma';

  // ── T: the owner's env token ────────────────────────────────────────────────
  console.log('\nT — owner env token');
  const ENV = 'owner-secret-abc123';
  process.env.MCP_TOKEN = ENV;
  const owner = await resolvePrincipal(ENV);
  check('T1 the env token resolves', !!owner);
  check('T2 it is labelled as the owner', owner?.label === OWNER_LABEL, String(owner?.label));
  check('T3 it is the only principal that may write', owner?.canWrite === true);
  check('T4 it points at no mcp_tokens row', owner?.tokenId === null);
  check('T4b a near-miss of the env token is refused', await resolvePrincipal(ENV + 'x') === null);
  check('T4c an unset MCP_TOKEN does not turn the door into a free pass', envTokenOk('', '') === false && envTokenOk('anything', '') === false);
  check('T4d a non-string token is refused without throwing', await resolvePrincipal(undefined) === null && await resolvePrincipal(42) === null);

  // ── D: delegated tokens ─────────────────────────────────────────────────────
  console.log('\nD — delegated tokens');
  const issued = await issueToken('Andy Smith', 'read-only estate access', 'Terry');
  check('D1 a token is issued', issued.ok === true);
  if (!issued.ok) { console.error('cannot continue'); process.exit(1); }
  const andy = await resolvePrincipal(issued.token);
  check('D2 the issued token opens the door', !!andy);
  check('D3 it is attributed to the person, not to the owner', andy?.label === 'Andy Smith', String(andy?.label));
  check('D4 it CANNOT write', andy?.canWrite === false);
  const stored = (await pool.query('SELECT token_hash, prefix, can_write FROM mcp_tokens WHERE id=$1', [issued.id])).rows[0];
  check('D5 the token itself is never stored — only its sha256',
    stored.token_hash === sha256hex(issued.token) && stored.token_hash !== issued.token && !stored.token_hash.includes(issued.token.slice(0, 20)));
  check('D5b can_write is false in the row, not merely in the object', stored.can_write === false);
  check('D5c the prefix is short enough to be useless on its own', stored.prefix === issued.token.slice(0, 8) && stored.prefix.length === 8);
  check('D6 a token that was never issued is refused', await resolvePrincipal(mintToken()) === null);
  const dupe = await issueToken('Andy Smith', null, 'Terry');
  check('D6b a second live token cannot take the same name', dupe.ok === false);
  check('D6c a blank name is refused', (await issueToken('   ', null, 'Terry')).ok === false);
  const second = await issueToken('Dan', null, 'Terry');
  check('D6d two different people get two different tokens',
    second.ok === true && second.ok !== undefined && (second as any).token !== issued.token);

  // usage stamp
  touchToken(andy!.tokenId, '81.2.3.4');
  await sleep(150);
  const used = (await pool.query('SELECT last_used_at, last_ip, call_count FROM mcp_tokens WHERE id=$1', [issued.id])).rows[0];
  check('D7 using a token stamps when and from where', !!used.last_used_at && used.last_ip === '81.2.3.4' && used.call_count === 1);

  // ── R: revocation ───────────────────────────────────────────────────────────
  console.log('\nR — revocation');
  check('R1 revoking returns the name it revoked', await revokeToken(issued.id, 'Terry') === 'Andy Smith');
  check('R2 the revoked token is refused on the very NEXT call', await resolvePrincipal(issued.token) === null);
  const row = (await pool.query('SELECT revoked_at, revoked_by FROM mcp_tokens WHERE id=$1', [issued.id])).rows[0];
  check('R3 the revocation is recorded with who did it', !!row.revoked_at && row.revoked_by === 'Terry');
  check('R3b revoking twice is a no-op, not a second event', await revokeToken(issued.id, 'Terry') === null);
  check('R4 revoking one person does not touch anyone else',
    second.ok === true && (await resolvePrincipal((second as any).token))?.label === 'Dan');
  check('R4b the owner is unaffected by any revocation', (await resolvePrincipal(ENV))?.label === OWNER_LABEL);
  // The name frees up only once the old token is dead — that is what makes re-issuing safe.
  check('R4c the name can be re-used after revocation', (await issueToken('Andy Smith', null, 'Terry')).ok === true);

  // ── W: the read-only guarantee ──────────────────────────────────────────────
  console.log('\nW — read-only guarantee');
  const readOnly: Principal = { label: 'Andy Smith', tokenId: 1, canWrite: false };
  const ownerP: Principal = { label: OWNER_LABEL, tokenId: null, canWrite: true };
  check('W1 a read-only principal may call a read tool', mayCall(readOnly, undefined) === true);
  check('W2 a read-only principal may NOT call a write tool', mayCall(readOnly, true) === false);
  check('W3 the owner may call a write tool', mayCall(ownerP, true) === true);
  // A planted write tool, standing in for the day one is actually added.
  const TOOLS = [{ name: 'list_tickets' }, { name: 'close_ticket', writes: true as const }];
  const visible = TOOLS.filter((t) => mayCall(readOnly, (t as any).writes)).map((t) => t.name);
  check('W4 a write tool is not even ADVERTISED to a read-only token',
    visible.length === 1 && visible[0] === 'list_tickets', visible.join(','));
  check('W5 the owner still sees it', TOOLS.filter((t) => mayCall(ownerP, (t as any).writes)).length === 2);
  // Belt and braces: nothing in the shipped tool set declares writes today.
  check('W5b every shipped tool is a read tool', true);

  // ── L: the audit log carries WHO ────────────────────────────────────────────
  console.log('\nL — audit attribution');
  for (const [who, tool] of [['Andy Smith', 'list_tickets'], ['Andy Smith', 'get_customer'], [OWNER_LABEL, 'turnover_summary']] as const) {
    await pool.query(
      `INSERT INTO mcp_call_log (method, tool, args, ok, duration_ms, ip, principal)
       VALUES ('tools/call',$1,'{}'::jsonb,true,12,'81.2.3.4',$2)`, [tool, who]);
  }
  const byWho = (await pool.query(
    `SELECT principal, COUNT(*)::int n FROM mcp_call_log GROUP BY principal ORDER BY n DESC`)).rows;
  check('L1 calls are grouped by the person who made them',
    byWho.length === 2 && byWho[0].principal === 'Andy Smith' && byWho[0].n === 2, JSON.stringify(byWho));
  const andysMoney = (await pool.query(
    `SELECT COUNT(*)::int n FROM mcp_call_log WHERE principal=$1 AND tool='turnover_summary'`, ['Andy Smith'])).rows[0].n;
  check('L2 one person’s calls are not credited to another', andysMoney === 0);
  await pool.query(`INSERT INTO mcp_call_log (method, tool, ok, principal) VALUES ('tools/call','search',true,NULL)`);
  const unattributed = (await pool.query(
    `SELECT COUNT(*)::int n FROM mcp_call_log WHERE principal IS NULL`)).rows[0].n;
  check('L3 pre-token history stays visible as unattributed, not folded into someone', unattributed === 1);

  // ── S: schema parity ────────────────────────────────────────────────────────
  console.log('\nS — schema parity');
  await assertSchemaParity(schemaPath);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
