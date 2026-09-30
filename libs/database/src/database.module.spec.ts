import { Test } from '@nestjs/testing';
import { expect, it, vi } from 'vitest';
import { DatabaseModule } from './database.module.ts';
import { DATABASE_CONFIG } from './database.config.ts';
import { DRIZZLE_DB, PG_POOL } from './database.provider.ts';

it('closes the shared PostgreSQL pool exactly once when the module shuts down', async () => {
  const pool = { end: vi.fn().mockResolvedValue(undefined) };
  const context = await Test.createTestingModule({ imports: [DatabaseModule] })
    .overrideProvider(DATABASE_CONFIG)
    .useValue({})
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(DRIZZLE_DB)
    .useValue({})
    .compile();
  await context.init();
  await context.close();
  expect(pool.end).toHaveBeenCalledTimes(1);
});
