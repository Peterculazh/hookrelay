# Milestone 10 benchmark report

Milestone 10 was verified locally on 2026-09-30. All ten k6 scenarios passed.
Increasing worker concurrency from one to four reduced recovery time for the
same 41-job published backlog from **25.62 seconds to 11.36 seconds** in the
repeat comparison: **2.25× faster**, including worker startup, with the same
one-CPU / 512 MiB worker limit.

The main suite accepted 582 events: 567 were delivered and 15 intentionally
failed. It recorded 623 attempts and 567 receiver effects. Every k6 iteration was
accepted, with zero dropped iterations. Three additional repeat/configuration
runs passed. Numeric results and checks are preserved in
[benchmark-results.json](benchmark-results.json); commands and measurement
details are in [load-testing.md](load-testing.md).

## Conditions

- Windows host: AMD Ryzen 7 5700X3D, 16 logical CPUs, 63.91 GiB RAM.
- Docker Desktop engine 29.8.0: 16 CPUs, approximately 31.3 GiB VM memory.
- Host Node.js 26.8.1; application image uses Node.js 24.21.0.
- k6 0.51.0; local loopback ingress with a monotonic forwarding observer.
- Base commit: `f7d81c606333f528eda4fb7e9961b13c3f0b1cba`, plus the uncommitted
  milestone implementation. The tested application image ID is recorded in the
  results JSON. API, relay, receiver, and workers used that same image.
- Each application container: one CPU, 512 MiB, ten-connection database pool.
  PostgreSQL: two CPUs / 512 MiB. Redis and receiver proxy: one CPU / 256 MiB each.
- A single relay publishes at most 100 events per ten-second tick. Worker counts
  and concurrency are scenario-specific. k6 and the observer run on the host.
- Dedicated Compose project `hookrelay-load` with its own persistent volumes.

## Main suite

Delivery latency is measured from the API acknowledgment to observing a committed
delivered state. Times below include polling delay. Failure cases have separate
terminal-failure percentiles in the results JSON.

| Scenario                                | Accepted | Delivered / failed | API p95 ms | Delivery p95 s | Drain after ingress s | Peak unpublished outbox |
| --------------------------------------- | -------: | -----------------: | ---------: | -------------: | --------------------: | ----------------------: |
| Healthy baseline                        |       51 |             51 / 0 |      22.24 |          11.45 |                  6.59 |                      26 |
| Slow, one worker, concurrency 1         |       41 |             41 / 0 |      21.30 |          19.49 |                 18.50 |                      34 |
| Slow, one worker, concurrency 4         |       41 |             41 / 0 |      21.42 |           9.51 |                  4.99 |                      28 |
| Slow, two workers, concurrency 1 each   |       41 |             41 / 0 |      20.63 |           9.88 |                  9.20 |                      31 |
| One controlled failure, then retry      |       11 |             11 / 0 |      24.14 |          12.79 |                  6.99 |                      11 |
| Three controlled failures               |       11 |             0 / 11 |      21.03 |              — |                 17.25 |                      11 |
| Receiver timeout                        |        4 |              0 / 4 |      19.71 |              — |                 47.67 |                       4 |
| Paused workers, resume at concurrency 1 |       41 |             41 / 0 |      21.10 |          34.20 |                 33.98 |                      35 |
| Paused workers, resume at concurrency 4 |       40 |             40 / 0 |      22.15 |          24.54 |                 18.48 |                      35 |
| Relay pressure, 20 events/s             |      301 |            301 / 0 |      21.23 |          19.37 |                 18.58 |                     181 |

The slow cases inject 500 ms per receiver request. Retry failures return HTTP 503.
The timeout case injects 11 seconds, beyond the worker's ten-second timeout.
Successes were HTTP 204. Exhaustion cases each recorded exactly three failures,
and the timeout case recorded `TIMEOUT`, with no simulated receiver effects.

## Controlled tuning comparison

Workers were paused during admission. The harness waited until every event was
published, then measured from worker startup to the last observed completion.
This removes the relay's cron phase from the drain comparison. It still includes
application startup and database observation delay.

| Run        | Concurrency 1: jobs / recovery | Concurrency 4: jobs / recovery |
| ---------- | -----------------------------: | -----------------------------: |
| Main suite |                   41 / 25.75 s |                   40 / 10.82 s |
| Repeat     |                   41 / 25.62 s |                   41 / 11.36 s |

The repeat uses equal counts and confirms the improvement. Serial execution is
the bottleneck for this delayed, I/O-bound receiver workload. Four concurrent
requests hide some of the receiver wait time. Database connections peaked at
six for the serial case and twelve for the parallel case in the main suite, so
parallelism has a resource cost even though the worker CPU/memory limits match.

The live-ingress slow comparison also reduced delivery p95 from 19.49 to 9.51
seconds. Two workers improved delivery too, with twice the worker CPU/memory
allocation and separate database pools. The short runs do not establish an
optimal production concurrency or replica count.

## Publication bottleneck

With a healthy receiver and four concurrent deliveries, ingress at 20 events/s
still grew the unpublished outbox to 181 records. API p95 stayed around 21 ms,
while delivery p95 reached 19.37 seconds. The relay's fixed 100-event batch per
ten-second tick limits sustained publication to roughly ten events/s before
overhead. Additional worker concurrency cannot remove that publication limit.

This identifies the next tuning target if higher sustained ingress is needed:
relay batch scheduling/publication. Multiple relays still require coordination.
No database or Node CPU saturation limit was established by these short tests.

## Evidence and limits

The main raw evidence is in
`.tmp/benchmarks/2026-09-30T17-59-52-842Z-suite/`. Repeated recovery evidence is in
the `2026-09-30T18-06-45-905Z-backlog-serial` and
`2026-09-30T18-07-45-871Z-backlog-concurrency` directories. A custom baseline
at two events/s for two seconds, with two workers and concurrency four, also
passed in `2026-09-30T18-08-30-774Z-baseline`. Each directory retains k6 summaries,
logs, database/backlog samples, Docker CPU/memory samples, and Node/queue metrics.

The observer polls every 500 ms. The largest observed interval in the main suite
was 578.18 ms; latency is an upper bound on committed completion after the API
acknowledgment. API timings include forwarding to the API and reading its body.
k6 HTTP timings also include the observer gateway. Sampling adds load and can
miss brief resource spikes. One resumed worker had a recorded metrics startup
gap and subsequently produced valid metrics; all required endpoints were
collected and no post-startup collection errors occurred.

Persisted wall-clock timestamps are not used for latency. No reversed attempt
timestamps appeared in the measured suite; the historical clock issue remains
unresolved. Cron phase, application startup, small sample sizes, and background
host activity affect individual numbers. These are local learning benchmarks,
not a VPS capacity claim. Rebuild after application changes and repeat the
comparison before choosing deployment settings.

## Validation

Lint, typechecking, all 66 unit tests, the Docker application build, all ten
benchmark scenarios, both repeated backlog cases, and the custom load/replica
run passed. The existing graceful-shutdown probe also passed with info-level
logs: active delivery drained, the next job stayed queued during shutdown, and
that job completed after restart. The database module's duplicate pool-close
provider was removed; module shutdown now closes the shared pool once, verified
by a regression test and the real container shutdown check. Benchmark containers
were stopped after verification; volumes and raw evidence remain available.
