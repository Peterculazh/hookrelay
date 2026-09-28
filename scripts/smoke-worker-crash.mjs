import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const mode = process.argv[2] ?? 'crash';
assert.ok(['crash', 'shutdown', 'exhaustion'].includes(mode));

const composeArgs = [
  'compose',
  '-f',
  process.env.CRASH_COMPOSE_FILE ?? 'docker-compose.yml',
];
if (process.env.CRASH_COMPOSE_PROJECT)
  composeArgs.push('-p', process.env.CRASH_COMPOSE_PROJECT);
const compose = (...args) =>
  execFileSync('docker', [...composeArgs, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });

// One worker is required: another worker could recover the job during the probe.
assert.equal(
  compose('ps', '-q', 'worker').trim().split(/\r?\n/).filter(Boolean).length,
  1,
  'Run against a test stack with exactly one running worker',
);
try {
  compose('stop', 'worker');
  const source = readFileSync(
    new URL('./worker-crash-probe.mjs', import.meta.url),
    'utf8',
  );
  await new Promise((resolve, reject) => {
    // Use the relay container's internal network and DB/Redis environment.
    const child = spawn(
      'docker',
      [
        ...composeArgs,
        'exec',
        '-T',
        'relay',
        'node',
        '--input-type=module',
        '-e',
        `const mode = ${JSON.stringify(mode)};\n${source}`,
      ],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    let controlError;
    const watchdog = setTimeout(() => {
      controlError = new Error('Crash probe exceeded 330 seconds');
      child.kill();
    }, 330_000);
    const lines = createInterface({ input: child.stdout });
    let stopProcess;
    let stopResult;
    lines.on('line', async (line) => {
      try {
        if (line === 'CONTROL:START') {
          compose('start', 'worker');
          child.stdin.write('OK\n');
        } else if (line === 'CONTROL:TERM') {
          // Keep the probe running so it can release its database lock while
          // Docker waits for the worker to finish within the grace period.
          stopProcess = spawn(
            'docker',
            [...composeArgs, 'stop', '-t', '30', 'worker'],
            { stdio: 'ignore' },
          );
          stopResult = new Promise((resolveStop) => {
            stopProcess.on('error', (error) => resolveStop(error));
            stopProcess.on('close', (code) => resolveStop(code));
          });
          const deadline = performance.now() + 10_000;
          let draining = false;
          while (performance.now() < deadline) {
            if (
              compose('logs', '--since', '10s', 'worker').includes(
                'worker.draining',
              )
            ) {
              draining = true;
              break;
            }
            await sleep(100);
          }
          assert.ok(
            draining,
            'Worker must acknowledge shutdown while delivery is active',
          );
          child.stdin.write('OK\n');
        } else if (line === 'CONTROL:STOPPED') {
          assert.equal(await stopResult, 0, 'docker compose stop must succeed');
          const id = compose('ps', '--all', '-q', 'worker').trim();
          const state = JSON.parse(
            execFileSync(
              'docker',
              ['inspect', '--format', '{{json .State}}', id],
              { encoding: 'utf8', timeout: 10_000 },
            ),
          );
          assert.equal(state.Running, false);
          assert.ok(
            [0, 143].includes(state.ExitCode),
            `Expected graceful exit, got ${state.ExitCode}`,
          );
          assert.ok(
            compose('logs', '--since', '40s', 'worker').includes(
              'worker.drained',
            ),
          );
          child.stdin.write('OK\n');
        } else if (line === 'CONTROL:KILL') {
          compose('kill', '--signal', 'SIGKILL', 'worker');
          const id = compose('ps', '--all', '-q', 'worker').trim();
          const state = JSON.parse(
            execFileSync(
              'docker',
              ['inspect', '--format', '{{json .State}}', id],
              { encoding: 'utf8', timeout: 10_000 },
            ),
          );
          assert.equal(
            state.Running,
            false,
            'Worker must be stopped after SIGKILL',
          );
          assert.equal(state.ExitCode, 137, 'Expected SIGKILL exit code');
          child.stdin.write('OK\n');
        } else {
          console.log(line);
        }
      } catch (error) {
        controlError = error;
        child.stdin.write('ERROR\n');
      }
    });
    child.on('error', (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      lines.close();
      if (controlError) reject(controlError);
      else if (code !== 0)
        reject(new Error(`Crash probe exited with code ${code}`));
      else resolve();
    });
  });
} finally {
  compose('start', 'worker');
}
