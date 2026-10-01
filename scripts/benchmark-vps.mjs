import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { cases, tuningCases, quantiles } from '../load/profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const profile = process.argv[2] ?? 'baseline';
const profiles = { ...cases, ...tuningCases };
assert.ok(
  profile === 'suite' || Object.hasOwn(profiles, profile),
  'Unknown benchmark profile',
);
const target = process.env.VPS_SSH_TARGET;
assert.match(
  target ?? '',
  /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/,
  'Set VPS_SSH_TARGET to the existing SSH destination',
);
const ssh = process.env.SSH_EXECUTABLE ?? 'ssh';
const sshArgs = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
];
if (process.env.VPS_SSH_KEY)
  sshArgs.push('-i', process.env.VPS_SSH_KEY, '-o', 'IdentitiesOnly=yes');
const { stdout: commitOutput } = await exec('git', ['rev-parse', 'HEAD'], {
  cwd: root,
});
const commit = process.env.VPS_RELEASE_COMMIT ?? commitOutput.trim();
assert.match(commit, /^[a-f0-9]{40}$/);
const relayOverrides = [
  process.env.BENCH_RELAY_BATCH_SIZE,
  process.env.BENCH_RELAY_INTERVAL_SECONDS,
];
assert.ok(
  relayOverrides.every((v) => v === undefined) ||
    relayOverrides.every((v) => v !== undefined),
  'Set both relay benchmark settings together',
);
const relayConfiguration = relayOverrides.every((v) => v !== undefined)
  ? {
      batchSize: Number(relayOverrides[0]),
      publishEverySeconds: Number(relayOverrides[1]),
    }
  : undefined;
