import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { availableParallelism, cpus, totalmem, platform } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { cases, quantiles } from '../load/profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const composeArgs = [
  'compose',
  '-p',
  'hookrelay-load',
  '-f',
  'load/compose.yml',
];
const arg = process.argv[2] ?? 'baseline';
const output = resolve(
  root,
  '.tmp',
  'benchmarks',
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${arg}`,
);
assert.ok(
  arg === 'suite' || arg in cases,
  `Choose baseline, suite, or ${Object.keys(cases).join(', ')}`,
);
const selected = arg === 'suite' ? Object.entries(cases) : [[arg, cases[arg]]];
if (arg !== 'suite') {
  const overrides = [
    ['rate', 'BENCH_RATE', 1, 500],
    ['seconds', 'BENCH_SECONDS', 1, 120],
    ['concurrency', 'BENCH_CONCURRENCY', 1, 100],
    ['replicas', 'BENCH_REPLICAS', 1, 4],
  ];
  for (const [key, variable, minimum, maximum] of overrides) {
    if (process.env[variable] === undefined) continue;
    const value = Number(process.env[variable]);
    assert.ok(
      Number.isInteger(value) && value >= minimum && value <= maximum,
      `${variable} must be an integer from ${minimum} to ${maximum}`,
    );
    selected[0][1] = { ...selected[0][1], [key]: value };
  }
}
const results = [];
let pool;

async function command(file, args, environment = {}) {
  const { stdout } = await exec(file, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}
const docker = (...args) => command('docker', args);
const compose = (args, concurrency = 1) =>
  command('docker', [...composeArgs, ...args], {
    BENCH_CONCURRENCY: String(concurrency),
  });
async function port(service, internal) {
  return Number(
    (await compose(['port', service, String(internal)])).split(':').at(-1),
  );
}
async function waitReady(base) {
  const deadline = performance.now() + 60000;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${base}/health/ready`, {
        signal: AbortSignal.timeout(2000),
      });
      await response.text();
      if (response.status === 200) return;
    } catch {
      /* applications may still be booting */
    }
    await sleep(500);
  }
  throw new Error('Benchmark API did not become ready');
}

