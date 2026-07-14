# deploy-views.ps1 — HOT deploy for UI tweaks (views + static only).
# Ships src/views and static/ to the server. NO build, NO prisma, NO restart.
# Because view cache is off and static is served from disk, changes go live on the next
# request — nobody gets logged out. Use this for .ejs / CSS / client-JS / image tweaks.
# For TypeScript / logic / schema changes, use the full deploy.ps1 instead.

$server     = "lits-admin@51.11.176.101"
$localPath  = "D:\LITS\LumenMSP Portal"
$remotePath = "/srv/apps/lumenmsp-portal"
$staging    = "C:\Temp\portal-views"

Write-Host "=== Lumen MSP Portal — HOT view/static deploy (no restart) ===" -ForegroundColor Cyan

# Stage just the two hot folders, mirroring their paths under the app root.
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path "$staging\src\views" | Out-Null
New-Item -ItemType Directory -Path "$staging\static"    | Out-Null
robocopy "$localPath\src\views" "$staging\src\views" /E /NFL /NDL /NJH /NJS | Out-Null
robocopy "$localPath\static"    "$staging\static"    /E /NFL /NDL /NJH /NJS | Out-Null

Write-Host "Packaging..." -ForegroundColor Yellow
$tar = Join-Path $env:TEMP "portal-views.tar.gz"
if (Test-Path $tar) { Remove-Item $tar -Force }
tar --format=gnutar -czf $tar -C $staging .
if ($LASTEXITCODE -ne 0) { Write-Host "Packaging failed!" -ForegroundColor Red; exit 1 }

$sshOpts = @("-o","ServerAliveInterval=15","-o","ServerAliveCountMax=8","-o","ConnectTimeout=30")

Write-Host "Uploading..." -ForegroundColor Yellow
$ok = $false
for ($i = 1; $i -le 3; $i++) {
    scp @sshOpts $tar "${server}:/tmp/portal-views.tar.gz"
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Write-Host ("  SCP attempt {0} failed; retrying in 3s..." -f $i) -ForegroundColor DarkYellow
    Start-Sleep -Seconds 3
}
if (-not $ok) { Write-Host "SCP failed after 3 attempts!" -ForegroundColor Red; exit 1 }

# Overlay onto the live app — no npm, no prisma, no pm2. Live on the next request.
Write-Host "Applying (no restart)..." -ForegroundColor Yellow
ssh @sshOpts $server "tar --warning=no-unknown-keyword -xzf /tmp/portal-views.tar.gz -C $remotePath && rm -f /tmp/portal-views.tar.gz"

Remove-Item $staging -Recurse -Force
Remove-Item $tar -Force

Write-Host ""
Write-Host "Hot view/static deploy complete — no restart, no logouts." -ForegroundColor Green
Write-Host "Live at: https://portal.lumenmsp.co.uk"

# Record this hot deploy in git (same idea as deploy.ps1's Step 6, but scoped to the
# folders this script actually ships — src/views and static — so un-deployed code
# changes are NOT swept into a "deployed" commit). Non-fatal: a git hiccup never
# undoes a completed deploy.
try {
    Set-Location $localPath
    $stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
    git add src/views static 2>$null
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        $msg = Read-Host "Git commit message for this view deploy (Enter = 'Hot deploy $stamp (views/static)')"
        if (-not $msg) { $msg = "Hot deploy $stamp (views/static)" }
        git commit -m $msg | Out-Null
        git push
        if ($LASTEXITCODE -eq 0) { Write-Host "Committed + pushed to GitHub: $msg" -ForegroundColor Green }
        else { Write-Host "Committed locally but PUSH FAILED - run 'git push' when back online." -ForegroundColor Yellow }
    } else {
        Write-Host "Git: no view/static changes to commit." -ForegroundColor DarkGray
    }
    $other = git status --porcelain 2>$null | Where-Object { $_ -notmatch '^\s*.. src/views/' -and $_ -notmatch '^\s*.. static/' }
    if ($other) {
        Write-Host "Note: other files are still uncommitted (code/route changes?) - they need the FULL deploy.ps1 to go live + commit." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Git step failed (the deploy itself is fine): $_" -ForegroundColor Yellow
}
