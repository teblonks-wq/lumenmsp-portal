#!/usr/bin/env bash
#
# Lumen MSP Portal — nightly backup (Azure Blob edition)
# Dumps all Postgres DBs + uploaded files + .env, encrypts the bundle, uploads to an Azure
# Blob container with rotation, and pings Teams on failure. Run from cron as root.
#
# Setup (one-off):
#   1. sudo apt-get install -y postgresql-client openssl curl
#   2. Install Azure CLI:  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
#   3. sudo cp backup.sh /usr/local/bin/lumenmsp-backup.sh && sudo chmod 750 /usr/local/bin/lumenmsp-backup.sh
#   4. Create /etc/lumenmsp-backup.env from the example (chmod 600) and fill it in.
#   5. Test:  sudo /usr/local/bin/lumenmsp-backup.sh
#   6. Cron (02:30 nightly):
#        sudo crontab -e
#        30 2 * * *  /usr/local/bin/lumenmsp-backup.sh >> /var/log/lumenmsp-backup.log 2>&1
#
set -euo pipefail

ENV_FILE="/etc/lumenmsp-backup.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

# ── Config (override in /etc/lumenmsp-backup.env) ───────────────────────────────
STAGING="${STAGING:-/var/backups/lumenmsp}"
PGUSER="${PGUSER:-postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
APP_DIR="${APP_DIR:-/srv/apps/lumenmsp-portal}"

# Azure Blob target (set AZ_ACCOUNT, AZ_KEY, AZ_CONTAINER in the env file)
AZ_ACCOUNT="${AZ_ACCOUNT:-}"
AZ_KEY="${AZ_KEY:-}"
AZ_CONTAINER="${AZ_CONTAINER:-}"
AZ_PREFIX="${AZ_PREFIX:-portal-backups/}"   # folder inside the container, keeps backups tidy

DBS_STR="${DBS:-lumenmsp_portal}"
read -r -a DBS_ARR <<< "$DBS_STR"

FILE_DIRS=( "${APP_DIR}/static/attachments" "${APP_DIR}/static/branding" "${APP_DIR}/uploads" )
ENV_FILES=( "${APP_DIR}/.env" )

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="${STAGING}/work-${STAMP}"
mkdir -p "$WORK"

az() { command az "$@" --account-name "$AZ_ACCOUNT" --account-key "$AZ_KEY" --only-show-errors; }

fail() {
  echo "[backup] FAILED: $1" >&2
  if [ -n "${TEAMS_WEBHOOK:-}" ]; then
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"title\":\"⚠ Portal backup FAILED\",\"text\":\"$(hostname) — $1\"}" \
      "$TEAMS_WEBHOOK" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit 1
}
trap 'fail "error near line $LINENO"' ERR

# ── 1. Databases (custom format = restore whole DB or a single table) ────────────
for db in "${DBS_ARR[@]}"; do
  echo "[backup] dumping database: $db"
  sudo -u "$PGUSER" pg_dump -Fc "$db" > "${WORK}/${db}.dump" || fail "pg_dump $db"
done
sudo -u "$PGUSER" pg_dumpall --globals-only > "${WORK}/globals.sql" 2>/dev/null || true

# ── 2. Uploaded files + .env ─────────────────────────────────────────────────────
EXIST=()
for d in "${FILE_DIRS[@]}"; do [ -d "$d" ] && EXIST+=("$d"); done
[ ${#EXIST[@]} -gt 0 ] && tar -czf "${WORK}/files.tar.gz" "${EXIST[@]}" || fail "tar files"
for f in "${ENV_FILES[@]}"; do
  [ -f "$f" ] && cp "$f" "${WORK}/env-$(basename "$(dirname "$f")").txt"
done

# ── 3. Bundle + encrypt (AES-256) ────────────────────────────────────────────────
BUNDLE="${STAGING}/lumenmsp-${STAMP}.tar.gz"
tar -czf "$BUNDLE" -C "$WORK" .
rm -rf "$WORK"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -salt -pbkdf2 -in "$BUNDLE" -out "${BUNDLE}.enc" -pass pass:"$BACKUP_PASSPHRASE" || fail "encrypt"
  rm -f "$BUNDLE"
  BUNDLE="${BUNDLE}.enc"
else
  echo "[backup] WARNING: BACKUP_PASSPHRASE not set — bundle is NOT encrypted (it holds PII + secrets)."
fi

# ── 4. Upload to Azure Blob ──────────────────────────────────────────────────────
[ -n "$AZ_ACCOUNT" ] && [ -n "$AZ_KEY" ] && [ -n "$AZ_CONTAINER" ] || fail "Azure Blob not configured (AZ_ACCOUNT/AZ_KEY/AZ_CONTAINER)"
BLOBNAME="${AZ_PREFIX}$(basename "$BUNDLE")"
echo "[backup] uploading ${BLOBNAME} to ${AZ_ACCOUNT}/${AZ_CONTAINER}"
az storage blob upload --container-name "$AZ_CONTAINER" --file "$BUNDLE" --name "$BLOBNAME" --overwrite || fail "azure upload"
rm -f "$BUNDLE"

# ── 5. Rotate (delete blobs + local staging older than retention) ────────────────
CUTOFF="$(date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)"
az storage blob list --container-name "$AZ_CONTAINER" --prefix "$AZ_PREFIX" \
  --query "[?properties.lastModified < '${CUTOFF}'].name" -o tsv 2>/dev/null | while read -r b; do
    [ -n "$b" ] && az storage blob delete --container-name "$AZ_CONTAINER" --name "$b" || true
done
find "$STAGING" -maxdepth 1 -name 'lumenmsp-*.tar.gz*' -mtime +2 -delete || true

echo "[backup] OK $(date -Is) — ${BLOBNAME}"
