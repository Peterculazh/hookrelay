# Load testing and tuning

This guide records Milestone 10's local baseline. Milestone 11's
[VPS deployment and remote load testing](vps-load-testing.md) is also complete,
with k6 on the PC and the application pipeline on the VPS. Relay tuning follows
these measurements.

Milestone 10 uses k6 to drive event acceptance independently of delivery, then
observes committed delivery results and queue recovery. The local benchmark
stack is defined in `load/compose.yml`, uses the fixed Compose project
`hookrelay-load`, and has its own PostgreSQL/Redis volumes and random loopback
ports. It does not target the VPS or the normal development stack.

## Run

Prerequisites: Docker Desktop with Linux containers running, Node.js 24, installed
dependencies (`npm ci`), and `k6` on PATH. The scripts are verified with k6 0.51.0;
they do not import remote JavaScript libraries.

From the repository root in PowerShell:

```powershell
npm run benchmark
npm run benchmark:suite
```

The first command builds the application and runs the healthy-receiver baseline.
The second runs all ten scenarios. Once the current application image is built,
skip rebuilding it when repeating measurements:

```powershell
npm run benchmark -- backlog-serial --no-build
npm run benchmark -- backlog-concurrency --no-build
```

For an individual scenario, override its load or worker settings in PowerShell:

```powershell
$env:BENCH_RATE = '10'
$env:BENCH_SECONDS = '30'
$env:BENCH_CONCURRENCY = '4'
$env:BENCH_REPLICAS = '2'
try {
    npm run benchmark -- baseline --no-build
} finally {
    Remove-Item Env:BENCH_RATE, Env:BENCH_SECONDS, Env:BENCH_CONCURRENCY, Env:BENCH_REPLICAS
}
```

Limits are 1–500 events/s, 1–120 seconds, 1–100 concurrency, and 1–4 worker
replicas. The suite uses its fixed comparison settings. k6 0.51 can schedule one
additional iteration at the duration boundary; actual iteration counts are
recorded and every iteration must be accepted with zero drops.

Runs stop only the benchmark project in `finally`; database/queue volumes and
measurement files remain. A failed scenario stops the suite and returns a nonzero
exit code. The next invocation starts the benchmark containers again. Run only
one harness at a time because it owns the fixed project and worker settings.
If a previous run reached its drain deadline, the harness refuses to measure a
new run while old events remain pending. Let that benchmark stack drain first:

```powershell
docker compose -p hookrelay-load -f load/compose.yml up -d --no-build --scale worker=1
```

Then rerun the harness. Its preflight checks that the queue workload has finished.

Reports and evidence are written to `.tmp/benchmarks/<timestamp>-<scenario>/`:

- `report.md`, `metadata.json`, and `results.json`: environment and comparisons.
- Per scenario: `k6.json`, `k6.log`, `result.json`, `samples.json`, `runtime.json`.
- `samples.json`: run-scoped event status, unpublished outbox, effects, attempts,
  database connections, lock waits, transaction/cache/deadlock counters.
- `runtime.json`: container CPU/memory and raw API, relay, and each worker's
  Prometheus metrics, including Node CPU, RSS, heap, and event-loop delay.

## Scenarios

| Scenario              | Events/s × seconds | Receiver                  | Workers × concurrency | Purpose                                     |
| --------------------- | ------------------ | ------------------------- | --------------------- | ------------------------------------------- |
| `baseline`            | 5 × 10             | Healthy                   | 1 × 1                 | Initial API/delivery baseline               |
| `slow-serial`         | 4 × 10             | 500 ms delay              | 1 × 1                 | Worker saturation and queue growth          |
| `slow-concurrency`    | 4 × 10             | 500 ms delay              | 1 × 4                 | Same workload, parallel requests            |
| `slow-replicas`       | 4 × 10             | 500 ms delay              | 2 × 1                 | Independent worker replicas                 |
| `retry`               | 2 × 5              | First request returns 503 | 1 × 4                 | Automatic retry recovery                    |
| `failure`             | 2 × 5              | Three requests return 503 | 1 × 4                 | Terminal failures and exhaustion            |
| `timeout`             | 1 × 3              | 11-second delay           | 1 × 4                 | Ten-second worker timeouts                  |
| `backlog-serial`      | 4 × 10             | 500 ms delay              | Paused, then 1 × 1    | Drain a fully published queue               |
| `backlog-concurrency` | 4 × 10             | 500 ms delay              | Paused, then 1 × 4    | Controlled tuning comparison                |
| `relay-pressure`      | 20 × 15            | Healthy                   | 1 × 4                 | Exceed 100 events per ten-second relay tick |

