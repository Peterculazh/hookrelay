# HookRelay

HookRelay is a webhook delivery service built as a low-budget learning project for Kubernetes, CI/CD, observability, and load testing.

The stack is a NestJS monorepo with TypeScript, PostgreSQL and Drizzle ORM, Redis and BullMQ, Docker Compose, and local Kubernetes on Docker Desktop.

## How delivery works

```text
Client -> REST API -> PostgreSQL (event + outbox, one transaction)
                           |
                    Dedicated outbox relay
                           |
                      Redis / BullMQ
                           |
                    Worker delivery processor -> test-receiver
                           |
                    PostgreSQL (attempt + event status)
```

| Application     | Responsibility                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| `hookrelay`     | Accept events, return delivery status and attempt history, expose health endpoints. |
| `worker`        | Run webhook delivery processors independently of the relay.                 |
| `relay`        | Publish committed outbox records to BullMQ; run exactly one instance. |
| `test-receiver` | Apply each event once in PostgreSQL; acknowledge committed duplicates with HTTP 204.                                        |

The API returns HTTP 202 after committing the event and outbox record together. Every ten seconds, the relay enqueues unpublished records using the event ID as the BullMQ job ID, then marks them published. Each job contains the delivery snapshot, including the target URL.

Delivery requests have a ten-second timeout. Jobs get three total attempts with exponential backoff starting at five seconds. Events stay `pending` between failures, become `delivered` on success, or become `failed` after exhaustion. Attempt completion and event status changes are committed in one database transaction. Delivery can be repeated after failures; receivers should handle duplicates.

## API

| Method | Path             | Result                                                 |
| ------ | ---------------- | ------------------------------------------------------ |
| POST   | `/v1/events`     | Accept an event; HTTP 202 with its ID.                 |
| GET    | `/v1/events/:id` | Return the event status and attempt history.           |
| GET    | `/health/live`   | HTTP 200 while the API can respond; no database check. |
| GET    | `/health/ready`  | HTTP 200 when PostgreSQL responds, otherwise HTTP 503. |

Example event body:

```json
{
  "type": "order.created",
  "payload": {
    "orderId": "order-001",
    "amount": 100,
    "currency": "USD"
  }
}
```

The API uses `WEBHOOK_TARGET_URL` when creating the delivery snapshot. Both container setups point it at `http://test-receiver:3001/webhooks`. This hostname resolves inside the container network or Kubernetes namespace.

Readiness checks PostgreSQL, not the entire delivery pipeline. The smoke test verifies delivery through Redis and the worker as well.

## Prerequisites

- Node.js 24 and npm for local checks and the smoke test.
- Docker Desktop running Linux containers with Docker Compose available.
- For Kubernetes: `kubectl` and Docker Desktop Kubernetes enabled.

Commands below use **Windows PowerShell** and run from the repository root. The Kubernetes instructions describe the verified single-node Docker Desktop **kind** setup, whose node container is named `desktop-control-plane`. Every Kubernetes command explicitly selects `docker-desktop` to avoid using another active context.

## Local development with Docker Compose

Install dependencies and create a local environment file only if one does not already exist:

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set `API_HOST_PORT=3200` in the root `.env` to match the default smoke-test URL. The example file uses port 3000; an existing PowerShell environment variable with the same name takes precedence over `.env`.

```powershell
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps --all
npm run test:smoke
```

This starts PostgreSQL, Redis, the migration service, the API, the relay, the worker, the receiver, Prometheus, and Grafana. The migration service must finish successfully before the API, relay, worker, and receiver start. Its `Exited (0)` status is expected.

The API is available at `http://localhost:3200`. PostgreSQL is exposed on `127.0.0.1:5433`; the applications use `postgres:5432` internally. Redis and the receiver do not need host ports.

```powershell
curl.exe -i http://localhost:3200/health/live
curl.exe -i http://localhost:3200/health/ready
docker compose -f docker-compose.yml logs -f hookrelay relay worker
```

This container setup runs compiled code. After source changes, rerun `up -d --build`. The explicit `-f docker-compose.yml` keeps these commands independent of a local override file.

To stop and remove the local containers while retaining database and Redis volumes:

```powershell
docker compose -f docker-compose.yml down
```

## Observability

