#!/usr/bin/env node
/*
 * LumenMSP <-> MeshCentral bridge
 * ------------------------------------------------------------------------
 * Runs on mesh01. Pushes to the Portal; the Portal never reaches in here.
 * That direction matters: MeshCentral's control interface stays unreachable
 * from anywhere except this box's own loopback, and the only credential that
 * ever leaves is the shared bridge secret.
 *
 * Each run does four things:
 *
 *   1. Ask the Portal for the customer list.
 *   2. Make sure every customer has a MeshCentral device group.
 *   3. Fetch that group's Windows agent binary and hand it to the Portal,
 *      which serves it to our own agents over their authenticated channel.
 *   4. Export the device list so every MeshCentral node id gets matched back
 *      to an AgentDevice row. That mapping is what makes the Portal's
 *      "Remote control" button work without anyone typing anything.
 *
 * Everything is idempotent. Run it every five minutes; it does nothing on a
 * quiet cycle and repairs itself on a noisy one.
 *
 * Facts learned the hard way (see the notes doc) and encoded below:
 *   - adddevicegroup / listdevicegroups return ids as "mesh//xxxx"
 *   - agentdownload wants that id WITHOUT the "mesh//" prefix
 *   - agentdownload refuses when lockAgentDownload is true, and the invite
 *     link route can't be driven from a script (the binary 401s even with the
 *     invite cookie), so lockAgentDownload is false and the meshid is the
 *     secret that matters
 *   - agent type 4 = Windows x86-64 service; installflags 2 = background only
 *   - meshctrl is invoked with an argument ARRAY, never a shell string:
 *     group ids routinely contain $ @ / and would be mangled by a shell
 */

'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const execFileAsync = promisify(execFile);

const MESHCTRL = process.env.MESHCTRL_PATH
  || '/opt/meshcentral/node_modules/meshcentral/meshctrl';

const CFG = {
  meshUrl: req('MESH_URL'),
  meshUser: req('MESH_USER'),
  meshPass: req('MESH_PASS'),
  portalUrl: req('PORTAL_URL').replace(/\/+$/, ''),
  portalSecret: req('PORTAL_SECRET'),
  // Windows x86-64 service agent, background-only.
  agentType: process.env.MESH_AGENT_TYPE || '4',
  installFlags: process.env.MESH_INSTALL_FLAGS || '2',
};

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} - is EnvironmentFile=/etc/lumen-mesh-bridge.env set?`);
    process.exit(2);
  }
  return v;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------------------------------------------------------- meshctrl */

/**
 * Run a meshctrl action. Arguments go across as an array so nothing is ever
 * parsed by a shell - group ids contain $ and @ and would not survive it.
 */
async function meshctrl(action, args = []) {
  const argv = [
    MESHCTRL, action,
    '--url', CFG.meshUrl,
    '--loginuser', CFG.meshUser,
    '--loginpass', CFG.meshPass,
    ...args,
  ];
  const { stdout } = await execFileAsync('node', argv, {
    maxBuffer: 32 * 1024 * 1024,
    cwd: '/opt/meshcentral',
  });
  return stdout;
}

async function meshctrlJson(action, args = []) {
  const out = await meshctrl(action, [...args, '--json']);
  const from = out.indexOf('[');
  const to = out.lastIndexOf(']');
  if (from < 0 || to < from) {
    // meshctrl reports failures as plain prose on stdout rather than a non-zero
    // exit, so an unparseable response is the error message.
    throw new Error(`${action}: unexpected response: ${out.trim().slice(0, 200)}`);
  }
  return JSON.parse(out.slice(from, to + 1));
}

/** "mesh//abc" -> "abc". agentdownload rejects the prefixed form. */
const bareId = (id) => String(id || '').replace(/^mesh\/\//, '');

/* ------------------------------------------------------------------ portal */

async function portal(method, route, body, isForm = false) {
  const headers = { 'x-mesh-bridge-secret': CFG.portalSecret };
  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${CFG.portalUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`portal ${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  // Some routes legitimately return nothing.
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`portal ${method} ${route}: response was not JSON: ${text.slice(0, 200)}`); }
}

/* -------------------------------------------------------------------- work */

/**
 * The description carries the Portal's customer id. The Portal stores the
 * group id at its end, but keeping the reverse mapping here means the link is
 * recoverable from MeshCentral alone if the Portal is ever restored from an
 * older backup - which is exactly when you least want to rebuild it by hand.
 */
const descFor = (customerId) => `lumen-customer:${customerId}`;

