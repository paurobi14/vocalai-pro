'use strict';

const express = require('express');
const http    = require('http');

const config  = require('../config');
const logger  = require('./utils/logger');
const {
  helmetMiddleware,
  corsMiddleware,
  requestId,
  httpLogger,
  apiLimiter,
  compression,
  errorHandler,
  notFoundHandler,
} = require('./middleware');

// ── App ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Middleware global ────────────────────────────────────────
app.set('trust proxy', 1); // Necesario detrás de Nginx / Heroku
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(compression);
app.use(requestId);
app.use(httpLogger);

// Body parsers — orden importante: raw para Twilio, json para el resto
app.use('/api/webhooks/twilio', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir dashboard estático
app.use(express.static(require('path').join(__dirname, '../public')));

// Rate limiting en todas las rutas API
app.use('/api', apiLimiter);

// ── Rutas ────────────────────────────────────────────────────
app.use('/health',          require('./routes/health'));

// ── Rutas activas ────────────────────────────────────────────
app.use('/api/calls',    require('./routes/calls'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/contacts',  require('./routes/contacts'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/auth',         require('./routes/auth'));

// ── Error handling ───────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Arranque del servidor ────────────────────────────────────
async function start() {
  try {
    // Inicializar base de datos
    const { initializeSchema } = require('./services/database');
    try {
      await initializeSchema();
    } catch (dbErr) {
      logger.warn('DB init failed, continuing anyway', { error: dbErr.message });
    }

    // Inicializar WebSocket de audio
    const { createAudioStreamServer } = require('./services/audioStream');
    createAudioStreamServer(server);

    server.listen(config.port, () => {
      logger.info(`VocalAI Pro server started`, {
        port:    config.port,
        env:     config.env,
        appUrl:  config.appUrl,
        langs:   config.languages.supported.join(', '),
      });

      if (config.isDev) {
        logger.info(`Health check: http://localhost:${config.port}/health`);
        logger.info(`API base:     http://localhost:${config.port}/api`);
      }
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully...`);
      server.close(async () => {
        const { db } = require('./services/database');
        await db.pool.end();
        logger.info('Server and DB connections closed');
        process.exit(0);
      });

      // Forzar cierre si tarda más de 10s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('uncaughtException',  (err) => {
      logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled Rejection', { reason: String(reason) });
    });

  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();

module.exports = { app, server }; // Exportado para tests
