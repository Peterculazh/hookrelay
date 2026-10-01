# Preliminary worker concurrency results

Measured on 2026-10-01 against the existing release `8290734d2df271206510cffa41ab2558be4277d2`.
Concurrency four improved delivery at equal offered rates. The five-minute
confirmation is recorded below. These runs validate the configuration change
on that release; the new database/processor timing metrics still need a
published instrumented release. Milestone 14 remains in progress.

See the [run guide](worker-concurrency.md) and [numeric evidence](worker-concurrency-results.json).

## Valid comparisons

| Offered/s | Concurrency | Load s | Delivered | Steady deliveries/s | API p95 ms | Delivery p95 s | Drain s | Steady pending start → end | Peak pending |
| --------- | ----------: | -----: | --------: | ------------------: | ---------: | -------------: | ------: | -------------------------- | -----------: |
| 85        |           1 |     60 |      5100 |               72.73 |      65.96 |          14.79 |   10.68 | 733 → 1226                 |         1226 |
| 85        |           4 |     60 |      5101 |               84.55 |      74.10 |           2.01 |    0.51 | 75 → 36                    |          144 |
| 100       |           4 |     60 |      6000 |              104.68 |     128.38 |           4.02 |    0.80 | 315 → 104                  |          357 |
| 100       |           1 |     60 |      6000 |               78.28 |      63.82 |          16.58 |   14.14 | 733 → 1568                 |         1638 |
| 100       |           4 |    300 |     30001 |              100.15 |      86.47 |           3.82 |    1.45 | 267 → 185                  |          303 |

All accepted events in these valid rows completed with one HTTP 204 attempt and
one durable receiver effect, with no failed requests or dropped iterations.
An offered-load test establishes behavior at its tested rate/duration, not
maximum production capacity. A steady delivery rate above the offered rate
means earlier queued work was catching up during that observation window.

In the five-minute run, mean pending work in minutes three through five was
223.81 → 217.72 → 212.84, while mean unpublished outbox was
210.51 → 185.60 → 168.61.
Delivery averaged approximately 100/s in each of those minutes. Whole-window
least-squares slopes were slightly positive (pending +0.30/s,
outbox +0.31/s) because the run transitioned from initial
bursts to a larger publication buffer. The later minutes did not show a
continuing rise. This supports bounded behavior during this five-minute test;
it does not demonstrate hours of endurance or spare relay headroom at 100/s.

The steady window excludes the first 20 seconds after k6 launch and ends at
the last sample before k6 exits. Pending/outbox/queue counts are sampled;
completion latency includes observation polling and SSH/network transit.
The same image, CPU/memory allocations, one relay at batch 100 every second,
one worker replica, default payload, and healthy receiver were used. Redis was
fresh and isolated per run; the original Redis and its retained queue history
remained running. This differs from milestone 13's populated original queue
and older observer, so the paired rows above are the appropriate controls.
Application PostgreSQL history continued accumulating between runs.

## Failed runs and regression checks

- preliminary-85-serial: Observer is not running. Cleanup restored the original settings and removed fixtures. Excluded from performance conclusions.
- diagnostic-85-serial: Final metrics unavailable. Cleanup restored the original settings and removed fixtures. Excluded from performance conclusions.
- preliminary-100-concurrent: Observer failed during ingress; Observer snapshot failed (Error: unspecified). Cleanup restored the original settings and removed fixtures. Excluded from performance conclusions.

The observer exits/final-scrape failure were intermittent. A completed-run
observer query took 69.73 ms in EXPLAIN ANALYZE, but that does not explain every
failure under load. Sanitized phase/error diagnostics, failed-observation
snapshots, and exit codes are retained; no specific hardware or database cause
is claimed. The 20-second 100 RPS diagnostic passed but is excluded from the
capacity comparison because it has essentially no steady window.

The complete ten-scenario harness regression accepted 580 events, delivered
566, and intentionally exhausted 14, with 618 attempts and 566 effects.
The separate initial baseline delivered 51 events. Retry, HTTP exhaustion,
timeout, concurrency/replicas, backlog recovery, and relay-pressure checks
passed. The isolated-queue recovery guard now drains pending fixture work
before restoring Redis routing; if recovery times out, it retains the worker's
fixture routing and reports incomplete restoration.

## Resource observations

| Offered/s × load s | Concurrency | PostgreSQL peak CPU m / MiB | Worker peak CPU m / MiB | Relay + observer peak CPU m / MiB | Maximum observation gap s |
| ------------------ | ----------: | --------------------------: | ----------------------: | --------------------------------: | ------------------------: |
| 85 × 60            |           1 |                359 / 313.00 |             469 / 59.00 |                       267 / 91.00 |                      1.10 |
| 85 × 60            |           4 |                459 / 348.00 |             483 / 60.00 |                       113 / 91.00 |                      1.30 |
| 100 × 60           |           4 |                468 / 354.00 |             496 / 61.00 |                       218 / 89.00 |                      1.41 |
| 100 × 60           |           1 |                416 / 341.00 |             450 / 60.00 |                       355 / 90.00 |                      1.85 |
| 100 × 300          |           4 |                580 / 372.00 |             487 / 63.00 |                      140 / 105.00 |                      1.97 |

K3s samples are periodic and may miss brief peaks; separate workload maxima
are not simultaneous whole-machine utilization. The receiver proxy, isolated
Redis, idle original Redis, and observer also consume VPS resources. These
measurements do not prove hardware exhaustion or identify the database phase
that dominates. Existing HTTP histograms are available; new database/processor
histograms are absent on this release and their validation was not enabled.

## Implementation validation

Local validation passed: 83 application unit tests, typecheck, lint, builds of
all applications, nine release guards, eight controller tests, and six
observer/timing helper tests. CI publication and its container reliability
checks remain pending the authenticated terminal push.

## Final state and remaining deployment

Original worker/relay/Redis/API settings are restored. All six workloads are
ready, no test fixtures or forwarding processes remain, and global pending
events/unpublished outbox are zero. Historical delivered events and a fresh
delivery retained one HTTP 204 attempt and one effect. Numeric evidence includes
the direct database audit of every run, including invalid observer runs.

The new instrumentation and benchmark support are committed locally. Publish
the current branch with `git push origin main`, wait for all CI/reliability
checks and GHCR publication, then deploy that exact digest-pinned release with
a fresh verified backup. Repeat the paired phase-timing comparison using
`BENCH_REQUIRE_TIMINGS=1` before marking the milestone complete.
The versioned worker manifest selects `WORKER_CONCURRENCY=4`; the VPS is
currently restored to its original concurrency-one release pending deployment.
