# Milestone 11: VPS benchmark report

Milestone 11 was verified on 2026-10-01. The committed application release was
deployed to the existing VPS, and all ten load scenarios passed with k6 running
on the local PC. The suite accepted **582 events**, delivered
**567**, and intentionally exhausted **15**.
It recorded 623 attempts and 567 receiver effects;
each successful event had exactly one effect. No k6 iterations were dropped.
Numeric results, all checks, supplemental runs, release evidence, and resource
peaks are in [vps-benchmark-results.json](vps-benchmark-results.json).

## Release and data verification

- Application commit: `8c817589dc58ffc6966e33cf49e535ee72c57dee`.
- All four applications use `ghcr.io/peterculazh/hookrelay:sha-8c817589dc58ffc6966e33cf49e535ee72c57dee@sha256:8130f3a2f85e9ed80a812819c7988cd2398f1b6c2fbd24e2b2f619a1149c8d81`.
- [CI run 36760176540](https://github.com/Peterculazh/hookrelay/actions/runs/36760176540)
  completed successfully before deployment.
- Before deployment, custom-format backup `backup-RTy7oOqy` (12933 bytes)
  was copied outside the repository to the local backup directory. Its SHA256
  matched: `8ea6a6e22c0bc7375e12fe3f041df64c39f74159ce05b733340e86f5988019da`. The archive listing was readable; this new dump
  was not separately restored. The earlier restore exercise is recorded in
  [database backup and restore](database-backup-restore.md).
- Migration Job `hookrelay-migrate-8c817589dc58ffc6966e33cf49e535ee72c57dee` completed, followed by
  successful receiver, API, worker, and relay rollouts.
- Readiness returned HTTP 200; fresh smoke event
  `3d51bb35-61ae-4e46-a9c8-3a7c9b07eda5` delivered with HTTP 204.
  The three saved historical events remained delivered, with one successful
  attempt and one receiver effect each.
- Original worker settings and API destination were restored. Owned benchmark
  resources were removed, pending work drained, and the fresh post-benchmark
  smoke event `ccaa9d4e-41f9-4f01-b0e1-605d4a0d6c0d` delivered with HTTP 204. The application remains
  on this release; all six application/storage Pods were ready at the final check.

## Conditions

- VPS: 2 logical CPUs, Intel Core Processor (Haswell, no TSX),
  3.73 GiB reported RAM; K3s v1.36.4+k3s1.
- Local generator: Node.js v26.8.1; k6.exe v0.51.0 (commit/33d3caa7d1, go1.22.3, windows/amd64).
- Network path: local k6 → local timing gateway → SSH tunnel → Kubernetes
  loopback port-forward → VPS API. All business processing and storage run remotely.
- API, worker, relay: CPU request 100m, memory request 128 MiB, memory limit 256 MiB.
  Receiver: CPU request 50m, memory request 64 MiB, memory limit 256 MiB.
  PostgreSQL: CPU request 100m, memory request 128 MiB, memory limit 512 MiB.
  Redis: CPU request 50m, memory request 64 MiB, memory limit 256 MiB.
  These workloads have no configured CPU limits and share the VPS CPUs.
- Controlled receiver proxy: CPU request 50m, memory request 32 MiB, memory limit
  128 MiB. The remote observer has one database connection and runs inside the
  relay Pod; both add load to the VPS.
- One relay, fixed 100-event batch per ten-second tick. Workers normally run with
  one replica and concurrency one; each scenario records its temporary settings.
- Remote API p95 guard: 1000 ms, including network overhead.
  This is a benchmark guard, not a production SLO.

## Suite results

All rows passed acceptance, expected attempt outcomes, effect counts, resource
collection, and API/relay/worker metrics checks. Latency percentiles use nearest
rank from the client observations; k6 summaries use their own interpolation.

| Scenario            | Accepted | Delivered / failed | API p95 ms | Delivery p95 s | Delivered/s over whole run | Drain s | Recovery s | Peak outbox |
| ------------------- | -------: | -----------------: | ---------: | -------------: | -------------------------: | ------: | ---------: | ----------: |
| baseline            |       51 |             51 / 0 |      57.65 |           9.77 |                       4.13 |    0.53 |          — |          48 |
| slow-serial         |       40 |             40 / 0 |      51.80 |          17.89 |                       1.38 |   17.53 |          — |          29 |
| slow-concurrency    |       41 |             41 / 0 |      60.11 |          10.22 |                       2.28 |    6.33 |          — |          30 |
| slow-replicas       |       41 |             41 / 0 |      53.06 |          11.02 |                       1.85 |   10.35 |          — |          29 |
| retry               |       11 |             11 / 0 |      87.03 |          14.92 |                       0.52 |   14.21 |          — |          10 |
| failure             |       11 |             0 / 11 |      67.69 |              — |                       0.00 |   22.41 |          — |           6 |
| timeout             |        4 |              0 / 4 |      64.59 |              — |                       0.00 |   54.38 |          — |           3 |
| backlog-serial      |       41 |             41 / 0 |      52.14 |          28.99 |                       1.01 |   28.74 |      26.66 |          31 |
| backlog-concurrency |       41 |             41 / 0 |      50.75 |          18.00 |                       1.75 |   11.84 |      11.58 |          37 |
| relay-pressure      |      301 |            301 / 0 |      52.86 |          16.10 |                       8.03 |   20.77 |          — |         201 |

Slow receivers delay each request by 500 ms. Retry cases return controlled HTTP
503; exhaustion records exactly three failed attempts per event. Timeouts delay
11 seconds beyond the worker's ten-second timeout, record three `TIMEOUT`
attempts, and create no receiver effects. Failure percentiles and API/delivery
p99 values are retained in the results JSON.

## Worker recovery and publication

The published-backlog cases pause workers during admission, wait for every
outbox record to publish, then measure from the worker restart command to the
last observed completion. Serial recovery drained 41 jobs
in 26.66 seconds; concurrency four drained
41 in 11.58 seconds.
With equal counts, concurrency four was 2.30× faster, including rollout and observer restart time.

Supplemental backlog-serial: 40 jobs, recovery 24.87 seconds. Evidence: `.tmp/vps-benchmarks/2026-10-01T08-10-29-978Z-backlog-serial`.

Supplemental backlog-concurrency: 40 jobs, recovery 10.83 seconds. Evidence: `.tmp/vps-benchmarks/2026-10-01T08-11-33-942Z-backlog-concurrency`.

The equal-count repeat confirms approximately 2.30× faster recovery at
concurrency four, with the same worker resources.

At offered ingress 20 events/s, 301 were accepted,
API p95 was 52.86 ms, and the unpublished outbox peaked at 201. All delivered after draining. The completed-delivery
rate across admission and drain was **8.03 events/s**.
The relay's 100-per-ten-second schedule implies a publication ceiling near ten
events/s before overhead; extra worker concurrency does not remove that limit.
The next milestone is bounded relay batch/schedule tuning, with repeat VPS tests
at unchanged worker settings and resource allocations.

## Resource samples and limits

Sampled maxima below are per Pod, across the suite; CPU and memory maxima may
come from different times. Two worker replicas therefore do not have their
CPU/memory summed in this table.

| Workload                     | Maximum sampled CPU, millicores | Maximum sampled memory, MiB |
| ---------------------------- | ------------------------------: | --------------------------: |
| postgres                     |                           30.00 |                       63.00 |
| redis                        |                            9.00 |                       12.00 |
| relay                        |                           68.00 |                       83.00 |
| test-receiver                |                           22.00 |                       44.00 |
| worker                       |                          359.00 |                       56.00 |
| hookrelay                    |                          278.00 |                       53.00 |
| hookrelay-benchmark-receiver |                           17.00 |                       25.00 |

Database connections peaked at 13.
Raw database counters, lock-wait samples, queue depth, Node metrics, and K3s
Pod samples are retained with the evidence. These samples can miss short peaks
and do not establish a CPU, memory, or database saturation limit.

API timings include the PC-to-VPS network, SSH, Kubernetes forwarding, and
reading the HTTP response. Delivery timings start at the API acknowledgment
and finish when a committed database snapshot arrives on the PC's same
monotonic clock. They include polling and return-network delay; they are upper
bounds on acknowledgment-to-completion time. The observer normally waits 500 ms
between polls; metric scraping and worker/observer restarts lengthen intervals.
The largest observed interval was 7.58 seconds.

These short runs verify the pipeline and expose a publication bottleneck;
they do not establish maximum sustainable production RPS. Local and VPS results
use different CPUs, resource allocations, network paths, and startup behavior,
so they should not be treated as a direct hardware speed comparison.

Raw suite evidence: `.tmp/vps-benchmarks/2026-10-01T08-04-07-784Z-suite/`. Original settings,
images, hardware, k6 summaries, observations, resource samples, and successful
restoration are preserved. Actual SSH destinations, public/Pod IPs, private-key
paths, and database credentials are excluded.
