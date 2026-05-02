'use strict';

/**
 * demo.js — shows how to embed the health monitor into any Node.js app.
 * Run:  node demo.js
 * Then: curl http://127.0.0.1:9090/health | jq
 */

const { createHealthServer } = require('./index');

// ── 1. Start the health server ─────────────────────────────────────────────
const health = createHealthServer({
  port: 9090,
  host: '127.0.0.1',
  path: '/health',
  prettyJson: true,
  // token: 'my-secret-token',  // uncomment to require Authorization header
  monitor: {
    eventLoopSampleMs: 200,
    cpuSampleMs: 500,
    trackAsyncResources: true,
    trackGc: true,
  },
});

health.listen();

// ── 2. Your normal application code lives here ────────────────────────────
console.log('[app] Application started. Health endpoint: http://127.0.0.1:9090/health');
console.log('[app] Additional routes:');
console.log('       GET /health        — full diagnostics');
console.log('       GET /health/live   — liveness probe');
console.log('       GET /health/ready  — readiness probe');

// ── 3. Demonstrate manual error recording ─────────────────────────────────
setTimeout(() => {
  health.monitor.errors.record(new Error('Simulated DB connection timeout'));
  console.log('[app] Recorded a manual error. Check /health errors.counts.manual');
}, 3000);

// ── 4. Simulate some async load so asyncResources shows activity ───────────
setInterval(() => {
  // Simulate I/O-bound work
  const promises = Array.from({ length: 5 }, (_, i) =>
    new Promise((resolve) => setTimeout(resolve, Math.random() * 100))
  );
  Promise.all(promises).catch(() => {});
}, 1000).unref();

// ── 5. Graceful shutdown ───────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[app] Received ${signal}. Shutting down…`);
  await health.close();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
