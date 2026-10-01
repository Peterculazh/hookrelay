import { describe, expect, it } from 'vitest';
import { loadRelayConfig, relayCronExpression } from './relay.config.js';

describe('relay settings', () => {
  it('preserves legacy defaults and accepts bounded settings', () => {
    expect(loadRelayConfig({})).toEqual({
      batchSize: 100,
      publishEverySeconds: 10,
    });
    expect(
      loadRelayConfig({
        RELAY_BATCH_SIZE: '1000',
        RELAY_PUBLISH_INTERVAL_SECONDS: '1',
      }),
    ).toEqual({ batchSize: 1000, publishEverySeconds: 1 });
    expect(relayCronExpression(1)).toBe('*/1 * * * * *');
    expect(relayCronExpression(60)).toBe('0 * * * * *');
  });

  it.each(['0', '-1', '1001', '1.5', '', 'invalid'])(
    'rejects unsafe batch size %s',
    (value) => {
      expect(() => loadRelayConfig({ RELAY_BATCH_SIZE: value })).toThrow();
    },
  );

  it.each(['0', '-1', '61', '7', '1.5', '', 'invalid'])(
    'rejects invalid/nonuniform interval %s',
    (value) => {
      expect(() =>
        loadRelayConfig({ RELAY_PUBLISH_INTERVAL_SECONDS: value }),
      ).toThrow();
    },
  );
});
