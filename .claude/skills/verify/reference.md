# Verify: reference

## CI-stack tests (need Docker)
Run only those whose area the change touches.

| Change touches | Run |
| --- | --- |
| apps/test-receiver, libs/database | npm run test:receiver |
| apps/signer, worker signing code | npm run test:signing |
| apps/worker: delivery, retries, shutdown | npm run test:worker-crash, test:shutdown, test:worker-exhaustion|
| docker-compose*.yml, Dockerfile, scripts/ | npm run test:smoke |
| release scripts | npm run test:release |

## Test-weakening checklist
A test change is weakening if the test now passes in more situations than before, without a stated reason:
- an assertion removed or loosened (toBe -> toBeDefined/toBeTruthy, exact -> toMatchObject, specific error -> any throw)
- an expected value changed to match the new output
- .skip / .only / .todo added, or a test deleted
- a timeout or retry count raised to get a flaky test through
- the unit under test mocked, or errors swallowed with try/catch inside a test
- a snapshot updated without explaining why the output should change

## Load-bearing tests (proven by mutation)
Any change to these is FAIL unless the user explicitly asked for it:
- signature.guard.spec.ts > known answers: both hard-coded HMAC vectors
- signer.grpc.spec.ts > replay test: the signature must come from the real SignerService
- scripts/smoke-receiver.mjs: the counts(id, 1) assertions for sequential and concurrent duplicates
- test-receiver.replay.spec.ts, and the retry re-sign test in events.processor.spec.ts
