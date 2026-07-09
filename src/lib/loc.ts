import fs from 'fs';
import path from 'path';

// Live count of the lines of code that make up the portal. Walks the project source once and
// memoises the result (cheap thereafter). Counts the hand-written source — TypeScript, EJS views,
// front-end JS/CSS and the Prisma schema — and skips deps, build output, uploads and vendor mins.
// In production (where only dist/ ships) it falls back to counting the compiled JS.

export interface LocStats { total: number; files: number; byExt: Record<string, number> }

let _cache: LocStats | null = null;

const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'attachments', '.claude', 'coverage', '.next', 'tmp']);
const EXTS = new Set(['.ts', '.tsx', '.ejs', '.js', '.css', '.prisma']);

function walk(dir: string, acc: LocStats, skipDist: boolean): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (skipDist && e.name === 'dist') continue;
      walk(path.join(dir, e.name), acc, skipDist);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (!EXTS.has(ext)) continue;
      if (/\.min\.(js|css)$/i.test(e.name) || /\.d\.ts$/i.test(e.name)) continue; // skip vendor mins + type decls
      try {
        const txt = fs.readFileSync(path.join(dir, e.name), 'utf8');
        const lines = txt.length ? txt.split('\n').length : 0;
        acc.total += lines;
        acc.files += 1;
        acc.byExt[ext] = (acc.byExt[ext] || 0) + lines;
      } catch { /* unreadable — ignore */ }
    }
  }
}

export function linesOfCode(): LocStats {
  if (_cache) return _cache;
  const root = process.cwd();
  const hasSrc = fs.existsSync(path.join(root, 'src'));
  const acc: LocStats = { total: 0, files: 0, byExt: {} };
  walk(root, acc, hasSrc); // if src/ is present, count it and skip dist/ to avoid double-counting
  _cache = acc;
  return acc;
}
