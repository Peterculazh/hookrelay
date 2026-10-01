// Executed inside the VPS relay Pod; never exports database credentials or Pod IPs.
import pg from 'pg';
import { Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import { compactCompletions } from './observation-state.mjs';
import { createInterface } from 'node:readline';

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
let forceMetrics = false;
const completed = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'metrics') forceMetrics = true;
});
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
    const {
      rows: [observation],
    } = await pool.query(
      `
      WITH run_events AS MATERIALIZED (
        SELECT id, status FROM events WHERE type=$1
      ), attempt_outcomes AS (
        SELECT a.status, a.http_status, a.error_code, count(*)::int AS count
        FROM delivery_attempts a JOIN run_events e ON e.id=a.event_id
        GROUP BY a.status, a.http_status, a.error_code
      )
      SELECT
        (SELECT json_build_object(
          'total', count(*)::int,
          'pending', count(*) FILTER (WHERE status='pending')::int,
          'delivered', count(*) FILTER (WHERE status='delivered')::int,
          'failed', count(*) FILTER (WHERE status='failed')::int,
          'unpublished', (SELECT count(*)::int FROM outbox o JOIN run_events e ON e.id=o.event_id WHERE o.published_at IS NULL),
          'effects', (SELECT count(*)::int FROM receiver_effects r JOIN run_events e ON e.id=r.event_id),
          'attempts', (SELECT COALESCE(sum(count),0)::int FROM attempt_outcomes)
        ) FROM run_events) AS snapshot,
        (SELECT COALESCE(json_agg(attempt_outcomes),'[]'::json) FROM attempt_outcomes) AS outcomes,
        (SELECT COALESCE(json_agg(json_build_object('id',id,'status',status)),'[]'::json)
          FROM run_events WHERE status <> 'pending') AS terminals`,
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
      snapshot: observation.snapshot,
      completions: compactCompletions(completed, observation.terminals),
      outcomes: observation.outcomes,
      database,
      queue: counts,
    };
    if (tick++ % 10 === 0 || forceMetrics) {
      sample.metricsForced = forceMetrics;
      forceMetrics = false;
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
