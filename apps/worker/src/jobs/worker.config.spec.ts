import { describe, expect, it } from 'vitest';
import { loadWorkerConcurrency } from './worker.config.js';

describe('worker concurrency', () => {
  it('preserves serial delivery by default and accepts bounded parallelism', () => {
    expect(loadWorkerConcurrency({})).toBe(1);
    expect(loadWorkerConcurrency({ WORKER_CONCURRENCY: '8' })).toBe(8);
  });

  it.each(['0', '-1', '1.5', '101', 'many', ''])(
    'rejects invalid value %s',
    (value) => {
      expect(() =>
        loadWorkerConcurrency({ WORKER_CONCURRENCY: value }),
      ).toThrow();
    },
  );
});
