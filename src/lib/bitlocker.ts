import { pool } from '../db/pool';
import { encryptSecret, decryptSecret, vaultConfigured } from './vault';

// ── BitLocker recovery keys ───────────────────────────────────────────────────────
// The honest shape of this feature: a machine sitting at the BitLocker recovery screen
// has no OS, so no agent, so no network. Nothing here can reach it. What this does is
// hold the key BEFORE that happens, so somebody can read it out to whoever is standing
// at the machine. That is why the keys are STORED and not merely fetched on demand —
// fetching on demand fails at the only moment the feature matters.
//
// Because they are stored, they are treated as the most sensitive thing in the Portal:
// AES-256-GCM through lib/vault, decrypted only on an explicit reveal behind
// requireVaultAccess, and every reveal written to the activity log.
//
// TODO (next agent build): this rides on the generic `shell.powershell` kind so it could
// ship without an agent rollout. Move it to an allow-listed `bitlocker.scan` kind — a
// recovery key should not travel through the general-purpose shell runner forever.

/** Marks output as ours, so the result hook can tell this apart from a PowerShell
 *  command a human typed. The agent reports the kind as shell.powershell either way. */
export const BITLOCKER_MARKER = 'LUMEN_BITLOCKER_V1';

export interface BitlockerVolumeRow {
  id: number;
  mount_point: string;
  protection_status: string | null;
  lock_status: string | null;
  encryption_method: string | null;
  volume_type: string | null;
  key_protector_id: string;
  has_key: boolean;
  collected_at: string;
}

// The upsert, kept as a named constant so the whole statement reads in one place.
// Rows are keyed on (device, mount, key protector id) so a nightly re-scan updates the
// row it already has instead of piling up a duplicate a night.
//
// COALESCE on the key is the important line: a scan that came back WITHOUT the password
// must not wipe a key we already hold. The usual cause is the scan running without the
// rights to read it, and losing a good key to a bad scan is the one mistake here that
// cannot be undone.
const BL_UPSERT = `INSERT INTO asset_bitlocker_keys
     (device_id, mount_point, key_protector_id, protection_status, lock_status,
              encryption_method, volume_type, recovery_key_encrypted, collected_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
   ON CONFLICT (device_id, mount_point, key_protector_id) DO UPDATE SET
     protection_status = EXCLUDED.protection_status,
     lock_status       = EXCLUDED.lock_status,
     encryption_method = EXCLUDED.encryption_method,
     volume_type       = EXCLUDED.volume_type,
     recovery_key_encrypted = COALESCE(EXCLUDED.recovery_key_encrypted, asset_bitlocker_keys.recovery_key_encrypted),
     collected_at = NOW(), updated_at = NOW()`;

const BL_PRUNE = `DELETE FROM asset_bitlocker_keys
  WHERE device_id=$1 AND (mount_point || ' ' || key_protector_id) <> ALL($2::text[])`;

/** Did this output come from our scan? Cheap check before parsing 400k of somebody's
 *  Get-ChildItem. */
export function looksLikeBitlockerScan(output: string | null | undefined): boolean {
  return !!output && output.indexOf(BITLOCKER_MARKER) >= 0;
}

/** Volumes for the device page. Never returns a key — only whether one exists. */
export async function bitlockerForDevice(deviceId: number): Promise<BitlockerVolumeRow[]> {
  const r = await pool.query(
    `SELECT id, mount_point, protection_status, lock_status, encryption_method, volume_type,
            key_protector_id, (recovery_key_encrypted IS NOT NULL) AS has_key,
            to_char(collected_at, 'YYYY-MM-DD HH24:MI') AS collected_at
       FROM asset_bitlocker_keys WHERE device_id=$1
      ORDER BY mount_point, key_protector_id`, [deviceId]
  );
  return r.rows as BitlockerVolumeRow[];
}

/** The one place a recovery key is ever decrypted. Callers must be behind
 *  requireVaultAccess and must log the access. */
export async function revealBitlockerKey(rowId: number): Promise<{ key: string; mount: string; deviceId: number } | null> {
  const r = await pool.query(
    'SELECT device_id, mount_point, recovery_key_encrypted FROM asset_bitlocker_keys WHERE id=$1', [rowId]
  );
  if (!r.rows.length || !r.rows[0].recovery_key_encrypted) return null;
  return {
    key: decryptSecret(r.rows[0].recovery_key_encrypted),
    mount: r.rows[0].mount_point,
    deviceId: r.rows[0].device_id,
  };
}

