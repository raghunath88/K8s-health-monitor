'use strict';

const { performance, PerformanceObserver } = require('perf_hooks');
const async_hooks = require('async_hooks');
const os = require('os');

// ─── Error Counter ────────────────────────────────────────────────────────────

class ErrorCounter {
  constructor() {
    this._counts = {
      uncaughtException: 0,
      unhandledRejection: 0,
      manual: 0,
    };
    this._lastErrors = [];
    this._maxHistory = 10;
    this._attach();
  }

  _attach() {
    process.on('uncaughtException', (err) => {
      this._counts.uncaughtException++;
      this._record('uncaughtException', err);
    });

    process.on('unhandledRejection', (reason) => {
      this._counts.unhandledRejection++;
      this._record('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
    });
  }

  _record(type, err) {
    this._lastErrors.unshift({
      type,
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
      timestamp: new Date().toISOString(),
    });
    if (this._lastErrors.length > this._maxHistory) {
      this._lastErrors.pop();
    }
  }

  /** Manually record an application-level error */
  record(err) {
    this._counts.manual++;
    this._record('manual', err instanceof Error ? err : new Error(String(err)));
  }

  snapshot() {
    return {
      counts: { ...this._counts, total: Object.values(this._counts).reduce((a, b) => a + b, 0) },
      recentErrors: [...this._lastErrors],
    };
  }
}

// ─── Event-Loop Delay Sampler ─────────────────────────────────────────────────

class EventLoopMonitor {
  constructor(sampleIntervalMs = 500) {
    this._interval = sampleIntervalMs;
    this._delayMs = 0;
    this._min = Infinity;
    this._max = 0;
    this._samples = 0;
    this._sum = 0;
    this._timer = null;
  }

  start() {
    const tick = () => {
      const start = performance.now();
      setImmediate(() => {
        const delay = performance.now() - start;
        this._delayMs = delay;
        this._min = Math.min(this._min, delay);
        this._max = Math.max(this._max, delay);
        this._sum += delay;
        this._samples++;
      });
    };

    this._timer = setInterval(tick, this._interval);
    // Don't block process exit
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  snapshot() {
    return {
      currentMs: parseFloat(this._delayMs.toFixed(3)),
      minMs: this._min === Infinity ? 0 : parseFloat(this._min.toFixed(3)),
      maxMs: parseFloat(this._max.toFixed(3)),
      avgMs: this._samples ? parseFloat((this._sum / this._samples).toFixed(3)) : 0,
      samples: this._samples,
    };
  }
}

// ─── Active-Handle / Request Tracker ─────────────────────────────────────────

class AsyncResourceTracker {
  constructor() {
    this._active = new Map();   // asyncId → { type, triggerAsyncId, createdAt }
    this._hook = async_hooks.createHook({
      init: (asyncId, type, triggerAsyncId) => {
        // Skip TIMERWRAP / Promise noise if desired — keep all for accuracy
        this._active.set(asyncId, { type, triggerAsyncId, createdAt: Date.now() });
      },
      destroy: (asyncId) => {
        this._active.delete(asyncId);
      },
      promiseResolve: (asyncId) => {
        this._active.delete(asyncId);
      },
    });
  }

  enable() {
    this._hook.enable();
    return this;
  }

  disable() {
    this._hook.disable();
  }

  snapshot() {
    const byType = {};
    for (const { type } of this._active.values()) {
      byType[type] = (byType[type] || 0) + 1;
    }
    return {
      total: this._active.size,
      byType,
    };
  }
}

// ─── CPU Usage Sampler ────────────────────────────────────────────────────────

class CpuMonitor {
  constructor(sampleIntervalMs = 1000) {
    this._interval = sampleIntervalMs;
    this._usage = { user: 0, system: 0, percent: 0 };
    this._prev = process.cpuUsage();
    this._prevTime = Date.now();
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => {
      const now = Date.now();
      const curr = process.cpuUsage();
      const elapsedUs = (now - this._prevTime) * 1000; // ms → µs

      const userDelta = curr.user - this._prev.user;
      const sysDelta = curr.system - this._prev.system;
      const totalDelta = userDelta + sysDelta;

      this._usage = {
        userMicros: userDelta,
        systemMicros: sysDelta,
        // % of one core; multiply by numCPUs for system-wide
        percentSingleCore: parseFloat(((totalDelta / elapsedUs) * 100).toFixed(2)),
        percentAllCores: parseFloat(
          ((totalDelta / (elapsedUs * os.cpus().length)) * 100).toFixed(2)
        ),
      };

      this._prev = curr;
      this._prevTime = now;
    }, this._interval);

    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  snapshot() {
    return { ...this._usage };
  }
}

// ─── GC Stats (optional, via PerformanceObserver) ────────────────────────────

class GcMonitor {
  constructor() {
    this._collections = 0;
    this._totalDurationMs = 0;
    this._lastDurationMs = 0;
    this._observer = null;
  }

