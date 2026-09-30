import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.join(root, '.tmp');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const image = `ghcr.io/example/hookrelay:sha-${commit}@sha256:${'a'.repeat(64)}`;
const bash = process.env.RELEASE_TEST_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const portable = (value) => value.replaceAll('\\', '/');

test('release selection rejects a different image commit before writing a bundle', () => {
  const otherImage = image.replace(`:sha-${commit}@`, `:sha-${'0'.repeat(40)}@`);
  const result = spawnSync(process.execPath, ['scripts/prepare-release.mjs', commit, otherImage], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /image tag must match/);
});

test('release bundle pins a digest and cannot be silently replaced', async (t) => {
  const bundle = path.join(temporaryRoot, 'releases', commit);
  if (existsSync(bundle)) return t.skip('Preserving an existing user release bundle');
  let created = false;
  try {
    const result = spawnSync(process.execPath, ['scripts/prepare-release.mjs', commit, image], { cwd: root, encoding: 'utf8' });
    created = existsSync(bundle);
    assert.equal(result.status, 0, result.stderr);
    const relay = await readFile(path.join(bundle, 'relay.yaml'), 'utf8');
    assert.ok(relay.includes(`image: ${image}`));
    assert.match(relay, /type: Recreate/);
    assert.match(relay, /imagePullSecrets:\n        - name: ghcr-credentials/);
    assert.ok(!existsSync(path.join(bundle, 'postgres.yaml')), 'Application releases must not update storage');
    const replacement = image.replace('a'.repeat(64), 'b'.repeat(64));
    const second = spawnSync(process.execPath, ['scripts/prepare-release.mjs', commit, replacement], { cwd: root, encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.equal(await readFile(path.join(bundle, 'image.txt'), 'utf8'), `${image}\n`);
  } finally {
    if (created && path.dirname(bundle) === path.join(temporaryRoot, 'releases')) await rm(bundle, { recursive: true });
  }
});

test('deployment failure gates and rollback behavior', async (t) => {
  await mkdir(temporaryRoot, { recursive: true });
  const fixture = await mkdtemp(path.join(temporaryRoot, 'release-test-'));
  const bundle = path.join(fixture, 'bundle');
  const bin = path.join(fixture, 'bin');
  await mkdir(bundle);
  await mkdir(bin);
  const log = path.join(fixture, 'commands.log');
  const mock = path.join(bin, 'kubectl');
  try {
    await writeFile(path.join(bundle, 'commit.txt'), `${commit}\n`);
    await writeFile(path.join(bundle, 'image.txt'), `${image}\n`);
    for (const name of ['migrate', 'test-receiver', 'hookrelay', 'worker', 'relay']) {
      await writeFile(path.join(bundle, `${name}.yaml`), `          image: ${image}\n`);
    }
    await writeFile(mock, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$RELEASE_TEST_LOG"
shift 2
case "$1" in
  get)
    if [[ $2 == deployment && \${*: -1} == *replicas* ]]; then
      printf '1:Recreate'
    elif [[ $2 == deployment && \${*: -1} == *containers* ]]; then
      printf '%s' "$RELEASE_TEST_IMAGE"
    elif [[ $2 == job && \${*: -1} == *containers* ]]; then
      printf '%s' "$RELEASE_TEST_IMAGE"
    elif [[ $2 == job && \${RELEASE_TEST_EXISTING_JOB:-0} == 1 ]]; then
      printf 'job/existing'
    fi ;;
  wait) [[ \${RELEASE_TEST_FAIL_MIGRATION:-0} != 1 ]] ;;
  rollout) [[ \${RELEASE_TEST_FAIL_ROLLOUT:-0} != 1 ]] ;;
esac
`, { mode: 0o755 });
    // Git Bash has no flock. This shim also lets us exercise lock rejection.
    await writeFile(path.join(bin, 'flock'), '#!/usr/bin/env bash\n[[ ${RELEASE_TEST_FAIL_LOCK:-0} != 1 ]]\n', { mode: 0o755 });
    const run = async (mode, flags = [], overrides = {}) => {
      await writeFile(log, '');
      const result = spawnSync(bash, ['scripts/deploy-release.sh', mode, portable(bundle), ...flags], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TMPDIR: portable(fixture),
          KUBECTL_BIN: portable(mock),
          RELEASE_TEST_LOG: portable(log),
          RELEASE_TEST_IMAGE: image,
          ...overrides,
        },
      });
      assert.ifError(result.error);
      return { ...result, commands: await readFile(log, 'utf8') };
    };
    await t.test('failed migration cannot update applications', async () => {
      const result = await run('deploy', [], { RELEASE_TEST_FAIL_MIGRATION: '1' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.commands, /create -f .*migrate.yaml/);
      assert.ok(!result.commands.includes('apply -f'));
      assert.match(result.stderr, /application versions were not changed/);
    });
    await t.test('successful migration precedes every rollout', async () => {
      const result = await run('deploy');
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.commands.indexOf('wait --for=condition=complete') < result.commands.indexOf('apply -f'));
      assert.equal((result.commands.match(/rollout status deployment\//g) ?? []).length, 4);
    });
    await t.test('existing successful migration is reused', async () => {
      const result = await run('deploy', [], { RELEASE_TEST_EXISTING_JOB: '1' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.commands.includes('create -f'));
      assert.match(result.commands, /wait --for=condition=complete/);
    });
    await t.test('rollback requires compatibility acknowledgement and never runs migrations', async () => {
      const rejected = await run('rollback');
      assert.equal(rejected.status, 2);
      assert.equal(rejected.commands, '');
      const result = await run('rollback', ['--compatible']);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.commands.includes('migrate'));
      assert.equal((result.commands.match(/apply -f/g) ?? []).length, 4);
    });
    await t.test('failed rollout stops subsequent application changes', async () => {
      const result = await run('deploy', [], { RELEASE_TEST_FAIL_ROLLOUT: '1' });
      assert.equal(result.status, 1, result.stderr);
      assert.equal((result.commands.match(/apply -f/g) ?? []).length, 1);
    });
    await t.test('concurrent operation is rejected before accessing Kubernetes', async () => {
      const result = await run('deploy', [], { RELEASE_TEST_FAIL_LOCK: '1' });
      assert.equal(result.status, 1);
      assert.equal(result.commands, '');
    });
  } finally {
    if (path.dirname(fixture) === temporaryRoot) await rm(fixture, { recursive: true });
  }
});
