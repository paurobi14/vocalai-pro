'use strict';

const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const { validationResult } = require('express-validator');
const twilio      = require('twilio');

const config = require('../../config');
const logger = require('../utils/logger');
const { AppError, ValidationError, UnauthorizedError } = require('../utils/errors');

// ── Seguridad HTTP headers ───────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
});

// ── CORS ─────────────────────────────────────────────────────
const corsMiddleware = cors({
  origin: config.isProd
    ? [config.appUrl]
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
});

// ── Request ID ───────────────────────────────────────────────
const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || require('crypto').randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
};

// ── HTTP Logger ──────────────────────────────────────────────
const httpLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip:   (req) => req.url === '/health',
  }
);

// ── Rate Limiting ────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      code:    'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later.',
    });
  },
});

// Límite más estricto para endpoints de llamadas
const callLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      code:    'CALL_RATE_LIMIT',
      message: 'Call limit reached. Maximum 10 calls per minute.',
    });
  },
});

// ── Validación de webhook Twilio ─────────────────────────────
const validateTwilioWebhook = (req, res, next) => {
  if (config.isDev || !config.twilio.authToken) return next();

  const twilioSignature = req.headers['x-twilio-signature'];
  const url             = `${config.appUrl}${req.originalUrl}`;
  const params          = req.body || {};

  const isValid = twilio.validateRequest(
    config.twilio.authToken,
    twilioSignature,
    url,
    params
  );

  if (!isValid) {
    logger.warn('Invalid Twilio webhook signature', { url, ip: req.ip });
    return next(new UnauthorizedError('Invalid Twilio signature'));
  }
  next();
};

// ── Validar campos express-validator ────────────────────────
const validateFields = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ValidationError('Validation failed', errors.array()));
  }
  next();
};

// ── Error Handler global ─────────────────────────────────────
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational || false;

  // Log del error
  const logData = {
    requestId: req.id,
    method:    req.method,
    url:       req.originalUrl,
    statusCode,
    code:      err.code,
    details:   err.details,
  };

  if (statusCode >= 500) {
    logger.error(err.message, { ...logData, stack: err.stack });
  } else {
    logger.warn(err.message, logData);
  }

  // Respuesta al cliente
  const response = {
    success:   false,
    code:      err.code || 'INTERNAL_ERROR',
    message:   isOperational ? err.message : 'An unexpected error occurred',
    requestId: req.id,
  };

  if (config.isDev && !isOperational) {
    response.stack = err.stack;
  }

  if (err.details) {
    response.details = err.details;
  }

  res.status(statusCode).json(response);
};

// ── 404 Handler ──────────────────────────────────────────────
const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    code:    'NOT_FOUND',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  requestId,
  httpLogger,
  apiLimiter,
  callLimiter,
  validateTwilioWebhook,
  validateFields,
  errorHandler,
  notFoundHandler,
  compression: compression(),
};
