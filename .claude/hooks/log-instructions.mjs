// InstructionsLoaded hook: log which CLAUDE.md and rule files load, and when.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

process.stdin.setEncoding('utf8');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

const dir = path.join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.claude', '.state');
mkdirSync(dir, { recursive: true });
appendFileSync(path.join(dir, 'instructions.log'), `${new Date().toISOString()} ${raw.trim()}\n`);
