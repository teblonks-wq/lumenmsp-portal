/**
 * The asset list's advanced query builder.
 *
 * Rows of "where FIELD OPERATOR VALUE", combined with AND or OR, exactly like the RMM
 * consoles everyone already knows. The whole point is that it accepts arbitrary user text
 * and turns it into SQL, so the ONE rule that matters:
 *
 *   NOTHING FROM THE REQUEST IS EVER INTERPOLATED INTO SQL.
 *
 * The field name is looked up in an allow-list and yields a fixed column expression we
 * wrote. The operator is looked up in an allow-list and yields a fixed fragment we wrote.
 * Only the VALUE travels, and it travels as a bound parameter. A field or operator we do
 * not recognise is dropped, not guessed at - a filter that silently ignores a condition
 * shows you the wrong machines, which on a screen wired to bulk software deployment is
 * not a cosmetic bug.
 */

type Kind = 'text' | 'number' | 'date' | 'enum' | 'tag';

interface FieldDef { label: string; col: string; kind: Kind; options?: string[] }

/** field key -> the column expression WE control. */
export const ASSET_FIELDS: Record<string, FieldDef> = {
  friendly_name: { label: 'Friendly name', col: 'a.friendly_name', kind: 'text' },
  hostname:      { label: 'Hostname',      col: 'a.hostname',      kind: 'text' },
  customer:      { label: 'Customer',      col: 'c.name',          kind: 'text' },
  device_type:   { label: 'Device type',   col: 'a.device_type',   kind: 'enum' },
  manufacturer:  { label: 'Manufacturer',  col: 'a.manufacturer',  kind: 'text' },
  model:         { label: 'Model',         col: 'a.model',         kind: 'text' },
  cpu:           { label: 'CPU',           col: 'a.cpu',           kind: 'text' },
  ram_gb:        { label: 'Memory (GB)',   col: 'a.ram_gb',        kind: 'number' },
  ip:            { label: 'IP address',    col: 'a.ip_addresses',  kind: 'text' },
  domain:        { label: 'Domain',        col: 'a.domain_or_workgroup', kind: 'text' },
  os:            { label: 'OS',            col: 'a.os',            kind: 'text' },
  os_version:    { label: 'OS version',    col: 'a.os_version',    kind: 'text' },
  serial:        { label: 'Serial number', col: 'a.serial_number', kind: 'text' },
  last_user:     { label: 'Last user',     col: 'a.last_login_user', kind: 'text' },
  agent_version: { label: 'Agent version', col: 'agd.agent_version', kind: 'text' },
  last_seen:     { label: 'Last seen',     col: 'a.last_seen_at',  kind: 'date' },
  tag:           { label: 'Group',         col: '',                kind: 'tag' },
};

/** operator key -> label, and which kinds of field it is offered for. */
export const ASSET_OPS: Record<string, { label: string; kinds: Kind[]; noValue?: boolean }> = {
  is:          { label: 'is',                kinds: ['text', 'enum', 'number', 'tag'] },
  not:         { label: 'is not',            kinds: ['text', 'enum', 'number', 'tag'] },
  contains:    { label: 'contains',          kinds: ['text'] },
  notcontains: { label: 'does not contain',  kinds: ['text'] },
  starts:      { label: 'starts with',       kinds: ['text'] },
  ends:        { label: 'ends with',         kinds: ['text'] },
  empty:       { label: 'is empty',          kinds: ['text', 'enum'], noValue: true },
  notempty:    { label: 'is not empty',      kinds: ['text', 'enum'], noValue: true },
  gt:          { label: 'is more than',      kinds: ['number'] },
  lt:          { label: 'is less than',      kinds: ['number'] },
  gte:         { label: 'is at least',       kinds: ['number'] },
  lte:         { label: 'is at most',        kinds: ['number'] },
  before:      { label: 'is before',         kinds: ['date'] },
  after:       { label: 'is after',          kinds: ['date'] },
  olderthan:   { label: 'is older than (days)', kinds: ['date'] },
};

export interface Condition { field: string; op: string; value: string }

