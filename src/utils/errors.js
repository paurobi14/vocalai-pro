'use strict';

// ── Clase base ───────────────────────────────────────────────
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name       = this.constructor.name;
    this.statusCode = statusCode;
    this.code       = code;
    this.details    = details;
    this.isOperational = true; // Distingue errores de negocio de bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Errores específicos ──────────────────────────────────────
class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor() {
    super('Too many requests. Please try again later.', 429, 'RATE_LIMIT_EXCEEDED');
  }
}

class TwilioError extends AppError {
  constructor(message, details = null) {
    super(message, 502, 'TWILIO_ERROR', details);
  }
}

class ElevenLabsError extends AppError {
  constructor(message, details = null) {
    super(message, 502, 'ELEVENLABS_ERROR', details);
  }
}

class CalendarError extends AppError {
  constructor(message, details = null) {
    super(message, 502, 'CALENDAR_ERROR', details);
  }
}

class AIError extends AppError {
  constructor(message, details = null) {
    super(message, 502, 'AI_ERROR', details);
  }
}

class CallSchedulingError extends AppError {
  constructor(message) {
    super(message, 400, 'CALL_SCHEDULING_ERROR');
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  TwilioError,
  ElevenLabsError,
  CalendarError,
  AIError,
  CallSchedulingError,
};
