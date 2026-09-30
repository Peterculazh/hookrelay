import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Each release needs a new image tag and migration Job name.
const release = process.argv[2];
assert.match(
  release ?? '',
  /^[a-z0-9][a-z0-9-]{0,29}$/,
  'Usage: npm run prepare:vps -- <release>, e.g. vps-1 (max 30 lowercase letters, digits, hyphens)',
);
const root = new URL('../', import.meta.url);
const output = new URL(`.tmp/${release}/`, root);
const files = [
  'namespace.yaml',
  'configmap.yaml',
  'postgres-pvc.yaml',
  'postgres.yaml',
  'redis.yaml',
  'migrate.yaml',
  'test-receiver.yaml',
  'test-receiver-service.yaml',
  'hookrelay.yaml',
  'worker.yaml',
  'relay.yaml',
];
const applications = new Set([
  'migrate.yaml', 'test-receiver.yaml', 'hookrelay.yaml', 'worker.yaml', 'relay.yaml',
]);
const prepared = await Promise.all(files.map(async (file) => {
  let contents = (await readFile(new URL(`k8s/${file}`, root), 'utf8')).replaceAll('\r\n', '\n');
  if (applications.has(file)) {
    const image = /^([ \t]*)image: hookrelay:[a-zA-Z0-9_.-]+$/gm;
    assert.equal([...contents.matchAll(image)].length, 1, `Expected one application image in ${file}`);
    assert.match(contents, /imagePullPolicy: Never/, `${file} must use the imported image`);
    contents = contents.replace(image, `$1image: hookrelay:${release}`);
  }
  if (file === 'postgres-pvc.yaml' || file === 'redis.yaml') {
    assert.equal(contents.split('storageClassName: standard').length, 2, `Expected one storage class in ${file}`);
    contents = contents.replace('storageClassName: standard', 'storageClassName: local-path');
  }
  if (file === 'migrate.yaml') {
    const name = /^  name: hookrelay-migrate-[a-z0-9-]+$/gm;
    assert.equal([...contents.matchAll(name)].length, 1, 'Expected one migration Job name');
    contents = contents.replace(name, `  name: hookrelay-migrate-${release}`);
  }
  return [file, contents];
}));
await mkdir(output, { recursive: true });
for (const [file, contents] of prepared) {
  await writeFile(new URL(file, output), contents);
}
console.log(`Prepared ${prepared.length} manifests in ${fileURLToPath(output)}`);
console.log(`Image: hookrelay:${release}; migration Job: hookrelay-migrate-${release}`);
console.log('Follow docs/vps-deployment.md. Apply in stages; migrations must succeed before starting applications.');
