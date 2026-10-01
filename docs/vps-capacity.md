# Milestone 13: VPS capacity measurements

Status: complete, verified on 2026-10-01. The highest tested bounded rate was
75 events/s, confirmed for 120 seconds with default worker concurrency one.

The capacity tests generate traffic with k6 on the local PC against the deployed
VPS release. Keep the existing single relay, batch 100 every second, one worker
at concurrency one, and workload resource allocations for the baseline sweep.
Use a healthy receiver with the benchmark's default 256-byte padding.

The [capacity report](vps-capacity-report.md) records the measured rates,
durations, limits, and final restoration evidence. Results describe this
deployment and benchmark path; receiver latency, payload size, retained data,
and concurrency can change the delivery capacity.

## Reproduce a rate

Set SSH connection values only in runtime environment variables using the
[VPS benchmark guide](vps-load-testing.md). Set `VPS_RELEASE_COMMIT` to the
digest-pinned release actually running on the VPS; the benchmark harness can
run from a newer local checkout without redeploying the application.

```powershell
$env:BENCH_RATE = '75'
$env:BENCH_SECONDS = '120'
$env:BENCH_CONCURRENCY = '1'
$env:BENCH_REPLICAS = '1'
npm run benchmark:vps -- relay-steady
```

Rate accepts 1–500 events/s and duration accepts 1–120 seconds. Remove any
previous `BENCH_RELAY_BATCH_SIZE` and `BENCH_RELAY_INTERVAL_SECONDS` overrides
when measuring the deployed settings. If comparing relay settings, set both
explicitly and keep the other variables constant.

Start at a known healthy rate and increase one step at a time. Let every run
drain and restore before the next. Stop increasing once delivery persistently
falls behind; refine around that boundary and repeat the highest bounded rate
for a longer interval. Do not treat the nominal batch-per-interval ratio as
measured throughput.

## Interpret the evidence

`PASS` verifies acceptance, generator scheduling, attempt/effect counts,
monitoring, and eventual draining. An overloaded run can pass those checks
after accumulating a backlog; that does not make its offered rate sustainable.

`steadyState` measures completed deliveries and unpublished, pending, and queue
counts from 20 seconds after k6 launches until the last observation before it
exits. The actual `ingressWindow` bounds are retained. Look for delivery near
the offered rate, bounded pending/outbox/queue counts, stable delivery latency,
and short recovery after load ends. A rising pending count with a small outbox
points toward delivery falling behind after publication; a rising outbox points
toward publication falling behind. These observations locate where work builds
up; they do not alone identify the underlying resource or query bottleneck.

k6 preallocates between 10 and 100 virtual users according to the offered rate,
with a maximum of 100, to avoid runtime allocation during these tests. Runs
with dropped iterations or failed requests must be reported and repeated or
investigated. Do not discard them silently or count them as validated rates.

API latency includes the local gateway, network, SSH, Kubernetes forwarding,
and response-body time. Delivery latency includes database polling and the
return network path on the same PC monotonic clock as acknowledgment. The
observer sends run-scoped rows every poll and adds VPS work that increases
with the run's retained event count. Resource samples can miss bursts.

All test events and durable receiver effects remain available afterward.
The controller restores the API destination and worker/relay settings, removes
owned fixture resources once their jobs drain, and stops its owned forwarding
process. If draining fails, keep the retained fixture until its jobs finish;
follow the existing restoration procedure before another run.
