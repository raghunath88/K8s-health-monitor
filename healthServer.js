'use strict';

const http = require('http');
const { HealthMonitor } = require('./healthMonitor');

/**
 * Creates and returns an HTTP server with a /health endpoint.
 *
 * @param {object} [options]
 * @param {number}  [options.port=9090]              - Port to listen on
 * @param {string}  [options.host='127.0.0.1']       - Host to bind
 * @param {string}  [options.path='/health']          - Endpoint path
 * @param {string}  [options.token]                  - Optional Bearer token for auth
 * @param {boolean} [options.prettyJson=false]        - Pretty-print JSON responses
 * @param {object}  [options.monitor]                - Options forwarded to HealthMonitor
 * @returns {{ server: http.Server, monitor: HealthMonitor, listen: Function, close: Function }}
 */
function createHealthServer(options = {}) {
  const {
    port = 9090,
    host = '127.0.0.1',
    path: endpointPath = '/health',
    token = null,
    prettyJson = false,
    monitor: monitorOptions = {},
  } = options;

  const monitor = new HealthMonitor(monitorOptions).start();

  const server = http.createServer((req, res) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    if (token) {
      const authHeader = req.headers['authorization'] ?? '';
      const supplied = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (supplied !== token) {
        return send(res, 401, { error: 'Unauthorized' }, prettyJson);
      }
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // ── Routes ────────────────────────────────────────────────────────────────
    if (url.pathname === endpointPath && req.method === 'GET') {
      return send(res, 200, monitor.diagnostics(), prettyJson);
    }

    if (url.pathname === `${endpointPath}/live` && req.method === 'GET') {
      // Kubernetes liveness probe – ultra-fast, no heavy sampling
      return send(res, 200, { status: 'alive', pid: process.pid, uptime: process.uptime() }, prettyJson);
    }

    if (url.pathname === `${endpointPath}/ready` && req.method === 'GET') {
      // Kubernetes readiness probe – check heap headroom as simple heuristic
      const mem = process.memoryUsage();
      const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;
      const ready = heapPercent < 95;
      return send(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        heapUsedPercent: parseFloat(heapPercent.toFixed(2)),
      }, prettyJson);
    }

    // 404 for everything else
    send(res, 404, { error: 'Not found' }, prettyJson);
  });

  // Prevent the health server from keeping the process alive on its own
  // server.unref();

  function listen() {
    return new Promise((resolve, reject) => {
      server.listen(port, host, (err) => {
        if (err) return reject(err);
        const addr = server.address();
        console.log(`[health] Listening on http://${addr.address}:${addr.port}${endpointPath}`);
        resolve(addr);
      });
    });
  }

  function close() {
    monitor.stop();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, monitor, listen, close };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(res, statusCode, body, pretty) {
  const payload = pretty
    ? JSON.stringify(body, null, 2)
    : JSON.stringify(body);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

module.exports = { createHealthServer };
