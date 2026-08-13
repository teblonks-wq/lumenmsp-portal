// One-click fixes for server findings. The differentiator: the Portal does not just say
// "AD Recycle Bin is not enabled" - it carries the button that enables it, safely, with
// the same judgement rule as the finding so the two can never drift apart.
//
// Ground rules, in the spirit of the GPO work:
//   - A fix goes in this registry ONLY if it is safe to run unattended as SYSTEM on the
//     server: idempotent, reversible (or explicitly one-way AND harmless, like the
//     Recycle Bin), and it must never delete anything. Disable, stamp, report - not remove.
//   - The script re-checks the condition itself before acting ("Nothing to do" is a
//     success), because facts on the page can be hours old.
//   - Findings that need a human decision (passwords that never expire, Domain Admins
//     membership, functional level, SQL recovery models) deliberately have NO fix here.
//     Marking something well is not the same as being entitled to change it.
//
// The commands ride the existing `shell.powershell` kind, so no agent build is needed.
// Output lands on the command record like any other; a `server.facts` re-collect is
// queued right behind the fix so the finding reconciles itself on the page.

export interface ServerFix {
  key: string;
  /** Which alert this fixes - matches ServerAlert.fix. */
  label: string;      // button text, verb-first
  confirm: string;    // shown in the browser confirm dialog - says exactly what will happen
  activity: string;   // audit-log line
  script: string;     // PowerShell, run as SYSTEM on the server by shell.powershell
}

export const SERVER_FIXES: Record<string, ServerFix> = {
  'ad-recycle-bin': {
    key: 'ad-recycle-bin',
    label: 'Enable the AD Recycle Bin',
    confirm: 'Enable the Active Directory Recycle Bin for the whole forest?\n\n' +
      'Deleted users, groups and computers become restorable in place for their tombstone lifetime (usually 180 days). ' +
      'It is free, has no operational downside, and is a ONE-WAY switch - it cannot be turned off again.',
    activity: 'Enabled the AD Recycle Bin',
    script: [
      `Import-Module ActiveDirectory -ErrorAction Stop`,
      `$feat = Get-ADOptionalFeature -Filter { Name -eq 'Recycle Bin Feature' } -ErrorAction Stop`,
      `if (@($feat.EnabledScopes).Count -gt 0) { 'Already enabled - nothing to do.'; exit 0 }`,
      `$forest = (Get-ADForest).RootDomain`,
      `try {`,
      `  Enable-ADOptionalFeature -Identity 'Recycle Bin Feature' -Scope ForestOrConfigurationSet -Target $forest -Confirm:$false -ErrorAction Stop`,
      `  'AD Recycle Bin is now ENABLED for forest ' + $forest + '. Deleted AD objects are restorable in place for the tombstone lifetime (usually 180 days). This switch is one-way by design.'`,
      `} catch {`,
      `  if ($_.Exception.Message -match 'access|denied|insufficient') {`,
      `    'Could not enable it from here: this needs Enterprise Admins rights, which SYSTEM on this DC does not hold in this forest. Run this one line as an Enterprise Admin instead:'`,
      `    ('  Enable-ADOptionalFeature -Identity ''Recycle Bin Feature'' -Scope ForestOrConfigurationSet -Target ' + $forest)`,
      `    exit 1`,
      `  }`,
      `  throw`,
      `}`,
    ].join('\n'),
  },

  'ad-stale-computers': {
    key: 'ad-stale-computers',
    label: 'Disable the stale computer accounts',
    confirm: 'Disable every enabled computer account that has not logged on for 90 days?\n\n' +
      'DISABLE only - nothing is deleted, and each account gets a dated note saying the Portal did it. ' +
      'Domain controllers and this server are excluded. Any of them can be re-enabled in one line if a machine turns out to be alive.',
    activity: 'Disabled stale computer accounts (90+ days, disable-only)',
    script: [
      `Import-Module ActiveDirectory -ErrorAction Stop`,
      `$cut = (Get-Date).AddDays(-90)`,
      `# Same test as the collector, so the button fixes exactly what the finding counted.`,
      `$dcs = @(Get-ADDomainController -Filter * | ForEach-Object { $_.ComputerObjectDN })`,
      `$stale = @(Get-ADComputer -Filter { Enabled -eq $true } -Properties LastLogonDate, Description |`,
      `  Where-Object { $_.LastLogonDate -and $_.LastLogonDate -lt $cut -and $dcs -notcontains $_.DistinguishedName -and $_.Name -ne $env:COMPUTERNAME })`,
      `if (-not $stale.Count) { 'Nothing to do - no stale computer accounts outside the domain controllers.'; exit 0 }`,
      `$stampDate = Get-Date -Format 'yyyy-MM-dd'`,
      `$done = @(); $failed = @()`,
      `foreach ($c in $stale) {`,
      `  try {`,
      `    $note = 'Disabled by LumenMSP Portal ' + $stampDate + ' - unused 90+ days.'`,
      `    if ($c.Description) { $note = ($c.Description + ' | ' + $note) }`,
      `    if ($note.Length -gt 1024) { $note = $note.Substring($note.Length - 1024) }`,
      `    Set-ADComputer -Identity $c.DistinguishedName -Description $note -ErrorAction Stop`,
      `    Disable-ADAccount -Identity $c.DistinguishedName -ErrorAction Stop`,
      `    $done += $c.Name`,
      `  } catch { $failed += ($c.Name + ': ' + $_.Exception.Message) }`,
      `}`,
      `'Disabled ' + $done.Count + ' computer account(s): ' + ($done -join ', ')`,
      `if ($failed.Count) { 'FAILED on ' + $failed.Count + ': ' + ($failed -join ' | ') }`,
      `'Nothing was deleted. Re-enable any of them with: Enable-ADAccount -Identity <name>'`,
    ].join('\n'),
  },
};
