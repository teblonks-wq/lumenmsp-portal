#!/usr/bin/env node
/*
 * [C] gen-module-map.js  —  regenerates "[C] MODULE-MAP.md" from the source tree.
 *
 * WHY THIS EXISTS
 *   A hand-written map of 51 route modules is wrong within a fortnight. This one is
 *   derived from the code, so it can only be as stale as the last time it was run.
 *   Anything a human must assert (what a module is FOR) lives in CLAUDE.md, not here.
 *
 * RUN:  node "ops/[C] gen-module-map.js"     (from the Portal folder root)
 * Reads only. Writes exactly one file: "[C] MODULE-MAP.md".
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const R = (...p) => path.join(ROOT, ...p);

// Run from the wrong directory and every scan returns nothing, which would quietly overwrite
// a good map with an empty one. Fail loudly instead.
if (!fs.existsSync(path.join(ROOT, 'src', 'routes')) || !fs.existsSync(path.join(ROOT, 'package.json'))) {
  console.error('Run this from the Portal folder root (the one containing package.json and src/).');
  console.error('  cd "D:\\LITS\\LumenMSP Portal"; node "ops/[C] gen-module-map.js"');
  console.error('Refusing to write an empty map. Nothing changed. cwd was: ' + ROOT);
  process.exit(1);
}
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const lsx = (d, ext) => { try { return fs.readdirSync(d).filter(f => f.endsWith(ext)).sort(); } catch { return []; } };

const GUARDS = ['requireAuth','requireAdmin','requireFinance','requireCustomer','requireStaff','requireBookkeeper'];

function analyseRoute(file) {
  const src = read(R('src/routes', file));
  const lines = src.split(/\r?\n/);

  // URL paths registered by this router
  const paths = new Set();
  const verbs = { get: 0, post: 0, put: 0, delete: 0, use: 0 };
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete|use)\(\s*['"`]([^'"`]+)['"`]/g)) {
    const verb = m[1] === 'patch' ? 'put' : m[1];
    if (verbs[verb] !== undefined) verbs[verb]++;
    paths.add(m[2]);
  }

  // Top-level URL prefixes, e.g. /tickets/:id/close -> /tickets
  const tops = new Set();
  for (const p of paths) {
    const seg = p.split('/').filter(Boolean)[0];
    if (seg && !seg.startsWith(':')) tops.add('/' + seg);
  }

  // Guards actually referenced
  const guards = GUARDS.filter(g => new RegExp('\\b' + g + '\\b').test(src));

  // Public (no session) routers announce themselves in index.ts; detect token auth here
  const tokenAuth = /bearer|device[- ]?token|shared[- ]?secret|capability|x-api-key/i.test(src);

  // lib/ dependencies
  const libs = [...new Set([...src.matchAll(/from\s+['"]\.\.\/lib\/([\w\-\/]+)['"]/g)].map(m => m[1]))].sort();

  // views rendered
  const views = [...new Set([...src.matchAll(/res\.render\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]))].sort();
  const viewDirs = [...new Set(views.map(v => v.includes('/') ? v.split('/')[0] : '(root)'))].sort();

  return { file, loc: lines.length, tops: [...tops].sort(), verbs, guards, tokenAuth, libs, views, viewDirs };
}

function table(rows, headers) {
  const out = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|'];
  for (const r of rows) out.push('| ' + r.join(' | ') + ' |');
  return out.join('\n');
}

const routeFiles = lsx(R('src/routes'), '.ts');
const mods = routeFiles.map(analyseRoute);

const libFiles = lsx(R('src/lib'), '.ts');
const libDirs = (() => { try { return fs.readdirSync(R('src/lib'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; } })();

// which libs are used by which routes (reverse index)
const libUsers = {};
for (const m of mods) for (const l of m.libs) (libUsers[l] ||= []).push(m.file.replace(/\.ts$/, ''));

// prisma models
const schema = read(R('prisma/schema.prisma'));
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(m => m[1]);
const tableMap = [...schema.matchAll(/^model\s+(\w+)\s*\{[\s\S]*?@@map\("([^"]+)"\)/gm)].map(m => [m[1], m[2]]);

// cron jobs, wherever they are declared (they live in lib/, not index.ts)
function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}
const allTs = walk(R('src')).filter(f => !f.includes(path.sep + 'scripts' + path.sep));
const crons = [];
for (const f of allTs) {
  const src = read(f);
  for (const m of src.matchAll(/cron\.schedule\(\s*['"`]([^'"`]+)['"`]/g)) {
    crons.push({ expr: m[1], file: path.relative(ROOT, f).split(path.sep).join('/') });
  }
}
crons.sort((a, b) => a.file.localeCompare(b.file));

const totalLoc = mods.reduce((a, m) => a + m.loc, 0);
const libLoc = libFiles.reduce((a, f) => a + read(R('src/lib', f)).split(/\r?\n/).length, 0);
const stamp = new Date().toISOString().slice(0, 10);

let out = '';
out += '# [C] Portal Module Map\n\n';
out += '> **GENERATED FILE — DO NOT HAND-EDIT.**\n';
out += '> Regenerate with `node "ops/[C] gen-module-map.js"` from the Portal folder root.\n';
out += '> Last generated: **' + stamp + '**. Anything here is derived from the code, so it is\n';
out += '> true as of that date. What each module is *for* is asserted in `CLAUDE.md`, not here.\n\n';
out += '**Scale:** ' + mods.length + ' route modules (' + totalLoc.toLocaleString() + ' lines) · '
     + libFiles.length + ' lib modules (' + libLoc.toLocaleString() + ' lines) · '
     + models.length + ' Prisma models · ' + lsx(R('src/views'), '.ejs').length + ' root views.\n\n';
out += '---\n\n## 1. Route modules\n\n';
out += 'Every router is mounted at `/` in `src/index.ts`; the URL prefixes below are what each one\n';
out += 'actually claims. **Guard** is the auth middleware referenced in the file — `token` means it\n';
out += 'authenticates by bearer/device token rather than a staff session (a public surface).\n\n';

out += table(mods.map(m => [
  '`' + m.file + '`',
  m.tops.length ? m.tops.map(t => '`' + t + '`').join(' ') : '—',
  m.loc,
  (m.guards.length ? m.guards.map(g => g.replace('require', '')).join(', ') : (m.tokenAuth ? 'token' : '—')),
  m.viewDirs.length ? m.viewDirs.map(v => '`' + v + '`').join(', ') : '—',
  m.libs.length ? m.libs.length + '' : '0',
]), ['Route file', 'URL prefixes', 'LOC', 'Guard', 'Views', 'libs']);

out += '\n\n---\n\n## 2. Route → lib dependencies\n\n';
for (const m of mods) {
  if (!m.libs.length) continue;
  out += '- **`' + m.file.replace(/\.ts$/, '`') + '** → ' + m.libs.map(l => '`lib/' + l + '`').join(', ') + '\n';
}

out += '\n---\n\n## 3. lib → who uses it (reverse index)\n\n';
out += 'A lib with **one** user is effectively private to that route. A lib with **many** is a shared\n';
out += 'contract — changing its behaviour ripples, so check every caller listed.\n\n';
const libRows = Object.keys(libUsers).sort().map(l => [
  '`lib/' + l + '`', libUsers[l].length, libUsers[l].map(u => '`' + u + '`').join(' ')
]);
out += table(libRows, ['lib', '#', 'used by']);

const orphans = libFiles.map(f => f.replace(/\.ts$/, '')).filter(l => !libUsers[l]);
out += '\n\n**Not imported by any route** (called from index.ts, cron, scripts, or each other — not necessarily dead):\n\n';
out += orphans.map(o => '`' + o + '`').join(' · ') + '\n';
if (libDirs.length) out += '\n**lib subdirectories:** ' + libDirs.map(d => '`lib/' + d + '/`').join(' · ') + '\n';

out += '\n---\n\n## 4. View directories\n\n';
const viewDirsOnDisk = (() => { try { return fs.readdirSync(R('src/views'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; } })();
out += table(viewDirsOnDisk.map(d => [
  '`views/' + d + '/`',
  lsx(R('src/views', d), '.ejs').length,
  mods.filter(m => m.viewDirs.includes(d)).map(m => '`' + m.file.replace(/\.ts$/, '') + '`').join(' ') || '—',
]), ['Directory', '.ejs', 'Rendered by']);

out += '\n\n---\n\n## 5. Data model\n\n';
out += models.length + ' models in `prisma/schema.prisma`. Model → table where the mapping is not obvious:\n\n';
out += tableMap.slice(0, 400).map(([m, t]) => '- `' + m + '` → `' + t + '`').join('\n') + '\n';

out += '\n---\n\n## 6. Scheduled work\n\n';
out += 'Scheduled jobs are registered inside the lib modules themselves, not in one place. Every\n';
out += '`cron.schedule` in `src/` (excluding `src/scripts/`) is listed below. Server time is UTC.\n\n';
out += crons.length
  ? table(crons.map(c => ['`' + c.expr + '`', '`' + c.file + '`']), ['Cron', 'Declared in'])
    + '\n\n**' + crons.length + ' scheduled jobs.** They start when the process starts, so a deploy restarts every one of them.\n'
  : '_No `cron.schedule` calls found under `src/`._\n';

fs.writeFileSync(R('[C] MODULE-MAP.md'), out, 'utf8');
console.log('Wrote [C] MODULE-MAP.md — ' + mods.length + ' route modules, ' + libFiles.length + ' libs, ' + models.length + ' models.');
