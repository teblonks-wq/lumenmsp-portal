#!/usr/bin/env bash
#
# Lumen MSP Portal — restore helper
# Decrypts a backup bundle and lays out the contents so you can restore a DB or files.
# It does NOT auto-overwrite your live data — it extracts, then prints the exact commands.
#
# Usage:
#   sudo ./restore.sh /path/to/lumenmsp-YYYYMMDD-HHMMSS.tar.gz.enc
#
set -euo pipefail
ENV_FILE="/etc/lumenmsp-backup.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

SRC="${1:?Usage: restore.sh <backup-file.tar.gz[.enc]>}"
OUT="$(mktemp -d /tmp/lumenmsp-restore.XXXXXX)"

echo "[restore] extracting to $OUT"
if [[ "$SRC" == *.enc ]]; then
  [ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "BACKUP_PASSPHRASE not set (need it to decrypt)"; exit 1; }
  openssl enc -d -aes-256-cbc -pbkdf2 -in "$SRC" -pass pass:"$BACKUP_PASSPHRASE" | tar -xzf - -C "$OUT"
else
  tar -xzf "$SRC" -C "$OUT"
fi

echo
echo "Extracted contents:"
ls -lh "$OUT"
echo
echo "── To restore a DATABASE into a SCRATCH db (safe, recommended test) ──"
echo "  sudo -u postgres createdb portal_restore_test"
echo "  sudo -u postgres pg_restore -d portal_restore_test --no-owner ${OUT}/lumenmsp_portal.dump"
echo
echo "── To restore OVER the live db (DANGER — take a fresh dump first!) ──"
echo "  sudo -u postgres pg_restore -d lumenmsp_portal --clean --if-exists --no-owner ${OUT}/lumenmsp_portal.dump"
echo
echo "── To restore uploaded FILES ──"
echo "  tar -xzf ${OUT}/files.tar.gz -C /        # paths inside are absolute"
echo
echo "(Roles/passwords, if needed:  sudo -u postgres psql -f ${OUT}/globals.sql )"
echo "Extracted dir left in place for you: $OUT"