  start() {
    try {
      this._observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this._collections++;
          this._totalDurationMs += entry.duration;
          this._lastDurationMs = entry.duration;
        }
      });
      this._observer.observe({ entryTypes: ['gc'] });
    } catch {
      // gc entryType not always available (e.g. workers)
    }
    return this;
  }

  stop() {
    this._observer?.disconnect();
  }

  snapshot() {
    return {
      collections: this._collections,
      totalDurationMs: parseFloat(this._totalDurationMs.toFixed(3)),
      lastDurationMs: parseFloat(this._lastDurationMs.toFixed(3)),
      avgDurationMs: this._collections
        ? parseFloat((this._totalDurationMs / this._collections).toFixed(3))
        : 0,
    };
  }
}

// ─── Main HealthMonitor ───────────────────────────────────────────────────────

class HealthMonitor {
  constructor(options = {}) {
    this._startedAt = Date.now();
    this._options = {
      eventLoopSampleMs: options.eventLoopSampleMs ?? 500,
      cpuSampleMs: options.cpuSampleMs ?? 1000,
      trackAsyncResources: options.trackAsyncResources ?? true,
      trackGc: options.trackGc ?? true,
    };

    this.errors = new ErrorCounter();
    this._eventLoop = new EventLoopMonitor(this._options.eventLoopSampleMs);
    this._cpu = new CpuMonitor(this._options.cpuSampleMs);
    this._gc = new GcMonitor();
    this._async = this._options.trackAsyncResources ? new AsyncResourceTracker() : null;
  }

  start() {
    this._eventLoop.start();
    this._cpu.start();
    this._gc.start();
    this._async?.enable();
    return this;
  }

  stop() {
    this._eventLoop.stop();
    this._cpu.stop();
    this._gc.stop();
    this._async?.disable();
  }

  /** Returns full diagnostics snapshot */
  diagnostics() {
    const mem = process.memoryUsage();
    const uptimeSec = process.uptime();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: {
        processSeconds: parseFloat(uptimeSec.toFixed(3)),
        systemSeconds: os.uptime(),
        startedAt: new Date(this._startedAt).toISOString(),
      },
      memory: {
        rss:          formatBytes(mem.rss),
        heapTotal:    formatBytes(mem.heapTotal),
        heapUsed:     formatBytes(mem.heapUsed),
        external:     formatBytes(mem.external),
        arrayBuffers: formatBytes(mem.arrayBuffers),
        heapUsedPercent: parseFloat(((mem.heapUsed / mem.heapTotal) * 100).toFixed(2)),
        rawBytes: mem,
      },
      cpu: this._cpu.snapshot(),
      eventLoop: this._eventLoop.snapshot(),
      gc: this._gc.snapshot(),
      asyncResources: this._async ? this._async.snapshot() : null,
      handles: {
        active: process._getActiveHandles?.()?.length ?? null,
        requests: process._getActiveRequests?.()?.length ?? null,
      },
      process: {
        pid: process.pid,
        ppid: process.ppid,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        title: process.title,
        argv0: process.argv0,
        execPath: process.execPath,
      },
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        totalMemory: formatBytes(os.totalmem()),
        freeMemory:  formatBytes(os.freemem()),
        loadAvg: os.loadavg().map(v => parseFloat(v.toFixed(4))),
      },
      errors: this.errors.snapshot(),
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

module.exports = { HealthMonitor };