if (relayConfiguration) {
  assert.ok(
    Number.isInteger(relayConfiguration.batchSize) &&
      relayConfiguration.batchSize >= 1 &&
      relayConfiguration.batchSize <= 1000,
  );
  assert.ok(
    Number.isInteger(relayConfiguration.publishEverySeconds) &&
      relayConfiguration.publishEverySeconds >= 1 &&
      relayConfiguration.publishEverySeconds <= 60 &&
      60 % relayConfiguration.publishEverySeconds === 0,
  );
}
const session = randomUUID();
const output = resolve(
  root,
  '.tmp',
  'vps-benchmarks',
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${profile}`,
);
const selected =
  profile === 'suite'
    ? Object.entries(cases)
    : [[profile, { ...profiles[profile] }]];
if (profile !== 'suite') {
  for (const [key, variable, min, max] of [
    ['rate', 'BENCH_RATE', 1, 500],
    ['seconds', 'BENCH_SECONDS', 1, 120],
    ['concurrency', 'BENCH_CONCURRENCY', 1, 100],
    ['replicas', 'BENCH_REPLICAS', 1, 4],
  ]) {
    if (process.env[variable] === undefined) continue;
    const value = Number(process.env[variable]);
    assert.ok(
      Number.isInteger(value) && value >= min && value <= max,
      `${variable} out of range`,
    );
    selected[0][1][key] = value;
  }
}
await mkdir(output, { recursive: true });
const controllerCode = await readFile(
  resolve(root, 'load/vps-controller.py'),
  'utf8',
);
const observerCode = await readFile(
  resolve(root, 'load/vps-observer.mjs'),
  'utf8',
);
const proxyCode = await readFile(
  resolve(root, 'load/receiver-proxy.mjs'),
  'utf8',
);
const rpc = new Map();
let requestId = 0;
let current;
let interrupted = false;
let activeK6;
let gateway;
let tunnel;
let remote;
let setup = false;
let metadata;
const results = [];
const resources = [];
const metricsSeen = new Set();
const ready = {};
ready.promise = new Promise((done, reject) => {
  ready.done = done;
  ready.reject = reject;
});
const checkInterrupted = () => assert.ok(!interrupted, 'Benchmark interrupted');
const stop = () => {
  interrupted = true;
  activeK6?.kill('SIGINT');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function remoteCommand(action, payload = {}) {
  const id = ++requestId;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      rpc.delete(id);
      reject(new Error(`Remote ${action} timed out`));
    }, 240000);
    rpc.set(id, { done, reject, timer });
    remote.stdin.write(JSON.stringify({ id, action, ...payload }) + '\n');
  });
}

function observe(message) {
  if (message.kind === 'resources') {
    resources.push({ observedAtMs: performance.now(), ...message });
    if (current) current.resources.push(message);
    return;
  }
  if (!current || message.type !== current.type) return;
  if (message.kind === 'observerError') {
    current.errors.push(message.error);
    return;
  }
  if (message.kind !== 'observation') return;
  const now = performance.now();
  const snapshot = {
    total: message.rows.length,
    pending: 0,
    delivered: 0,
    failed: 0,
    unpublished: 0,
    effects: 0,
    attempts: 0,
  };
  for (const row of message.rows) {
    snapshot[row.status]++;
    snapshot.unpublished += Number(row.unpublished);
    snapshot.effects += Number(row.effect);
    snapshot.attempts += row.attempts;
    const entry = current.accepted.get(row.id);
    if (entry && !entry.observed && row.status !== 'pending') {
      entry.observed = now;
      entry.status = row.status;
      current.lastCompletion = now;
    }
  }
  current.maxInterval = Math.max(
    current.maxInterval,
    now - current.lastObservation,
  );
  current.lastObservation = now;
  current.snapshot = snapshot;
  current.outcomes = message.outcomes;
  for (const entry of message.metrics ?? []) {
    if (!entry.error) metricsSeen.add(entry.name);
    else if (metricsSeen.has(entry.name))
      current.errors.push(`${entry.name}: metrics unavailable after startup`);
  }
  current.samples.push({
    seconds: (now - current.started) / 1000,
    ...snapshot,
    database: message.database,
    queue: message.queue,
    metrics: message.metrics,
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function forwarding() {
  const { port: remotePort } = await remoteCommand('forward_api');
  const port = await freePort();
  tunnel = spawn(
    ssh,
    [
      ...sshArgs,
      '-o',
      'ExitOnForwardFailure=yes',
      '-N',
      '-L',
      `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
      target,
    ],
    { stdio: 'ignore' },
  );
  tunnel.on('error', (error) => ready.reject(error));
  const base = `http://127.0.0.1:${port}`;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    checkInterrupted();
    try {
      const response = await fetch(`${base}/health/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      await response.text();
      if (response.status === 200) return base;
    } catch {
      /* wait for the SSH tunnel */
    }
    await sleep(250);
  }
  throw new Error('Remote API readiness failed');
}

async function runCase(name, config) {
  const replicas = config.replicas ?? 1;
  const concurrency = config.concurrency ?? 1;
  await remoteCommand('configure', {
    replicas: config.paused ? 0 : replicas,
    concurrency,
  });
  checkInterrupted();
  metricsSeen.clear();
  const directory = resolve(output, name);
  await mkdir(directory, { recursive: true });
  current = {
    type: `benchmark.${randomUUID()}`,
    started: performance.now(),
    accepted: new Map(),
    samples: [],
    resources: [],
    errors: [],
    snapshot: { total: 0, pending: 0, unpublished: 0 },
    maxInterval: 0,
    lastObservation: performance.now(),
    outcomes: [],
  };
  await remoteCommand('observe', { type: current.type, source: observerCode });
  console.log(
    `VPS ${name}: ${config.rate}/s × ${config.seconds}s; workers=${config.paused ? 0 : replicas}, concurrency=${concurrency}`,
  );
  activeK6 = spawn('k6', ['run', '--quiet', 'load/k6-events.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BENCH_URL: `http://127.0.0.1:${gateway.address().port}`,
      EVENT_TYPE: current.type,
      RATE: String(config.rate),
      DURATION: `${config.seconds}s`,
      DELAY_MS: String(config.delayMs ?? 0),
      FAIL_ATTEMPTS: String(config.failAttempts ?? 0),
      SUMMARY_PATH: resolve(directory, 'k6.json'),
      API_P95_MS: process.env.API_P95_MS ?? '1000',
    },
  });
  current.ingressStarted = performance.now();
  let log = '';
  for (const stream of [activeK6.stdout, activeK6.stderr])
    stream.on('data', (chunk) => {
      log += chunk;
      process.stdout.write(chunk);
    });
  const exitCode = await new Promise((done, reject) => {
    activeK6.on('exit', done);
    activeK6.on('error', reject);
  });
  activeK6 = null;
  current.ingressDone = performance.now();
  await writeFile(resolve(directory, 'k6.log'), log);
  checkInterrupted();
  if (config.paused) {
    const deadline = performance.now() + 90000;
    while (
      (current.snapshot.total < current.accepted.size ||
        current.snapshot.unpublished) &&
      performance.now() < deadline
    ) {
      checkInterrupted();
      await sleep(250);
    }
    assert.equal(current.snapshot.total, current.accepted.size);
    assert.equal(current.snapshot.unpublished, 0, 'Backlog did not publish');
    current.recoveryStarted = performance.now();
    await remoteCommand('configure', { replicas, concurrency });
    await remoteCommand('observe', {
      type: current.type,
      source: observerCode,
    });
  }
  const deadline = performance.now() + 180000;
  while (
    (current.snapshot.total < current.accepted.size ||
      current.snapshot.pending ||
      current.snapshot.unpublished ||
      [...current.accepted.values()].some((e) => !e.observed)) &&
    performance.now() < deadline
  ) {
    checkInterrupted();
    await sleep(250);
  }
  const summary = JSON.parse(
    await readFile(resolve(directory, 'k6.json'), 'utf8'),
  );
  const entries = [...current.accepted.values()];
  const expected = config.expected ?? 'delivered';
  const failures = current.outcomes
    .filter(
      (a) =>
        a.status === 'failed' &&
        a.error_code === (name === 'timeout' ? 'TIMEOUT' : 'HTTP_ERROR') &&
        a.http_status === (name === 'timeout' ? null : 503),
    )
    .reduce((sum, a) => sum + a.count, 0);
  const successes = current.outcomes
    .filter((a) => a.status === 'succeeded' && a.http_status === 204)
    .reduce((sum, a) => sum + a.count, 0);
  const snapshot = current.snapshot;
  const checks = {
    k6: exitCode === 0,
    tracked:
      current.accepted.size === summary.metrics.events_accepted?.values.count &&
      current.accepted.size === summary.metrics.iterations.values.count,
    rate: Math.abs(current.accepted.size - config.rate * config.seconds) <= 1,
    terminal:
      snapshot.total === current.accepted.size &&
      snapshot.pending === 0 &&
      entries.every((e) => e.status === expected),
    effects:
      snapshot.effects === (expected === 'delivered' ? entries.length : 0),
    attempts:
      snapshot.attempts ===
      entries.length *
        (expected === 'failed' ? 3 : (config.failAttempts ?? 0) + 1),
    outcomes:
      failures ===
        entries.length *
          (expected === 'failed' ? 3 : (config.failAttempts ?? 0)) &&
      successes === (expected === 'delivered' ? entries.length : 0),
    observer: current.errors.length === 0,
    resources:
      current.resources.some((sample) => sample.pods?.length) &&
      current.resources.every((sample) => !sample.error),
    metrics:
      metricsSeen.has('relay') &&
      [...metricsSeen].some((n) => n.startsWith('hookrelay/')) &&
      [...metricsSeen].filter((n) => n.startsWith('worker/')).length >=
        replicas,
  };
  const elapsed = (current.lastCompletion - current.started) / 1000;
  const result = {
    name,
    type: current.type,
    config: { ...config, replicas, concurrency, relay: metadata.relaySettings },
    checks,
    snapshot,
    attemptOutcomes: current.outcomes,
    acceptedPerSecond: entries.length / config.seconds,
    deliveredPerSecondOverWholeRun: snapshot.delivered / elapsed,
    apiMs: quantiles(entries.map((e) => e.apiMs)),
    deliveryMs: quantiles(
      entries
        .filter((e) => e.status === 'delivered')
        .map((e) => e.observed - e.ack),
    ),
    failureMs: quantiles(
      entries
        .filter((e) => e.status === 'failed')
        .map((e) => e.observed - e.ack),
    ),
    totalSeconds: elapsed,
    drainSeconds: Math.max(
      0,
      (current.lastCompletion - current.ingressDone) / 1000,
    ),
    recoverySeconds: current.recoveryStarted
      ? (current.lastCompletion - current.recoveryStarted) / 1000
      : null,
    peakPending: Math.max(...current.samples.map((s) => s.pending)),
    peakUnpublished: Math.max(...current.samples.map((s) => s.unpublished)),
    peakDatabaseConnections: Math.max(
      ...current.samples.map((s) => s.database.connections),
    ),
    maxObservationIntervalMs: current.maxInterval,
    errors: current.errors,
  };
  const steadySamples = current.samples.filter(
    (s) =>
      s.seconds >= (current.ingressStarted - current.started) / 1000 + 20 &&
      s.seconds <= (current.ingressDone - current.started) / 1000,
  );
  if (steadySamples.length >= 2) {
    const first = steadySamples[0];
    const last = steadySamples.at(-1);
    result.steadyState = {
      observationWindowSeconds: last.seconds - first.seconds,
      deliveredPerSecond:
        (last.delivered - first.delivered) / (last.seconds - first.seconds),
      initialUnpublished: first.unpublished,
      finalUnpublished: last.unpublished,
      peakUnpublished: Math.max(...steadySamples.map((s) => s.unpublished)),
    };
  }
  await writeFile(
    resolve(directory, 'samples.json'),
    JSON.stringify(current.samples, null, 2),
  );
  await writeFile(
    resolve(directory, 'resources.json'),
    JSON.stringify(current.resources, null, 2),
  );
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(
    `${name}: ${snapshot.delivered} delivered / ${snapshot.failed} failed; ${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'}`,
  );
  current = null;
  return result;
}

