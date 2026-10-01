import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const loginFile = resolve(
  process.env.USERPROFILE ?? process.env.HOME,
  'HookRelayMonitoring',
  'grafana-login.txt',
);
const login = await readFile(loginFile, 'utf8');
const address = new URL(
  process.env.GRAFANA_URL ?? login.match(/^Grafana: (.+)$/m)[1],
);
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname),
  'Use a local SSH tunnel',
);
const username = login.match(/^Username: (.+)$/m)[1];
const password = login.match(/^Password: (.+)$/m)[1];
const authorization =
  'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
const request = async (path) => {
  const response = await fetch(new URL(path, address.origin), {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, 'Monitoring API request failed');
  return response.json();
};
const unauthenticated = await fetch(
  new URL('/api/dashboards/uid/hookrelay-overview', address.origin),
  { signal: AbortSignal.timeout(10000) },
);
assert.equal(unauthenticated.status, 401, 'Dashboard must require login');
const datasource = await request(
  '/api/datasources/uid/hookrelay-prometheus/health',
);
assert.equal(datasource.status, 'OK');
const expected = JSON.parse(
  await readFile(
    new URL(
      '../observability/grafana/dashboards/hookrelay.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const { dashboard } = await request('/api/dashboards/uid/hookrelay-overview');
assert.equal(dashboard.panels.length, expected.panels.length);
const proxy = '/api/datasources/proxy/uid/hookrelay-prometheus';
const targets = (await request(proxy + '/api/v1/targets')).data.activeTargets;
assert.deepEqual(
  new Set(targets.map((t) => t.labels.job)),
  new Set(['hookrelay-api', 'hookrelay-worker', 'hookrelay-relay']),
);
assert.ok(targets.every((t) => t.health === 'up'));
const panels = [];
const end = Date.now() / 1000;
for (const panel of expected.panels) {
  const actual = dashboard.panels.find((p) => p.id === panel.id);
  assert.deepEqual(
    actual.targets.map((t) => t.expr),
    panel.targets.map((t) => t.expr),
  );
  for (const target of panel.targets) {
    const expr = target.expr
      .replaceAll('$__rate_interval', '1m')
      .replaceAll('$__range', '5m');
    const params = new URLSearchParams({
      query: expr,
      start: String(end - 300),
      end: String(end),
      step: '5',
    });
    const response = await request(proxy + '/api/v1/query_range?' + params);
    assert.equal(response.status, 'success');
    const series = response.data.result;
    const finiteSamples = series.reduce(
      (sum, s) =>
        sum + s.values.filter(([, v]) => Number.isFinite(Number(v))).length,
      0,
    );
    assert.ok(finiteSamples > 0, 'No finite data: ' + panel.title);
    panels.push({
      id: panel.id,
      title: panel.title,
      refId: target.refId,
      series: series.length,
      finiteSamples,
    });
  }
}
const result = {
  verifiedAt: new Date().toISOString(),
  localPort: Number(address.port),
  dashboardUid: dashboard.uid,
  dashboardPanels: expected.panels.length,
  requiresLogin: true,
  datasourceHealthy: true,
  targets: targets.map((t) => ({ job: t.labels.job, health: t.health })),
  panels,
};
await writeFile(
  new URL('../.tmp/monitoring-smoke.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  `PASS: ${expected.panels.length} dashboard panels, ${panels.length} queries, all application scrape targets healthy; login required.`,
);
