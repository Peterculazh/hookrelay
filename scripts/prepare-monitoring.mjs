import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const output = new URL('.tmp/monitoring/', root);
const load = async (path) =>
  (await readFile(new URL(path, root), 'utf8')).replaceAll('\r\n', '\n');
const files = await Promise.all(
  [
    'k8s/monitoring.yaml',
    'observability/prometheus-vps.yml',
    'observability/grafana/provisioning/datasources/prometheus.yml',
    'observability/grafana/provisioning/dashboards/hookrelay.yml',
    'observability/grafana/dashboards/hookrelay.json',
  ].map(load),
);
const checksum = createHash('sha256').update(files.join('\n')).digest('hex');
const configMap = (name, data) => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: {
    name,
    namespace: 'hookrelay-monitoring',
    labels: { 'app.kubernetes.io/part-of': 'hookrelay-monitoring' },
  },
  data,
});
const maps = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    configMap('hookrelay-prometheus', { 'prometheus.yml': files[1] }),
    configMap('hookrelay-grafana-provisioning', {
      'datasource.yml': files[2],
      'dashboard.yml': files[3],
    }),
    configMap('hookrelay-grafana-dashboard', { 'hookrelay.json': files[4] }),
  ],
};
await mkdir(output, { recursive: true });
await writeFile(
  new URL('monitoring.yaml', output),
  files[0].replaceAll('CONFIGURATION_SHA256', checksum),
);
await writeFile(
  new URL('configmaps.json', output),
  JSON.stringify(maps, null, 2) + '\n',
);
await writeFile(new URL('prometheus.yml', output), files[1]);
await writeFile(
  new URL('metadata.json', output),
  JSON.stringify(
    {
      checksum,
      namespace: 'hookrelay-monitoring',
      retentionDays: 7,
      retentionSize: '1GB',
    },
    null,
    2,
  ) + '\n',
);
console.log('Prepared .tmp/monitoring (no credentials or connection details).');