try {
  const encoded = Buffer.from(controllerCode).toString('base64');
  remote = spawn(
    ssh,
    [
      ...sshArgs,
      target,
      `python3 -u -c 'exec(__import__("base64").b64decode("${encoded}"))'`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  remote.on('error', ready.reject);
  remote.on('exit', () => {
    ready.reject(new Error('VPS controller disconnected'));
    for (const entry of rpc.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('VPS controller disconnected'));
    }
    rpc.clear();
  });
  remote.stderr.on('data', () => {}); // Keep connection details out of saved evidence.
  createInterface({ input: remote.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.kind === 'ready') ready.done();
      else if (message.id) {
        const entry = rpc.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          rpc.delete(message.id);
          message.error
            ? entry.reject(new Error(message.error))
            : entry.done(message.result);
        }
      } else observe(message);
    } catch {
      current?.errors.push('Invalid controller output');
    }
  });
  await Promise.race([
    ready.promise,
    sleep(15000).then(() => {
      throw new Error('VPS controller did not start');
    }),
  ]);
  setup = true; // The server also restores after partial setup failures or disconnects.
  metadata = await remoteCommand('setup', {
    session,
    commit,
    proxy: proxyCode,
  });
  if (relayConfiguration) {
    metadata.relaySettings = await remoteCommand(
      'configure_relay',
      relayConfiguration,
    );
  }
  metadata = {
    ...metadata,
    session,
    commit,
    startedAt: new Date().toISOString(),
    network: 'Local PC → SSH tunnel → kubectl port-forward → VPS API',
    generatorNode: process.version,
    generatorK6: (await exec('k6', ['version'])).stdout.trim(),
    apiP95GuardMs: Number(process.env.API_P95_MS ?? 1000),
  };
  await writeFile(
    resolve(output, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );
  const base = await forwarding();
  gateway = createServer(async (req, res) => {
    if (!current || req.method !== 'POST' || req.url !== '/v1/events')
      return res.writeHead(404).end();
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) return res.writeHead(413).end();
      }
      const sent = performance.now();
      const response = await fetch(`${base}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(4000),
      });
      const text = await response.text();
      const ack = performance.now();
      if (response.status === 202) {
        const { id } = JSON.parse(text);
        current.accepted.set(id, { ack, apiMs: ack - sent });
      }
      res
        .writeHead(response.status, {
          'content-type': 'application/json',
          'x-benchmark-api-duration-ms': String(ack - sent),
        })
        .end(text);
    } catch {
      current?.errors.push('API forwarding failed');
      if (!res.headersSent) res.writeHead(502).end('{}');
    }
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  for (const [name, config] of selected) {
    checkInterrupted();
    const result = await runCase(name, config);
    results.push(result);
    if (!Object.values(result.checks).every(Boolean)) {
      process.exitCode = 1;
      break;
    }
  }
} catch (error) {
  console.error(error.message);
  await writeFile(resolve(output, 'error.txt'), error.message);
  process.exitCode = 1;
} finally {
  activeK6?.kill('SIGINT');
  if (gateway)
    await new Promise((done) => {
      gateway.close(done);
      gateway.closeAllConnections();
    });
  if (setup && remote?.exitCode === null) {
    try {
      const restoration = await remoteCommand('restore');
      await writeFile(
        resolve(output, 'restoration.json'),
        JSON.stringify(restoration),
      );
      if (restoration.fixtureRetained) {
        console.error(
          'Settings restored; receiver retained for pending benchmark jobs.',
        );
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Restore: ${error.message}`);
      process.exitCode = 1;
    }
  }
  remote?.stdin.end();
  tunnel?.kill();
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(results, null, 2),
  );
  await writeFile(
    resolve(output, 'resources.json'),
    JSON.stringify(resources, null, 2),
  );
  const number = (v) => (v == null ? '—' : v.toFixed(2));
  await writeFile(
    resolve(output, 'report.md'),
    `# VPS benchmark\n\nApplication release: ${commit}. Traffic generated on the local PC. Network path: SSH plus Kubernetes port-forward. VPS hardware, workload resources, images, and original settings are recorded in metadata.json.\n\n| Scenario | Accepted/s | Delivered/s over full run | API p95 ms | Delivery p95 ms | Drain s | Recovery s | Peak outbox | Pass |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n${results.map((r) => `| ${r.name} | ${number(r.acceptedPerSecond)} | ${number(r.deliveredPerSecondOverWholeRun)} | ${number(r.apiMs.p95)} | ${number(r.deliveryMs.p95)} | ${number(r.drainSeconds)} | ${number(r.recoverySeconds)} | ${r.peakUnpublished} | ${Object.values(r.checks).every(Boolean) ? 'PASS' : 'FAIL'} |`).join('\n')}\n\nAPI latency includes network/tunnel overhead. Delivery completion is observed on the PC from committed database snapshots streamed from the VPS on the same monotonic client clock as API acknowledgment. Latency includes observer polling and network delay; maximum observation intervals are recorded. Observer restarts during worker configuration can lengthen these intervals. Raw Node, queue, database, and K3s resource samples are retained. The benchmark receiver and observer also consume VPS resources. These short runs do not establish maximum sustainable production RPS.\n`,
  );
  console.log(`VPS evidence: ${output}`);
}
