// Stop hook: Claude can't end its turn with unverified code changes.
// If apps/, libs/ or scripts/ differ from HEAD and this exact state hasn't
// passed verify:check yet, run it. On failure, block the stop (exit 2) and
// feed the failing output back to Claude.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AREAS = 'apps libs scripts';

process.stdin.setEncoding('utf8');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

let root;
try {
  root = run('git rev-parse --show-toplevel', input.cwd ?? process.cwd()).trim();
} catch {
  process.exit(0); // not a git repository
}

if (!run(`git status --porcelain -- ${AREAS}`, root).trim()) process.exit(0); // nothing to verify

// Fingerprint of the current code state, so an already verified state isn't re-checked.
const hash = createHash('sha256').update(run(`git diff HEAD -- ${AREAS}`, root));
for (const file of run(`git ls-files --others --exclude-standard -- ${AREAS}`, root).split('\n').filter(Boolean)) {
  hash.update(file).update(readFileSync(path.join(root, file)));
}
const fingerprint = hash.digest('hex');

const stateFile = path.join(root, '.claude', '.state', 'verify-pass');
if (existsSync(stateFile) && readFileSync(stateFile, 'utf8') === fingerprint) process.exit(0);

try {
  run('npm run verify:check', root);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, fingerprint);
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.split('\n').slice(-40).join('\n');
  process.stderr.write(
    'Code changed and `npm run verify:check` failed. ' +
      'Fix the cause before finishing; never loosen a test to make it pass.\n\n' +
      output,
  );
  process.exit(2);
}
