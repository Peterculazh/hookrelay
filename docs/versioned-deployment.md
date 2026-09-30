# Commit-tagged releases and application rollback

The first GHCR release (A) was deployed and verified on the remote K3s server
on 2026-09-30. Milestone 9 still requires deployment of a second compatible
release (B), rollback to A, and delivery checks after rollback. This extends
the existing single-node K3s installation from [Milestone 8](vps-deployment.md).

CI on `main` runs lint, type checking, unit tests, and the Compose delivery,
deduplication, crash recovery, shutdown, and exhaustion checks. Only a successful
push run passes its tested `linux/amd64` image to a separate publishing job.
Pull requests have no publishing job or package-write permission.
The image is published at `ghcr.io/peterculazh/hookrelay:sha-<full-commit>`;
its source and revision labels link it to this repository. The CI summary
records the full tag **and digest** used by the release bundle. Commit tags
can be republished on workflow reruns; the digest identifies the exact image.

New GHCR packages default to private. After first publication, check the
package's visibility and repository access in GitHub package settings. The
workflow uses `GITHUB_TOKEN`; no publishing PAT or server SSH key is needed
in Actions. Deployment remains an explicit operation on the server.

## 1. Give K3s read access to the private package

Create a GitHub personal access token (classic) with `read:packages` for an
account allowed to read the package. This is a server pull credential, separate
from CI's token. Authorize it for SSO if the account's organization requires it.
Run on the VPS; credentials stay out of shell history and command arguments:

```bash
(
  set -euo pipefail
  umask 077
  read -rp 'GitHub username with package access: ' registry_user
  [[ $registry_user =~ ^[A-Za-z0-9-]+$ ]]
  read -rsp 'GHCR read:packages token: ' registry_token
  printf '\n'
  [[ -n $registry_token ]]
  auth=$(printf '%s:%s' "$registry_user" "$registry_token" | base64 -w0)
  unset registry_token
  config_file=$(mktemp)
  trap 'rm -f -- "$config_file"' EXIT
  printf '{"auths":{"ghcr.io":{"auth":"%s"}}}\n' "$auth" > "$config_file"
  unset auth
  sudo k3s kubectl -n hookrelay create secret generic ghcr-credentials \
    --type=kubernetes.io/dockerconfigjson \
    --from-file=".dockerconfigjson=$config_file" --dry-run=client -o yaml |
    sudo k3s kubectl -n hookrelay apply -f -
)
```

Repeat when rotating the token. New application and migration Pods reference
this Secret. Existing PostgreSQL credentials and ConfigMap stay in place.

## 2. Prepare an exact release on Windows

Commit/push the Milestone 9 changes and wait for both CI jobs to succeed.
Copy the preparation command from the **Verified release image** summary.
It supplies the full commit and the published image digest:

```powershell
$releaseCommit = Read-Host 'Full commit SHA from the successful CI run'
$releaseImage = Read-Host 'Full image:sha-commit@sha256:digest from its summary'
npm run prepare:release -- $releaseCommit $releaseImage
if ($LASTEXITCODE -ne 0) { throw 'Release preparation failed.' }
```

The commit must exist locally (`git fetch origin` if necessary). Preparation
reads the five application/migration manifests with `git show` at that commit,
changes them to the registry digest, adds the pull Secret, and assigns a
commit-specific migration Job name. It preserves the single relay's `Recreate`
strategy. The output is `.tmp/releases/<full-commit>/`. Preparation refuses to
overwrite an existing bundle; preserve its digest and use it for repeat runs.
The bundle excludes storage, Secrets, and the shared ConfigMap.
Review the manifests before uploading:

```powershell
Get-Content ".tmp/releases/$releaseCommit/image.txt"
Get-Content ".tmp/releases/$releaseCommit/migrate.yaml"
& {
    $ErrorActionPreference = 'Stop'
    $vpsTarget = (Read-Host 'SSH destination (user@host)').Trim()
    if ($vpsTarget -notmatch '^[^@\s]+@[^@\s]+$') { throw 'Enter your actual SSH username@host.' }
    $sshKeyPath = (Read-Host 'Existing SSH private key path, without quotes').Trim()
    if ([string]::IsNullOrWhiteSpace($sshKeyPath) -or !(Test-Path -LiteralPath $sshKeyPath -PathType Leaf)) { throw 'Enter the path to an existing private key file.' }
    if (!(Test-Path -LiteralPath ".tmp/releases/$releaseCommit" -PathType Container)) { throw 'Prepare the release bundle first.' }
    $scpExecutable = (Get-Command scp.exe -CommandType Application).Source
    & $scpExecutable -i "$sshKeyPath" -o IdentitiesOnly=yes -r ".tmp/releases/$releaseCommit" "${vpsTarget}:~/"
    if ($LASTEXITCODE -ne 0) { throw 'Release upload failed.' }
    & $scpExecutable -i "$sshKeyPath" -o IdentitiesOnly=yes scripts/deploy-release.sh "${vpsTarget}:~/"
    if ($LASTEXITCODE -ne 0) { throw 'Script upload failed.' }
    Write-Host 'Both uploads succeeded.'
}
```