async function runCase(name, config) {
  const concurrency = config.concurrency ?? 1;
  const replicas = config.replicas ?? 1;
  const type = `benchmark.${randomUUID()}`;
  const directory = resolve(output, name);
  await mkdir(directory, { recursive: true });
  await compose(
    [
      'up',
      '-d',
      '--no-build',
      '--scale',
      `worker=${config.paused ? 0 : replicas}`,
      'worker',
    ],
    concurrency,
  );
  const api = `http://127.0.0.1:${await port('hookrelay', 3000)}`;
  await waitReady(api);
  const accepted = new Map();
  const samples = [];
  const runtime = [];
  const errors = [];
  const telemetryStartupGaps = [];
  const metricFirstSeen = new Map();
  const metricReady = new Set();
  const metricServices = new Map();
  let ingressDone;
  let recoveryStarted;
  let lastCompletion;
  let stopping = false;
  let snapshot = {};
  let pollMaxMs = 0;
  let lastPoll = performance.now();
  const started = performance.now();

  // A local forwarding observer timestamps the API acknowledgment on one
  // monotonic clock. k6 never waits for delivery and keeps its arrival rate.
  const gateway = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/events')
      return res.writeHead(404).end();
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) return res.writeHead(413).end();
      }
      const sent = performance.now();
      const response = await fetch(`${api}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(4000),
      });
      const text = await response.text();
      const ack = performance.now();
      if (response.status === 202) {
        const { id } = JSON.parse(text);
        assert.equal(typeof id, 'string');
        accepted.set(id, { ack, sent, apiMs: ack - sent });
      }
      res
        .writeHead(response.status, {
          'content-type': 'application/json',
          'x-benchmark-api-duration-ms': String(ack - sent),
        })
        .end(text);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(502).end('{}');
    }
  });
  await new Promise((ready) => gateway.listen(0, '127.0.0.1', ready));

  const monitoring = (async () => {
    while (!stopping) {
      try {
        const { rows } = await pool.query(
          `
          SELECT e.id, e.status, (o.published_at IS NULL) AS unpublished,
                 EXISTS (SELECT 1 FROM receiver_effects r WHERE r.event_id=e.id) AS effect,
                 (SELECT count(*)::int FROM delivery_attempts a WHERE a.event_id=e.id) AS attempts,
                 (SELECT count(*)::int FROM delivery_attempts a WHERE a.event_id=e.id AND a.finished_at<a.started_at) AS reversed_timestamps
          FROM events e JOIN outbox o ON o.event_id=e.id WHERE e.type=$1`,
          [type],
        );
        const now = performance.now();
        pollMaxMs = Math.max(pollMaxMs, now - lastPoll);
        lastPoll = now;
        snapshot = {
          total: rows.length,
          pending: 0,
          delivered: 0,
          failed: 0,
          unpublished: 0,
          effects: 0,
          attempts: 0,
          reversedTimestamps: 0,
        };
        for (const row of rows) {
          snapshot[row.status]++;
          snapshot.unpublished += Number(row.unpublished);
          snapshot.effects += Number(row.effect);
          snapshot.attempts += row.attempts;
          snapshot.reversedTimestamps += row.reversed_timestamps;
          const entry = accepted.get(row.id);
          if (entry && !entry.observed && row.status !== 'pending') {
            entry.observed = now;
            entry.status = row.status;
            lastCompletion = now;
          }
        }
        const {
          rows: [database],
        } = await pool.query(`SELECT
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waits,
          xact_commit, xact_rollback, blks_read, blks_hit, deadlocks
          FROM pg_stat_database WHERE datname=current_database()`);
        samples.push({
          seconds: (now - started) / 1000,
          phase: ingressDone ? 'drain' : 'ingress',
          ...snapshot,
          database,
        });
      } catch (error) {
        errors.push(`observer: ${error}`);
      }
      await sleep(500);
    }
  })();
  const telemetry = (async () => {
    while (!stopping) {
      try {
        const ids = (await compose(['ps', '-q']))
          .split(/\r?\n/)
          .filter(Boolean);
        const stats = (
          await docker('stats', '--no-stream', '--format', '{{json .}}', ...ids)
        )
          .split(/\r?\n/)
          .filter(Boolean)
          .map(JSON.parse);
        // Dynamic ports support worker replicas without a shared scrape target.
        const listing = await compose(['ps', '--format', 'json']);
        const containers = listing.startsWith('[')
          ? JSON.parse(listing)
          : listing.split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const items = Array.isArray(containers) ? containers : [containers];
        const metrics = [];
        for (const item of items) {
          const endpoint = item.Publishers?.find((p) =>
            [9464, 9465, 9466].includes(p.TargetPort),
          );
          if (!endpoint) continue;
          if (!metricFirstSeen.has(item.ID))
            metricFirstSeen.set(item.ID, performance.now());
          try {
            const response = await fetch(
              `http://127.0.0.1:${endpoint.PublishedPort}/metrics`,
              { signal: AbortSignal.timeout(4000) },
            );
            if (!response.ok)
              throw new Error(`Metrics HTTP ${response.status}`);
            metrics.push({ container: item.Name, text: await response.text() });
            metricReady.add(item.ID);
            metricServices.set(item.Name, item.Service);
          } catch (error) {
            // A newly resumed worker can be running before Nest binds its port.
            if (
              metricReady.has(item.ID) ||
              performance.now() - metricFirstSeen.get(item.ID) > 30000
            )
              throw error;
            telemetryStartupGaps.push({
              seconds: (performance.now() - started) / 1000,
              container: item.Name,
              error: String(error),
            });
          }
        }
        runtime.push({
          seconds: (performance.now() - started) / 1000,
          stats,
          metrics,
        });
      } catch (error) {
        errors.push(`telemetry: ${error}`);
      }
      await sleep(2000);
    }
  })();
  let exitCode;
  try {
    console.log(
      `Benchmark ${name}: ${config.rate}/s for ${config.seconds}s, workers=${config.paused ? 'paused' : replicas}, concurrency=${concurrency}`,
    );
    const child = spawn('k6', ['run', '--quiet', 'load/k6-events.js'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BENCH_URL: `http://127.0.0.1:${gateway.address().port}`,
        EVENT_TYPE: type,
        RATE: String(config.rate),
        DURATION: `${config.seconds}s`,
        DELAY_MS: String(config.delayMs ?? 0),
        FAIL_ATTEMPTS: String(config.failAttempts ?? 0),
        SUMMARY_PATH: resolve(directory, 'k6.json'),
      },
    });
    let log = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        log += chunk;
        process.stdout.write(chunk);
      });
    exitCode = await new Promise((done, reject) => {
      child.on('error', reject);
      child.on('exit', done);
    });
    await writeFile(resolve(directory, 'k6.log'), log);
    ingressDone = performance.now();
    if (config.paused) {
      const publicationDeadline = performance.now() + 60000;
      while (
        (snapshot.total < accepted.size || snapshot.unpublished) &&
        performance.now() < publicationDeadline
      )
        await sleep(500);
      assert.equal(
        snapshot.total,
        accepted.size,
        'All acknowledged events must exist',
      );
      assert.equal(
        snapshot.unpublished,
        0,
        'Backlog must reach the queue before timing recovery',
      );
      recoveryStarted = performance.now();
      await compose(
        ['up', '-d', '--no-build', '--scale', `worker=${replicas}`, 'worker'],
        concurrency,
      );
    }
    const deadline = performance.now() + 180000;
    while (
      (snapshot.total < accepted.size ||
        snapshot.pending ||
        [...accepted.values()].some((e) => !e.observed)) &&
      performance.now() < deadline
    )
      await sleep(500);
  } finally {
    stopping = true;
    await Promise.all([monitoring, telemetry]);
    await new Promise((done) => {
      gateway.close(done);
      gateway.closeAllConnections();
    });
    await writeFile(
      resolve(directory, 'samples.json'),
      JSON.stringify(samples, null, 2),
    );
    await writeFile(
      resolve(directory, 'runtime.json'),
      JSON.stringify(runtime, null, 2),
    );
  }
  const summary = JSON.parse(
    await readFile(resolve(directory, 'k6.json'), 'utf8'),
  );
  const observed = [...accepted.values()];
  const expected = config.expected ?? 'delivered';
  const { rows: attemptOutcomes } = await pool.query(
    `
    SELECT a.status, a.http_status, a.error_code, count(*)::int AS count
    FROM delivery_attempts a JOIN events e ON e.id=a.event_id
    WHERE e.type=$1 GROUP BY a.status, a.http_status, a.error_code`,
    [type],
  );
  const expectedFailures =
    expected === 'failed' ? 3 : (config.failAttempts ?? 0);
  const expectedError = name === 'timeout' ? 'TIMEOUT' : 'HTTP_ERROR';
  const expectedHttpStatus = name === 'timeout' ? null : 503;
  const matchingFailures = attemptOutcomes
    .filter(
      (a) =>
        a.status === 'failed' &&
        a.error_code === expectedError &&
        a.http_status === expectedHttpStatus,
    )
    .reduce((sum, a) => sum + a.count, 0);
  const matchingSuccesses = attemptOutcomes
    .filter((a) => a.status === 'succeeded' && a.http_status === 204)
    .reduce((sum, a) => sum + a.count, 0);
  const checks = {
    k6Passed: exitCode === 0,
    allAcknowledgmentsTracked:
      accepted.size === (summary.metrics.events_accepted?.values.count ?? 0),
    scheduledEventsAccepted:
      accepted.size === summary.metrics.iterations.values.count,
    // k6 0.51 can schedule one extra iteration at the duration boundary.
    configuredRateReached:
      Math.abs(accepted.size - config.rate * config.seconds) <= 1,
    allTerminal:
      snapshot.total === accepted.size &&
      snapshot.pending === 0 &&
      observed.every((e) => e.status === expected),
    effectCount:
      snapshot.effects === (expected === 'delivered' ? accepted.size : 0),
    attemptCount:
      snapshot.attempts ===
      accepted.size *
        (expected === 'failed' ? 3 : (config.failAttempts ?? 0) + 1),
    attemptOutcomes:
      matchingFailures === accepted.size * expectedFailures &&
      matchingSuccesses === (expected === 'delivered' ? accepted.size : 0),
    noObserverErrors: errors.length === 0,
    runtimeMetricsPresent:
      ['hookrelay', 'relay'].every((service) =>
        [...metricServices.values()].includes(service),
      ) &&
      [...metricServices.values()].filter((service) => service === 'worker')
        .length >= replicas,
  };
  const elapsed = (lastCompletion - started) / 1000;
  const result = {
    name,
    type,
    config: { ...config, concurrency, replicas },
    checks,
    snapshot,
    attemptOutcomes,
    errors,
    telemetryStartupGaps,
    accepted: accepted.size,
    apiMs: quantiles(observed.map((e) => e.apiMs)),
    acceptanceToObservedDeliveryMs: quantiles(
      observed
        .filter((e) => e.status === 'delivered')
        .map((e) => e.observed - e.ack),
    ),
    acceptanceToObservedFailureMs: quantiles(
      observed
        .filter((e) => e.status === 'failed')
        .map((e) => e.observed - e.ack),
    ),
    acceptedPerSecond: accepted.size / config.seconds,
    deliveredPerSecondOverWholeRun: snapshot.delivered / elapsed,
    totalSeconds: elapsed,
    drainAfterIngressSeconds: Math.max(
      0,
      (lastCompletion - ingressDone) / 1000,
    ),
    recoverySeconds: recoveryStarted
      ? (lastCompletion - recoveryStarted) / 1000
      : null,
    peakPending: Math.max(...samples.map((s) => s.pending)),
    peakUnpublished: Math.max(...samples.map((s) => s.unpublished)),
    peakDatabaseConnections: Math.max(
      ...samples.map((s) => s.database.connections),
    ),
    maxObservationIntervalMs: pollMaxMs,
    k6: summary.metrics,
  };
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(
    `${name}: ${snapshot.delivered} delivered, ${snapshot.failed} failed; drain ${result.drainAfterIngressSeconds.toFixed(2)}s; checks=${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'}`,
  );
  return result;
}

