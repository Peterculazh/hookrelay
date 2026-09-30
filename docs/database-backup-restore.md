# PostgreSQL backup and restore

This manual procedure was verified on the remote K3s deployment on
2026-09-30. It covers the application database's schema and data, including
receiver records and migration history. Database roles, Kubernetes Secrets,
the K3s datastore, and Redis queue data are outside this dump. Credentials
must be provisioned separately when recovering onto another server.
Scheduled backups and retention policies are not configured.

## 1. Create an archive on the VPS

```bash
(
  set -euo pipefail
  umask 077
  sudo -v
  mkdir -p "$HOME/hookrelay-backups"
  backup_dir=$(mktemp -d "$HOME/hookrelay-backups/backup-XXXXXXXX")

  sudo k3s kubectl -n hookrelay exec postgres-0 -- \
    sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
    > "$backup_dir/hookrelay.dump.partial"

  sudo k3s kubectl -n hookrelay exec -i postgres-0 -- \
    pg_restore --list < "$backup_dir/hookrelay.dump.partial" \
    > "$backup_dir/contents.txt"

  mv "$backup_dir/hookrelay.dump.partial" "$backup_dir/hookrelay.dump"
  cd "$backup_dir"
  sha256sum hookrelay.dump > hookrelay.dump.sha256
  printf 'Backup directory: %s\n' "$backup_dir"
  ls -lh hookrelay.dump
  cat hookrelay.dump.sha256
)
```

Record the printed directory and checksum locally. Each run creates a new
private directory. The archive is compressed and uses a consistent database
snapshot while the application runs. A readable archive list is only a
preliminary check; verify recovery by restoring the archive.

## 2. Copy off the server from Windows PowerShell

Enter actual connection values at the prompts and keep them outside the
repository. Run commands individually, stopping if a command fails.

```powershell
$vpsTarget = Read-Host 'SSH destination (user@host)'
$sshKeyPath = Read-Host 'Absolute path to your SSH private key'
$remoteBackupDirectory = Read-Host 'Absolute backup directory printed by the VPS'
$expectedHash = Read-Host 'SHA256 printed by the VPS (64 hex characters)'
if ([string]::IsNullOrWhiteSpace($vpsTarget) -or !(Test-Path -LiteralPath $sshKeyPath -PathType Leaf)) { throw 'Enter a destination and an existing key path.' }
if ($remoteBackupDirectory -notmatch '^/[a-zA-Z0-9/_-]+/backup-[a-zA-Z0-9]+$') { throw 'Enter the absolute generated backup directory.' }
if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Enter the recorded SHA256.' }
$backupRoot = Join-Path $env:USERPROFILE 'HookRelayBackups'
New-Item -ItemType Directory -Force -Path "$backupRoot" | Out-Null
scp -i "$sshKeyPath" -o IdentitiesOnly=yes -r "${vpsTarget}:$remoteBackupDirectory" "$backupRoot"
if ($LASTEXITCODE -ne 0) { throw 'Backup transfer failed.' }
$backupName = ($remoteBackupDirectory -split '/')[-1]
$backupFile = Join-Path (Join-Path $backupRoot $backupName) 'hookrelay.dump'
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath "$backupFile").Hash
if ($actualHash -eq $expectedHash) { 'Backup copy verified: SHA256 matches.' } else { throw 'Backup checksum mismatch.' }
```

The backup lives outside the project directory. Keep the verified copy and
the recorded checksum for recovery.

## 3. Restore into a separate test database on the VPS

Enter the absolute generated backup directory at the prompt. This creates
`hookrelay_restore_check` in the existing PostgreSQL instance. If that
database already exists, stop and choose a fresh test database name in both
the create and restore commands. Applications continue using their original
database.

```bash
(
  set -euo pipefail
  sudo -v
  read -r -p 'Absolute backup directory: ' backup_dir
  test -n "$backup_dir"
  cd "$backup_dir"
  sha256sum -c hookrelay.dump.sha256

  sudo k3s kubectl -n hookrelay exec postgres-0 -- \
    sh -c 'createdb -U "$POSTGRES_USER" -T template0 hookrelay_restore_check'

  sudo k3s kubectl -n hookrelay exec -i postgres-0 -- \
    sh -c 'pg_restore -U "$POSTGRES_USER" -d hookrelay_restore_check --single-transaction --no-owner --no-privileges' \
    < hookrelay.dump

  printf 'Restore completed successfully.\n'
)
```

The single transaction rolls back the restore if any statement fails.
The test database stays available for inspection. Restoring into the same
instance demonstrates archive recovery; it does not demonstrate rebuilding
the whole server from backups.

## 4. Verify the restored event and receiver effect

Use an event ID from a successful smoke test completed before the backup.
On the VPS, run:

```bash
read -r -p 'Delivered event UUID captured before the backup: ' event_id
sudo k3s kubectl -n hookrelay exec -i postgres-0 -- \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hookrelay_restore_check -v event_id="$1"' sh "$event_id" <<'SQL'
SELECT
  e.id,
  e.status,
  (SELECT count(*) FROM delivery_attempts a
   WHERE a.event_id = e.id AND a.status = 'succeeded'
     AND a.http_status = 204) AS successful_attempts,
  (SELECT count(*) FROM received_events r
   WHERE r.event_id = e.id) AS received_events,
  (SELECT count(*) FROM receiver_effects r
   WHERE r.event_id = e.id) AS receiver_effects
FROM events e
WHERE e.id = :'event_id';
SQL
```

For the clean successful smoke-test event, expect exactly one row, status
`delivered`, and `1` in all three count columns. An empty result is a failed
verification. If using another test database name, adjust the command above.
To check original data after a reboot, replace `-d hookrelay_restore_check`
with `-d "$POSTGRES_DB"` inside the shell command and run the same query.

References: [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html),
[PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