After starting Compose, open [HookRelay delivery overview](http://localhost:18082/d/hookrelay-overview) in Grafana. Log in with `admin` / `hookrelay-local` (override with `GRAFANA_ADMIN_PASSWORD` before first startup). The Prometheus data source and dashboard are provisioned from `observability/`; no manual dashboard setup is needed. [Prometheus targets](http://localhost:9090/targets) should show all three services up. Host ports can be changed using `GRAFANA_HOST_PORT` and `PROMETHEUS_HOST_PORT`.

The dashboard shows API traffic and HTTP errors, API p95 latency, delivery attempts by outcome, receiver p95 response time, waiting/active/delayed queue jobs, and unpublished outbox records. Allow two five-second scrapes for rates to appear. Percentiles are estimates from histogram buckets and are empty when there are no observations.

All three processes expose `GET /metrics` on separate internal HTTP listeners: API port 9464, worker port 9465, and relay port 9466. Compose does not publish these ports to the host. For local Node development, `METRICS_HOST` and `METRICS_PORT` override their bindings. The API's public port does not expose metrics. A failed collector returns HTTP 503 instead of a misleading zero. The API collects the outbox gauge directly so backlog growth remains visible when the relay is stopped. Queue metrics are collected by the relay, so queue backlog remains visible while workers are stopped. Relay downtime leaves a queue-metric gap, while the API still reports unpublished outbox records.

Metrics use bounded method, route template, status, outcome, and state labels. IDs, payloads, and receiver URLs are never labels. API middleware counts completed responses including validation errors and unmatched routes. Delivery counters count actual receiver request outcomes, including every retry, before database finalization. A receiver 2xx followed by a database failure still counts as a successful receiver response; `job.failed` logs and event history explain finalization failures. Counters reset when a process restarts; the dashboard uses `rate`/`increase` to handle resets. A process killed before the next scrape can lose unobserved increments.

Durations use `performance.now()` in milliseconds for logs and seconds for histograms. Receiver duration ends at response headers or request failure, excluding database work and discarded response bodies. Stored timestamps are unchanged; the timestamp investigation remains deferred.

API, relay, and worker logs are Pino JSON on stdout. `event.accepted`, `job.published`, `delivery.started`, and `delivery.succeeded`/`delivery.failed` share `eventId` and `jobId`; delivery records add `attemptId`, `attemptNumber`, HTTP status, error code where applicable, and duration. `attemptId` is null before an attempt exists. `job.published` means Redis accepted the add operation, which is idempotent by event ID; it does not assert that the enclosing outbox transaction committed. `job.publish_failed`, `outbox.mark_failed`, and `job.failed` expose infrastructure failures. `LOG_LEVEL` defaults to `info`.

Follow one event without querying database tables:

```powershell
$eventId = 'paste-event-id-here'
docker compose -f docker-compose.yml logs --no-color --no-log-prefix hookrelay relay worker |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object eventId -EQ $eventId |
    Format-Table service, action, eventId, jobId, attemptId, attemptNumber, httpStatus, errorCode, durationMs
```

Run the acceptance scenarios against the local Compose stack:

```powershell
npm run test:observability
```

This creates twelve test events, verifies a normal delivery, stops the receiver until three failed attempts are observed, restarts it, stops the relay while submitting five events, checks the API outbox gauge rises, and restarts the relay to verify draining. It then stops the worker, submits five more events, verifies publication continues and queue backlog is visible, and restarts the worker to verify delivery. It checks correlated JSON logs, every dashboard query, and Grafana provisioning. It restores the receiver, relay, and worker in `finally` and retains test events. It discovers published host ports through Compose. Run it against a disposable local workload, since it intentionally interrupts delivery. CI continues using the delivery smoke test and its separate Compose file.

For manual inspection, run `docker compose -f docker-compose.yml stop test-receiver`, submit events, and watch failed attempts; restore it with `start test-receiver`. Then `stop relay`, submit events, watch the outbox gauge grow, and `start relay` to drain it. Jobs that have exhausted all retries stay failed; submit a new event to verify receiver recovery.

## Receiver deduplication

The test receiver validates a UUID event ID, a nonempty type (up to 255 characters), and a JSON payload. Invalid requests return HTTP 400. It inserts the ID into its own `received_events` table with `ON CONFLICT DO NOTHING`. Only the transaction that inserts the marker creates a `receiver_effects` row containing the event type and payload. That row is the simulated business effect; the marker and effect commit together before HTTP 204 is returned. Database errors return HTTP 500 so delivery can retry.

Concurrent deliveries of the same ID produce one effect. A repeated ID with a different payload is treated as a duplicate: the first committed effect remains unchanged. Deduplication persists across receiver restarts. These receiver-owned tables have no foreign key to HookRelay's events; sharing the PostgreSQL instance and migration runner is a learning-project convenience. This guarantee covers the database effect, not external side effects such as sending email. Keep the markers for as long as duplicate delivery is possible.

After rebuilding the Compose stack (which applies the new migration), run:

```powershell
npm run test:receiver
```

The test sends sequential and concurrent duplicate requests, checks invalid input, forces a commit-time failure with a temporary trigger scoped to one generated event ID, verifies rollback and successful retry, then restarts the receiver and verifies persistent deduplication. It removes its test rows and temporary trigger/function. Run against a local test workload: it briefly restarts the receiver and requires database DDL privileges for fault injection. It does not add a failure endpoint or switch to the application.

CI runs the same test against its disposable Compose stack using `RECEIVER_COMPOSE_FILE=docker-compose.ci.yml` and `RECEIVER_COMPOSE_PROJECT=hookrelay-ci`. Rebuild/import the image and run a new migration Job before deploying the updated receiver to Kubernetes; the Kubernetes changes have not been validated by this local Compose test.

## Worker crash recovery

Run the deterministic crash test against an already running, migrated Compose stack with exactly one delivery worker:

```powershell
npm run test:worker-crash
```

It briefly stops the worker, submits one event through the API, and installs a temporary event-scoped PostgreSQL trigger that blocks the attempt's success update on an advisory lock. Once the worker reaches that update, the test verifies the receiver has committed exactly one effect while the event is still pending and its attempt is unfinished. It sends `SIGKILL`, verifies exit code 137, releases the database block, removes the trigger, and restarts the worker.

BullMQ must recover the stalled job naturally after its lock expires; the test does not re-enqueue or manually retry it. It verifies a second execution succeeds with HTTP 204, the queue job completes, and the same single receiver effect remains. Recovery spans lock expiry and periodic stalled-job checks. With the current 30-second defaults, observed recovery approached 90 seconds; the test allows 150 seconds without changing worker settings.

When BullMQ assigns a new execution, starting its attempt also closes earlier unfinished attempts in the same PostgreSQL transaction. These become `failed` with error code `INTERRUPTED` and no HTTP status: the receiver outcome is unknown. Their `finishedAt` is the reconciliation time, not a measured request completion time. A late finalization cannot overwrite an attempt that has already been reconciled. The new successful attempt explains the eventual `delivered` event. The test verifies one durable receiver effect across repeated HTTP deliveries and prints the retained event ID for inspection.

The single relay also reconciles retained terminal queue jobs every ten seconds, scanning up to 100 candidate events per batch with keyset pagination. Failed jobs change still-pending events to `failed` and close unfinished attempts; completed jobs allow cleanup of historical unfinished attempts without changing the event outcome. This covers stalled-job exhaustion and database finalization failures even when no new processor execution occurs. Missing, waiting, delayed, and active jobs are left alone; elapsed time never determines whether an attempt is abandoned. Keep completed/failed jobs retained and do not manually retry or remove them while reconciliation is running. A future replay API will need coordination with reconciliation.

```powershell
npm run test:worker-exhaustion
```

This repeats the crash after receiver acceptance twice. With BullMQ's default single stalled recovery, the job eventually fails. The test verifies that the relay reconciles the event and both interrupted attempts while the receiver still has exactly one effect. Event `failed` means delivery could not be confirmed; it does not prove the receiver applied no effect.

The test restores the worker in `finally`; the probe normally removes its temporary trigger/function and releases the lock. Run against a test workload because worker availability is interrupted and fault injection needs database DDL privileges. CI uses `CRASH_COMPOSE_FILE=docker-compose.ci.yml` and `CRASH_COMPOSE_PROJECT=hookrelay-ci` to target its disposable stack.

## Graceful shutdown

Workers close their BullMQ worker during Nest's module-destruction phase. This stops new jobs and waits for active HTTP delivery, database finalization, and the queue acknowledgment. The relay stops starting publication/reconciliation batches and waits for active batches. PostgreSQL pools close in the later application-shutdown phase, after this work drains. Logs include `worker.draining` / `worker.drained` and `relay.draining` / `relay.drained`.

Compose application containers and the Kubernetes worker/relay manifests allow 30 seconds to stop, leaving room beyond the ten-second webhook timeout for database and queue finalization. An unresponsive dependency can still exhaust that grace period; forced termination then uses the crash-recovery path.

```powershell
npm run test:shutdown
```

The test blocks success persistence after receiver acceptance, queues another event, sends SIGTERM, and waits for the worker to acknowledge shutdown before releasing the database block. It verifies that the active delivery and queue acknowledgment finish without SIGKILL, the next job remains waiting with no attempt, and that job completes after restart. Relay draining and reconciliation shutdown also have unit coverage.

## Checks and CI

```powershell
npm run lint
npm run typecheck
npm test
npm run build -- --all
```

GitHub Actions runs on pull requests and pushes to `main`. The workflow installs dependencies with `npm ci`, runs lint, typechecking, and unit tests, then builds the shared `hookrelay:ci` Docker image.

CI starts an isolated stack using `docker-compose.ci.yml` and project name `hookrelay-ci`, runs migrations, and executes delivery, receiver deduplication, crash recovery, graceful shutdown, and repeated-crash exhaustion checks. On failure it prints container status and logs; cleanup always removes the CI containers and volumes. This workflow validates the application but does not publish images or deploy to Kubernetes. Set `CI_API_HOST_PORT` and the matching `SMOKE_BASE_URL` to use another port when running a separate local CI stack.

The smoke test:

1. Waits up to 30 seconds for `/health/ready` to return HTTP 200.
2. Submits one event and expects HTTP 202 with an event ID.
3. Polls that event for up to 60 seconds.
4. Requires `delivered` status and a successful attempt with HTTP 204.

Failures produce a nonzero exit code, the event ID if one was created, and the last event response. `SMOKE_BASE_URL` overrides the default `http://127.0.0.1:3200`. Each run leaves its event and attempt history in the database.

## Local Kubernetes

Use the following order for a fresh namespace. Stop at a failed readiness or migration check and inspect its logs before proceeding. Kubernetes does not infer application startup dependencies from these manifests.

### 1. Verify the cluster and create the namespace

```powershell
kubectl --context docker-desktop --request-timeout=5s get --raw=/readyz
kubectl --context docker-desktop get nodes
kubectl --context docker-desktop get storageclass
kubectl --context docker-desktop apply -f k8s/namespace.yaml
kubectl --context docker-desktop apply -f k8s/configmap.yaml
```

Expect `ok`, a Ready node, and a `standard` storage class. The verified storage class uses `rancher.io/local-path` with `WaitForFirstConsumer` binding.

Create the database Secret once in the new namespace. These are local learning credentials; reuse the existing Secret if this setup is already running.

```powershell
kubectl --context docker-desktop -n hookrelay create secret generic postgres-credentials --from-literal=POSTGRES_USER=dbuser --from-literal=POSTGRES_PASSWORD=local-learning-password --from-literal=POSTGRES_DB=db
```

The PostgreSQL, API, relay, worker, receiver, and migration manifests read this Secret. Changing its values later does not change credentials inside an already initialized PostgreSQL volume. Application processes and the migration Job load shared non-secret database/Redis settings from `hookrelay-config`. After changing that ConfigMap, roll out the affected application Pods so they receive the new environment.

### 2. Build and import the application image

All four applications and the migration Job use the same image, with different startup commands. The manifests currently reference `hookrelay:k8s-2` with `imagePullPolicy: Never`.

```powershell
docker build --tag hookrelay:k8s-2 .
$archive = Join-Path $env:TEMP "hookrelay-k8s-2.tar"
docker image save --output "$archive" hookrelay:k8s-2
cmd.exe /d /c 'docker exec -i desktop-control-plane ctr --namespace=k8s.io images import --all-platforms --digests - < "%TEMP%\hookrelay-k8s-2.tar"'
docker exec desktop-control-plane crictl images hookrelay
```

The Docker host image store and the kind node image store are separate. A successful `docker image inspect` alone does not mean Kubernetes can use the image. The import command streams the archive through `cmd.exe` so binary image data is not passed through a PowerShell text pipeline. The containerd namespace `k8s.io` is separate from the Kubernetes namespace `hookrelay`.

This import targets the verified single node. A different node name requires adjusting the command; a cluster with multiple nodes needs the image on every node that can run the application Pods.

### 3. Start PostgreSQL and run migrations

```powershell
kubectl --context docker-desktop apply -f k8s/postgres-pvc.yaml
kubectl --context docker-desktop apply -f k8s/postgres.yaml
kubectl --context docker-desktop -n hookrelay rollout status statefulset/postgres --timeout=180s
kubectl --context docker-desktop -n hookrelay get pvc

kubectl --context docker-desktop apply -f k8s/migrate.yaml
kubectl --context docker-desktop -n hookrelay wait --for=condition=complete job/hookrelay-migrate-v2 --timeout=180s
kubectl --context docker-desktop -n hookrelay logs job/hookrelay-migrate-v2
```

The `postgres-data` claim requests 1 GiB. It can remain Pending until the PostgreSQL Pod is scheduled because the storage class uses `WaitForFirstConsumer`. Once PostgreSQL is running, expect the claim to be Bound.

Continue only after the migration Job completes successfully. It runs `npm run db:migrate`, has no automatic retries, and has a 120-second execution deadline.

### 4. Start the receiver and Redis

```powershell
kubectl --context docker-desktop apply -f k8s/test-receiver.yaml
kubectl --context docker-desktop apply -f k8s/test-receiver-service.yaml
kubectl --context docker-desktop -n hookrelay rollout status deployment/test-receiver --timeout=180s

kubectl --context docker-desktop apply -f k8s/redis.yaml
kubectl --context docker-desktop -n hookrelay rollout status statefulset/redis --timeout=180s
kubectl --context docker-desktop -n hookrelay exec redis-0 -- redis-cli -h redis ping
```

Expect Redis to return `PONG`. Redis uses a 1 GiB claim, AOF persistence with `appendfsync everysec`, and `noeviction`. Its configured Redis memory limit is 128 MB, within a 256 MiB container memory limit.

### 5. Start the API, relay, and worker

```powershell
kubectl --context docker-desktop apply -f k8s/hookrelay.yaml
kubectl --context docker-desktop -n hookrelay rollout status deployment/hookrelay --timeout=180s
kubectl --context docker-desktop apply -f k8s/worker.yaml -f k8s/relay.yaml
kubectl --context docker-desktop -n hookrelay rollout status deployment/worker --timeout=180s
kubectl --context docker-desktop -n hookrelay rollout status deployment/relay --timeout=180s
kubectl --context docker-desktop -n hookrelay get pods,services,pvc,jobs
```

Keep exactly one relay replica. Its Deployment uses `Recreate` to avoid overlapping relay Pods during an update. Rebuild/import an image containing the relay before applying its manifest.

The API has startup, liveness, and PostgreSQL readiness probes. Worker and relay probes call `/health/live` on their internal metrics listeners (9465 and 9466). This endpoint responds without querying dependencies or collecting metrics, so a database or Redis outage does not trigger restart loops. Their readiness means the process can respond; it does not prove delivery capacity. The receiver has startup, liveness, and readiness probes on its root endpoint. Verify the full path with the smoke test next. The Prometheus/Grafana setup above is currently Compose-only.

### 6. Forward the API and verify delivery

Keep this running in one terminal. Omitting the local port lets `kubectl` select an available one:

```powershell
kubectl --context docker-desktop -n hookrelay port-forward --address=127.0.0.1 service/hookrelay :3000
```

In another terminal, enter the local port shown by the forwarding command, such as `17916`:

```powershell
$apiPort = Read-Host "Local port printed by kubectl"
curl.exe -i "http://127.0.0.1:$apiPort/health/ready"
$previousSmokeBaseUrl = $env:SMOKE_BASE_URL
try {
    $env:SMOKE_BASE_URL = "http://127.0.0.1:$apiPort"
    npm run test:smoke
} finally {
    $env:SMOKE_BASE_URL = $previousSmokeBaseUrl
}
```

Expect readiness HTTP 200 and `Smoke test passed: event ... delivered with HTTP 204`. This path has been verified against the local Kubernetes deployment. Stop port forwarding with Ctrl+C when finished.

### Updating code and migrations

For a new application build, use a new image tag, such as `hookrelay:k8s-3`. Repeat the build, save, and import steps with that tag and archive filename. Update the image references in the relevant manifests, apply them, wait for their rollouts, and rerun the smoke test.

Rebuilding a tag on the Docker host does not update the image already imported into the Kubernetes node. Reapplying an unchanged Deployment also does not trigger a rollout.

When schema changes require another migration, update the migration image and give the Job a new name, such as `hookrelay-migrate-v3`. Apply it and wait for successful completion before deploying code that requires the new schema. Reapplying a completed Job does not rerun it, and its Pod template cannot generally be changed in place.

When upgrading from the original combined worker/relay image, scale the old worker Deployment to zero and wait for its Pods to terminate before starting the dedicated relay. Applying the current worker manifest restores one delivery worker. This prevents overlap between the old embedded outbox cron and the new relay.

### 7. Verify persistence, worker scaling, and Pod replacement

```powershell
npm run test:k8s
```

This acceptance test is pinned to the `docker-desktop` context and `hookrelay` namespace. Run it on the local learning workload: it temporarily stops workers, replaces the Redis Pod, scales to two workers, and replaces one worker Pod. It preserves persistent volumes and restores the original worker replica count in `finally`.

The test submits 24 events while workers are stopped, verifies they reach the queue, and checks that waiting jobs survive Redis Pod replacement. It pauses the queue while both workers start, then verifies that both Pods deliver test events, with one successful attempt and one durable receiver effect per event. After replacing a worker Pod, it verifies another 12 deliveries. The relay remains a single replica throughout. Test events remain available for inspection.

## Troubleshooting

Start with the status, events, and logs for the affected component:

```powershell
kubectl --context docker-desktop -n hookrelay get pods,pvc,jobs
kubectl --context docker-desktop -n hookrelay get events --sort-by=.metadata.creationTimestamp
kubectl --context docker-desktop -n hookrelay describe pods -l app=worker
kubectl --context docker-desktop -n hookrelay logs deployment/worker --tail=100
kubectl --context docker-desktop -n hookrelay logs deployment/hookrelay --tail=100
kubectl --context docker-desktop -n hookrelay logs job/hookrelay-migrate-v2
```

| Symptom                                                          | Check or next action                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Kubernetes API returns `EOF`                                     | Check Docker Desktop Kubernetes status and wait for `/readyz` to return `ok` before applying resources.               |
| `ErrImageNeverPull`                                              | Confirm the exact manifest image tag is imported into the node. Building it on the Docker host is insufficient.       |
| Node container missing from `docker ps`                          | Docker Desktop may hide system containers. Enable their display and confirm the actual node container name.           |
| `docker cp` reports success but the node cannot find the archive | Use the archive streaming import shown above; that was the working path for this setup.                               |
| PVC stays Pending before PostgreSQL starts                       | With `WaitForFirstConsumer`, create the consuming StatefulSet. If it still stays Pending, inspect Pod and PVC events. |
| Port forwarding reports forbidden socket access                  | A fixed Windows port may be reserved. Use the dynamic local port form shown above.                                    |
| Readiness returns 503 while liveness returns 200                 | Inspect PostgreSQL availability and API database configuration. This separation is intentional.                       |
| Smoke test gets `ECONNREFUSED`                                   | Check that port forwarding is still running and `SMOKE_BASE_URL` matches its current local port.                      |
| Migration wait times out                                         | Inspect the Job logs and description. Do not continue deploying code until the migration succeeds.                    |

## Persistence and current scope

PostgreSQL data was verified to survive deletion and recreation of `postgres-0`: a test row remained after the StatefulSet replaced the Pod. Both PostgreSQL and Redis use persistent volumes, but this local setup has no replication or backup workflow. The storage class uses the `Delete` reclaim policy; deleting claims or resetting the cluster can destroy data. Pod replacement is not the same as deleting storage.

Implemented and verified: transactional outbox delivery, retry handling, automated CI delivery checks, API health endpoints, and an end-to-end delivery through local Kubernetes.

Milestone 6 reliability work is implemented and verified: a dedicated single relay, transactional receiver deduplication, graceful shutdown, interrupted-attempt reconciliation, and automated crash/restart checks. Multiple relays are still unsupported.

Milestone 7 is verified on Docker Desktop Kubernetes as of 2026-09-28 with `hookrelay:k8s-2` and the completed `hookrelay-migrate-v2` Job. The cluster now runs separate API, relay, delivery worker, and receiver Deployments with ConfigMap/Secret configuration and health probes. The acceptance test preserved 24 waiting jobs across Redis Pod replacement; two workers delivered 12 events each. After worker Pod replacement, another 12 deliveries succeeded. All 36 test events had one successful attempt and one receiver effect. The test restored one worker replica and kept one relay throughout. PostgreSQL persistence was verified separately as described above.

Next is milestone 8: a low-cost remote deployment, with database backup and a demonstrated restore. The local Kubernetes setup is not a highly available production environment.

A previously observed attempt had `finishedAt` earlier than `startedAt` by 3.110 seconds. Investigation of attempt creation, schema, response mapping, and clock behavior remains deferred; duration-based assertions are not part of the smoke test. `INTERRUPTED` attempt timestamps record reconciliation rather than receiver request duration.