function report(metadata) {
  const number = (v) => (v == null ? '—' : v.toFixed(2));
  return `# HookRelay benchmark\n\nGenerated ${metadata.startedAt}. Commit ${metadata.commit}; local modifications included.\n\nHost: ${metadata.cpu}, ${metadata.hostCpus} logical CPUs, ${metadata.memoryGiB} GiB; ${metadata.platform}. Docker: ${metadata.docker}. k6: ${metadata.k6}.\n\nApplication containers: 1 CPU / 512 MiB each; PostgreSQL: 2 CPUs / 512 MiB; Redis and receiver proxy: 1 CPU / 256 MiB. DB pools: 10 per process. One relay, 100 events per ten-second tick.\n\n| Scenario | Accepted | Delivered / failed | API p95 ms | Delivery p95 ms | Drain s | Recovery s | Peak pending | Peak outbox | Pass |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${results.map((r) => `| ${r.name} | ${r.accepted} | ${r.snapshot.delivered} / ${r.snapshot.failed} | ${number(r.apiMs.p95)} | ${number(r.acceptanceToObservedDeliveryMs.p95)} | ${number(r.drainAfterIngressSeconds)} | ${number(r.recoverySeconds)} | ${r.peakPending} | ${r.peakUnpublished} | ${Object.values(r.checks).every(Boolean) ? 'PASS' : 'FAIL'} |`).join('\n')}\n\nAPI timings cover forwarding the POST and reading its response; k6 also measures gateway overhead. Delivery timings start at the API acknowledgment and end when a committed terminal state is observed by a host-side database poll on the same monotonic clock. They include polling delay and are upper bounds, not exact receiver latency. Per-scenario maximum observation intervals are in result.json. No persisted wall-clock timestamps are used for latency. Failed events are excluded from delivery percentiles and reported separately.\n\nRecovery measurements start with an entirely published queue and include worker container startup. The observer adds database read load; docker stats and metric collection add overhead. Counts are run-scoped. Throughput over the whole run includes publication and draining. Cron phase varies between runs; repeat runs before drawing small-effect conclusions. This is a short local benchmark, not a VPS capacity claim or saturation proof.\n\nRaw k6 metrics, database/backlog samples, container CPU/memory samples, Node runtime/queue metrics, and results are saved alongside this report.\n`;
}

