# Milestone 14: worker concurrency and delivery timings

Status: implementation and local checks complete; preliminary harness checks
are running against the existing release. Instrumented-release deployment,
paired phase-timing comparisons, and longer confirmation are pending.

Milestone 13 verified 75 incoming events/s for two minutes with one worker at
concurrency one. At 80–100 events/s, deliveries accumulated after publication.
This milestone compares concurrency one and four at 85 and 100 incoming
events/s on the same deployed application image and VPS resources, then repeats
the better configuration for five minutes at a bounded rate. Do not assume a
fourfold gain or adopt a setting from acceptance throughput alone.

## Instrumentation

The worker retains its existing webhook-to-response-header histogram and adds:

- `hookrelay_delivery_database_duration_seconds{phase,outcome}`: phases
  `attempt_start` and `finalize`; outcomes `completed` and `error`. These timers
  cover the database operation including transaction commit.
- `hookrelay_delivery_processing_duration_seconds{outcome}`: complete processor
  invocation, including database/HTTP work and local overhead, excluding queue
  waiting and BullMQ's post-processor acknowledgment. Outcomes distinguish a
  completed invocation from an error that BullMQ may retry.

All timers use the monotonic process clock. Labels are bounded; event IDs and
URLs are not metric labels. A successful receiver response followed by failed
database finalization remains a successful receiver metric, an errored database
operation, and an errored processor invocation. Delivery/retry/deduplication
and transaction boundaries remain unchanged.

The benchmark takes a metrics baseline before ingress and a forced sample
after draining. It computes per-Pod counter/histogram deltas, allowing a new
worker Pod to start at zero. Reports include mean durations and p95 histogram
bucket upper bounds, not exact duration percentiles. Set
`BENCH_REQUIRE_TIMINGS=1` to require instrumented phase counts to match the
observed attempt and delivery counts.

## Observer overhead

The VPS observer collects counters and terminal IDs from one consistent
PostgreSQL statement, then sends aggregate snapshots and only newly completed
IDs/statuses over SSH. It retains the last terminal status so an observer
restart or a later status change remains visible. The client handles a terminal
observation arriving before HTTP acknowledgment: already-complete delivery has
zero delay after acknowledgment and is counted explicitly.

Aggregate queries and terminal-ID collection still scan run-scoped data. This
reduces repeated per-event subqueries and SSH traffic; it does not make polling
constant-cost. The first sample and later samples retain the same monotonic
acknowledgment-to-observation timing boundaries. Histories generated with the
older observer remain historical evidence, not an identical paired baseline.

## Queue isolation for longer tests

The original Redis contains retained completed jobs from earlier milestones.
It was using 78,176,576 bytes out of a 134,217,728-byte memory limit before this
milestone. Adding a comparison sweep plus five-minute load would consume much
of that budget without indicating a worker throughput limit.

`BENCH_ISOLATE_REDIS=1` creates a session-owned Redis Deployment, Service, and
PVC with the existing Redis image, server arguments, resource allocations, and
storage-class/request settings. The controller temporarily redirects the relay
and worker, while the API uses the owned receiver proxy. The original Redis
continues running with its queue history intact. Both sides of a comparison
use this same isolation; the extra idle original Redis and fixture resources
remain part of VPS resource consumption. This differs from milestone 13's
populated production queue and must be recorded in comparisons.

Restoration stops fixture ingress and enables a worker to drain the isolated
queue before reinstating the original Redis host entries, relay settings, and
worker concurrency/replicas. Owned Redis/receiver resources are removed after
pending fixture deliveries reach zero. If the bounded recovery wait expires,
fixtures and their Redis routing remain available for recovery; the result
reports `restored: false` and `fixtureRetained: true`. Check `restoration.json`
before another run. Ownership checks refuse deletion of another
session's resources. Application PostgreSQL data, receiver effects, and the
original Redis history are retained. The fixture PVC is disposable test data.

Observer failures include a sanitized phase/error code and exit status.
Failed runs preserve their last aggregate snapshot, errors, and samples in
`failed-observation.json`; they are excluded from capacity conclusions.

## Run the comparison from the local PC

Use runtime SSH connection values and the digest-pinned deployed commit from
the [VPS guide](vps-load-testing.md). Deploy the successful CI instrumentation
release through the existing backup and exact-release procedure first. Keep
one relay at batch 100 every second, one worker replica, and existing limits.

```powershell
$env:BENCH_ISOLATE_REDIS = '1'
$env:BENCH_REQUIRE_TIMINGS = '1'
$env:BENCH_SECONDS = '60'
$env:BENCH_RATE = '85'
$env:BENCH_CONCURRENCY = '1'
npm run benchmark:vps -- relay-steady
$env:BENCH_CONCURRENCY = '4'
npm run benchmark:vps -- relay-steady

$env:BENCH_RATE = '100'
npm run benchmark:vps -- relay-steady
$env:BENCH_CONCURRENCY = '1'
npm run benchmark:vps -- relay-steady

# Select the rate from the paired results before confirming it.
$env:BENCH_CONCURRENCY = '4'
$env:BENCH_SECONDS = '300'
npm run benchmark:vps -- relay-steady
```

The remote runner accepts durations 1–600 seconds. Durations above 120 seconds
require isolated Redis, and an isolated case is capped at 50,000 offered events.
The local Compose runner retains its 120-second bound. Paired runs use matching receiver/payload settings,
generator allocation, release, resources, relay settings, and isolation mode.
Require every attempt/effect, timing, resource, and draining check to pass;
evaluate backlog growth separately from eventual draining. Record any failed
run and repeat it only after the cause is understood and cleanup is verified.

Finish with original settings restored, fixture resources and forwarding
removed, all workloads ready, historical effects intact, and a fresh delivery.
Choose further database changes from timings/query plans, rather than adding
indexes or changing transaction semantics during the concurrency comparison.
