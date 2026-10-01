# Milestone 13 VPS capacity results

Verified on 2026-10-01 with traffic generated on the local PC. **75 incoming
events/second is the highest tested rate that stayed bounded**, confirmed for
120 seconds with one worker at concurrency one. Its measured completed-delivery
rate was **74.90/s** in the steady window.
All 9,001 confirmation events delivered with one HTTP 204 attempt and one
durable receiver effect. No requests failed or iterations dropped.

80 events/s was near the observed boundary and accumulated queued work over
120 seconds. 85 and 100 events/s accumulated more. These are finite benchmark
observations, not an exact production maximum or a long-term capacity guarantee.
The [run guide](vps-capacity.md) explains reproduction and interpretation;
[numeric results](vps-capacity-results.json) preserve every run, including the
rejected initial generator run, metadata, resource peaks, and restoration.

## Rates and delivery

All rows use the same application image, batch 100 every second, one relay with
Recreate, one worker at concurrency one, resource allocations, healthy controlled
receiver, and default 256-byte payload padding. Rows are listed in execution order.

| Run                 | Offered/s | Load s | Accepted/delivered | Steady deliveries/s | API p95 ms | Delivery p95 s | Drain s | Peak pending | Interpretation                |
| ------------------- | --------: | -----: | -----------------: | ------------------: | ---------: | -------------: | ------: | -----------: | ----------------------------- |
| 30 RPS              |        30 |     60 |               1801 |               30.13 |      51.32 |           1.47 |    0.15 |           31 | bounded                       |
| 50 RPS initial      |        50 |     60 |               3000 |               50.13 |      53.08 |           1.59 |    0.54 |           57 | generator rejected            |
| 50 RPS repeat       |        50 |     60 |               3001 |               49.85 |      53.50 |           1.57 |    0.19 |           55 | bounded                       |
| 75 RPS short        |        75 |     60 |               4501 |               74.81 |      59.21 |           2.09 |    0.82 |          136 | bounded                       |
| 100 RPS             |       100 |     60 |               6001 |               69.64 |      68.27 |          20.04 |   18.29 |         1923 | backlog growth                |
| 85 RPS              |        85 |     60 |               5101 |               78.55 |      57.10 |           7.61 |    5.58 |          593 | backlog growth                |
| 80 RPS extended     |        80 |    120 |               9600 |               78.38 |      59.74 |           5.92 |    3.63 |          407 | near boundary; backlog growth |
| 75 RPS confirmation |        75 |    120 |               9001 |               74.90 |      62.63 |           3.27 |    0.58 |          193 | bounded                       |

The first 50 RPS run delivered all 3,000 accepted events, but k6 dropped one
scheduled iteration and failed its zero-drop threshold. Its virtual-user
allocation rose from 10 to 11. The harness now preallocates virtual users by
offered rate, bounded to 10–100, rather than allocating them during the run.
The repeat and all subsequent runs had zero drops. The initial run is retained
for transparency and excluded from validated capacity conclusions.

Across all eight runs, 42,006 accepted events
delivered, with 42,006 effects and exactly
one successful attempt each. There were no delivery failures. All runs drained
and restored; seven passed every harness check. The initial 50 RPS run failed
only the k6 check because of its single dropped iteration.

## Where work accumulated

The steady window excludes the first 20 seconds after k6 process launch and
ends at the last observation before k6 exits. Completed-delivery deltas use the
actual recorded observation-window duration. Startup/exit overhead, polling,
and network transit are included. Whole-run throughput includes drain time and
does not establish capacity. Pending means accepted but not terminal; outbox
means not yet committed as published. Queue waiting counts are sampled separately
and can differ from a database snapshot taken earlier in the same poll.

| Run                 | Steady window s | Pending start → end | Outbox start → end | Queue waiting start → end | Pending endpoint growth/s |
| ------------------- | --------------: | ------------------: | -----------------: | ------------------------: | ------------------------: |
| 30 RPS              |           40.82 |                   — |            30 → 17 |                         — |                         — |
| 50 RPS initial      |           40.44 |             42 → 27 |            13 → 26 |                    27 → 0 |                     -0.37 |
| 50 RPS repeat       |           40.48 |             37 → 29 |            19 → 29 |                    13 → 0 |                     -0.20 |
| 75 RPS short        |           41.08 |             69 → 54 |            52 → 35 |                   13 → 12 |                     -0.37 |
| 100 RPS             |           41.05 |          710 → 1913 |           108 → 70 |                597 → 1834 |                     29.30 |
| 85 RPS              |           40.66 |           351 → 593 |            74 → 25 |                 273 → 561 |                      5.95 |
| 80 RPS extended     |          100.85 |           279 → 407 |            79 → 32 |                 222 → 362 |                      1.27 |
| 75 RPS confirmation |          100.81 |            101 → 65 |            26 → 42 |                   68 → 38 |                     -0.36 |

At 100 offered events/s, the outbox remained comparatively small while queued
deliveries grew: pending rose from 710 to 1,913 during the measured window,
and completed delivery averaged 69.64/s. Delivery p95 reached 20.04 seconds;
after ingress stopped, the remaining work drained in 18.29 seconds.
At 85 events/s, delivery averaged 78.55/s and pending rose from 351 to 593.
At 80 events/s for two minutes, delivery averaged 78.38/s and pending rose
from 279 to 407; the first minute was comparatively flat, with a later rise.
This rate is not counted as clearly bounded.