await mkdir(output, { recursive: true });
try {
  const metadata = {
    startedAt: new Date().toISOString(),
    commit: await command('git', ['rev-parse', 'HEAD']),
    cpu: cpus()[0]?.model,
    hostCpus: availableParallelism(),
    memoryGiB: (totalmem() / 1024 ** 3).toFixed(2),
    platform: platform(),
    docker: await docker('version', '--format', '{{.Server.Version}}'),
    node: process.version,
    k6: await command('k6', ['version']),
    dockerResources: JSON.parse(
      await docker(
        'info',
        '--format',
        '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}',
      ),
    ),
  };
  await writeFile(
    resolve(output, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );
  await compose([
    'up',
    '-d',
    ...(process.argv.includes('--no-build') ? ['--no-build'] : ['--build']),
  ]);
  metadata.applicationImage = await docker(
    'image',
    'inspect',
    'hookrelay:load',
    '--format',
    '{{.Id}}',
  );
  await writeFile(
    resolve(output, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );
  pool = new pg.Pool({
    host: '127.0.0.1',
    port: await port('postgres', 5432),
    user: 'loadtest',
    password: 'loadtest',
    database: 'loadtest',
    max: 2,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  const {
    rows: [existingWork],
  } = await pool.query(
    "SELECT count(*)::int AS pending FROM events WHERE status='pending'",
  );
  assert.equal(
    existingWork.pending,
    0,
    'Previous benchmark work is still pending. Drain it before comparing new runs; see docs/load-testing.md.',
  );
  for (const [name, config] of selected) {
    const result = await runCase(name, config);
    results.push(result);
    if (!Object.values(result.checks).every(Boolean)) {
      process.exitCode = 1;
      break; // Do not carry an undrained or invalid run into the next comparison.
    }
  }
  await writeFile(resolve(output, 'report.md'), report(metadata));
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(results, null, 2),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await writeFile(resolve(output, 'error.txt'), String(error.stack ?? error));
} finally {
  await pool?.end();
  // Only the fixed benchmark project is stopped; volumes and evidence remain.
  await compose(['stop']).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  console.log(`Benchmark evidence: ${output}`);
}
