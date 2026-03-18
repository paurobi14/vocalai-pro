'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../../config');

// ── IDs únicos ───────────────────────────────────────────────
const generateCallId    = () => `call_${uuidv4()}`;
const generateContactId = () => `cnt_${uuidv4()}`;
const generateEventId   = () => `evt_${uuidv4()}`;

// ── Horario laboral ──────────────────────────────────────────
/**
 * Verifica si ahora mismo está dentro del horario de llamadas configurado
 */
function isWithinCallHours() {
  const now = new Date();
  const tz  = config.calls.timezone;

  // Hora local en la zona horaria configurada
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  }).format(now).toLowerCase();

  // No llamar fines de semana
  if (day === 'saturday' || day === 'sunday') return false;

  const [currentH, currentM] = localTime.split(':').map(Number);
  const [startH, startM]     = config.calls.hoursStart.split(':').map(Number);
  const [endH, endM]         = config.calls.hoursEnd.split(':').map(Number);

  const currentMins = currentH * 60 + currentM;
  const startMins   = startH   * 60 + startM;
  const endMins     = endH     * 60 + endM;

  return currentMins >= startMins && currentMins < endMins;
}

/**
 * Calcula la próxima ventana de llamadas válida
 */
function getNextCallWindow() {
  const now = new Date();
  const tz  = config.calls.timezone;
  const [startH, startM] = config.calls.hoursStart.split(':').map(Number);

  // Día siguiente (o el lunes si es fin de semana)
  const next = new Date(now);
  next.setDate(next.getDate() + 1);

  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' })
    .format(next).toLowerCase();

  if (day === 'saturday') next.setDate(next.getDate() + 2);
  if (day === 'sunday')   next.setDate(next.getDate() + 1);

  next.setHours(startH, startM, 0, 0);
  return next;
}

// ── Formateo de duración ─────────────────────────────────────
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Formateo de fechas ───────────────────────────────────────
function formatDateLocale(date, lang = 'es', tz = config.calls.timezone) {
  const formats = {
    es: { dateStyle: 'full', timeStyle: 'short', timeZone: tz },
    ca: { dateStyle: 'full', timeStyle: 'short', timeZone: tz },
    en: { dateStyle: 'full', timeStyle: 'short', timeZone: tz },
  };
  const locale = lang === 'ca' ? 'ca-ES' : lang === 'en' ? 'en-GB' : 'es-ES';
  return new Intl.DateTimeFormat(locale, formats[lang] || formats.es).format(new Date(date));
}

// ── Sanitización ─────────────────────────────────────────────
function sanitizePhone(phone) {
  return phone.replace(/\s+/g, '').replace(/[^+\d]/g, '');
}

function maskPhone(phone) {
  const clean = sanitizePhone(phone);
  return clean.slice(0, -4).replace(/\d/g, '*') + clean.slice(-4);
}

// ── Reintentos con backoff ───────────────────────────────────
async function withRetry(fn, { maxAttempts = 3, delayMs = 1000, factor = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = delayMs * Math.pow(factor, attempt - 1);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── Detección de idioma básica (fallback sin API) ─────────────
const CATALAN_MARKERS  = ['molt', 'però', 'gràcies', 'sí', 'bon dia', 'hola', 'com estàs', 'avui', 'ara'];
const ENGLISH_MARKERS  = ['hello', 'hi', 'yes', 'no', 'thanks', 'please', 'good morning', 'okay', 'sure'];
const SPANISH_MARKERS  = ['hola', 'sí', 'no', 'gracias', 'buenos días', 'de acuerdo', 'claro', 'por favor'];

function detectLanguageBasic(text) {
  const lower = text.toLowerCase();
  let scores  = { es: 0, ca: 0, en: 0 };

  CATALAN_MARKERS.forEach((m) => { if (lower.includes(m)) scores.ca++; });
  ENGLISH_MARKERS.forEach((m) => { if (lower.includes(m)) scores.en++; });
  SPANISH_MARKERS.forEach((m) => { if (lower.includes(m)) scores.es++; });

  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

module.exports = {
  generateCallId,
  generateContactId,
  generateEventId,
  isWithinCallHours,
  getNextCallWindow,
  formatDuration,
  formatDateLocale,
  sanitizePhone,
  maskPhone,
  withRetry,
  sleep,
  detectLanguageBasic,
};
