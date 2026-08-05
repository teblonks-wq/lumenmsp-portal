#!/bin/bash
# Nightly backup of the MeshCentral server.
#
# meshcentral-data IS the server: config, database, TLS and agent certificates, device
# groups, user accounts. Lose it and every deployed agent is orphaned — they trust a
# certificate that no longer exists anywhere, so recovery means visiting every machine.
# That is the scenario this exists to prevent.
#
# Runs as root from a systemd timer. Keeps 14 days locally and pushes a copy to the
# Portal server, which is itself backed up — a backup that only lives on the machine it
# backs up is not a backup.

set -euo pipefail

DATA=/opt/meshcentral/meshcentral-data
DEST=/var/backups/meshcentral
KEEP_DAYS=14

# Where to push the offsite copy. Blank = local only (still better than nothing).
REMOTE="${MESH_BACKUP_REMOTE:-}"          # e.g. lits-admin@51.11.176.101:/data/backups/meshcentral/

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

# A JSON dump alongside the raw files. The database is the fiddly part to restore from a
# half-copied file, and this gives a second, format-independent route back.
sudo -u meshcentral -H bash -lc 'cd /opt/meshcentral && node node_modules/meshcentral --dbexport' >/dev/null 2>&1 || \
  echo "warning: dbexport failed, continuing with a file-level copy" >&2

TARBALL="$DEST/meshcentral-$STAMP.tar.gz"
tar -czf "$TARBALL" -C "$(dirname "$DATA")" "$(basename "$DATA")"
chmod 600 "$TARBALL"

# Refuse to report success on a tarball that is obviously wrong. A truncated backup that
# nobody notices is worse than no backup, because it buys false confidence.
SIZE=$(stat -c%s "$TARBALL")
if [ "$SIZE" -lt 100000 ]; then
  echo "backup is only $SIZE bytes — something is wrong, not pruning old copies" >&2
  exit 1
fi

if [ -n "$REMOTE" ]; then
  scp -q -o BatchMode=yes "$TARBALL" "$REMOTE" || echo "warning: offsite copy failed" >&2
fi

find "$DEST" -name 'meshcentral-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup ok: $TARBALL ($((SIZE / 1024 / 1024)) MB)"
