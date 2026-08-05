#!/usr/bin/env node
/*
 * One-shot cleanup: remove MeshCentral device groups that the bridge created for
 * customers the Portal no longer offers (leads, website enquiries, placeholders).
 *
 *   sudo bash -c 'set -a; . /etc/lumen-mesh-bridge.env; set +a; node /opt/lumen-bridge/mesh-prune.js'
 *
 * Dry run by default — it prints what it WOULD delete and stops. Add --yes to act.
 * Groups containing devices are never touched, whatever the flag says: deleting a
 * populated group would orphan real machines.
 */

'use strict';

const { execFileSync } = require('node:child_process');

const MESHCTRL = '/opt/meshcentral/node_modules/meshcentral/meshctrl';
const GO = process.argv.includes('--yes');

const env = (n) => { const v = process.env[n]; if (!v) { console.error(`Missing ${n}`); process.exit(2); } return v; };
const MESH_URL = env('MESH_URL'), MESH_USER = env('MESH_USER'), MESH_PASS = env('MESH_PASS');
const PORTAL_URL = env('PORTAL_URL').replace(/\/+$/, ''), PORTAL_SECRET = env('PORTAL_SECRET');

function meshctrl(action, args = []) {
  return execFileSync('node', [
    MESHCTRL, action, '--url', MESH_URL, '--loginuser', MESH_USER, '--loginpass', MESH_PASS, ...args,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: '/opt/meshcentral' });
}

function json(action, args = []) {
  const out = meshctrl(action, [...args, '--json']);
  return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
}

(async () => {
  const res = await fetch(`${PORTAL_URL}/agent/api/mesh/customers`, {
    headers: { 'x-mesh-bridge-secret': PORTAL_SECRET },
  });
  if (!res.ok) { console.error(`Portal returned ${res.status}`); process.exit(1); }
  const { customers } = await res.json();
  const keep = new Set(customers.map((c) => `lumen-customer:${c.id}`));

  const groups = json('listdevicegroups');
  const devices = json('listdevices');
  const populated = new Set(devices.map((d) => d.meshid));

  const doomed = groups.filter((g) => {
    const desc = (g.desc || '').trim();
    if (!desc.startsWith('lumen-customer:')) return false;   // not ours, leave alone
    if (keep.has(desc)) return false;                         // still a live customer
    return true;
  });

  if (!doomed.length) { console.log('Nothing to prune.'); return; }

  for (const g of doomed) {
    if (populated.has(g._id)) {
      console.log(`SKIP  ${g.name} — has devices in it`);
      continue;
    }
    if (!GO) { console.log(`WOULD DELETE  ${g.name}  (${g.desc})`); continue; }
    try {
      meshctrl('removedevicegroup', ['--id', g._id.replace(/^mesh\/\//, '')]);
      console.log(`deleted  ${g.name}`);
    } catch (e) {
      console.error(`failed   ${g.name}: ${String(e.message).split(MESH_PASS).join('«redacted»').slice(0, 200)}`);
    }
  }

  if (!GO) console.log('\nDry run. Re-run with --yes to actually delete.');
})().catch((e) => {
  console.error(String(e.message).split(MESH_PASS).join('«redacted»'));
  process.exit(1);
});
