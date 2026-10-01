# Milestone 11: VPS deployment and remote load testing

Status: complete, verified on 2026-10-01. Milestone 10 remains the completed local
baseline. The committed release is deployed on the existing K3s VPS, and all ten
remote scenarios passed with the local PC generating traffic. See the
[VPS benchmark report](vps-benchmark-report.md) and
[numeric results](vps-benchmark-results.json). Relay tuning is the next milestone.

## Acceptance

- Deploy the selected successful CI release with its pinned GHCR digest, after
  an off-server database backup. Verify migration, all rollouts, readiness, and
  fresh delivery; preserve earlier delivered records.
- Run k6 on the local PC. API, relay, workers, receiver, PostgreSQL, Redis, and
  the controlled receiver proxy run on the VPS.
- Repeat healthy traffic, slow receivers, worker concurrency and replicas,
  retries, exhaustion, timeouts, published-backlog recovery, and relay pressure.
- Record offered/accepted and completed-delivery rates, API/delivery p95/p99,
  backlog, recovery, VPS hardware/resources, Node metrics, database activity,
  network path, application commit, and image digest.
- Verify expected attempts/effects and complete draining. Restore original
  worker concurrency/replicas and receiver destination; remove owned fixture
  resources. Retain evidence and a benchmark report.

## Deploy the application release

Follow [versioned deployment](versioned-deployment.md) and
[database backup](database-backup-restore.md). The benchmark harness requires
all four applications to use the same selected commit-tagged, digest-pinned
image. It refuses a mismatched image or a pre-existing pending workload.
This milestone's controller and observer are transmitted over SSH at runtime;
they do not require a new application image beyond Milestone 10's committed
worker-concurrency support and database shutdown fix.

## Run from Windows PowerShell

Prerequisites: Node.js, dependencies, k6, OpenSSH, and noninteractive access to
the existing VPS. The VPS needs Python 3, K3s, working metrics-server, and the
existing `ghcr-credentials` pull Secret. Python is orchestration only; the
database observer executes Node.js inside the relay Pod with its existing
database environment. Database credentials never leave the VPS.

The local runner and remote observer use JavaScript. The small Python controller
uses only the standard library to coordinate Kubernetes subprocesses, stream
observations, hold the Linux release lock, and restore settings when SSH input
closes. It is transmitted at runtime and is separate from the application.
Its configuration-preservation and cleanup checks run locally without Kubernetes:
`python load/vps-controller.test.py`.

```powershell
$env:VPS_SSH_TARGET = Read-Host 'Existing SSH destination (user@host or alias)'
$env:VPS_SSH_KEY = Read-Host 'Existing SSH private key path'
$env:VPS_RELEASE_COMMIT = Read-Host 'Full deployed commit SHA'
npm run benchmark:vps -- baseline
npm run benchmark:vps -- suite
```

The harness starts its own loopback Kubernetes API port-forward on the VPS and
SSH tunnel on the PC. No application or metrics listener is published publicly.
The only local server is the lightweight request/timing observer forwarding k6
requests across that tunnel; business delivery work stays on the VPS.

Profiles match [the local guide](load-testing.md). Individual runs accept the
same `BENCH_RATE`, `BENCH_SECONDS`, `BENCH_CONCURRENCY`, and `BENCH_REPLICAS`
overrides. The full suite keeps fixed comparison settings. Remote API p95 has
an explicit default guard of 1000 ms, configurable with `API_P95_MS`; this includes
network and tunnel time and is not a production SLO.

## Evidence and measurement boundaries

Output: `.tmp/vps-benchmarks/<timestamp>-<profile>/`. Reports include the actual
VPS CPU/RAM and workload resource requests/limits, selected image references,
original settings, k6 summaries, run-scoped database/outbox/queue samples, raw
Node metrics, K3s Pod CPU/memory samples, and restoration status. No actual SSH
destination, public IP, private key path, database password, or Pod IP is saved.

API latency includes the PC-to-VPS network, SSH, Kubernetes port-forward, and
the HTTP response body. Delivery latency uses the same PC monotonic clock for
API acknowledgment and receiving a committed database observation streamed from
the VPS. It includes polling and return-network delay. Actual maximum observation
intervals are recorded; observer restarts when worker configuration changes can
lengthen them. Persisted wall-clock timestamps are not used for latency.

The database observer and receiver proxy add VPS work. K3s resource metrics use
their own sampling window and may miss bursts. Comparing a delayed receiver at
concurrency one and four isolates a useful worker bottleneck; the full-run
delivery rate also includes relay publication and drain time. These short tests
do not establish maximum sustainable RPS.

## Restoration

The remote controller holds the same release lock as `deploy-release.sh` for
the session. It restores API receiver configuration and worker settings both
on normal completion and when its SSH input closes. Fixture resources carry a
session ownership label; cleanup refuses resources owned by another session.
The selected application release remains deployed after benchmarking.

If a run cannot drain, settings are restored but the receiver fixture is retained
while immutable delivery snapshots still point at it. The run exits unsuccessfully
and records that condition; let those jobs drain before removing the fixture.
The original settings are recorded in metadata.json. Inspect an interrupted
session before starting another benchmark or release. Do not delete application
storage, retained queue jobs, or event history to make a test pass.

## Verification record

Application release `8c817589dc58ffc6966e33cf49e535ee72c57dee` passed CI and was
deployed with digest
`sha256:8130f3a2f85e9ed80a812819c7988cd2398f1b6c2fbd24e2b2f619a1149c8d81`,
after a verified off-server database backup. Migration, all four rollouts,
readiness, fresh delivery, and retained historical event effects passed.

The main suite accepted 582 events, delivered 567, and intentionally exhausted
15, with 623 attempts and 567 receiver effects. All ten scenarios and three
supplemental runs passed; no k6 iterations were dropped. At 20 incoming events/s,
API p95 was 52.86 ms, whole-run delivery was 8.03 events/s, and the unpublished
outbox peaked at 201. Equal 40-job repeat recovery improved from 24.87 seconds
at concurrency one to 10.83 seconds at concurrency four, approximately 2.30×.

Final verification found zero pending events, all six application/storage Pods
ready, the original one worker/default concurrency and receiver destination
restored, and no benchmark fixture resources. Fresh post-benchmark event
`ccaa9d4e-41f9-4f01-b0e1-605d4a0d6c0d` delivered with HTTP 204. The selected
application release remained deployed at milestone 11 verification; milestone
12 subsequently advanced it to the tuned release below. Raw evidence directories and all numeric
checks are recorded in the linked report/results.

## Following milestone: relay tuning

Milestone 12 is complete; see [relay tuning](relay-tuning.md) and its
[comparison report](relay-tuning-report.md). It added bounded, validated relay batch/schedule settings
while retaining one relay and existing delivery/reconciliation guarantees.
The VPS comparison used the same worker concurrency and resources for the
legacy and tuned schedules. The repeated 20 events/s pressure case and longer
steady-ingress runs recorded outbox growth, delivery p95/p99, CPU/memory,
database activity, and recovery. All acceptance, attempt/effect, and draining
checks passed. Future tuning should preserve those comparison conditions.
Do not infer a production capacity limit from the short milestone 11 runs.
