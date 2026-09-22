import type { Pool } from 'pg';
import { DatabaseService } from './database.service.ts';
import type { DrizzleDatabase } from './database.provider.ts';

describe('DatabaseService', () => {
  let query: ReturnType<typeof vi.fn>;
  let service: DatabaseService;

  beforeEach(() => {
    query = vi.fn();
    service = new DatabaseService(
      {} as DrizzleDatabase,
      { query } as unknown as Pool,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkConnection', () => {
    it('executes a small query with a PostgreSQL query timeout', async () => {
      query.mockResolvedValue(undefined);

      await service.checkConnection(250);

      expect(query).toHaveBeenCalledWith({
        text: 'select 1',
        query_timeout: 250,
      });
    });

    it('propagates PostgreSQL query failures', async () => {
      query.mockRejectedValue(new Error('connection failed'));

      await expect(service.checkConnection(250)).rejects.toThrow(
        'connection failed',
      );
    });

    it('times out while waiting for pool acquisition or query execution', async () => {
      vi.useFakeTimers();
      query.mockReturnValue(new Promise(() => undefined));
      const result = service.checkConnection(1_000).then(
        () => undefined,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toEqual(
        new Error('PostgreSQL health check timed out after 1000ms'),
      );
    });
  });
});
