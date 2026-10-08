---
name: verify
description: Verify a code change in hookrelay before calling it done - run lint, typecheck, unit tests and build, review the diff, and check that no test was weakened to make things pass. Use after editing code, before committing, or when asked to check, verify or review changes.
allowed-tools: Bash(npm run verify:check*) Bash(git diff *) Bash(git status *)
---

# Verify a change

FAIL if any gate fails or any test was weakened. Never fix a failure by loosening a test: report it instead.

## Current changes
!`git status --short`
!`git diff --stat HEAD`

## Steps
1. Run `npm run verify:check` (lint, typecheck, unit tests, build, test-weakening signals). Don't edit code while it runs.
2. Read the diff of every changed test file(`git diff HEAD -- '*.spec.ts' scripts/`). Judge weakening with the checklist in [reference.md](reference.md). Scripts signals are leads, not verdicts: confirm each in the diff.
3. If the change touches the receiver, signer, worker, database or compose files, run the CI-stack tests listed in [reference.md](reference.md). If Docker isn't running, stop and ask.
4. Report:
  - **Verdict: PASS or FAIL**
  - When I ran; each command, its exit code, the key output lines
  - Test integrity: weakened tests with file:line, or "none found" and what you checked
  - What I didn't verify: every skipped gate and why
