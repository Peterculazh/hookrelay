# VPS Grafana dashboard

Prometheus and Grafana are deployed on the VPS as of 2026-10-01. Open [HookRelay delivery overview](http://localhost:18083/d/hookrelay-overview) from the local PC while its SSH tunnel is running. Both services remain private inside Kubernetes; access goes through SSH.

Sign in as `admin`. The generated password is saved outside the repository in `$env:USERPROFILE\HookRelayMonitoring\grafana-login.txt`. The current PC connection is already running in the background.

## Save the SSH connection once

The current PC has a `hookrelay-vps` alias configured in `$env:USERPROFILE\.ssh\config`, outside the repository. The monitoring and VPS benchmark scripts use this alias by default. It remembers the server, SSH user, and existing private key; no connection prompts are needed on each run.

On another PC, add an entry to its user SSH config with that PC's existing connection values:

```text
Host hookrelay-vps
    HostName your-vps-host
    User your-ssh-user
    IdentityFile ~/.ssh/your-existing-key
    IdentitiesOnly yes
```

Check it with `ssh hookrelay-vps`. Keep real connection values in the user SSH config. `VPS_SSH_TARGET` and `VPS_SSH_KEY` remain optional terminal overrides.

## Reconnect from the PC

After restarting the PC or losing the connection, open PowerShell in the repository and run:

```powershell
.\scripts\connect-monitoring.ps1
```

The script connects using `hookrelay-vps`. Keep that terminal open while viewing Grafana; Ctrl+C closes the tunnel. It also accepts `VPS_SSH_TARGET` and `VPS_SSH_KEY` from the terminal environment.

The default PC port is **18083**, leaving the local Compose Grafana port 18082 available. To select another local port:

```powershell
$env:GRAFANA_LOCAL_PORT = '18084'
.\scripts\connect-monitoring.ps1
```

Open the URL printed by the script. Only one of these tunnels can use the remote forwarding port 18082 at a time. If a connection is already open, use its dashboard rather than starting another connection. If the Grafana Pod is replaced, reconnect after it becomes ready.

## Read the dashboard

The dashboard refreshes every five seconds and shows:

- API requests/second by route and HTTP status, HTTP errors, and API p95 response time.
- Delivery attempts/second by outcome, attempts within the selected period, and receiver p95 response time.
- Waiting, active, and delayed queue jobs; unpublished outbox records.
- API, worker, and relay process CPU, resident memory, and event-loop delay.
- Scrape health for all three services.

Use the `POST /v1/events` series with HTTP status `202` to read accepted ingress RPS, and the successful delivery-attempt series to read receiver successes/second. Other API routes contribute their own traffic. Successful attempts count HTTP acknowledgments before database finalization, including retries, so event status/history remains the final delivery check. Queue and outbox growth reveal when delivery is falling behind ingress.

CPU is expressed as a percentage of one core: 100% means one fully occupied CPU core. These process charts cover the API, worker, and relay; they do not represent whole-VPS usage or include PostgreSQL, Redis, the receiver, or monitoring itself. Replicated service CPU is summed; memory and event-loop series remain per process. Latency charts use histogram estimates and can be empty during periods without requests. Rates need at least two scrapes.

Prometheus collects on the VPS even while the PC is disconnected. History starts when this deployment was installed; earlier benchmark files are not imported. Retention is limited to seven days or 1 GB of metric blocks, whichever is reached first. The time selector controls how much of that retained history Grafana displays. Persistent volumes retain Prometheus data and Grafana state across Pod replacement.

The current live application release remains `8290734d2df271206510cffa41ab2558be4277d2`. The pending Milestone 14 phase-timing metrics require the instrumented application release; those phase charts are not part of this dashboard yet.

## Reproduce or update the deployment

From the repository root, with Node.js installed and existing SSH access that permits `sudo -n k3s kubectl`:

```powershell
node scripts/prepare-monitoring.mjs
node scripts/deploy-monitoring.mjs
```

The preparation script bundles the versioned Kubernetes manifest, Prometheus configuration, and shared Grafana provisioning/dashboard into `.tmp/monitoring/`. The deployment script takes the existing release lock, validates ownership and Kubernetes manifests, applies the resources, waits for readiness, and checks scrape targets, the data source, and the dashboard. It refuses to replace resources without the monitoring ownership label.

A random admin password is generated only when the monitoring Secret is absent. The deployment copies it into the local login file through the encrypted SSH connection without printing it. This is the initial admin password: if you change the Grafana password in its UI, use the changed password thereafter; changing the Kubernetes Secret alone does not reset an existing Grafana account.

The deployment uses namespace `hookrelay-monitoring`, private ClusterIP services, and two `local-path` claims: 2 GiB for Prometheus and 1 GiB for Grafana. Three headless metrics services are added in the application namespace. DNS discovery follows application Pod replacement and replicas. No application release or worker setting is changed by this monitoring deployment.

Prometheus requests 100m CPU / 128 MiB memory with a 512 MiB memory limit; Grafana requests 100m / 128 MiB with a 768 MiB memory limit. The actual idle footprint is recorded in the [deployment evidence](vps-monitoring-results.json). Record that monitoring is enabled during future load tests: its resource use changes the VPS baseline compared with previous benchmark runs.

Configuration lives in [the Kubernetes manifest](../k8s/monitoring.yaml), [the VPS scrape configuration](../observability/prometheus-vps.yml), and [the shared dashboard](../observability/grafana/dashboards/hookrelay.json). After editing them, rerun preparation and deployment. Persistent data remains in the claims. Do not delete claims to update configuration.

## Verify the connection

With the tunnel open and recent application traffic:

```powershell
node scripts/smoke-monitoring.mjs
```

This read-only check loads the local login file, verifies that anonymous dashboard access requires login, checks the Prometheus data source and all scrape targets, compares the deployed panel queries with the versioned dashboard, and executes every query over the last five minutes. It requires finite samples, so latency panels may fail this check after five minutes without relevant traffic. It saves filtered results in `.tmp/monitoring-smoke.json`; it does not create events or interrupt workloads.

Deployment acceptance verified 12 panels / 13 queries, all three scrape jobs up, two ready monitoring Pods, bound persistent claims, unchanged application releases/settings, and one fresh delivery with HTTP 204 and one receiver effect. Historical delivery records were also preserved. See [the numeric evidence](vps-monitoring-results.json).
