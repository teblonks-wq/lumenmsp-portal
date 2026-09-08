/**
 * The asset list's sticky filter, proven branch by branch.   npm run test:asset-filters
 *
 * Every case here is a way the list is actually reached: the sidebar link, a back link from a
 * device, a batch finishing with a message, a tile click, emptying the dropdowns by hand, and
 * the Clear button. The one that matters most is "empty means empty" - get that wrong and the
 * dropdowns cannot be cleared, which is worse than the bug this fixes.
 */
import { stickyAssetFilter, assetFilterQuery } from '../lib/asset-filter';

let pass = 0, fail = 0;
function check(name: string, got: any, want: any) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}`);
  if (!ok) console.log(`      wanted ${JSON.stringify(want)}\n      got    ${JSON.stringify(got)}`);
}

console.log('\nSticky asset filters\n');

// Nothing remembered, nothing asked: an ordinary first visit.
check('first visit renders everything', stickyAssetFilter({}, undefined), { kind: 'use', save: null });

// Filtering. The form submits every control, so the empties arrive too and must not be saved.
check('a filter is remembered',
  stickyAssetFilter({ q: 'dell', customer: '304', type: '', online: '', agent: '', nouser: '', patch: '', sec: '' }, undefined),
  { kind: 'use', save: 'q=dell&customer=304' });

// The whole point: coming back to a bare /assets puts it back.
check('the sidebar link restores it',
  stickyAssetFilter({}, 'q=dell&customer=304'),
  { kind: 'restore', to: '/assets?q=dell&customer=304' });

// A batch finishing redirects with its own result - which must survive the restore.
check('a message survives the restore',
  stickyAssetFilter({ msg: 'Queued on 4 machines' }, 'customer=304'),
  { kind: 'restore', to: '/assets?customer=304&msg=Queued+on+4+machines' });

// Empty means empty: clearing the last dropdown by hand is an explicit "show me everything".
check('emptying the dropdowns forgets it',
  stickyAssetFilter({ q: '', customer: '', type: '', online: '', agent: '' }, 'q=dell&customer=304'),
  { kind: 'use', save: null });

// The Clear button.
check('?clear=1 forgets it', stickyAssetFilter({ clear: '1' }, 'q=dell'), { kind: 'clear' });

// Arriving with a different filter replaces what was remembered, it does not merge.
check('a new filter replaces the old',
  stickyAssetFilter({ customer: '282' }, 'q=dell&customer=304'),
  { kind: 'use', save: 'customer=282' });

// The advanced panel and the group dropdown are filters too, or "Clear" would leave the list
// narrowed with nothing on screen to say why.
check('hardware boxes are part of the filter',
  stickyAssetFilter({ make: 'Dell', rammax: '8', tag: '3' }, undefined),
  { kind: 'use', save: 'make=Dell&rammax=8&tag=3' });

// Conditions travel as three parallel arrays. They must stay aligned even when a value is
// blank, or condition two ends up asking condition one's question.
check('conditions keep their alignment',
  assetFilterQuery({ cf: ['os', 'ram_gb'], co: ['contains', 'lt'], cv: ['', '8'] }).toString(),
  'cf=os&co=contains&cv=&cf=ram_gb&co=lt&cv=8');

check('conditions are remembered',
  stickyAssetFilter({ cf: 'os', co: 'contains', cv: 'Windows 10', cj: 'or' }, undefined),
  { kind: 'use', save: 'cj=or&cf=os&co=contains&cv=Windows+10' });

// `cj` defaults to "and", so on its own it is not a filter and must not make the list look
// filtered - the Clear button would appear with nothing to clear.
check('cj=and alone is not a filter',
  stickyAssetFilter({ cj: 'and' }, undefined),
  { kind: 'use', save: null });

// A restore must never bounce again: the URL it sends you to carries filter keys, so the next
// request is explicit. Proven by feeding the redirect back in.
const restored = stickyAssetFilter({}, 'q=dell') as any;
const round = new URLSearchParams(restored.to.split('?')[1]);
check('a restore does not loop',
  stickyAssetFilter(Object.fromEntries(round), 'q=dell'),
  { kind: 'use', save: 'q=dell' });

console.log(`\n${fail ? '\x1b[31m✗' : '\x1b[32m✓'}\x1b[0m ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
