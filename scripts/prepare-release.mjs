import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Read manifests from the selected commit, rather than from a newer checkout.
const [commit, image, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, 'Usage: npm run prepare:release -- <full-commit> <image:sha-commit@sha256:digest>');
assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Use the full lowercase Git commit SHA');
assert.match(image ?? '', /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*:sha-[a-f0-9]{40}@sha256:[a-f0-9]{64}$/, 'Use the GHCR commit tag and digest from the CI summary');
assert.ok(image.includes(`:sha-${commit}@`), 'The image tag must match the selected commit');
const root = fileURLToPath(new URL('../', import.meta.url));
const resolved = execFileSync('git', ['rev-parse', `${commit}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(resolved, commit, 'The selected commit must exist locally');
const output = new URL(`../.tmp/releases/${commit}/`, import.meta.url);
const files = ['migrate.yaml', 'test-receiver.yaml', 'hookrelay.yaml', 'worker.yaml', 'relay.yaml'];
const prepared = files.map((file) => {
  let contents = execFileSync('git', ['show', `${commit}:k8s/${file}`], { cwd: root, encoding: 'utf8' }).replaceAll('\r\n', '\n');
  const imageLine = /^([ \t]*)image: hookrelay:[a-zA-Z0-9_.-]+$/gm;
  assert.equal([...contents.matchAll(imageLine)].length, 1, `Expected one application image in ${file}`);
  assert.equal(contents.split('imagePullPolicy: Never').length, 2, `Expected one imported-image policy in ${file}`);
  assert.equal(contents.split('      containers:').length, 2, `Expected one Pod spec in ${file}`);
  assert.match(contents, /namespace: hookrelay/, `Unexpected namespace in ${file}`);
  contents = contents.replace(imageLine, `$1image: ${image}`)
    .replace('imagePullPolicy: Never', 'imagePullPolicy: IfNotPresent')
    .replace('      containers:', '      imagePullSecrets:\n        - name: ghcr-credentials\n      containers:');
  if (file === 'migrate.yaml') {
    const jobName = /^  name: hookrelay-migrate-[a-z0-9-]+$/gm;
    assert.equal([...contents.matchAll(jobName)].length, 1, 'Expected one migration Job name');
    contents = contents.replace(jobName, `  name: hookrelay-migrate-${commit}`);
  }
  if (file === 'relay.yaml') {
    assert.match(contents, /strategy:\n    type: Recreate/, 'Release must preserve the single-relay Recreate strategy');
    assert.match(contents, /replicas: 1\n/, 'Release must preserve one relay replica');
  }
  return [file, contents];
});
// Refuse to overwrite a bundle: a commit tag may be republished with a new digest.
await mkdir(new URL('../', output), { recursive: true });
await mkdir(output);
for (const [file, contents] of prepared) await writeFile(new URL(file, output), contents);
await writeFile(new URL('commit.txt', output), `${commit}\n`);
await writeFile(new URL('image.txt', output), `${image}\n`);
console.log(`Prepared release ${commit} in ${fileURLToPath(output)}`);
console.log('Review the bundle, then follow docs/versioned-deployment.md. Storage and configuration are not included.');
