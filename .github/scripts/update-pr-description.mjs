import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const START = '<!-- claude-pr-description:start -->';
export const END = '<!-- claude-pr-description:end -->';

// Only the block between the markers is generated; the rest belongs to people.
export function mergeBody(currentBody, summary) {
  const body = (currentBody ?? '').replaceAll('\r\n', '\n');
  // A summary that carried its own markers would corrupt the next replacement.
  const text = summary.replaceAll(START, '').replaceAll(END, '').trim();
  if (!text) throw new Error('Generated description is empty');
  const block = `${START}\n${text}\n${END}`;

  const start = body.indexOf(START);
  if (start !== -1 && body.indexOf(END, start + START.length) === -1) {
    throw new Error(
      'Start marker without an end marker after it: fix the PR description by hand',
    );
  }
  const end = start === -1 ? -1 : body.indexOf(END, start + START.length);
  if (end === -1) {
    const existing = body.trimEnd();
    return existing ? `${existing}\n\n${block}\n` : `${block}\n`;
  }
  return body.slice(0, start) + block + body.slice(end + END.length);
}

function main() {
  const number = process.env.PR_NUMBER;
  if (!number) throw new Error('PR_NUMBER is required');
  const summary = readFileSync(
    process.env.PR_SUMMARY_FILE ?? '.pr-context/summary.md',
    'utf8',
  );

  const current = JSON.parse(
    execFileSync('gh', ['pr', 'view', number, '--json', 'body'], {
      encoding: 'utf8',
    }),
  ).body;
  const merged = mergeBody(current, summary);
  if (merged === (current ?? '').replaceAll('\r\n', '\n')) {
    console.log('Pull request description is already up to date.');
    return;
  }

  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'pr-body-')),
    'body.md',
  );
  writeFileSync(file, merged);
  execFileSync('gh', ['pr', 'edit', number, '--body-file', file], {
    stdio: 'inherit',
  });
  console.log(`Updated the description of pull request #${number}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
