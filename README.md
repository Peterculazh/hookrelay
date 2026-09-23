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
| `test-receiver` | Accept `POST /webhooks` and return HTTP 204.                                        |

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

This starts PostgreSQL, Redis, the migration service, the API, the relay, the worker, the receiver, Prometheus, and Grafana. The migration service must finish successfully before the API, relay, and worker start. Its `Exited (0)` status is expected.

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

## Checks and CI

```powershell
npm run lint
npm run typecheck
npm test
npm run build -- --all
```

GitHub Actions runs on pull requests and pushes to `main`. The workflow installs dependencies with `npm ci`, runs lint, typechecking, and unit tests, then builds the shared `hookrelay:ci` Docker image.

CI starts an isolated stack using `docker-compose.ci.yml` and project name `hookrelay-ci`, runs migrations, and executes `npm run test:smoke`. On failure it prints container status and logs; cleanup always removes the CI containers and volumes. This workflow validates the application but does not publish images or deploy to Kubernetes.

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
```

Expect `ok`, a Ready node, and a `standard` storage class. The verified storage class uses `rancher.io/local-path` with `WaitForFirstConsumer` binding.

Create the database Secret once in the new namespace. These are local learning credentials; reuse the existing Secret if this setup is already running.

```powershell
kubectl --context docker-desktop -n hookrelay create secret generic postgres-credentials --from-literal=POSTGRES_USER=dbuser --from-literal=POSTGRES_PASSWORD=local-learning-password --from-literal=POSTGRES_DB=db
```

The PostgreSQL, API, relay, worker, and migration manifests read this Secret. Changing its values later does not change credentials inside an already initialized PostgreSQL volume.

### 2. Build and import the application image

All four applications and the migration Job use the same image, with different startup commands. The manifests currently reference `hookrelay:k8s-1` with `imagePullPolicy: Never`.

```powershell
docker build --tag hookrelay:k8s-1 .
$archive = Join-Path $env:TEMP "hookrelay-k8s-1.tar"
docker image save --output "$archive" hookrelay:k8s-1
cmd.exe /d /c 'docker exec -i desktop-control-plane ctr --namespace=k8s.io images import --all-platforms --digests - < "%TEMP%\hookrelay-k8s-1.tar"'
docker exec desktop-control-plane crictl images --name hookrelay
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
kubectl --context docker-desktop -n hookrelay wait --for=condition=complete job/hookrelay-migrate-v1 --timeout=180s
kubectl --context docker-desktop -n hookrelay logs job/hookrelay-migrate-v1
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

The API has startup, liveness, and readiness probes. The worker and relay expose internal metrics listeners but have no Kubernetes health probes, so its rollout status alone does not prove that webhook delivery works. Verify the full path with the smoke test next. The Prometheus/Grafana setup above is currently Compose-only.

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

For a new application build, use a new image tag, such as `hookrelay:k8s-2`. Repeat the build, save, and import steps with that tag and archive filename. Update the image references in the relevant manifests, apply them, wait for their rollouts, and rerun the smoke test.

Rebuilding a tag on the Docker host does not update the image already imported into the Kubernetes node. Reapplying an unchanged Deployment also does not trigger a rollout.

When schema changes require another migration, update the migration image and give the Job a new name, such as `hookrelay-migrate-v2`. Apply it and wait for successful completion before deploying code that requires the new schema. Reapplying a completed Job does not rerun it, and its Pod template cannot generally be changed in place.

## Troubleshooting

Start with the status, events, and logs for the affected component:

```powershell
kubectl --context docker-desktop -n hookrelay get pods,pvc,jobs
kubectl --context docker-desktop -n hookrelay get events --sort-by=.metadata.creationTimestamp
kubectl --context docker-desktop -n hookrelay describe pods -l app=worker
kubectl --context docker-desktop -n hookrelay logs deployment/worker --tail=100
kubectl --context docker-desktop -n hookrelay logs deployment/hookrelay --tail=100
kubectl --context docker-desktop -n hookrelay logs job/hookrelay-migrate-v1
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

Observability and the relay/worker separation are implemented. Next are receiver deduplication and crash-recovery testing before scaling. A previously observed attempt had `finishedAt` earlier than `startedAt` by 3.110 seconds. Investigation of attempt creation, schema, response mapping, and clock behavior remains deferred; duration-based assertions are not part of the smoke test.
