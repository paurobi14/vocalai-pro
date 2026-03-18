'use strict';

const express = require('express');
const router  = express.Router();
const { checkHealth } = require('../services/database');
const config  = require('../../config');
const logger  = require('../utils/logger');

/**
 * GET /health
 * Health check básico (usado por load balancers)
 */
router.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /health/detailed
 * Estado detallado de todos los servicios
 */
router.get('/detailed', async (req, res) => {
  const checks = {
    server:       { status: 'ok' },
    database:     { status: 'unknown' },
    redis:        { status: 'unknown' },
    twilio:       { status: config.twilio.accountSid ? 'configured' : 'missing_config' },
    elevenlabs:   { status: config.elevenlabs.apiKey  ? 'configured' : 'missing_config' },
    anthropic:    { status: config.anthropic.apiKey   ? 'configured' : 'missing_config' },
    googleCal:    { status: config.google.clientId    ? 'configured' : 'missing_config' },
  };

  // Database check
  try {
    const dbHealth = await checkHealth();
    checks.database = { status: 'ok', ...dbHealth };
  } catch (err) {
    checks.database = { status: 'error', message: err.message };
  }

  // Redis check
  try {
    const Redis = require('ioredis');
    const redis = new Redis(config.redis.url, { lazyConnect: true, connectTimeout: 2000 });
    await redis.ping();
    checks.redis = { status: 'ok' };
    await redis.quit();
  } catch (err) {
    checks.redis = { status: 'error', message: err.message };
  }

  const allOk = Object.values(checks).every((c) => ['ok', 'configured'].includes(c.status));

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'healthy' : 'degraded',
    version:   process.env.npm_package_version || '1.0.0',
    env:       config.env,
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  });
});

module.exports = router;
