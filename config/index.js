'use strict';

require('dotenv').config();

// ── Helpers ──────────────────────────────────────────────────
const required = (key) => {
  return process.env[key] || '';
};

const optional = (key, defaultValue = '') => process.env[key] || defaultValue;
const num       = (key, def)  => parseInt(process.env[key] || def, 10);
const bool      = (key, def)  => (process.env[key] ?? String(def)) === 'true';

// ── Config object ────────────────────────────────────────────
const config = {
  env:  optional('NODE_ENV', 'development'),
  port: num('PORT', 3000),
  appUrl: optional('APP_URL', 'http://localhost:3000'),
  isDev:  optional('NODE_ENV', 'development') === 'development',
  isProd: optional('NODE_ENV', 'development') === 'production',

  db: {
    connectionString: optional('DATABASE_URL', '') || undefined,
    host:     optional('DB_HOST', 'localhost'),
    port:     num('DB_PORT', 5432),
    database: optional('DB_NAME', 'vocalai_pro'),
    user:     optional('DB_USER', 'vocalai'),
    password: optional('DB_PASSWORD', ''),
    max:      num('DB_POOL_MAX', 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  twilio: {
    accountSid:   optional('TWILIO_ACCOUNT_SID'),
    authToken:    optional('TWILIO_AUTH_TOKEN'),
    phoneNumber:  optional('TWILIO_PHONE_NUMBER'),
    webhookSecret: optional('TWILIO_WEBHOOK_SECRET'),
  },

  elevenlabs: {
    apiKey:  optional('ELEVENLABS_API_KEY'),
    modelId: optional('ELEVENLABS_MODEL_ID', 'eleven_multilingual_v2'),
    voiceId: optional('ELEVENLABS_VOICE_ID'),
    baseUrl: 'https://api.elevenlabs.io/v1',
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
    model:  optional('CLAUDE_MODEL', 'claude-sonnet-4-20250514'),
    maxTokens: 1024,
  },

  google: {
    clientId:     optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    redirectUri:  optional('GOOGLE_REDIRECT_URI'),
    refreshToken: optional('GOOGLE_REFRESH_TOKEN'),
    calendarId:   optional('GOOGLE_CALENDAR_ID', 'primary'),
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  },

  security: {
    jwtSecret:      optional('JWT_SECRET', 'dev_secret_change_in_prod'),
    encryptionKey:  optional('ENCRYPTION_KEY'),
  },

  email: {
    host:     optional('SMTP_HOST', 'smtp.gmail.com'),
    port:     num('SMTP_PORT', 587),
    user:     optional('SMTP_USER'),
    pass:     optional('SMTP_PASS'),
    from:     optional('EMAIL_FROM', 'VocalAI Pro <noreply@vocalai.pro>'),
  },

  calls: {
    maxDuration:     num('CALL_MAX_DURATION', 300),
    retryMax:        num('CALL_RETRY_MAX', 2),
    retryDelayHours: num('CALL_RETRY_DELAY_HOURS', 2),
    hoursStart:      optional('CALL_HOURS_START', '09:00'),
    hoursEnd:        optional('CALL_HOURS_END', '18:30'),
    timezone:        optional('CALL_TIMEZONE', 'Europe/Madrid'),
  },

  languages: {
    supported: (optional('SUPPORTED_LANGUAGES', 'es,ca,en')).split(','),
    default:   optional('DEFAULT_LANGUAGE', 'es'),
  },

  rateLimit: {
    windowMs:    num('RATE_LIMIT_WINDOW_MS', 900000),
    maxRequests: num('RATE_LIMIT_MAX_REQUESTS', 100),
  },
};

module.exports = config;
