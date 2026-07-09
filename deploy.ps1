# deploy.ps1 — Deploy Lumen MSP Portal to Azure server
# Builds locally then ships dist/ to server — server just runs node.

$server     = "lits-admin@51.11.176.101"
$localPath  = "D:\LITS\LumenMSP Portal"
$remotePath = "/srv/apps/lumenmsp-portal"
$staging    = "C:\Temp\portal-deploy"
$appName    = "lumenmsp-portal"

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

# Step 2: Stage files (include dist/, exclude node_modules, .env and workspace material)
Write-Host "Staging..." -ForegroundColor Yellow
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

robocopy $localPath $staging /E /NFL /NDL /NJH /NJS `
    /XD "node_modules" ".git" "01 Daily Logs" "02 Projects" `
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
$tar = Join-Path $env:TEMP "portal-deploy.tar.gz"
if (Test-Path $tar) { Remove-Item $tar -Force }
# Windows' `tar` is bsdtar (libarchive), which defaults to pax format and stamps every
# file with a SCHILY.fflags header that GNU tar on the server warns about. Force GNU
# format so no SCHILY headers are written → clean extraction, no warnings.
tar --format=gnutar -czf $tar -C $staging .
if ($LASTEXITCODE -ne 0) { Write-Host "Packaging failed!" -ForegroundColor Red; exit 1 }

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
ssh @sshOpts $server "mkdir -p $remotePath && tar --warning=no-unknown-keyword -xzf /tmp/portal-deploy.tar.gz -C $remotePath && rm -f /tmp/portal-deploy.tar.gz && cd $remotePath && npm install --omit=dev --silent && npx prisma generate && npx prisma db push --accept-data-loss && pm2 restart $appName 2>/dev/null || pm2 start dist/index.js --name $appName && pm2 save"

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
    }
} catch {
    Write-Host "Git step failed (the deploy itself is fine): $_" -ForegroundColor Yellow
}
