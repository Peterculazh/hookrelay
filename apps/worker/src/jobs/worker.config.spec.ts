import { describe, expect, it } from 'vitest';
import { loadSignerUrl, loadWorkerConcurrency } from './worker.config.js';

describe('signer address', () => {
  it('leaves signing off unless an address is configured', () => {
    expect(loadSignerUrl({})).toBeUndefined();
    expect(loadSignerUrl({ SIGNER_URL: 'signer:5051' })).toBe('signer:5051');
    expect(() => loadSignerUrl({ SIGNER_URL: '' })).toThrow();
  });
});

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
