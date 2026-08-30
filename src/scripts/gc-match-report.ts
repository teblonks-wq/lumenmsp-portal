import 'dotenv/config';
import { pool } from '../db/pool';
import { GoCardless } from '../lib/gocardless';
import { buildMatchState, TIER_LABEL } from '../lib/gocardless-match';

// READ-ONLY dry run of the GoCardless matcher. Prints exactly what the hourly sync WOULD do —
// who links to whom and on what evidence — and writes nothing. Run this after a deploy, before
// letting the matcher act, whenever the matching rules change.
//
// Run on the server:  node dist/scripts/gc-match-report.js

async function main() {
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) { console.log('GoCardless is not configured.'); return; }
  const state = await buildMatchState(gc);

  for (const w of state.warnings) console.log('WARNING:', w);
  console.log('');
  console.log(`GoCardless customers: ${state.stats.total}  (active mandate: ${state.stats.withMandate}, none: ${state.stats.noMandate})`);
  console.log(`Already matched: ${state.stats.linked}   proposed: ${state.stats.suggested}   no match: ${state.stats.unmatched}`);
  console.log('');

  const willLink = state.rows.filter((r) => !r.linked && r.match && r.confident);
  const needsHuman = state.rows.filter((r) => !r.linked && r.match && !r.confident);
  const nothing = state.rows.filter((r) => !r.linked && !r.match);
  const refresh = state.rows.filter((r) => r.linked && String(r.linked.gocardless_mandate_id || '') !== String(r.mandateId || ''));

  console.log(`── WOULD AUTO-LINK (${willLink.length}) ──`);
  for (const r of willLink) {
    console.log(`  ${r.gcName.padEnd(34)} ${(r.gcEmail || '').padEnd(30)} → ${r.match!.name}   [${TIER_LABEL[r.tier!]}]  mandate=${r.mandateId || 'none'}`);
  }

  console.log('');
  console.log(`── WOULD REFRESH THE CACHED MANDATE (${refresh.length}) ──`);
  for (const r of refresh) {
    console.log(`  ${r.linked!.name.padEnd(34)} ${String(r.linked!.gocardless_mandate_id || 'none')} → ${r.mandateId || 'none'}`);
  }

  console.log('');
  console.log(`── NEEDS A HUMAN (${needsHuman.length}) ──`);
  for (const r of needsHuman) {
    console.log(`  ${r.gcName.padEnd(34)} ${(r.gcEmail || '').padEnd(30)} ~ ${r.match!.name}   [${TIER_LABEL[r.tier!]}]${r.ambiguous ? '  ⚠ ' + r.ambiguous : ''}`);
  }

  console.log('');
  console.log(`── NO MATCH AT ALL (${nothing.length}) ──`);
  for (const r of nothing) {
    console.log(`  ${r.gcName.padEnd(34)} ${(r.gcEmail || '').padEnd(30)} mandate=${r.mandateId || 'none'}${r.ambiguous ? '  ⚠ ' + r.ambiguous : ''}`);
  }

  console.log('');
  console.log(`── DEAD MANDATES STILL HELD BY A CUSTOMER (${state.stale.length}) ──`);
  for (const s of state.stale) {
    console.log(`  ${s.customer.name.padEnd(34)} ${s.customer.gocardless_mandate_id}  (${s.reason})`);
  }
  console.log('');
  console.log('Nothing was written.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
