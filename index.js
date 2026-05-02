'use strict';

const { HealthMonitor } = require('./src/healthMonitor');
const { createHealthServer } = require('./src/healthServer');

module.exports = { HealthMonitor, createHealthServer };
