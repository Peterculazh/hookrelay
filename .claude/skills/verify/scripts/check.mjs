import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const gates = ['npm run lint', 'npm run typecheck', 'npm test', 'npm run build -- --all'];
const tailLines = 15;

// Run every gate even after a failure, so one run reports all of them.
const failed = [];
let totalTests = 'unknown';
for (const command of gates) {
  const result = spawnSync(`${command} 2>&1`, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const exitCode = result.status ?? 1;
  const output = `${result.stdout ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replaceAll('\r', '').trimEnd().split('\n');
  console.log(`\n$ ${command}\nexit code: ${exitCode}\n--- last ${Math.min(tailLines, lines.length)} of ${lines.length} lines ---\n${lines.slice(-tailLines).join('\n')}`);
  if (exitCode !== 0) failed.push(command);
  if (command === 'npm test') totalTests = /^\s*Tests\s.*\((\d+)\)\s*$/m.exec(lines.join('\n'))?.[1] ?? totalTests;
}
console.log(`\nTotal tests: ${totalTests}`);

// Load-bearing tests must still exist: a deleted or renamed one fails the run like any other gate.
const missing = [];
for (const { file, tests } of JSON.parse(readFileSync(new URL('load-bearing.json', import.meta.url), 'utf8'))) {
  if (!existsSync(join(root, file))) missing.push(`${file}: file missing`);
  else {
    const source = readFileSync(join(root, file), 'utf8');
    for (const test of tests) if (!source.includes(test)) missing.push(`${file}: test missing: ${test}`);
  }
}
console.log(`\n$ load-bearing tests\nexit code: ${missing.length === 0 ? 0 : 1}\n${missing.length === 0 ? 'all listed files and tests present' : missing.join('\n')}`);
if (missing.length > 0) failed.push('load-bearing tests');

// Signals are leads for the skill to confirm in the diff, so they never change the exit code.
const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).replaceAll('\r\n', '\n');
// Diff against the merge base, so changes already committed on the branch are scanned along with uncommitted ones.
let ref = process.env.VERIFY_BASE || 'origin/main';
let base;
try {
  base = git('merge-base', ref, 'HEAD').trim();
} catch {
  console.log('\nWARNING: only uncommitted changes scanned');
  ref = 'HEAD';
  base = 'HEAD';
}
console.log(`\nTest-weakening scan base: ${ref} (${git('rev-parse', '--short', base).trim()})`);
const paths = [':(glob)**/*.spec.ts', ':(glob)scripts/*.mjs', ':(glob)**/__snapshots__/**'];
const isSnapshot = (file) => file.split('/').includes('__snapshots__');
const added = [];
const removed = [];
const signals = [];
let file;
let oldLine = 0;
let newLine = 0;
for (const line of git('diff', base, '--no-color', '--no-ext-diff', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', '--', ...paths).split('\n')) {
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (line.startsWith('diff --git ')) file = undefined;
  else if (line.startsWith('--- a/')) file = line.slice(6);
  else if (line.startsWith('+++ b/')) file = line.slice(6);
  else if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
  else if (hunk) {
    [oldLine, newLine] = [Number(hunk[1]), Number(hunk[2])];
    // A pure deletion has no new-side line, so point at the old one.
    if (isSnapshot(file)) signals.push({ file, line: hunk[3] === '0' ? oldLine : newLine, kind: 'snapshot changed', text: line });
  } else if (file && line.startsWith('+')) added.push({ file, line: newLine++, text: line.slice(1) });
  else if (file && line.startsWith('-')) removed.push({ file, line: oldLine++, text: line.slice(1) });
}
for (const untracked of git('ls-files', '--others', '--exclude-standard', '--', ...paths).split('\n').filter(Boolean)) {
  if (isSnapshot(untracked)) signals.push({ file: untracked, line: 1, kind: 'snapshot added (untracked)', text: '' });
  else readFileSync(join(root, untracked), 'utf8').split(/\r?\n/).forEach((text, index) => added.push({ file: untracked, line: index + 1, text }));
}

const focus = /\b(?:describe|suite|it|test)(?:\.\w+)*\.(skip|only|todo)\b/;
const weak = /\.(toBeDefined|toBeTruthy|toBeFalsy)\s*\(/;
const testCase = /\b(?:it|test)(?:\.\w+)*\s*\(/;
const assertion = /\b(?:expect|assert)(?:\.\w+)*\s*\(/;
// scripts/*.mjs assert with node:assert and counts( helpers rather than expect.
const scriptAssertion = /assert|\bcounts\s*\(/;
const isScript = (file) => /^scripts\/[^/]+\.mjs$/.test(file);
// A line that was only moved or re-indented is added back with the same text: don't call it removed.
const readded = new Map();
for (const { file: name, line, text } of added) {
  if (isSnapshot(name)) continue;
  const key = `${name}\n${text.trim()}`;
  readded.set(key, (readded.get(key) ?? 0) + 1);
  if (focus.test(text)) signals.push({ file: name, line, kind: `added .${focus.exec(text)[1]}`, text });
  if (weak.test(text)) signals.push({ file: name, line, kind: `added ${weak.exec(text)[1]}`, text });
}
for (const { file: name, line, text } of removed) {
  if (isSnapshot(name)) continue;
  const key = `${name}\n${text.trim()}`;
  if (readded.get(key) > 0) {
    readded.set(key, readded.get(key) - 1);
    continue;
  }
  if (testCase.test(text)) signals.push({ file: name, line, kind: 'removed test (old line)', text });
  if (assertion.test(text) || (isScript(name) && scriptAssertion.test(text))) signals.push({ file: name, line, kind: 'removed assertion (old line)', text });
}

console.log(`\nTest-weakening signals: ${signals.length === 0 ? 'none' : signals.length}`);
for (const signal of signals.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) console.log(`${signal.file}:${signal.line}: ${signal.kind}${signal.text ? `: ${signal.text.trim()}` : ''}`);
console.log(`\nGates: ${failed.length === 0 ? 'all passed' : `FAILED: ${failed.join(', ')}`}`);
process.exit(failed.length === 0 ? 0 : 1);
