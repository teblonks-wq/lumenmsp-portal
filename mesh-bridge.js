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

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

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
  // Engineers' MeshCentral accounts, comma-separated, in MeshCentral's internal form
  // (user//name). Groups are created by the service account, and MeshCentral grants
  // rights to whoever created a group - so without this, the only login that can
  // actually use remote control is the unattended one, which is exactly backwards.
  // Adding an engineer is one edit here plus one bridge run.
  adminUsers: (process.env.MESH_ADMIN_USER || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  // Session recordings: where MeshCentral writes them, and how long we keep them.
  recordingsDir: process.env.MESH_RECORDINGS_DIR || '/opt/meshcentral/meshcentral-recordings',
  retentionDays: parseInt(process.env.MESH_RETENTION_DAYS || '60', 10),
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

/** How meshctrl reports a real failure — always as prose, never reliably as an exit code. */
const FAILED = /^(invalid|unknown|missing|access denied|unauthorized|not found|file .* already exists)/i;

/* ---------------------------------------------------------------- meshctrl */

/**
 * Run a meshctrl action. Arguments go across as an array so nothing is ever
 * parsed by a shell - group ids contain $ and @ and would not survive it.
 */
/**
 * Run meshctrl and hand back everything it printed.
 *
 * Deliberately spawn() rather than execFile(): meshctrl's exit codes cannot be trusted
 * in either direction - agentdownload exits non-zero after a SUCCESSFUL download, and
 * other failures exit zero and only say so in the text. execFile treats a non-zero exit
 * as a rejection, and the stdout hung off that rejection is not reliably complete: it
 * silently handed back half a 300 KB device list, which then failed to parse in a way
 * that looked like MeshCentral emitting bad JSON. So: collect the stream ourselves,
 * resolve on close whatever the code, and judge the OUTPUT.
 */
async function spawnMeshctrl(argv, cwd) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshctrl-'));
  const outPath = path.join(dir, 'out.txt');
  const fh = await fs.open(outPath, 'w');
  try {
    const err = await new Promise((resolve, reject) => {
      // stdout goes straight to a FILE DESCRIPTOR, not a pipe. meshctrl ends with
      // process.exit(), and Node discards whatever is still buffered on a piped stdout
      // when that happens — which silently truncated a 309 KB device list to exactly
      // half. Writes to a file are synchronous, so nothing is lost.
      const child = spawn('node', argv, { cwd, stdio: ['ignore', fh.fd, 'pipe'] });
      let e = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { e += c; });
      child.on('error', reject);
      child.on('close', () => resolve(e));
    });
    await fh.close();
    const out = await fs.readFile(outPath, 'utf8');
    return { out, err };
  } finally {
    await fh.close().catch(() => {});          // already closed on the happy path
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function meshctrl(action, args = [], cwd = '/opt/meshcentral') {
  const argv = [
    MESHCTRL, action,
    '--url', CFG.meshUrl,
    '--loginuser', CFG.meshUser,
    '--loginpass', CFG.meshPass,
    ...args,
  ];

  let res;
  try {
    res = await spawnMeshctrl(argv, cwd);
  } catch (err) {
    // Never let the command line reach a log — it carries the password.
    throw new Error(redact(`${action} could not start: ${err.message}`).slice(0, 300));
  }

  const text = (res.out || '').trim();
  if (!text && res.err) throw new Error(redact(`${action} failed: ${res.err}`).slice(0, 300));
  if (FAILED.test(text)) throw new Error(`${action}: ${text.slice(0, 200)}`);
  return res.out;
}

/** Strip the MeshCentral password out of anything on its way to a log. */
function redact(text) {
  return String(text || '').split(CFG.meshPass).join('«redacted»');
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
  const slice = out.slice(from, to + 1);
  try {
    return JSON.parse(slice);
  } catch (err) {
    // Say WHERE it broke. "Unexpected token" against a 300 KB document tells you
    // nothing; the surrounding characters told us straight away we had half a file.
    const at = Number((/position (\d+)/.exec(err.message) || [])[1]);
    const near = Number.isFinite(at)
      ? ` near ${JSON.stringify(slice.slice(Math.max(0, at - 50), at + 50))}`
      : '';
    throw new Error(`${action}: response was not valid JSON (${slice.length} chars)${near}`);
  }
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

/**
 * Give the named human account full rights on a group. Idempotent — MeshCentral
 * complains if the link already exists, which is fine and expected on every run after
 * the first, so that particular complaint is swallowed rather than logged.
 */
async function grantAdmin(group) {
  for (const user of CFG.adminUsers) {
    try {
      await meshctrl('addusertodevicegroup', [
        '--id', bareId(group._id),
        '--userid', user,
        '--fullrights',
      ]);
      log(`granted ${user} rights on "${group.name}"`);
    } catch (err) {
      // Already-a-member is the normal case on every run after the first.
      if (!/already|exist/i.test(err.message)) {
        console.error(`could not grant ${user} on "${group.name}": ${redact(err.message)}`);
      }
    }
  }
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
  // A FRESH directory per download, deliberately. meshctrl writes into its working
  // directory, names the file after the group, and refuses outright if that name is
  // already taken - so a single leftover file would poison every later run.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshagent-'));
  try {
    await meshctrl('agentdownload', [
      '--id', bareId(group._id),
      '--type', CFG.agentType,
      '--installflags', CFG.installFlags,
    ], dir);

    // Take whatever .exe appeared rather than guessing at how it sanitised the name.
    const produced = await fs.readdir(dir);
    const hit = produced.find((f) => f.toLowerCase().endsWith('.exe'));
    if (!hit) throw new Error('agentdownload reported success but produced no .exe');
    const exe = path.join(dir, hit);

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
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------- recordings */

/**
 * MeshCentral names recordings:
 *
 *   relaysession-2026-08-05-17-50-22-terry.okelly-RDS001-vvajcn3ggil.mcrec
 *                └──── UTC ────┘ └engineer┘ └device┘ └session┘
 *
 * Everything we need is in the name, so there is no reason to parse the binary
 * format. Two things to be careful about:
 *
 *  - The timestamp is UTC, while the file's mtime is local. Mixing them is an hour
 *    out for eight months of the year, which is exactly the bug that had agents
 *    showing offline last night.
 *  - Both the engineer ("terry.okelly") and the device ("LVG-AD2") can contain the
 *    separator, so splitting on "-" is ambiguous. We resolve it against the device
 *    names MeshCentral just told us about, and only guess if that fails.
 */
function parseRecording(fileName, knownDevices) {
  const m = /^relaysession-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(.+)\.mcrec$/i.exec(fileName);
  if (!m) return null;

  const [, y, mo, d, h, mi, s, rest] = m;
  const startedAt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));

  // rest = "<engineer>-<device>-<sessionid>"
  const lastDash = rest.lastIndexOf('-');
  if (lastDash < 0) return null;
  const withoutSession = rest.slice(0, lastDash);

  let engineer = null, deviceName = null;
  const hit = knownDevices.find((n) => withoutSession.toLowerCase().endsWith('-' + n.toLowerCase()));
  if (hit) {
    deviceName = withoutSession.slice(withoutSession.length - hit.length);
    engineer = withoutSession.slice(0, withoutSession.length - hit.length - 1);
  } else {
    // Device has since been renamed or removed — fall back to the first separator.
    const i = withoutSession.indexOf('-');
    if (i < 0) return null;
    engineer = withoutSession.slice(0, i);
    deviceName = withoutSession.slice(i + 1);
  }

  return { fileName, engineer, deviceName, startedAt };
}

/**
 * Index the recordings and hand the metadata to the Portal, then delete anything
 * past the retention window. The files stay here — they are far too big to be worth
 * shipping to Azure just to render a list, and the Portal only ever needs the index.
 */
async function syncRecordings(devices) {
  let names = [];
  try { names = await fs.readdir(CFG.recordingsDir); }
  catch { return; }   // recording not enabled yet — nothing to do, and not an error

  const knownDevices = devices.map((d) => d.hostname).filter(Boolean);
  const cutoff = Date.now() - CFG.retentionDays * 86400000;
  const byName = new Map(devices.map((d) => [d.hostname.toLowerCase(), d]));

  const sessions = [];
  let pruned = 0;

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.mcrec')) continue;
    const full = path.join(CFG.recordingsDir, name);

    let st;
    try { st = await fs.stat(full); } catch { continue; }

    const parsed = parseRecording(name, knownDevices);
    if (!parsed) { log(`unrecognised recording filename, skipping: ${name}`); continue; }

    if (parsed.startedAt.getTime() < cutoff) {
      try { await fs.unlink(full); pruned++; } catch { /* next run */ }
      continue;
    }

    // The file is appended to for the life of the session, so its mtime is when the
    // session ended. Clamp at zero — a clock adjustment mid-session shouldn't produce
    // a negative duration in the audit trail.
    const endedAt = st.mtime;
    const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - parsed.startedAt.getTime()) / 1000));

    const dev = byName.get(parsed.deviceName.toLowerCase());
    sessions.push({
      fileName: parsed.fileName,
      engineer: parsed.engineer,
      deviceName: parsed.deviceName,
      meshNodeId: dev ? dev.nodeId : null,
      meshGroupId: dev ? dev.meshGroupId : null,
      startedAt: parsed.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds,
      sizeBytes: st.size,
    });
  }

  if (pruned) log(`pruned ${pruned} recording(s) older than ${CFG.retentionDays} days`);
  await portal('POST', '/agent/api/mesh/sessions', { sessions, retentionDays: CFG.retentionDays });
  log(`indexed ${sessions.length} recording(s)`);
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
      await grantAdmin(group);

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
      console.error(`customer ${customer.id} (${customer.name}): ${redact(err.message)}`);
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

  try { await syncRecordings(mapped); }
  catch (err) { console.error(`recording sync failed: ${redact(err.message)}`); }
}

main().then(
  () => process.exit(0),
  (err) => { console.error('bridge run failed:', redact(err.message)); process.exit(1); },
);
