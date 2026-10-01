# Commit-tagged releases and application rollback

Milestone 9 is complete as of 2026-09-30. Two commit-tagged GHCR releases were
deployed and verified on the remote K3s server, followed by a successful
application rollback from B to A. Fresh delivery and retained event history
were verified after rollback. This extends the existing single-node K3s
installation from [Milestone 8](vps-deployment.md).

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

For Milestone 11, use this release process before running the
[remote benchmark harness](vps-load-testing.md). Preserve the known compatible
release bundle for rollback and take a new off-server backup before updating.

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

Commit/push the selected changes and wait for both CI jobs to succeed.
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

Release B was verified on 2026-09-30:

- Commit: `d3c7d8620b7d770bb88f825f677d7bc6d391da4a`.
- Image digest: `sha256:56286149fb023f6d2d63679db8a992887cea85dfa09f0ed5969dca74306c803c`.
- Migration Job `hookrelay-migrate-d3c7d8620b7d770bb88f825f677d7bc6d391da4a` completed before application updates.
- Receiver, API, worker, and relay rollouts succeeded at B's selected image.
- The delivery smoke check passed, including its API readiness check; event `4aa8f820-6688-4d56-9b6e-0caacb7571c7` delivered with a successful HTTP 204 attempt.

Rollback from B to A was verified on the same date:

- All four application rollouts completed at A's selected image, without running or reversing database migrations.
- After a local PC reboot and reconnection, all four application Pods were ready and referenced A's pinned digest.
- Remote API readiness returned HTTP 200.
- A fresh event, `7db544ee-8596-4939-960a-114b8e7662b8`, delivered with a successful HTTP 204 attempt.
- A's saved event `84cfef07-9881-4568-9ae2-b8f5154d2e7e` and B's saved event `4aa8f820-6688-4d56-9b6e-0caacb7571c7` both remained `delivered` when read through the API after rollback.

B was a documentation-only commit with the same application code, database
schema, manifests, and shared configuration as A. This exercise verifies
version selection and application rollback between compatible releases;
compatibility must still be reviewed for future code or schema changes. The
remote applications remained on A after this exercise. Preserve both image
digests and release bundles.

### Milestone 11 release, 2026-10-01

The VPS subsequently advanced to commit
`8c817589dc58ffc6966e33cf49e535ee72c57dee`, image digest
`sha256:8130f3a2f85e9ed80a812819c7988cd2398f1b6c2fbd24e2b2f619a1149c8d81`.
[CI run 36760176540](https://github.com/Peterculazh/hookrelay/actions/runs/36760176540)
passed before deployment. A new custom-format database archive was copied off
the VPS and its SHA256 verified. The commit-specific migration Job completed,
and receiver, API, worker, and relay rollouts all succeeded at that digest.

Readiness returned HTTP 200; fresh event
`3d51bb35-61ae-4e46-a9c8-3a7c9b07eda5` delivered with HTTP 204. The saved A, B,
and rollback smoke events remained delivered, with one successful attempt and
one receiver effect each. After all VPS benchmark runs, fresh event
`ccaa9d4e-41f9-4f01-b0e1-605d4a0d6c0d` also delivered. Final inspection confirmed
all four applications' running image IDs match the selected digest, all six
application/storage Pods are ready, zero events are pending, and original
settings are restored with benchmark fixtures removed. The VPS now remains on
this release until the milestone 12 update below. Details and backup checksum are in the
[VPS benchmark report](vps-benchmark-report.md).

### Milestone 12 release, 2026-10-01

The VPS now runs commit `8290734d2df271206510cffa41ab2558be4277d2`, digest
`sha256:c80584dddfe5c1d3127c75b05b4c0a26ece7daae89268a0a35d6277e31fe5921`.
[CI run 36837371313](https://github.com/Peterculazh/hookrelay/actions/runs/36837371313)
passed before deployment. The new off-server backup's checksum and archive
listing were verified; the migration Job completed and all four rollouts
succeeded. The relay manifest selects batch 100 every second, one replica,
and `Recreate`, with unchanged resources.

Fresh deployment smoke event `6e8dc4aa-7bcc-4dd5-bcfb-8bd8fa1d8f2e` and final
post-benchmark event `57bec177-4ec4-4ee1-a681-ee66a7d46c0d` delivered with HTTP 204.
The three saved historical events still had one successful attempt and one
receiver effect each. Six VPS comparison runs passed; final inspection found
zero pending work, all six application/storage Pods ready on the intended
images, one default-concurrency worker, restored receiver settings, removed
fixtures, and no remaining forwarding processes. The
[relay tuning report](relay-tuning-report.md) records the measurements and limits.

References: [GHCR authentication and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[publishing from GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images),
[Kubernetes deployments and rollback](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
