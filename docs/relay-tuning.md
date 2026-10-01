# Milestone 12: relay batch and schedule tuning

Status: implementation complete; local integration, CI, and VPS verification
in progress. The [milestone 11 VPS report](vps-benchmark-report.md) established
the baseline: 20 incoming events/s grew the outbox to 201, with whole-run
delivery 8.03 events/s and delivery p95 16.10 seconds.

## Implementation

The single relay now accepts `RELAY_BATCH_SIZE` (integer 1–1000, default 100)
and `RELAY_PUBLISH_INTERVAL_SECONDS` (integer 1–60 that divides 60 evenly,
default 10). Allowed intervals are 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, and 60
seconds. These produce uniform cron schedules rather than irregular minute
boundaries. Invalid values stop startup. Settings are read at startup; changing
them requires restarting the relay.

Application and Compose defaults retain the previous 100-per-ten-second
behavior. The Kubernetes relay manifest selects a 100-event batch every second.
It retains one replica, `Recreate`, and the existing resource requests/limits.
Publication batches cannot overlap, and shutdown drains an active batch.
Transactional outbox locks, enqueue-before-mark ordering, deterministic job IDs,
retry policy, and receiver deduplication remain in place. Reconciliation retains
its existing ten-second schedule and 100-event scan size.

The benchmark controller can temporarily change both relay settings in one
rollout. It records the effective settings, preserves unrelated container
configuration, and restores the original environment entries on completion or
SSH input closure. Workers and resources are kept constant for comparisons.

## Compare on the VPS from the local PC

Deploy the successful CI image with the existing exact-release process after
a fresh off-server backup. Set connection values only in runtime environment
variables as described in [the VPS guide](vps-load-testing.md).

```powershell
$env:BENCH_RELAY_BATCH_SIZE = '100'
$env:BENCH_RELAY_INTERVAL_SECONDS = '10'
npm run benchmark:vps -- relay-pressure
npm run benchmark:vps -- relay-steady

$env:BENCH_RELAY_INTERVAL_SECONDS = '1'
npm run benchmark:vps -- relay-pressure
npm run benchmark:vps -- relay-pressure
npm run benchmark:vps -- relay-steady
```

`relay-pressure` offers 20 events/s for 15 seconds. `relay-steady` offers the same
rate for 60 seconds. Both use one worker with concurrency four. The longer
profile also records observed completed-delivery rate and outbox counts during
the admission window after excluding the first 20 seconds. Polling and network
delay still apply; recorded observation-window duration is included.

Require all acceptance, attempt/effect, monitoring, and draining checks to pass.
Compare outbox growth and delivery p95/p99 at identical offered rate, worker
configuration, and resources. Record API p95, database activity, Pod CPU/memory,
and post-benchmark readiness/delivery. These runs establish behavior at the
tested rate and duration; they do not establish maximum production capacity.

For an isolated local regression with the tuned schedule:

```powershell
$env:BENCH_RELAY_BATCH_SIZE = '100'
$env:BENCH_RELAY_INTERVAL_SECONDS = '1'
npm run benchmark:suite
```

## Verification

Pending the CI release and remote comparison. Unit checks cover configuration
bounds, configured batch selection, non-overlap, shutdown, publication failures,
and retry IDs. Controller tests cover preserving container fields, restoring
relay settings, and fixture ownership/pending-work cleanup.
