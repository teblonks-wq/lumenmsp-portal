// ── Cyber Essentials rules engine ───────────────────────────────────────────────
// The agent gathers facts and judges none of them. Everything that decides "this is a
// problem" lives here, for two reasons: the scheme is revised every year, and the list
// of things that have gone end-of-life changes every month. Neither should mean pushing
// a new agent out to every customer machine.
//
// The five controls are the ones an assessor actually marks against:
//   firewall  — boundary firewalls and internet gateways
//   config    — secure configuration
//   access    — user access control
//   malware   — malware protection
//   patch     — security update management
//
// Every finding carries remediation written to be acted on, not to be read: the registry
// path, the value, the command. If we can't say what to do about something, it isn't a
// finding — it's noise.

export type CeStatus = 'fail' | 'warn' | 'pass';

import { windowsOsName } from './os-name';

export interface CeFinding {
  control: 'firewall' | 'config' | 'access' | 'malware' | 'patch';
  rule: string;
  title: string;
  status: CeStatus;
  action?: string | null;      // remove | upgrade | configure | review | none
  detail?: string | null;      // what we found
  remediation?: string | null; // what to do about it
  evidence?: string | null;    // the raw value behind the judgement
  eolDate?: string | null;     // YYYY-MM-DD when the finding is an end-of-life one
}

export interface EolRow {
  id: number;
  category: string;
  vendor: string | null;
  name: string;
  match_type: string;
  match_value: string;
  version_max: string | null;
  eol_date: string | Date | null;
  severity: string;
  action: string;
  replacement: string | null;
  guidance: string | null;
  ce_control: string;
}

export interface CeContext {
  device: any;                 // agent_devices row (os, patch_* columns, reboot_required)
  software?: Array<{ name: string; version: string | null; publisher?: string | null }>;
  eol?: EolRow[];
}

// ── small helpers ───────────────────────────────────────────────────────────────

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: any): boolean => v === true || v === 'True' || v === 'true' || v === 1 || v === '1';
const str = (v: any): string => (v === null || v === undefined ? '' : String(v));