/** Facts only — every volume, its protection state, and its recovery passwords. No
 *  judgement: the Portal decides what counts as a problem, so tightening the bar never
 *  means touching an agent on a customer machine. Wrapped throughout because a machine
 *  with no TPM, no BitLocker, or an old build is normal, and one bad volume should cost
 *  that volume rather than the whole scan. */
export const BITLOCKER_SCAN_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  '$vols = @()',
  'try {',
  '  foreach ($v in @(Get-BitLockerVolume -ErrorAction Stop)) {',
  '    $prot = @()',
  '    try {',
  '      foreach ($p in @($v.KeyProtector)) {',
  '        if ("$($p.KeyProtectorType)" -eq \'RecoveryPassword\' -and "$($p.RecoveryPassword)".Trim().Length -gt 0) {',
  '          $prot += [ordered]@{ id = "$($p.KeyProtectorId)"; password = "$($p.RecoveryPassword)" }',
  '        }',
  '      }',
  '    } catch { }',
  '    $vols += [ordered]@{',
  '      mount = "$($v.MountPoint)"; status = "$($v.ProtectionStatus)"; lock = "$($v.LockStatus)";',
  '      method = "$($v.EncryptionMethod)"; volType = "$($v.VolumeType)"; protectors = $prot',
  '    }',
  '  }',
  '} catch { }',
  "$out = [ordered]@{ marker = '" + BITLOCKER_MARKER + "'; volumes = $vols }",
  '$out | ConvertTo-Json -Depth 6 -Compress',
].join('\n');

/** Suspend protection for one reboot. The pre-firmware-update button: it stops the
 *  machine dropping into a recovery prompt after a BIOS or TPM change, and protection
 *  resumes by itself. Never a way to decrypt anything. */
export function bitlockerSuspendScript(mount: string): string {
  const m = mount.replace(/'/g, "''");
  return `Suspend-BitLocker -MountPoint '${m}' -RebootCount 1 | Out-Null; ` +
         `"Protection is now $((Get-BitLockerVolume -MountPoint '${m}').ProtectionStatus)"`;
}

/**
 * Store what a scan reported, and return how many recovery passwords were kept.
 *
 * Rows are keyed on (device, mount point, key protector id): re-running the scan updates
 * the row it already has rather than piling up a duplicate a night. A protector that has
 * DISAPPEARED from the machine is deleted, so a re-encrypted disk cannot leave a stale key
 * on screen and send somebody to the wrong number over the phone.
 */
export async function ingestBitlockerScan(deviceId: number, output: string): Promise<number> {
  if (!vaultConfigured()) throw new Error('vault key not configured - refusing to store recovery keys in the clear');
  const start = output.indexOf('{');
  if (start < 0) return 0;
  const parsed = JSON.parse(output.slice(start));
  if (!parsed || parsed.marker !== BITLOCKER_MARKER) return 0;
  const volumes: any[] = Array.isArray(parsed.volumes) ? parsed.volumes : [];
  const seen: string[] = [];
  let kept = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of volumes) {
      const mount = String(v.mount || '').slice(0, 20);
      if (!mount) continue;
      const protectors: any[] = Array.isArray(v.protectors) ? v.protectors : [];
      // A volume with no recovery password still gets a row: "C: is encrypted and we hold
      // NO key for it" is the most important thing this screen can say, and a missing row
      // would read as "not encrypted" instead.
      const list = protectors.length ? protectors : [{ id: '', password: '' }];
      for (const p of list) {
        const protectorId = String(p.id || '').slice(0, 100);
        const password = String(p.password || '').trim();
        seen.push(mount + ' ' + protectorId);
        const enc = password ? encryptSecret(password) : null;
        if (enc) kept++;
        await client.query(BL_UPSERT, [
          deviceId, mount, protectorId,
          String(v.status || '').slice(0, 40), String(v.lock || '').slice(0, 40),
          String(v.method || '').slice(0, 60), String(v.volType || '').slice(0, 40), enc,
        ]);
      }
    }
    // Drop protectors the machine no longer has, so a re-encrypted disk cannot leave a
    // stale key on screen.
    if (seen.length) {
      await client.query(BL_PRUNE, [deviceId, seen]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    throw e;
  } finally { client.release(); }
  return kept;
}
