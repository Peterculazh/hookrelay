// PostToolUse hook: fast feedback after Edit/Write on a .ts file under apps/ or libs/.
// Lints that one file with oxlint and typechecks only the tsconfig project that owns it.
// On failure the output goes to stderr with exit 2, so Claude sees it right away.
// The Stop hook still runs the full verify:check; this is only the fast path.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateDir = path.join(root, '.claude', '.state', 'tsc');

process.stdin.setEncoding('utf8');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  // Not a payload we understand: do not interfere.
  process.exit(0);
}

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || filePath === '') process.exit(0);

// Resolve relative paths, then compare with forward slashes and without case:
// Windows paths arrive as E:\..., e:/... or /e/... depending on the caller.
const resolved = path.resolve(input?.cwd ?? process.cwd(), filePath);
const relative = path.relative(root, resolved).replaceAll('\\', '/');
if (!/^(apps|libs)\/[^/]+\/.+\.ts$/i.test(relative) || !existsSync(resolved)) process.exit(0);

const run = (bin, args) =>
  spawnSync(process.execPath, [path.join(root, 'node_modules', ...bin), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

const failures = [];

// Same invocation as `npm run lint`, narrowed to the edited file.
const lint = run(['oxlint', 'bin', 'oxlint'], [relative]);
if (lint.status !== 0) failures.push(`oxlint ${relative}\n${lint.stdout}${lint.stderr}`);

// Owning project: apps/<name>/tsconfig.app.json or libs/<name>/tsconfig.lib.json.
// Files it excludes (specs, test/) have no owner here and are left to the Stop hook.
const [area, name] = relative.split('/');
const projectConfig = path.join(root, area, name, area === 'apps' ? 'tsconfig.app.json' : 'tsconfig.lib.json');

async function ownedBy(configPath) {
  if (!existsSync(configPath)) return false;
  const { default: ts } = await import('typescript');
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  const target = path.normalize(resolved).toLowerCase();
  return parsed?.fileNames.some((file) => path.normalize(file).toLowerCase() === target) ?? false;
}

if (await ownedBy(projectConfig)) {
  // The project configs can't be checked standalone: their references point at unbuilt
  // dist/*.d.ts (TS6305) and imports into libs/observability break rootDir (TS6059).
  // A wrapper drops references (not inherited via extends), widens rootDir and mirrors
  // tsconfig.typecheck.json, with an incremental cache under .claude/.state/.
  mkdirSync(stateDir, { recursive: true });
  const wrapper = path.join(stateDir, `${area}-${name}.json`);
  const content = `${JSON.stringify(
    {
      extends: path.relative(stateDir, projectConfig).replaceAll('\\', '/'),
      compilerOptions: {
        composite: false,
        declaration: false,
        noEmit: true,
        incremental: true,
        allowImportingTsExtensions: true,
        rootDir: path.relative(stateDir, root).replaceAll('\\', '/'),
        tsBuildInfoFile: `./${area}-${name}.tsbuildinfo`,
      },
    },
    null,
    2,
  )}\n`;
  if (!existsSync(wrapper) || readFileSync(wrapper, 'utf8') !== content) writeFileSync(wrapper, content);

  const tsc = run(['typescript', 'bin', 'tsc'], ['--project', wrapper, '--pretty', 'false']);
  if (tsc.status !== 0) {
    failures.push(`tsc (${path.relative(root, projectConfig).replaceAll('\\', '/')})\n${tsc.stdout}${tsc.stderr}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Post-edit check failed for ${relative}:\n\n${failures.join('\n')}`);
  process.exit(2);
}
