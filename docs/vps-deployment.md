# First deployment on a K3s VPS

Milestone 8 is complete as of 2026-09-30. These steps target a single Ubuntu/K3s server.
Remote deployment and delivery were verified on 2026-09-29: API readiness
returned HTTP 200 and the delivery smoke test passed with HTTP 204. A custom-format
PostgreSQL backup was created and copied off the server; its SHA256 checksum
was verified on 2026-09-30. On the same date, the archive was successfully
restored into a separate test database. The restored smoke-test event was
delivered, with one successful HTTP 204 attempt, one receiver receipt, and one
receiver effect. After a VPS reboot, all workloads recovered, the original
database retained those records, readiness returned HTTP 200, and a fresh
event delivered with HTTP 204.
Run the marked commands on the indicated machine.

The application stays on ClusterIP Services and is reached through SSH while
we verify it. K3s includes containerd; Docker is needed only on the Windows
build machine. No registry or extra paid service is required.

## 1. Verify K3s on the VPS

```bash
sudo k3s kubectl -n kube-system rollout status deployment/coredns --timeout=180s
sudo k3s kubectl -n kube-system rollout status deployment/local-path-provisioner --timeout=180s
sudo k3s kubectl get pods -A
sudo k3s kubectl get storageclass
```

The initial `ContainerCreating` state is expected during startup. CoreDNS,
the storage provisioner, metrics-server, and Traefik should settle to Running;
the Traefik install Jobs should be Completed. If a Pod stays Pending or fails,
inspect `sudo k3s kubectl -n kube-system get events --sort-by=.metadata.creationTimestamp`
before proceeding. Confirm the `local-path` storage class exists.

## 2. Prepare and transfer from Windows PowerShell

Run in the HookRelay repository with Docker Desktop running. Stop if any
command fails. Use a new release name for each new build; the instructions
below use `vps-1` throughout.

```powershell
npm run prepare:vps -- vps-1
docker build --platform linux/amd64 --tag hookrelay:vps-1 .
docker image save --output .tmp/hookrelay-vps-1.tar hookrelay:vps-1
$vpsTarget = Read-Host 'SSH destination (user@host)'
$sshKeyPath = Read-Host 'Absolute path to your SSH private key'
if ([string]::IsNullOrWhiteSpace($vpsTarget) -or !(Test-Path -LiteralPath $sshKeyPath -PathType Leaf)) { throw 'Enter a destination and an existing key path.' }
scp -i "$sshKeyPath" -o IdentitiesOnly=yes .tmp/hookrelay-vps-1.tar "${vpsTarget}:~/"
scp -i "$sshKeyPath" -o IdentitiesOnly=yes -r .tmp/vps-1 "${vpsTarget}:~/"
```

The preparation command derives all manifests from `k8s/`, changes both
storage classes to `local-path`, and assigns the release image and migration
Job name. It does not modify the local Kubernetes manifests. Generated files
and image archives in `.tmp/` are ignored by Git and Docker builds.
Connection values are entered only in your local terminal session; do not
save them in project files.

## 3. Import the image and create credentials on the VPS

```bash
sudo k3s ctr --namespace k8s.io images import "$HOME/hookrelay-vps-1.tar"
sudo k3s crictl images hookrelay
cd "$HOME/vps-1"
sudo k3s kubectl apply -f namespace.yaml -f configmap.yaml
```

Confirm `hookrelay` with tag `vps-1` is present. Generate the initial database
password on the server using this subshell. The temporary credentials file is
private and removed on exit. Do not run with shell tracing (`set -x`).

```bash
(
  set -euo pipefail
  umask 077
  credentials_file=$(mktemp)
  trap 'rm -f "$credentials_file"' EXIT
  printf 'POSTGRES_USER=hookrelay\nPOSTGRES_DB=hookrelay\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" > "$credentials_file"
  sudo k3s kubectl -n hookrelay create secret generic postgres-credentials --from-env-file="$credentials_file"
)
```

This deliberately uses `create`, so rerunning it cannot overwrite an existing
Secret. Reuse the existing Secret on subsequent deployments: changing it does
not change the password inside an already initialized PostgreSQL volume.

## 4. Start storage, then complete the migration on the VPS

Run each command only after the previous one succeeds.

