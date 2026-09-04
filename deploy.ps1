# deploy.ps1 — Deploy Lumen MSP Portal to Azure server
# Builds locally then ships dist/ to server — server just runs node.

$server     = "lits-admin@51.11.176.101"
$localPath  = "D:\LITS\LumenMSP Portal"
$remotePath = "/srv/apps/lumenmsp-portal"
$appName    = "lumenmsp-portal"

# Staging and the tarball live under D:\LITS, which is excluded in Bitdefender.
#
# They used to sit on C: - staging in C:\Temp\portal-deploy, the tarball in %TEMP% - and
# on 2026-08-18 a deploy failed with scp reporting "stat local ... No such file or
# directory" three times over. tar had returned 0; the archive was simply not there when
# scp looked. An 80 MB compressed archive written and immediately re-read is close to a
# textbook on-access / ransomware-mitigation trigger, and the run before it was the one
# where a new Bitdefender policy went live on this machine.
#
# NOT inside "D:\LITS\LumenMSP Portal": this script robocopies that whole folder and then
# runs `git add -A` over it. An 80 MB tarball in there would be staged into its own
# deploy and committed to the repo.
$deployWork = "D:\LITS\_deploy"
$staging    = Join-Path $deployWork "portal-staging"

Write-Host "=== Lumen MSP Portal Deploy ===" -ForegroundColor Cyan

# Step 1: Build locally
Write-Host "Building TypeScript..." -ForegroundColor Yellow
Set-Location $localPath
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "Build OK." -ForegroundColor Green

# Step 1.5: Journey-builder regression suite - the core product claim ("the magic key to
# group calls"). A journey builder that miscounts calls must NEVER reach customers, so a
# failing suite aborts the deploy. Fixtures live in src/scripts/test-journeys.ts - add one
# for every counting bug ever found.
Write-Host "Testing journey builder..." -ForegroundColor Yellow
node dist/scripts/test-journeys.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "Journey-builder tests FAILED - deploy aborted." -ForegroundColor Red
    exit 1
}
Write-Host "Journey builder OK." -ForegroundColor Green

# Step 2: Stage files (include dist/, exclude node_modules, .env and workspace material)
Write-Host "Staging..." -ForegroundColor Yellow
if (-not (Test-Path $deployWork)) { New-Item -ItemType Directory -Path $deployWork | Out-Null }
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

robocopy $localPath $staging /E /NFL /NDL /NJH /NJS `
    /XD "node_modules" ".git" "01 Daily Logs" "02 Projects" ".preview" "_to_delete" `
    /XF ".env" "*.log" "CLAUDE.md" "Getting Started.pdf" | Out-Null

# Step 2.5: Local revision backup. Since 2026-07-09 the code lives on GitHub
# (teblonks-wq/lumenmsp-portal) — git is the real history now, so we keep only a
# handful of zips as a safety net for deploys made with UNCOMMITTED changes.
$backupDir = "D:\LITS\LumenMSP-Portal-Backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$zip   = Join-Path $backupDir "portal_$stamp.zip"
Write-Host "Backing up this revision -> $zip" -ForegroundColor Yellow
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force
$old = Get-ChildItem $backupDir -Filter "portal_*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5
if ($old) { $old | Remove-Item -Force; Write-Host ("Pruned {0} old backup(s); keeping 5 (git is the real history)." -f $old.Count) -ForegroundColor DarkGray }


# Step 3: Package into ONE tarball, then upload it (a single-file transfer is far more
# resilient than scp -r over hundreds of files, which drops on a flaky link).
Write-Host "Packaging..." -ForegroundColor Yellow
$tar = Join-Path $deployWork "portal-deploy.tar.gz"
if (Test-Path $tar) { Remove-Item $tar -Force }
# Windows' `tar` is bsdtar (libarchive), which defaults to pax format and stamps every
# file with a SCHILY.fflags header that GNU tar on the server warns about. Force GNU
# format so no SCHILY headers are written → clean extraction, no warnings.
tar --format=gnutar -czf $tar -C $staging .
if ($LASTEXITCODE -ne 0) { Write-Host "Packaging failed!" -ForegroundColor Red; exit 1 }

# Exit code 0 is not proof the file exists.
#
# That is the whole lesson of 2026-08-18: tar reported success, the archive was gone by
# the time scp reached for it, and the deploy died three retries later with a message
# about scp that had nothing to do with scp. Trusting an exit code over the artefact is
# how a five-second diagnosis becomes a twenty-minute one.
$tarInfo = Get-Item $tar -ErrorAction SilentlyContinue
if (-not $tarInfo -or $tarInfo.Length -lt 1MB) {
    Write-Host ""
    Write-Host "Packaging reported success but the archive is missing or truncated:" -ForegroundColor Red
    Write-Host ("  {0}" -f $tar) -ForegroundColor Red
    if ($tarInfo) { Write-Host ("  size: {0} bytes - far too small for the Portal." -f $tarInfo.Length) -ForegroundColor Red }
    Write-Host "  Something removed it AFTER tar wrote it. Check antivirus quarantine first" -ForegroundColor Yellow
    Write-Host "  (GravityZone > Network > Quarantine), then free space on this drive." -ForegroundColor Yellow
    exit 1
}
Write-Host ("Packaged {0:N0} MB." -f ($tarInfo.Length / 1MB)) -ForegroundColor Green