/** Version compare that copes with "10.0.19045", "4.8", "6.0.36" and junk. */
export function vcmp(a: string, b: string): number {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const iso = (d: any): string | null => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(String(d));
  return isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

/** "past" means the date has been and gone — anything else is a future cliff edge. */
const isPast = (d: any): boolean => {
  const s = iso(d);
  return !!s && s <= new Date().toISOString().slice(0, 10);
};

// The .NET Framework 4.x Release DWORD is the only reliable version indicator, and the
// mapping is published by Microsoft as a table of thresholds. Highest match wins.
const NET4: Array<[number, string]> = [
  [533320, '4.8.1'], [528040, '4.8'], [461808, '4.7.2'], [461308, '4.7.1'], [460798, '4.7'],
  [394802, '4.6.2'], [394254, '4.6.1'], [393295, '4.6'], [379893, '4.5.2'], [378675, '4.5.1'],
  [378389, '4.5'],
];
export function net4Version(release: number | null): string | null {
  if (!release) return null;
  for (const [n, v] of NET4) if (release >= n) return v;
  return 'older than 4.5';
}

// ── EOL matching ────────────────────────────────────────────────────────────────

/** Does this EOL row apply to this (name, version)? */
export function eolMatches(row: EolRow, name: string, version: string | null): boolean {
  const n = String(name || '');
  const mv = String(row.match_value || '');
  let hit = false;
  switch (row.match_type) {
    case 'exact': hit = n.toLowerCase() === mv.toLowerCase(); break;
    case 'regex':
      try { hit = new RegExp(mv, 'i').test(n); } catch { hit = false; }
      break;
    default: hit = n.toLowerCase().includes(mv.toLowerCase());
  }
  if (!hit) return false;
  // version_max scopes a row to old builds only — "Java 8" is EOL, "Java 21" is not,
  // and both are called Java.
  if (row.version_max && version) return vcmp(version, row.version_max) <= 0;
  return true;
}

/**
 * The one end-of-life row that actually describes this installation.
 *
 * Several rows can match the same name — "Node.js" has a row per major version, all of
 * them matching the word "Node.js" and differing only in version_max. Reporting every
 * match would tell you the machine is running four end-of-life versions of one product.
 * The most specific row wins: the tightest version ceiling that still covers what is
 * installed, and failing that the longest name match.
 */
export function bestEolMatch(rows: EolRow[], name: string, version: string | null): EolRow | null {
  const hits = (rows || []).filter((r) => r.category !== 'os' && eolMatches(r, name, version));
  if (!hits.length) return null;

  const capped = hits.filter((r) => r.version_max);
  if (capped.length && version) {
    return capped.reduce((best, r) => (vcmp(r.version_max!, best.version_max!) < 0 ? r : best));
  }
  return hits.reduce((best, r) =>
    (String(r.match_value).length > String(best.match_value).length ? r : best));
}

// ── the rules ───────────────────────────────────────────────────────────────────

export function evaluate(facts: any, ctx: CeContext): CeFinding[] {
  const out: CeFinding[] = [];
  const add = (f: CeFinding) => out.push(f);
  const f = facts || {};
  const dev = ctx.device || {};
  const isServer = bool(f?.os?.isServer) || String(dev.os || '').toLowerCase().includes('server');

  // ── Firewall ──────────────────────────────────────────────────────────────────
  const fw = f.firewall || {};
  const fwNames = Object.keys(fw);
  if (!fwNames.length) {
    add({ control: 'firewall', rule: 'fw.unknown', title: 'Firewall state could not be read', status: 'warn',
      action: 'review', detail: 'Get-NetFirewallProfile returned nothing on this machine.',
      remediation: 'Check the Windows Defender Firewall service (mpssvc) is running, and whether a third-party firewall has replaced it. If it has, evidence for that product is needed instead.' });
  } else {
    const off = fwNames.filter((k) => !bool(fw[k]));
    add(off.length
      ? { control: 'firewall', rule: 'fw.profiles', title: 'A firewall profile is switched off', status: 'fail',
          action: 'configure', detail: `Off: ${off.join(', ')}.`, evidence: JSON.stringify(fw),
          remediation: 'Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True — and if this machine is domain-joined, set it in Group Policy (Computer Configuration → Windows Settings → Security Settings → Windows Defender Firewall) so it cannot be turned off locally.' }
      : { control: 'firewall', rule: 'fw.profiles', title: 'All firewall profiles are on', status: 'pass',
          detail: fwNames.join(', '), evidence: JSON.stringify(fw) });
  }

  // ── Secure configuration ──────────────────────────────────────────────────────
  const cfg = f.config || {};
  const POL = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies';

  const autoDrive = num(cfg.noDriveTypeAutoRun);
  const autoRun = num(cfg.noAutorun);
  const autoOk = autoDrive === 255 && autoRun === 1;
  add(autoOk
    ? { control: 'config', rule: 'cfg.autorun', title: 'AutoRun and AutoPlay are disabled', status: 'pass',
        evidence: `NoDriveTypeAutoRun=${autoDrive}, NoAutorun=${autoRun}` }
    : { control: 'config', rule: 'cfg.autorun', title: 'AutoRun is not fully disabled', status: 'fail',
        action: 'configure',
        detail: `NoDriveTypeAutoRun is ${autoDrive === null ? 'not set' : autoDrive} (needs 255) and NoAutorun is ${autoRun === null ? 'not set' : autoRun} (needs 1).`,
        evidence: `NoDriveTypeAutoRun=${autoDrive}, NoAutorun=${autoRun}`,
        remediation: `Set ${POL}\\Explorer → NoDriveTypeAutoRun (DWORD) = 255 (0xFF) and NoAutorun (DWORD) = 1. Assessors check both: 255 stops AutoPlay on every drive type, NoAutorun stops the AutoRun command being honoured at all.` });

  const lua = num(cfg.enableLua);
  const consent = num(cfg.consentPromptAdmin);
  if (lua === 0) {
    add({ control: 'config', rule: 'cfg.uac', title: 'User Account Control is switched off', status: 'fail',
      action: 'configure', evidence: `EnableLUA=${lua}`,
      detail: 'EnableLUA is 0, so every administrator action runs elevated with no prompt.',
      remediation: `Set ${POL}\\System → EnableLUA (DWORD) = 1 and restart. This is a hard fail on assessment.` });
  } else if (consent === 0) {
    add({ control: 'config', rule: 'cfg.uac', title: 'UAC elevates administrators without prompting', status: 'warn',
      action: 'configure', evidence: `ConsentPromptBehaviorAdmin=${consent}`,
      detail: 'UAC is on but administrators are elevated silently.',
      remediation: `Set ${POL}\\System → ConsentPromptBehaviorAdmin (DWORD) = 2 (consent on the secure desktop) or 5 (consent for non-Windows binaries, the Windows default).` });
  } else {
    add({ control: 'config', rule: 'cfg.uac', title: 'User Account Control is enabled', status: 'pass',
      evidence: `EnableLUA=${lua}, ConsentPromptBehaviorAdmin=${consent}` });
  }

  const lock = num(cfg.inactivityTimeoutSecs);
  add(lock !== null && lock > 0 && lock <= 900
    ? { control: 'config', rule: 'cfg.lock', title: 'Screen locks on inactivity', status: 'pass', evidence: `InactivityTimeoutSecs=${lock}` }
    : { control: 'config', rule: 'cfg.lock', title: 'No enforced lock on inactivity', status: 'fail',
        action: 'configure', evidence: `InactivityTimeoutSecs=${lock === null ? 'not set' : lock}`,
        detail: lock === null ? 'The machine inactivity limit is not set.' : `Set to ${lock} seconds, which is longer than the 15 minutes the scheme expects.`,
        remediation: 'Set HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System → InactivityTimeoutSecs (DWORD) = 900 (15 minutes) or less. In Group Policy this is "Interactive logon: Machine inactivity limit".' });

  const blank = num(cfg.limitBlankPassword);
  if (blank === 0) {
    add({ control: 'config', rule: 'cfg.blankpw', title: 'Blank passwords may be used remotely', status: 'fail',
      action: 'configure', evidence: `LimitBlankPasswordUse=${blank}`,
      remediation: 'Set HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa → LimitBlankPasswordUse (DWORD) = 1. This is the Windows default; something has changed it.' });
  }

  const feats = f.features || {};
  const smb1Feature = str(feats.SMB1Protocol).toLowerCase() === 'enabled';
  const smb1Reg = num(cfg.smb1Server) === 1;
  add(smb1Feature || smb1Reg
    ? { control: 'config', rule: 'cfg.smb1', title: 'SMBv1 is present', status: 'fail', action: 'remove',
        evidence: `feature=${str(feats.SMB1Protocol) || 'n/a'}, SMB1=${cfg.smb1Server}`,
        detail: 'SMBv1 is the protocol WannaCry and NotPetya spread over. It has no place on a supported estate.',
        remediation: 'Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart, then reboot. Check first that nothing genuinely needs it — old MFPs and NAS boxes are the usual culprits, and the answer there is to replace or firewall them, not to keep SMBv1.' }
    : { control: 'config', rule: 'cfg.smb1', title: 'SMBv1 is not installed', status: 'pass',
        evidence: str(feats.SMB1Protocol) || 'feature absent' });

  const psv2 = ['MicrosoftWindows-PowerShell-V2', 'MicrosoftWindows-PowerShell-V2Root']
    .filter((k) => str(feats[k]).toLowerCase() === 'enabled');
  if (psv2.length) {
    add({ control: 'config', rule: 'cfg.psv2', title: 'PowerShell 2.0 engine is enabled', status: 'warn',
      action: 'remove', evidence: psv2.join(', '),
      detail: 'PowerShell 2.0 has no script block logging and no AMSI, so it is the version attackers ask for by name.',
      remediation: 'Disable-WindowsOptionalFeature -Online -FeatureName MicrosoftWindows-PowerShell-V2Root -NoRestart' });
  }

  const rdpOn = num(cfg.rdpDenied) === 0;
  const nla = num(cfg.rdpNla);
  if (rdpOn && nla !== 1) {
    add({ control: 'config', rule: 'cfg.rdp', title: 'RDP is enabled without Network Level Authentication', status: 'fail',
      action: 'configure', evidence: `fDenyTSConnections=${cfg.rdpDenied}, UserAuthentication=${nla}`,
      remediation: 'Set HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp → UserAuthentication (DWORD) = 1. Then confirm RDP is not reachable from the internet — an assessor will scan for 3389 from outside.' });
  } else if (rdpOn) {
    add({ control: 'config', rule: 'cfg.rdp', title: 'RDP is enabled (NLA on)', status: 'warn', action: 'review',
      evidence: `fDenyTSConnections=0, UserAuthentication=${nla}`,
      detail: 'Configured correctly, but it is still a remote entry point.',
      remediation: 'Confirm 3389 is not published to the internet and that access is via VPN or a gateway. If nothing uses RDP on this machine, turn it off: fDenyTSConnections (DWORD) = 1.' });
  } else {
    add({ control: 'config', rule: 'cfg.rdp', title: 'RDP is disabled', status: 'pass', evidence: `fDenyTSConnections=${cfg.rdpDenied}` });
  }

  const tls = f.tls || {};
  const legacy = ['TLS 1.0 Client', 'TLS 1.0 Server', 'TLS 1.1 Client', 'TLS 1.1 Server'];
  const tlsOn = legacy.filter((k) => num(tls[k]) === 1);
  const tlsUnset = legacy.filter((k) => str(tls[k]) === 'notset');
  if (tlsOn.length) {
    add({ control: 'config', rule: 'cfg.tls', title: 'TLS 1.0/1.1 is explicitly enabled', status: 'fail',
      action: 'configure', evidence: JSON.stringify(tls),
      detail: `Enabled: ${tlsOn.join(', ')}.`,
      remediation: 'Under HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.0 (and 1.1) create Client and Server keys with Enabled (DWORD) = 0 and DisabledByDefault (DWORD) = 1, then reboot. Check line-of-business software first: older SQL drivers and payment terminals are the ones that break.' });
  } else if (tlsUnset.length === legacy.length) {
    add({ control: 'config', rule: 'cfg.tls', title: 'TLS 1.0/1.1 not explicitly disabled', status: 'warn',
      action: 'configure', evidence: JSON.stringify(tls),
      detail: 'No SCHANNEL policy is set, so the OS default applies. On current builds that is fine; on older ones it leaves TLS 1.0 available.',
      remediation: 'Set the SCHANNEL Protocols keys for TLS 1.0 and TLS 1.1 (Client and Server) to Enabled=0, DisabledByDefault=1 so the position is explicit and evidenced.' });
  } else {
    add({ control: 'config', rule: 'cfg.tls', title: 'Legacy TLS is disabled', status: 'pass', evidence: JSON.stringify(tls) });
  }

  // ── User access control ───────────────────────────────────────────────────────
  const users: any[] = Array.isArray(f.localUsers) ? f.localUsers : [];
  const admins: string[] = Array.isArray(f.localAdmins) ? f.localAdmins.map(str) : [];

  const guest = users.find((u) => bool(u.builtinGuest));
  if (guest && bool(guest.enabled)) {
    add({ control: 'access', rule: 'acc.guest', title: 'The Guest account is enabled', status: 'fail',
      action: 'configure', evidence: str(guest.name),
      remediation: `Disable-LocalUser -Name "${str(guest.name)}" — the scheme requires guest and unused accounts to be disabled.` });
  } else if (guest) {
    add({ control: 'access', rule: 'acc.guest', title: 'The Guest account is disabled', status: 'pass', evidence: str(guest.name) });
  }

  const builtinAdmin = users.find((u) => bool(u.builtinAdmin));
  if (builtinAdmin && bool(builtinAdmin.enabled)) {
    add({ control: 'access', rule: 'acc.builtinadmin', title: 'The built-in Administrator account is enabled', status: 'warn',
      action: 'review', evidence: `${str(builtinAdmin.name)} (last logon ${str(builtinAdmin.lastLogon) || 'unknown'})`,
      detail: 'Not an automatic fail, but it is a shared account with a well-known SID, and an assessor will ask who uses it.',
      remediation: `If it is genuinely unused: Disable-LocalUser -Name "${str(builtinAdmin.name)}". If it is a break-glass account, document it, give it a long unique password in the password manager and confirm it is not used day to day.` });
  }

  const noPw = users.filter((u) => bool(u.enabled) && !bool(u.passwordRequired));
  if (noPw.length) {
    add({ control: 'access', rule: 'acc.nopassword', title: 'Enabled accounts with no password required', status: 'fail',
      action: 'configure', evidence: noPw.map((u) => str(u.name)).join(', '),
      remediation: 'Either set a password on these accounts or disable them. An enabled account that needs no password fails user access control outright.' });
  }

  if (admins.length) {
    const localAdmins = admins.filter((a) => !/\\(Domain Admins|Enterprise Admins)$/i.test(a));
    add(localAdmins.length > 3
      ? { control: 'access', rule: 'acc.admincount', title: `${localAdmins.length} accounts have local administrator rights`, status: 'warn',
          action: 'review', evidence: admins.join(', '),
          detail: 'The scheme expects administrator accounts to be used only for administrative work, and only by people who need them.',
          remediation: 'Remove day-to-day user accounts from the Administrators group. Where someone genuinely needs admin, give them a separate admin account and keep their normal login standard.' }
      : { control: 'access', rule: 'acc.admincount', title: 'Local administrator membership is contained', status: 'pass',
          evidence: admins.join(', ') });
  }

  const stale = users.filter((u) => {
    if (!bool(u.enabled) || bool(u.builtinGuest)) return false;
    const d = iso(u.lastLogon);
    if (!d) return false;
    return (Date.now() - new Date(d).getTime()) / 86400000 > 90;
  });
  if (stale.length) {
    add({ control: 'access', rule: 'acc.stale', title: 'Enabled accounts unused for over 90 days', status: 'warn',
      action: 'review', evidence: stale.map((u) => `${str(u.name)} (${str(u.lastLogon)})`).join(', '),
      remediation: 'Disable accounts that are no longer needed. Assessors specifically ask how leavers are removed, and a dormant enabled account is the easiest evidence against you.' });
  }

  // ── Malware protection ────────────────────────────────────────────────────────
  const def = f.defender || {};
  const av: any[] = Array.isArray(f.antivirus) ? f.antivirus : [];
  const thirdParty = av.filter((p) => !/windows defender/i.test(str(p.name)));
  const defenderOn = bool(def.enabled);

  if (!defenderOn && !thirdParty.length) {
    add({ control: 'malware', rule: 'mal.present', title: 'No malware protection detected', status: 'fail',
      action: 'configure', evidence: JSON.stringify({ defender: def, antivirus: av }),
      detail: isServer ? 'Servers report through Defender directly rather than Security Center, and neither reported anything here.' : 'Neither Defender nor a third-party product reported in.',
      remediation: 'Confirm what this machine is meant to be protected by and that it is running. If Defender was disabled by policy for a product that has since been removed, re-enable it (Set-MpPreference -DisableRealtimeMonitoring $false) and clear the DisableAntiSpyware policy.' });
  } else {
    add({ control: 'malware', rule: 'mal.present', title: `Malware protection present${thirdParty.length ? ': ' + thirdParty.map((p) => str(p.name)).join(', ') : ': Microsoft Defender'}`,
      status: 'pass', evidence: JSON.stringify({ defender: def, antivirus: av.map((p) => str(p.name)) }) });

    if (defenderOn && !bool(def.realtime)) {
      add({ control: 'malware', rule: 'mal.realtime', title: 'Real-time protection is off', status: 'fail',
        action: 'configure', evidence: JSON.stringify(def),
        remediation: 'Set-MpPreference -DisableRealtimeMonitoring $false. If a policy is holding it off, clear HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender → DisableAntiSpyware and the Real-Time Protection subkey.' });
    }

    const age = num(def.signatureAge);
    if (defenderOn && age !== null) {
      if (age > 7) {
        add({ control: 'malware', rule: 'mal.signatures', title: `Malware signatures are ${age} days old`, status: 'fail',
          action: 'configure', evidence: `signatureDate=${str(def.signatureDate)}`,
          remediation: 'Update-MpSignature. If it fails, this machine cannot reach the update source — check proxy settings and whether the machine has simply been off.' });
      } else if (age > 2) {
        add({ control: 'malware', rule: 'mal.signatures', title: `Malware signatures are ${age} days old`, status: 'warn',
          action: 'review', evidence: `signatureDate=${str(def.signatureDate)}`,
          remediation: 'Update-MpSignature — worth watching if this machine is regularly behind.' });
      } else {
        add({ control: 'malware', rule: 'mal.signatures', title: 'Malware signatures are current', status: 'pass',
          evidence: `${age}d old, ${str(def.signatureDate)}` });
      }
    }

    if (defenderOn && !bool(def.tamper)) {
      add({ control: 'malware', rule: 'mal.tamper', title: 'Tamper protection is off', status: 'warn',
        action: 'configure', evidence: JSON.stringify(def),
        detail: 'Not required by the scheme, but it is what stops malware turning Defender off on its way in.',
        remediation: 'Turn on Tamper Protection in Windows Security, or push it from Intune/Defender for Business. It cannot be enabled by a local registry edit by design.' });
    }
  }

  // ── Security update management ────────────────────────────────────────────────
  const eol = (ctx.eol || []).filter((r) => r.category !== 'dotnet');

  // Operating system support
  const build = str(f?.os?.build);
  // Windows 11 calls itself "Windows 10 Pro" in the registry (see lib/os-name.ts). Left
  // uncorrected, the caption lookup below can match a Windows 10 end-of-support row and
  // fail a brand-new Windows 11 laptop for running an OS it is not running - the single
  // most damaging way this assessment could be wrong.
  const rawCaption = str(f?.os?.caption) || str(dev.os);
  const display = str(f?.os?.display);
  const caption = windowsOsName(rawCaption, build, display) || rawCaption;
  // Name first, build second. Windows 10 1809 and Server 2019 are both build 17763, so a
  // build-only lookup would tell a domain controller it was a desktop. Server editions are
  // matched on their caption; Windows 10/11 need the build, because the caption alone
  // cannot tell 22H2 from 23H2 and those go out of support a year apart.
  const osRow =
    (ctx.eol || []).find((r) => r.category === 'os' && r.match_type !== 'os_build' && eolMatches(r, caption, null)) ||
    (ctx.eol || []).find((r) => r.category === 'os' && r.match_type === 'os_build' && str(r.match_value) === build);
  if (osRow && isPast(osRow.eol_date)) {
    add({ control: 'patch', rule: 'pat.os', title: `${osRow.name} is out of support`, status: 'fail',
      action: osRow.action || 'upgrade', evidence: `${caption} build ${build}${display ? ' (' + display + ')' : ''}`,
      eolDate: iso(osRow.eol_date),
      detail: `Support ended ${iso(osRow.eol_date)}. An unsupported operating system fails the scheme on its own, whatever else is in order.`,
      remediation: osRow.guidance || (osRow.replacement ? `Move this machine to ${osRow.replacement}.` : 'Upgrade or replace this machine before assessment.') });
  } else if (osRow) {
    add({ control: 'patch', rule: 'pat.os', title: `${osRow.name} support ends ${iso(osRow.eol_date)}`, status: 'warn',
      action: 'review', evidence: `${caption} build ${build}`, eolDate: iso(osRow.eol_date),
      remediation: osRow.guidance || 'Plan the upgrade before that date — it becomes a hard fail the day after.' });
  } else {
    add({ control: 'patch', rule: 'pat.os', title: 'Operating system is in support', status: 'pass',
      evidence: `${caption} build ${build}${display ? ' (' + display + ')' : ''}`,
      detail: build ? undefined : 'No matching row in the end-of-life list — worth confirming this build is covered.' });
  }

  // Missing updates, judged against the scheme's 14-day rule
  const crit = num(dev.patch_critical);
  const oldest = num(dev.oldest_critical_days);
  if (dev.patch_scan_at == null) {
    add({ control: 'patch', rule: 'pat.scan', title: 'This machine has never reported its missing updates', status: 'warn',
      action: 'review', remediation: 'The agent scans on its daily inventory pass. If nothing appears within 24 hours, check the agent is running and can reach Windows Update.' });
  } else if (crit && oldest !== null && oldest > 14) {
    add({ control: 'patch', rule: 'pat.missing', title: `${crit} critical update${crit === 1 ? '' : 's'} missing, oldest known for ${oldest} days`, status: 'fail',
      action: 'upgrade', evidence: `critical=${crit}, pending=${num(dev.patch_pending)}`,
      detail: 'The scheme requires high and critical updates to be applied within 14 days of release.',
      remediation: 'Install the outstanding updates and reboot. If this machine keeps falling behind, check its patch policy and whether it is ever on during the maintenance window.' });
  } else if (crit) {
    add({ control: 'patch', rule: 'pat.missing', title: `${crit} critical update${crit === 1 ? '' : 's'} missing`, status: 'warn',
      action: 'upgrade', evidence: `critical=${crit}, pending=${num(dev.patch_pending)}, oldest=${oldest ?? '?'}d`,
      remediation: 'Inside the 14-day window for now. Install at the next maintenance window.' });
  } else {
    add({ control: 'patch', rule: 'pat.missing', title: 'No critical updates outstanding', status: 'pass',
      evidence: `pending=${num(dev.patch_pending) ?? 0}` });
  }

  if (bool(dev.reboot_required)) {
    add({ control: 'patch', rule: 'pat.reboot', title: 'A restart is outstanding', status: 'warn', action: 'review',
      detail: 'Updates have installed but are not in effect, and further updates often will not install until this is cleared.',
      remediation: 'Restart the machine at the next opportunity.' });
  }

  // .NET Framework
  const rel = num(f?.dotnet?.v4Release);
  const v4 = net4Version(rel);
  if (rel === null) {
    add({ control: 'patch', rule: 'pat.net4', title: '.NET Framework 4.x not detected', status: 'warn', action: 'review',
      remediation: 'Unusual on a modern Windows build. Confirm the machine is not running something older than 4.5, which is long out of support.' });
  } else if (rel < 394802) {
    add({ control: 'patch', rule: 'pat.net4', title: `.NET Framework ${v4} is out of support`, status: 'fail',
      action: 'upgrade', evidence: `Release=${rel}`, eolDate: '2022-04-26',
      detail: 'Everything below 4.6.2 stopped receiving security fixes on 26 April 2022.',
      remediation: 'Install .NET Framework 4.8.1 (or 4.8 on older builds). It is an in-place update — 4.x versions replace each other rather than sitting side by side, so applications built against 4.5 keep working.' });
  } else if (rel < 528040) {
    add({ control: 'patch', rule: 'pat.net4', title: `.NET Framework ${v4} is supported but behind`, status: 'warn',
      action: 'upgrade', evidence: `Release=${rel}`,
      detail: '4.6.2 and 4.7.x are still serviced, but only on operating systems that are themselves still serviced.',
      remediation: 'Move to 4.8.1 when convenient so this stops being a question at assessment.' });
  } else {
    add({ control: 'patch', rule: 'pat.net4', title: `.NET Framework ${v4}`, status: 'pass', evidence: `Release=${rel}` });
  }

  if (bool(f?.dotnet?.v20)) {
    add({ control: 'patch', rule: 'pat.net20', title: '.NET Framework 2.0/3.0 components are present', status: 'warn',
      action: 'remove', evidence: 'NDP\\v2.0.50727 key present',
      detail: 'Serviced only as part of the 3.5 feature; on its own it is very old code sitting on the machine.',
      remediation: 'If nothing needs .NET 3.5, remove it: Disable-WindowsOptionalFeature -Online -FeatureName NetFx3. Check line-of-business software first — a lot of older installers still want it.' });
  } else if (bool(f?.dotnet?.v35)) {
    add({ control: 'patch', rule: 'pat.net35', title: '.NET Framework 3.5 is installed', status: 'warn',
      action: 'review', evidence: 'NDP\\v3.5 key present',
      detail: 'Still supported alongside the OS, but it is only there for old applications.',
      remediation: 'Confirm something actually needs it. If not: Disable-WindowsOptionalFeature -Online -FeatureName NetFx3.' });
  }

  // .NET (Core) runtimes — matched against the EOL list so a new release is a data change
  const runtimes: string[] = Array.isArray(f?.dotnet?.coreRuntimes) ? f.dotnet.coreRuntimes.map(str) : [];
  const seenRuntime = new Set<string>();
  for (const line of runtimes) {
    // "Microsoft.NETCore.App 6.0.36 [C:\Program Files\dotnet\shared\...]"
    const m = line.match(/^(\S+)\s+(\d[\d.]*)/);
    if (!m) continue;
    const key = `${m[1]} ${m[2].split('.').slice(0, 2).join('.')}`;
    if (seenRuntime.has(key)) continue;
    seenRuntime.add(key);
    const row = eol.find((r) => r.category === 'runtime' && eolMatches(r, key, m[2]));
    if (row && isPast(row.eol_date)) {
      add({ control: 'patch', rule: `pat.runtime.${key.replace(/[^a-z0-9.]/gi, '_')}`,
        title: `${row.name} is out of support`, status: row.severity === 'warn' ? 'warn' : 'fail',
        action: row.action || 'upgrade', evidence: line, eolDate: iso(row.eol_date),
        detail: `Support ended ${iso(row.eol_date)}.`,
        remediation: row.guidance || (row.replacement ? `Move to ${row.replacement} and uninstall this runtime once nothing depends on it.` : 'Uninstall this runtime once nothing depends on it.') });
    }
  }

  // Installed software against the end-of-life list. One finding per row, not per
  // machine-copy: a title installed twice is still one thing to deal with.
  const sw = ctx.software || [];
  const hit = new Set<number>();
  for (const app of sw) {
    const row = bestEolMatch(eol, app.name, app.version || null);
    {
      if (!row) continue;
      if (hit.has(row.id)) continue;
      hit.add(row.id);
      const past = isPast(row.eol_date);
      add({ control: (row.ce_control as any) || 'patch', rule: `eol.${row.id}`,
        title: past ? `${row.name} is out of support` : `${row.name} support ends ${iso(row.eol_date)}`,
        status: past ? (row.severity === 'warn' ? 'warn' : 'fail') : 'warn',
        action: row.action || 'upgrade',
        evidence: `${app.name}${app.version ? ' ' + app.version : ''}`,
        eolDate: iso(row.eol_date),
        detail: past ? `Support ended ${iso(row.eol_date)}. Unsupported software in scope fails the assessment.` : undefined,
        remediation: row.guidance || (row.replacement ? `Replace with ${row.replacement}.` : row.action === 'remove' ? 'Uninstall it — if nobody can name what uses it, it should not be there.' : 'Upgrade to a supported version.') });
    }
  }

  // BitLocker is Cyber Essentials Plus territory, but it is asked about every time
  const bl = f.bitlocker || {};
  if (Object.keys(bl).length) {
    const on = /^(1|on|protected)/i.test(str(bl.status));
    add(on
      ? { control: 'config', rule: 'cfg.bitlocker', title: 'System drive is encrypted', status: 'pass', evidence: JSON.stringify(bl) }
      : { control: 'config', rule: 'cfg.bitlocker', title: 'System drive is not encrypted', status: 'warn',
          action: 'review', evidence: JSON.stringify(bl),
          detail: 'Not required for basic Cyber Essentials, but it is required for most cyber insurance and it is the first thing asked after a laptop goes missing.',
          remediation: isServer ? 'Consider BitLocker if this server is not in a locked comms room.' : 'Enable BitLocker with the recovery key escrowed to Entra ID or AD, not to a text file.' });
  }

  return out;
}

// ── scoring ─────────────────────────────────────────────────────────────────────
// Deliberately simple and explainable: a fail costs 8, a warning costs 3, floor at 0.
// It exists to rank machines against each other, not to predict an assessor's verdict.
export function score(findings: CeFinding[]): number {
  const fails = findings.filter((x) => x.status === 'fail').length;
  const warns = findings.filter((x) => x.status === 'warn').length;
  return Math.max(0, 100 - fails * 8 - warns * 3);
}

export const CONTROLS: Array<{ key: string; label: string }> = [
  { key: 'firewall', label: 'Firewalls' },
  { key: 'config', label: 'Secure configuration' },
  { key: 'access', label: 'User access control' },
  { key: 'malware', label: 'Malware protection' },
  { key: 'patch', label: 'Security update management' },
];
