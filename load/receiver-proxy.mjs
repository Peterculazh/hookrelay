import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Runs only in the benchmark network. The real receiver still owns deduplication.
const attempts = new Map();
const upstream =
  process.env.RECEIVER_URL ?? 'http://test-receiver:3001/webhooks';
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health')
    return res.writeHead(200).end('ok');
  if (req.method !== 'POST' || req.url !== '/webhooks')
    return res.writeHead(404).end();
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) return res.writeHead(413).end();
    }
    const event = JSON.parse(body);
    const delay = event.payload?.receiver?.delayMs ?? 0;
    const failures = event.payload?.receiver?.failAttempts ?? 0;
    if (
      !Number.isInteger(delay) ||
      delay < 0 ||
      delay > 15000 ||
      !Number.isInteger(failures) ||
      failures < 0 ||
      failures > 3 ||
      typeof event.id !== 'string'
    ) {
      return res.writeHead(400).end();
    }
    if (delay) await sleep(delay);
    if (res.destroyed) return; // A timed-out worker must not forward a late test effect.
    if (failures) {
      const count = (attempts.get(event.id)?.count ?? 0) + 1;
      attempts.set(event.id, { count, expires: performance.now() + 300000 });
      if (count <= failures)
        return res.writeHead(503).end('controlled failure');
    }
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    res.writeHead(response.status).end();
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
  }
});
const cleanup = setInterval(() => {
  for (const [id, entry] of attempts)
    if (entry.expires < performance.now()) attempts.delete(id);
}, 30000);
cleanup.unref();
server.listen(3002, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    clearInterval(cleanup);
    server.close();
    server.closeAllConnections();
  });
