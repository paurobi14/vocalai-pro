'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const config = require('../../config');

const { combine, timestamp, errors, json, colorize, printf } = format;

// ── Formato para consola (desarrollo) ────────────────────────
const consoleFormat = printf(({ level, message, timestamp, callId, service, ...meta }) => {
  const callTag  = callId  ? ` [call:${callId}]`  : '';
  const svcTag   = service ? ` [${service}]`       : '';
  const metaStr  = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}${svcTag}${callTag}: ${message}${metaStr}`;
});

// ── Formato para ficheros (producción) ───────────────────────
const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = createLogger({
  level: config.isDev ? 'debug' : 'info',
  defaultMeta: { app: 'vocalai-pro' },
  format: fileFormat,
  transports: [
    // Todos los logs
    new transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize:  10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    // Solo errores
    new transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize:  10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: path.join(__dirname, '../../logs/exceptions.log') }),
  ],
});

// Consola en desarrollo
if (config.isDev) {
  logger.add(new transports.Console({
    format: combine(
      colorize({ all: true }),
      timestamp({ format: 'HH:mm:ss' }),
      consoleFormat
    ),
  }));
}

// ── Child logger por llamada ──────────────────────────────────
logger.forCall = (callId) => logger.child({ callId });
logger.forService = (service) => logger.child({ service });

module.exports = logger;
