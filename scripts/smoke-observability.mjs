import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

// Deliberately targets the local development stack and restores stopped services.
const composeArgs = ['compose', '-f', 'docker-compose.yml'];
const compose = (...args) =>
  execFileSync('docker', [...composeArgs, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
const address = (service, port) =>
  `http://${compose('port', service, port).trim()}`;
const api = address('hookrelay', '3000');
const prometheus = address('prometheus', '9090');
const grafana = address('grafana', '3000');
const ids = [];

async function json(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(4000),
  });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
}
async function query(expr) {
  const result = await json(
    `${prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`,
  );
  assert.equal(result.status, 'success');
  return result.data.result;
}
async function value(expr) {
  const results = await query(expr);
  return results.length ? Number(results[0].value[1]) : NaN;
}
async function until(description, check, timeout = 90_000) {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try {
      if (await check()) {
        console.log(`PASS: ${description}`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out: ${description}`, { cause: lastError });
}
async function submit() {
  const event = await json(`${api}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'observability.test',
      payload: { source: 'smoke-observability' },
    }),
  });
  ids.push(event.id);
  return event.id;
}
const eventStatus = async (id) => (await json(`${api}/v1/events/${id}`)).status;

try {
  await until(
    'all three Prometheus targets up',
    async () => (await value('sum(up{job=~"hookrelay-.*"})')) === 3,
  );
  const successes = await value(
    'sum(hookrelay_delivery_attempts_total{outcome="succeeded"})',
  );
  const normal = await submit();
  await until(
    'normal delivery recorded and scraped',
    async () =>
      (await eventStatus(normal)) === 'delivered' &&
      (await value(
        'sum(hookrelay_delivery_attempts_total{outcome="succeeded"})',
      )) > successes,
  );

  const failures = await value(
    'sum(hookrelay_delivery_attempts_total{outcome="failed"})',
  );
  compose('stop', 'test-receiver');
  const failed = await submit();
  await until(
    'receiver outage produces three failed attempts',
    async () =>
      (await eventStatus(failed)) === 'failed' &&
      (await value(
        'sum(hookrelay_delivery_attempts_total{outcome="failed"})',
      )) >=
        failures + 3,
  );
  compose('start', 'test-receiver');
  await until('receiver healthy', () =>
    compose('ps', '--format', 'json', 'test-receiver').includes(
      '"Health":"healthy"',
    ),
  );

  compose('stop', 'relay');
  const backlog = [];
  for (let i = 0; i < 5; i++) backlog.push(await submit());
  await until(
    'relay down and outbox backlog visible from API',
    async () =>
      (await value('up{job="hookrelay-relay"}')) === 0 &&
      (await value('hookrelay_outbox_unpublished')) >= 5,
  );
  compose('start', 'relay');
  await until(
    'relay restart drains outbox backlog',
    async () =>
      (await value('hookrelay_outbox_unpublished')) === 0 &&
      (await Promise.all(backlog.map(eventStatus))).every(
        (status) => status === 'delivered',
      ),
  );
  await until(
    'queue gauges drained',
    async () =>
      (await value('sum(hookrelay_queue_jobs)')) === 0 &&
      (await value('up{job="hookrelay-worker"}')) === 1,
  );

  compose('stop', 'worker');
  const queued = [];
  for (let i = 0; i < 5; i++) queued.push(await submit());
  await until(
    'worker down while relay publishes and queue backlog remains visible',
    async () =>
      (await value('up{job="hookrelay-worker"}')) === 0 &&
      (await value('up{job="hookrelay-relay"}')) === 1 &&
      (await value('hookrelay_outbox_unpublished')) === 0 &&
      (await value('hookrelay_queue_jobs{service="relay",state="waiting"}')) >=
        5 &&
      (await Promise.all(queued.map(eventStatus))).every(
        (status) => status === 'pending',
      ),
  );
  compose('start', 'worker');
  await until(
    'worker restart drains queued deliveries',
    async () =>
      (await Promise.all(queued.map(eventStatus))).every(
        (status) => status === 'delivered',
      ) &&
      (await value('sum(hookrelay_queue_jobs{service="relay"})')) === 0 &&
      (await value('up{job="hookrelay-worker"}')) === 1,
  );

  const lines = compose(
    'logs',
    '--no-color',
    '--no-log-prefix',
    'hookrelay',
    'worker',
    'relay',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const id of [normal, ...backlog, ...queued]) {
    const logs = lines.filter((line) => line.eventId === id);
    for (const action of [
      'event.accepted',
      'job.published',
      'delivery.succeeded',
    ]) {
      const log = logs.find((line) => line.action === action);
      assert.ok(log, `${id}: missing ${action}`);
      assert.equal(log.jobId, id);
      assert.equal(
        log.service,
        action === 'event.accepted'
          ? 'api'
          : action === 'job.published'
            ? 'relay'
            : 'worker',
      );
      assert.ok(log.durationMs >= 0);
      if (action === 'delivery.succeeded') assert.ok(log.attemptId);
    }
  }
  assert.equal(
    lines.filter(
      (line) => line.eventId === failed && line.action === 'delivery.failed',
    ).length,
    3,
  );
  console.log(
    `PASS: JSON logs correlate acceptance, publication, delivery, and retries. Event: ${normal}`,
  );

  const dashboard = JSON.parse(
    readFileSync(
      new URL(
        '../observability/grafana/dashboards/hookrelay.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      const expr = target.expr
        .replaceAll('$__rate_interval', '1m')
        .replaceAll('$__range', '15m');
      assert.ok((await query(expr)).length > 0, `No data: ${panel.title}`);
    }
  }
  const credentials = Buffer.from(
    `admin:${process.env.GRAFANA_ADMIN_PASSWORD ?? 'hookrelay-local'}`,
  ).toString('base64');
  const provisioned = await json(
    `${grafana}/api/dashboards/uid/hookrelay-overview`,
    { headers: { Authorization: `Basic ${credentials}` } },
  );
  assert.equal(provisioned.dashboard.panels.length, dashboard.panels.length);
  console.log(
    `PASS: Grafana dashboard provisioned; every panel query returns data. ${grafana}/d/hookrelay-overview`,
  );
} finally {
  compose('start', 'test-receiver', 'relay', 'worker');
  console.log(`Created test events: ${ids.join(', ')}`);
}
