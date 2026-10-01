// Executed inside the VPS relay Pod; never exports database credentials or Pod IPs.
import pg from 'pg';
import { Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';

const config = JSON.parse(
  Buffer.from(process.env.BENCH_OBSERVER, 'base64').toString(),
);
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 1,
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
});
const queue = new Queue('events', {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    db: Number(process.env.REDIS_DB ?? 0),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 1,
  },
});
let stopping = false;
let tick = 0;
process.stdin.on('end', () => {
  stopping = true;
});
process.stdin.resume();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    const { rows } = await pool.query(
      `
      SELECT e.id, e.status, (o.published_at IS NULL) AS unpublished,
        EXISTS (SELECT 1 FROM receiver_effects r WHERE r.event_id=e.id) AS effect,
        (SELECT count(*)::int FROM delivery_attempts a WHERE a.event_id=e.id) AS attempts
      FROM events e JOIN outbox o ON o.event_id=e.id WHERE e.type=$1`,
      [config.type],
    );
    const { rows: outcomes } = await pool.query(
      `
      SELECT a.status, a.http_status, a.error_code, count(*)::int AS count
      FROM delivery_attempts a JOIN events e ON e.id=a.event_id WHERE e.type=$1
      GROUP BY a.status, a.http_status, a.error_code`,
      [config.type],
    );
    const {
      rows: [database],
    } = await pool.query(`SELECT
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waits,
      xact_commit, xact_rollback, blks_read, blks_hit, deadlocks
      FROM pg_stat_database WHERE datname=current_database()`);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    const sample = {
      kind: 'observation',
      rows,
      outcomes,
      database,
      queue: counts,
    };
    if (tick++ % 10 === 0) {
      sample.metrics = await Promise.all(
        config.endpoints.map(async ({ name, url }) => {
          try {
            const response = await fetch(url, {
              signal: AbortSignal.timeout(2000),
            });
            if (!response.ok) throw new Error();
            return { name, text: await response.text() };
          } catch {
            return { name, error: 'metrics unavailable' };
          }
        }),
      );
    }
    console.log(JSON.stringify(sample));
    await sleep(500);
  }
} finally {
  await queue.close();
  await pool.end();
}