The receiver proxy runs only in the benchmark network. It injects delay or a
bounded number of HTTP 503 responses per event, then forwards to the real test
receiver. Receiver deduplication and the simulated database effect still use the
real application. Requests whose worker connection has already timed out are
discarded before forwarding. This fixture behavior does not imply that real
receivers cancel business effects when a sender times out.

Successful scenarios require every scheduled event to be acknowledged, delivered,
and have one effect and the expected attempt count. Failure/timeout scenarios
require all events to become failed after three attempts with zero fixture
effects. k6 requires zero dropped iterations, zero failed HTTP requests, all
acceptance checks passing, and API p95 below the local 500 ms guard. This guard is
an explicit benchmark criterion, not a production SLO. Observer and telemetry
errors also fail the scenario.
New worker containers have a 30-second metrics startup allowance; gaps are
recorded separately, metrics must eventually be collected from every worker,
and collection failures after the first successful scrape fail the scenario.
Attempt outcomes must be HTTP 204 on success, HTTP 503 for controlled failures,
and `TIMEOUT` for the timeout case.

## Measurement boundaries

k6 uses a constant arrival rate and submits one event per iteration; it does not
poll delivery inside that iteration. Delivery slowdown therefore cannot silently
reduce offered ingress load. Dropped iterations fail the run; they can indicate
insufficient k6 VUs or rising system latency. See the [k6 arrival-rate and dropped
iteration documentation](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/).

A loopback forwarding observer submits the POST once and timestamps its API
acknowledgment using `performance.now()`. It polls committed event states every
500 ms through a separate, two-connection PostgreSQL pool. Acceptance-to-delivery
latency uses that same monotonic clock and includes observation delay. It is an
upper bound on completion after acknowledgment, not an exact receiver timestamp.
The maximum actual polling interval is recorded per scenario. Raw persisted
`createdAt`/`deliveredAt` or attempt timestamps are not used for latency.

API percentiles in the report include forwarding from the observer to the API
and reading its response. k6's HTTP duration also includes the observer gateway.
Database polling and telemetry add load; repeat runs on otherwise idle hardware.
Failed events have separate terminal-failure percentiles and do not enter delivery
latency distributions. `deliveredPerSecondOverWholeRun` includes publication and
draining; `acceptedPerSecond` covers the configured ingress duration. Drain time
starts after k6 finishes. Recovery time for paused-worker cases starts before
worker startup, once every event is already published to the queue.

Metadata records the Git commit, host hardware, Docker VM resources, and k6
version. The application may include uncommitted changes. Each application
container is limited to one CPU and 512 MiB; PostgreSQL has two CPUs and 512 MiB;
Redis and the proxy have one CPU and 256 MiB. Each application has a ten-connection
database pool. The host-side k6/observer have no container CPU limits.
Instrumented processes use warning-level logs by default. Set `BENCH_LOG_LEVEL`
to `info` when running existing crash/shutdown probes that inspect drain logs.

## Tuning and interpretation

`WORKER_CONCURRENCY` is a startup setting for each worker process: integer 1–100,
default 1. The load Compose file passes `BENCH_CONCURRENCY` to this setting and
the harness recreates workers when the scenario changes it. Increasing it uses
more simultaneous HTTP requests and competes for the per-process database pool.
The ordinary Compose stack accepts `WORKER_CONCURRENCY` from `.env` when its
worker is recreated. Existing crash/graceful-shutdown acceptance scenarios use
one worker with concurrency one; restore that setting before running them.
The relay remains a single process. Its 100-event batch every ten seconds bounds
sustained publication to at most roughly ten events/second before overhead.

Compare `backlog-serial` with `backlog-concurrency` first: both use a nominal
40-event load and a 500 ms receiver delay, isolating the worker drain limit from
the relay's cron phase. Confirm the effect in repeat runs. Then compare the
live-ingress slow scenarios, where varying cron phase can affect latency.

Use `relay-pressure` to distinguish outbox publication backlog from delivery
backlog. If CPU/event-loop delay rises, inspect Node processing; if database
connections or lock waits rise, inspect queries and pool pressure. Raw telemetry
supports those investigations; the short scenarios do not establish a database
or Node saturation limit. Do not infer delivery capacity from fast HTTP 202s.

The historical reversed attempt timestamp remains a separate deferred issue.
Review confirmed that start and finish currently use fresh worker `Date` values,
with supplied dates persisted directly; a clock adjustment remains possible and
has not been proved as the cause. The harness records reversed attempt counts
while avoiding these dates for latency. No schema or historical timestamp data
is rewritten by this milestone.
