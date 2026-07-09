# Mount the Azure Files share for backups

One-off, on the LITS app server. Replace `STORAGEACCOUNT`, `STORAGEKEY` and the share name.

## 1. Create the share (Azure Portal)
- Storage account → **File shares** → **+ File share** → name it `portal-backups`.
- Tier: **Transaction optimized** or **Hot** is fine for backups.
- Grab the **storage account name** and an **access key** (Storage account → Access keys).

## 2. Store the credentials securely on the server
```bash
sudo mkdir -p /etc/smbcredentials
sudo bash -c 'cat > /etc/smbcredentials/portalbackups.cred <<EOF
username=STORAGEACCOUNT
password=STORAGEKEY
EOF'
sudo chmod 600 /etc/smbcredentials/portalbackups.cred
sudo apt-get install -y cifs-utils
sudo mkdir -p /mnt/portal-backups
```

## 3. Mount now + persist across reboots (/etc/fstab)
```bash
sudo bash -c 'cat >> /etc/fstab <<EOF
//STORAGEACCOUNT.file.core.windows.net/portal-backups /mnt/portal-backups cifs nofail,vers=3.0,credentials=/etc/smbcredentials/portalbackups.cred,dir_mode=0750,file_mode=0640,serverino,mfsymlinks 0 0
EOF'
sudo mount -a
# verify:
mountpoint /mnt/portal-backups && echo "mounted OK"
```

## 4. Protect the backups (do this — it's the ransomware safety net)
In the Azure Portal on the storage account / file share:
- **Soft delete** for file shares → enable (e.g., 30-day retention).
- **Snapshots** → schedule (e.g., daily) via Azure Backup for Files, or manual/automated snapshots.

That way, even if the server is compromised and the mounted backups get deleted/encrypted,
you can restore them from a snapshot or soft-delete.

## 5. Done
`backup.sh` writes the encrypted nightly bundle to `/mnt/portal-backups` and refuses to run
if the share isn't mounted (so it never silently fills local disk).