/** Pull the conditions out of a query string. Repeated cf/co/cv params, aligned by index. */
export function parseConditions(query: any): Condition[] {
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const fs = arr(query.cf), os = arr(query.co), vs = arr(query.cv);
  const out: Condition[] = [];
  for (let i = 0; i < fs.length; i++) {
    const field = fs[i], op = os[i] || 'contains', value = (vs[i] ?? '').trim();
    if (!ASSET_FIELDS[field] || !ASSET_OPS[op]) continue;          // unknown = dropped, never guessed
    if (!value && !ASSET_OPS[op].noValue) continue;                // an empty box is not a filter
    out.push({ field, op, value });
    if (out.length >= 12) break;                                   // a sane ceiling, not a limit anyone meets
  }
  return out;
}

/**
 * Turn conditions into one SQL fragment plus its parameters.
 *
 * `startIndex` is how many parameters the caller has already bound, because this has to
 * slot into a WHERE clause that already carries the simple filters.
 */
export function conditionsToSql(
  conds: Condition[], startIndex: number, join: 'and' | 'or' = 'and',
): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  let n = startIndex;

  for (const c of conds) {
    const f = ASSET_FIELDS[c.field];
    const o = ASSET_OPS[c.op];
    if (!f || !o || !o.kinds.includes(f.kind)) continue;   // operator not valid for this field

    // Groups are a membership question, not a column comparison.
    if (f.kind === 'tag') {
      const id = parseInt(c.value, 10);
      if (!id) continue;
      params.push(id); n++;
      const ex = `EXISTS (SELECT 1 FROM asset_tag_members m WHERE m.asset_id = a.id AND m.tag_id = $${n})`;
      parts.push(c.op === 'not' ? `NOT ${ex}` : ex);
      continue;
    }

    if (o.noValue) {
      parts.push(c.op === 'empty' ? `(${f.col} IS NULL OR ${f.col} = '')` : `(${f.col} IS NOT NULL AND ${f.col} <> '')`);
      continue;
    }

    if (f.kind === 'number') {
      const v = parseFloat(c.value);
      if (!Number.isFinite(v)) continue;
      params.push(v); n++;
      const sym = ({ is: '=', not: '<>', gt: '>', lt: '<', gte: '>=', lte: '<=' } as any)[c.op];
      if (!sym) continue;
      parts.push(`${f.col} ${sym} $${n}`);
      continue;
    }

    if (f.kind === 'date') {
      if (c.op === 'olderthan') {
        const days = parseFloat(c.value);
        if (!Number.isFinite(days)) continue;
        params.push(days); n++;
        parts.push(`${f.col} < NOW() - ($${n} || ' days')::interval`);
      } else {
        params.push(c.value); n++;
        parts.push(`${f.col} ${c.op === 'before' ? '<' : '>'} $${n}::timestamp`);
      }
      continue;
    }

    // text and enum. ILIKE everywhere so nobody has to think about case; the % go on the
    // PARAMETER, never on the SQL, which is what keeps a value like "100%" harmless.
    const like = (v: string) => { params.push(v); n++; return `$${n}`; };
    switch (c.op) {
      case 'is':          parts.push(`${f.col} ILIKE ${like(c.value)}`); break;
      case 'not':         parts.push(`(${f.col} IS NULL OR ${f.col} NOT ILIKE ${like(c.value)})`); break;
      case 'contains':    parts.push(`${f.col} ILIKE ${like('%' + c.value + '%')}`); break;
      case 'notcontains': parts.push(`(${f.col} IS NULL OR ${f.col} NOT ILIKE ${like('%' + c.value + '%')})`); break;
      case 'starts':      parts.push(`${f.col} ILIKE ${like(c.value + '%')}`); break;
      case 'ends':        parts.push(`${f.col} ILIKE ${like('%' + c.value)}`); break;
      default: break;
    }
  }

  if (!parts.length) return { sql: '', params: [] };
  // "is not" with OR is almost always a mistake ("not a laptop OR not a Dell" matches
  // everything), but it is the user's call - we make the join explicit in the UI instead.
  return { sql: '(' + parts.join(join === 'or' ? ' OR ' : ' AND ') + ')', params };
}