function findGroupFor(groups, customer) {
  const wanted = descFor(customer.id);
  return groups.find((g) => (g.desc || '').trim() === wanted)
    || (customer.meshGroupId ? groups.find((g) => g._id === customer.meshGroupId) : undefined);
}

async function ensureGroup(groups, customer) {
  const existing = findGroupFor(groups, customer);
  if (existing) {
    // Track renames so the console stays readable, but never key on the name.
    if (existing.name !== customer.name) {
      log(`renaming group for customer ${customer.id}: "${existing.name}" -> "${customer.name}"`);
      await meshctrl('editdevicegroup', ['--id', bareId(existing._id), '--name', customer.name]);
      existing.name = customer.name;
    }
    return existing;
  }

  log(`creating device group for customer ${customer.id} (${customer.name})`);
  // --features 2 is Hostname Sync: MeshCentral tracks the device's real
  // hostname, which is what the node-id matching below relies on.
  await meshctrl('adddevicegroup', [
    '--name', customer.name,
    '--desc', descFor(customer.id),
    '--features', '2',
  ]);

  const after = await meshctrlJson('listdevicegroups');
  const created = findGroupFor(after, customer);
  if (!created) throw new Error(`created a group for customer ${customer.id} but could not find it again`);
  groups.length = 0;
  groups.push(...after);
  return created;
}

/**
 * Download this group's agent and hand it to the Portal. The Portal stores it
 * as a package and serves it to our agents over the channel they already
 * authenticate on - so nothing anonymous is used in normal running, even
 * though the download here is unauthenticated.
 */
async function pushAgentBinary(customer, group) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshagent-'));
  try {
    await meshctrl('agentdownload', [
      '--id', bareId(group._id),
      '--type', CFG.agentType,
      '--installflags', CFG.installFlags,
    ]);

    // meshctrl writes into the process working directory, naming the file
    // after the group. Take whatever .exe appeared rather than guessing at
    // how it sanitised the name.
    const cwdFiles = await fs.readdir('/opt/meshcentral');
    const exe = cwdFiles.filter((f) => f.toLowerCase().endsWith('.exe'))
      .map((f) => path.join('/opt/meshcentral', f))
      .sort()
      .pop();
    if (!exe) throw new Error('agentdownload reported success but produced no .exe');

    const buf = await fs.readFile(exe);
    if (buf.length < 1_000_000 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
      // "MZ" - a DOS/PE header. An error page would be a few bytes of text,
      // and we are about to run this as SYSTEM on customer machines.
      throw new Error(`downloaded agent does not look like a Windows executable (${buf.length} bytes)`);
    }

    const form = new FormData();
    form.append('customerId', String(customer.id));
    form.append('meshGroupId', group._id);
    form.append('file', new Blob([buf], { type: 'application/octet-stream' }), 'meshagent64.exe');
    await portal('POST', '/agent/api/mesh/agent-binary', form, true);

    log(`uploaded agent for customer ${customer.id} (${buf.length} bytes)`);
    await fs.unlink(exe).catch(() => {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  const { customers } = await portal('GET', '/agent/api/mesh/customers');
  if (!Array.isArray(customers)) throw new Error('Portal did not return a customer list');
  log(`${customers.length} customer(s) from the Portal`);

  const groups = await meshctrlJson('listdevicegroups');

  for (const customer of customers) {
    try {
      const group = await ensureGroup(groups, customer);

      if (customer.meshGroupId !== group._id || !customer.hasAgentBinary) {
        await portal('POST', '/agent/api/mesh/group', {
          customerId: customer.id,
          meshGroupId: group._id,
          meshGroupName: group.name,
        });
      }
      if (!customer.hasAgentBinary) await pushAgentBinary(customer, group);
    } catch (err) {
      // One broken customer must not stop the rest. The next run retries.
      console.error(`customer ${customer.id} (${customer.name}): ${err.message}`);
    }
  }

  // Node id mapping. Hostname is the join key, which is why every group is
  // created with Hostname Sync on.
  const devices = await meshctrlJson('listdevices');
  const mapped = devices
    .filter((d) => d._id && (d.rname || d.name))
    .map((d) => ({
      nodeId: d._id,
      meshGroupId: d.meshid,
      hostname: (d.rname || d.name || '').trim(),
      osName: d.osdesc || null,
      online: d.conn ? true : false,
    }));

  await portal('POST', '/agent/api/mesh/devices', { devices: mapped });
  log(`reported ${mapped.length} device(s) to the Portal`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error('bridge run failed:', err.message); process.exit(1); },
);