```bash
sudo k3s kubectl apply -f postgres-pvc.yaml -f postgres.yaml -f redis.yaml
sudo k3s kubectl -n hookrelay rollout status statefulset/postgres --timeout=180s
sudo k3s kubectl -n hookrelay rollout status statefulset/redis --timeout=180s
sudo k3s kubectl -n hookrelay get pvc
sudo k3s kubectl apply -f migrate.yaml
sudo k3s kubectl -n hookrelay wait --for=condition=complete job/hookrelay-migrate-vps-1 --timeout=180s
sudo k3s kubectl -n hookrelay logs job/hookrelay-migrate-vps-1
```

Both claims should be Bound. Do not proceed if the migration fails or times
out. Inspect the Job logs and Pod events first. Reapplying a completed Job
does not rerun it; subsequent releases need a new name.

## 5. Start applications on the VPS

```bash
sudo k3s kubectl apply -f test-receiver.yaml -f test-receiver-service.yaml
sudo k3s kubectl -n hookrelay rollout status deployment/test-receiver --timeout=180s
sudo k3s kubectl apply -f hookrelay.yaml -f worker.yaml -f relay.yaml
sudo k3s kubectl -n hookrelay rollout status deployment/hookrelay --timeout=180s
sudo k3s kubectl -n hookrelay rollout status deployment/worker --timeout=180s
sudo k3s kubectl -n hookrelay rollout status deployment/relay --timeout=180s
sudo k3s kubectl -n hookrelay get pods,services,pvc,jobs
```

Keep exactly one relay replica. The current setup uses one worker as well.

## 6. Verify delivery through an SSH tunnel

On the VPS, leave this running:

```bash
sudo k3s kubectl -n hookrelay port-forward --address=127.0.0.1 service/hookrelay 18080:3000
```

In a separate Windows PowerShell terminal, leave this running:

```powershell
$vpsTarget = Read-Host 'SSH destination (user@host)'
$sshKeyPath = Read-Host 'Absolute path to your SSH private key'
if ([string]::IsNullOrWhiteSpace($vpsTarget) -or !(Test-Path -LiteralPath $sshKeyPath -PathType Leaf)) { throw 'Enter a destination and an existing key path.' }
ssh -i "$sshKeyPath" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18080:127.0.0.1:18080 "$vpsTarget"
```

In another Windows terminal in the repository:

```powershell
curl.exe -i http://127.0.0.1:18080/health/ready
$previousSmokeBaseUrl = $env:SMOKE_BASE_URL
try {
    $env:SMOKE_BASE_URL = 'http://127.0.0.1:18080'
    npm run test:smoke
} finally {
    $env:SMOKE_BASE_URL = $previousSmokeBaseUrl
}
```

Expect HTTP 200 for readiness and a smoke test delivery with HTTP 204. Stop
both forwarding sessions with Ctrl+C afterward. Port 18080 and the Kubernetes
API port 6443 do not need public firewall rules for this workflow.

## 7. Back up and restore PostgreSQL

Follow the [database backup/restore procedure](database-backup-restore.md).
It covers a custom-format dump, an off-server copy and checksum verification,
and restoration into a separate test database. Local-path volumes reside on
this server's disk; they are not backups.

## 8. Verify recovery after a VPS reboot

Run `sudo reboot` on the VPS. Reconnect after it restarts, then run:

```bash
sudo systemctl is-active k3s
sudo k3s kubectl wait --for=condition=Ready nodes --all --timeout=180s
sudo k3s kubectl -n hookrelay rollout status statefulset/postgres --timeout=180s
sudo k3s kubectl -n hookrelay rollout status statefulset/redis --timeout=180s
for deployment in hookrelay worker relay test-receiver; do
  sudo k3s kubectl -n hookrelay rollout status deployment/"$deployment" --timeout=180s || break
done
sudo k3s kubectl -n hookrelay get pods,pvc
```

Verify the previously delivered event in the original database using the
record check in the backup/restore procedure. Restart both forwarding
sessions from step 6, confirm readiness HTTP 200, and rerun `npm run test:smoke`
against the forwarded remote API. A new delivery with HTTP 204 completes the
reboot check. Migration Jobs remain Completed and do not rerun on reboot.

References: [K3s image imports](https://docs.k3s.io/add-ons/import-images),
[K3s local-path storage](https://docs.k3s.io/add-ons/storage).