# Keepalive + sane timeouts so a brief stall doesn't kill the connection.
$sshOpts = @("-o","ServerAliveInterval=15","-o","ServerAliveCountMax=8","-o","ConnectTimeout=30")

Write-Host "Uploading..." -ForegroundColor Yellow
$ok = $false
for ($i = 1; $i -le 3; $i++) {
    scp @sshOpts $tar "${server}:/tmp/portal-deploy.tar.gz"
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Write-Host ("  SCP attempt {0} failed; retrying in 3s..." -f $i) -ForegroundColor DarkYellow
    Start-Sleep -Seconds 3
}
if (-not $ok) { Write-Host "SCP failed after 3 attempts!" -ForegroundColor Red; exit 1 }

# Step 4: Extract, install prod deps, sync schema + restart on server
# NOTE: using `prisma db push` for the foundation phase (starter schema is a placeholder).
# Switch to `prisma migrate deploy` once the real schema + proper migrations exist.
Write-Host "Restarting on server..." -ForegroundColor Yellow
# --- Pre-deploy safety snapshot (added 2026-08-04) ----------------------------
# The remote command below runs `prisma db push --accept-data-loss`, which DROPS any
# column or table not present in schema.prisma. That has already cost 51 rows once.
# Snapshot first so a mistake is recoverable instead of permanent.
# NOTE: the dump runs as the postgres user, so /var/backups/predeploy must be OWNED by
# postgres - root-owned 0700 gives 'Permission denied' from pg_dump (hit 2026-08-04).
Write-Host "Taking pre-deploy database snapshot..." -ForegroundColor Cyan
$snapName = "predeploy-$(Get-Date -Format 'yyyyMMdd-HHmmss').dump"
ssh @sshOpts $server "sudo mkdir -p /var/backups/predeploy && sudo chown postgres:postgres /var/backups/predeploy && sudo chmod 700 /var/backups/predeploy && sudo -u postgres pg_dump -Fc lumenmsp_portal -f /var/backups/predeploy/$snapName"
if ($LASTEXITCODE -ne 0) {
    Write-Host "SNAPSHOT FAILED - deploy STOPPED. Fix the snapshot before shipping." -ForegroundColor Red
    exit 1
}
Write-Host ("Snapshot saved: {0}" -f $snapName) -ForegroundColor DarkGray
ssh @sshOpts $server "sudo bash -c 'ls -1t /var/backups/predeploy/*.dump 2>/dev/null | tail -n +21 | xargs -r rm -f'"
# ------------------------------------------------------------------------------

# --no-audit --no-fund (added 2026-09-04): the audit POST to registry.npmjs.org is the ONLY network
# call in a no-op install, and when that endpoint is slow or returns 400 (it did, twice, today) the
# deploy sits silently for 5+ minutes after "Snapshot saved". We deploy a lockfile we already built
# and tested locally; auditing it again on the server buys nothing.
ssh @sshOpts $server "mkdir -p $remotePath && tar --warning=no-unknown-keyword -xzf /tmp/portal-deploy.tar.gz -C $remotePath && rm -f /tmp/portal-deploy.tar.gz && cd $remotePath && npm install --omit=dev --silent --no-audit --no-fund && npx prisma generate && npx prisma db push --accept-data-loss && pm2 restart $appName 2>/dev/null || pm2 start dist/index.js --name $appName && pm2 save"

# Step 5: Clean up
Remove-Item $staging -Recurse -Force
Remove-Item $tar -Force

Write-Host ""
Write-Host "Deploy complete!" -ForegroundColor Green
Write-Host "Live at: https://portal.lumenmsp.co.uk"

# Step 6: Record this deploy in git (commit + push to GitHub). Non-fatal — a git
# hiccup (offline, auth expired) never undoes a completed deploy.
try {
    $dirty = git status --porcelain 2>$null
    if ($dirty) {
        Write-Host ""
        $msg = Read-Host "Git commit message for this deploy (Enter = 'Deploy $stamp')"
        if (-not $msg) { $msg = "Deploy $stamp" }
        git add -A
        git commit -m $msg | Out-Null
        git push
        if ($LASTEXITCODE -eq 0) { Write-Host "Committed + pushed to GitHub: $msg" -ForegroundColor Green }
        else { Write-Host "Committed locally but PUSH FAILED - run 'git push' when back online." -ForegroundColor Yellow }
    } else {
        Write-Host "Git: nothing new to commit." -ForegroundColor DarkGray
        # Still push: work committed during the session (e.g. by Claude) is otherwise
        # never pushed, because the push above only runs when this script commits.
        git push 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "Git: pushed existing commits to GitHub." -ForegroundColor Green }
        else { Write-Host "Git: push failed or nothing to push - run 'git push' manually if needed." -ForegroundColor Yellow }
    }
} catch {
    Write-Host "Git step failed (the deploy itself is fine): $_" -ForegroundColor Yellow
}
