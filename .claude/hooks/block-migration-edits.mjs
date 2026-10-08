// PreToolUse hook: protect drizzle migrations from hand edits.
// Edit/Write: committed migrations -> deny, new uncommitted ones -> ask.
// Bash/PowerShell: commands that name the migrations folder and can write -> deny.
// The shell check is a heuristic on the command text, not an airtight sandbox:
// CI is the real guarantee.
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GUARDED = '/libs/database/src/migrations/';

const IMMUTABLE =
  'Committed migrations are immutable and must not be edited. If you need a schema change, ' +
  'edit libs/database/src/schemas/ and run `npm run db:generate`; otherwise ask the user to edit the file by hand.';

process.stdin.setEncoding('utf8');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  // Not a payload we understand: do not interfere with the tool call.
  process.exit(0);
}

const cwd = input?.cwd ?? process.cwd();

function respond(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

// Shell tools carry no file_path, only a command line. It cannot be resolved to
// files reliably (globs, cd, variables), so this is a heuristic: a command that
// names the migrations directory and contains something able to write -> deny.
// Read-only commands and git restore/checkout pass through.
const SHELL_WRITERS = [
  /\b(sed|perl|ruby)\b[^|;&]*\s(-\w*i|--in-place)/, // in-place editors
  /\b(rm|mv|cp|tee|truncate|touch|dd|install|patch)\b/,
  /\b(set-content|add-content|clear-content|out-file|remove-item|move-item|copy-item|rename-item|new-item)\b/,
  /\b(writefile|appendfile|copyfile|unlink|rename)(sync)?\b/, // node -e one-liners
  /(^|[^-=0-9])>{1,2}(?!&)/, // output redirection
];

function checkShell(command) {
  const text = command.replaceAll('\\', '/').toLowerCase();
  // GUARDED without the surrounding slashes: commands use relative paths and globs.
  if (!text.includes(GUARDED.slice(1, -1))) return;
  if (!SHELL_WRITERS.some((pattern) => pattern.test(text))) return;
  respond('deny', `Shell writes to libs/database/src/migrations/ are blocked. ${IMMUTABLE}`);
}

// Tracked by git = committed (or staged), so it may already be applied somewhere.
function isTracked(file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', file], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    // Untracked, or git unavailable: let the user decide instead of allowing silently.
    return false;
  }
}

function checkFile(filePath) {
  // Resolve relative paths, then compare with forward slashes and without case:
  // Windows paths arrive as E:\..., e:/... or /e/... depending on the caller.
  const resolved = path.resolve(cwd, filePath);
  const normalized = `${resolved.replaceAll('\\', '/').toLowerCase()}/`;
  if (!normalized.includes(GUARDED)) return;

  if (isTracked(resolved)) {
    respond('deny', IMMUTABLE);
  } else {
    respond(
      'ask',
      'This is a new, uncommitted migration. Hand edits are only for custom SQL migrations ' +
        '(drizzle-kit generate --custom). Confirm?',
    );
  }
}

const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};

if (toolName === 'Bash' || toolName === 'PowerShell') {
  if (typeof toolInput.command === 'string') checkShell(toolInput.command);
} else if (typeof toolInput.file_path === 'string' && toolInput.file_path !== '') {
  checkFile(toolInput.file_path);
}