No image archive/import is needed. The shell script uses LF line endings and
runs with Bash on Ubuntu; it needs the standard `flock` utility.

## 3. Deploy on the VPS

Take an off-server [database backup](database-backup-restore.md) first. Review
the selected commit's migration and configuration requirements. Migrations run
while the previous version is still serving, so schema changes must remain
compatible with that version. Configuration changes requiring coordinated
updates need a separate procedure; this bundle does not modify shared config.

```bash
read -rp 'Full release commit: ' release_commit
[[ $release_commit =~ ^[a-f0-9]{40}$ ]] &&
  bash "$HOME/deploy-release.sh" deploy "$HOME/$release_commit"
```

The script checks existing applications, the pull Secret, and the single-relay
strategy. It locks release operations on this server and prints current image
references; save that output with the selected digest and smoke-test event ID.
It creates the migration Job only if absent, checks an existing Job's digest,
and waits for successful completion before updating any applications. A failed
or timed-out migration leaves application versions unchanged; inspect the Job
before deciding what to do. The script never deletes/retries a failed Job.

Applications update in order: receiver, API, worker, relay. Every update must
finish its rollout and have the selected image before the next begins. The
relay briefly pauses during replacement. A later rollout failure can leave a
mixture of application versions; the script stops and does not automatically
roll back. Database compatibility needs an operator's decision.

After successful rollout, inspect Pod image IDs:

```bash
sudo k3s kubectl -n hookrelay get pods \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[*].image,IMAGE_ID:.status.containerStatuses[*].imageID'
```

Run the remote readiness and `npm run test:smoke` checks using the two forwarding
sessions from [VPS deployment, step 6](vps-deployment.md#6-verify-delivery-through-an-ssh-tunnel).
Expect readiness HTTP 200 and a fresh delivery with HTTP 204. Rollout readiness
alone does not prove webhook delivery. Save the delivered event ID.

## 4. Demonstrate rollback between compatible releases

Keep the prepared bundle for a verified release **A**. Publish a second commit
**B** with no schema or shared-configuration changes (a documentation-only
commit is sufficient for this exercise). Prepare/deploy B and pass the same
readiness/delivery checks. Confirm its Pods use B's digest.

On the VPS, restore A's saved bundle:

```bash
read -rp 'Full commit of the previously verified release A: ' previous_commit
[[ $previous_commit =~ ^[a-f0-9]{40}$ ]] &&
  bash "$HOME/deploy-release.sh" rollback "$HOME/$previous_commit" --compatible
```

`--compatible` acknowledges that A supports the current database schema,
configuration, and queued payloads. The script applies A's application
manifests and waits for each rollout; **it does not run A's migration Job or
reverse B's migrations**. For incompatible schema changes, stop and plan a
forward fix or a separately reviewed data-recovery procedure.

Confirm all four applications use A's digest, readiness returns HTTP 200, and
a fresh event delivers with HTTP 204. Read the saved A/B event IDs through
`GET /v1/events/:id` and confirm they remain delivered. Record A/B commit SHAs,
digests, completed migration Jobs, rollout results, and smoke-test event IDs.
Those observations complete Milestone 9. Retain both registry versions and
bundles; deleting a digest removes the ability to pull that release again.

## 5. Verification record

Release A was verified on 2026-09-30:

- Commit: `34990bac3ad5f74ca4b33b1ae20a65d7f403c52d`.
- Image digest: `sha256:65484561054fd00b07eb4761086521ee08f62d286e0416f0244bf0f64bb1d5d7`.
- Migration Job `hookrelay-migrate-34990bac3ad5f74ca4b33b1ae20a65d7f403c52d` completed before application updates.
- Receiver, API, worker, and relay rollouts succeeded at the selected image.
- Remote API readiness returned HTTP 200.
- Event `84cfef07-9881-4568-9ae2-b8f5154d2e7e` delivered with a successful HTTP 204 attempt.

Release B and rollback verification are pending. The next documentation-only
commit provides a second release with the same application code, database
schema, manifests, and shared configuration as A. Keep A's bundle for rollback.

References: [GHCR authentication and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[publishing from GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images),
[Kubernetes deployments and rollback](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