The 75 RPS confirmation completed 74.90 deliveries/s, with pending 101 → 65,
peak pending 193, and final drain 0.58 seconds. It had transient queue bursts,
including a later burst that recovered before the end; delivery p95 was 3.27
seconds compared with 2.09 seconds in the shorter 75 RPS run. Endpoint counts
and finite throughput alone do not prove that hours of load will stay bounded.

The observations point to delivery falling behind after publication under
higher offered load. They do not isolate whether serial worker operations,
database writes, receiver/proxy work, CPU scheduling, or contention dominate.
Increasing offered load reduced observed delivery throughput at 100 RPS;
do not extrapolate a constant delivery ceiling from a single overloaded run.
The nominal relay limit of 100 per one-second batch is not end-to-end capacity.

The first 30 RPS run predates the added saved ingress/pending/queue fields.
Its existing steady-delivery/outbox values and raw samples are preserved.
The numeric sample analysis uses an explicitly marked approximate window for
that row; the later rows use the saved ingress bounds. Least-squares pending
and outbox slopes are included alongside endpoint deltas, since batch phase
and temporary queue bursts affect both.

## Resources and limits

VPS: 2 logical CPUs,
Intel Core Processor (Haswell, no TSX),
3.73 GiB RAM;
K3s v1.36.4+k3s1. API, relay, worker, and receiver retain 256 MiB
memory limits; PostgreSQL has 512 MiB and Redis 256 MiB. There are no configured
application CPU limits. Full requests/limits are in the numeric metadata.

| Run                 | PostgreSQL peak CPU m / memory MiB | Worker peak CPU m / memory MiB | Relay peak CPU m / memory MiB | Max observation interval s |
| ------------------- | ---------------------------------: | -----------------------------: | ----------------------------: | -------------------------: |
| 30 RPS              |                        129 / 66.00 |                    420 / 58.00 |                    59 / 90.00 |                       1.25 |
| 50 RPS initial      |                        209 / 82.00 |                    430 / 60.00 |                    81 / 92.00 |                       1.40 |
| 50 RPS repeat       |                        238 / 81.00 |                    463 / 58.00 |                    96 / 92.00 |                       1.18 |
| 75 RPS short        |                        318 / 91.00 |                    509 / 59.00 |                   104 / 95.00 |                       1.21 |
| 100 RPS             |                        345 / 96.00 |                    512 / 58.00 |                   140 / 98.00 |                       1.46 |
| 85 RPS              |                       341 / 108.00 |                    488 / 59.00 |                   109 / 98.00 |                       1.39 |
| 80 RPS extended     |                       443 / 276.00 |                    352 / 60.00 |                   132 / 98.00 |                       1.41 |
| 75 RPS confirmation |                       501 / 290.00 |                    368 / 59.00 |                   122 / 99.00 |                       1.53 |

Resource maxima are sampled and may come from different timestamps; they can
miss short bursts. PostgreSQL memory rose during the later runs. Test history,
queue records, and receiver effects were retained throughout, so later runs
also operated on a larger data set. Final application Pod restart counts were
zero; PostgreSQL/Redis retained their previously recorded count of one.

The controlled receiver proxy and database observer consume VPS resources.
The observer re-reads and transmits all run-scoped rows, so its cost grows with
the event count; two-minute runs contain about twice the records of one-minute
runs at the same rate. API timing includes network, SSH, Kubernetes forwarding,
and response-body time. Delivery timing uses the PC's monotonic
acknowledgment-to-observation clock and includes polling/return-network delay.
These runs measure the complete benchmark path, not direct public HTTP capacity,
a receiver with real business latency, or a multi-worker deployment.

## Final verification and next work

Application commit remained `8290734d2df271206510cffa41ab2558be4277d2`, with image
`ghcr.io/peterculazh/hookrelay:sha-8290734d2df271206510cffa41ab2558be4277d2@sha256:c80584dddfe5c1d3127c75b05b4c0a26ece7daae89268a0a35d6277e31fe5921`. No application release or schema change
was required. The local harness gained VU preallocation plus explicit ingress
bounds and pending/queue steady-window fields; the successful remote runs,
JavaScript syntax checks, and formatting checks validate those changes.

Each run restored the API receiver destination and original worker/relay
settings and removed its owned receiver resources. Final verification found
one default-concurrency worker, one relay with Recreate and batch 100 every
second, zero pending events, zero unpublished outbox records, all six Pods
ready, and no remaining Kubernetes forwarding process. Fresh smoke event
`f7384a28-e855-488a-b63c-e109dafa3425` delivered with HTTP 204. The three
historical release events remained delivered with one successful attempt and
one durable receiver effect each. IDs and image/state evidence are preserved
in the numeric results.

The next focused comparison is worker concurrency one versus four at equal
offered rates and resources, preserving attempt/effect and backlog checks.
Reduce observer cost before an extended soak, then repeat the chosen operating
rate for substantially longer and with representative receiver latency/payloads.
Do not permanently change concurrency or claim a production maximum from this
capacity sweep alone.
