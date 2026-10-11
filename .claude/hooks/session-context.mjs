// SessionStart hook (matcher "compact"): after compaction, print where we are,
// so Claude picks up the work instead of starting cold. Plain stdout goes into context.
import { execSync } from 'node:child_process';

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '(unavailable)';
  }
};

console.log(
  [
    'Context restored after compaction.',
    `Branch: ${sh('git branch --show-current')}`,
    'Uncommitted changes:',
    sh('git status --short') || '(none)',
    'Recent commits:',
    sh('git log --oneline -5'),
    'Reminder: code changes must pass the verify skill and the Stop hook before you finish.',
  ].join('\n'),
);
