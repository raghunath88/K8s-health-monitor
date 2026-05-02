'use strict';

/**
 * tests.js — zero-dependency test suite for the health monitor.
 * Run: node tests.js
 */

const assert = require('assert/strict');
const http = require('http');
const { HealthMonitor, createHealthServer } = require('./index');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n── HealthMonitor unit tests ──────────────────────────────────\n');

  // 1. Instantiation
  await test('HealthMonitor instantiates without throwing', () => {
    const m = new HealthMonitor();
    m.start();
    m.stop();
  });

  // 2. Diagnostics shape
  await test('diagnostics() returns expected top-level keys', () => {
    const m = new HealthMonitor().start();
    const d = m.diagnostics();
    const required = ['status', 'timestamp', 'uptime', 'memory', 'cpu', 'eventLoop', 'gc', 'asyncResources', 'handles', 'process', 'system', 'errors'];
    for (const key of required) {
      assert.ok(key in d, `Missing key: ${key}`);
    }
    m.stop();
  });

  // 3. Memory fields
  await test('memory snapshot contains formatted and raw bytes', () => {
    const m = new HealthMonitor().start();
    const { memory } = m.diagnostics();
    assert.ok(typeof memory.heapUsed === 'string', 'heapUsed should be formatted string');
    assert.ok(typeof memory.rawBytes.heapUsed === 'number', 'rawBytes.heapUsed should be number');
    assert.ok(memory.heapUsedPercent >= 0 && memory.heapUsedPercent <= 100);
    m.stop();
  });

  // 4. Uptime
  await test('uptime.processSeconds increases over time', async () => {
    const m = new HealthMonitor().start();
    const before = m.diagnostics().uptime.processSeconds;
    await sleep(150);
    const after = m.diagnostics().uptime.processSeconds;
    assert.ok(after > before, `Expected ${after} > ${before}`);
    m.stop();
  });

  // 5. Error counter — manual
  await test('errors.record() increments manual count', () => {
    const m = new HealthMonitor().start();
    m.errors.record(new Error('test error'));
    const snap = m.diagnostics().errors;
    assert.equal(snap.counts.manual, 1);
    assert.equal(snap.recentErrors[0].type, 'manual');
    assert.equal(snap.recentErrors[0].message, 'test error');
    m.stop();
  });

  // 6. Event-loop monitor
  await test('eventLoop snapshot has numeric fields', async () => {
    const m = new HealthMonitor({ eventLoopSampleMs: 50 }).start();
    await sleep(200); // let a few samples collect
    const el = m.diagnostics().eventLoop;
    assert.ok(typeof el.currentMs === 'number');
    assert.ok(typeof el.minMs === 'number');
    assert.ok(typeof el.maxMs === 'number');
    assert.ok(typeof el.avgMs === 'number');
    assert.ok(el.samples >= 0);
    m.stop();
  });

  // 7. Async resource tracker
  await test('asyncResources.total is a non-negative integer', () => {
    const m = new HealthMonitor({ trackAsyncResources: true }).start();
    const ar = m.diagnostics().asyncResources;
    assert.ok(ar !== null);
    assert.ok(Number.isInteger(ar.total) && ar.total >= 0);
    m.stop();
  });

  // ── HTTP server tests ────────────────────────────────────────────────────
  console.log('\n── HTTP server tests ─────────────────────────────────────────\n');

  const srv = createHealthServer({ port: 19090, prettyJson: false });
  await srv.listen();

  await test('GET /health returns 200 with status ok', async () => {
    const { status, body } = await get('http://127.0.0.1:19090/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  await test('GET /health/live returns 200 with alive status', async () => {
    const { status, body } = await get('http://127.0.0.1:19090/health/live');
    assert.equal(status, 200);
    assert.equal(body.status, 'alive');
    assert.ok(typeof body.uptime === 'number');
  });

  await test('GET /health/ready returns 200 when heap is healthy', async () => {
    const { status, body } = await get('http://127.0.0.1:19090/health/ready');
    assert.equal(status, 200);
    assert.equal(body.status, 'ready');
    assert.ok(body.heapUsedPercent < 95);
  });

  await test('Unknown path returns 404', async () => {
    const { status } = await get('http://127.0.0.1:19090/unknown');
    assert.equal(status, 404);
  });

  await srv.close();

  // ── Auth tests ───────────────────────────────────────────────────────────
  const secured = createHealthServer({ port: 19091, token: 'secret123' });
  await secured.listen();

  await test('Protected endpoint returns 401 without token', async () => {
    const { status } = await get('http://127.0.0.1:19091/health');
    assert.equal(status, 401);
  });

  await test('Protected endpoint returns 200 with correct token', async () => {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: 19091,
        path: '/health',
        headers: { Authorization: 'Bearer secret123' },
      };
      http.get(options, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
  });

  await secured.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`─────────────────────────────────────────────────────────────\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
