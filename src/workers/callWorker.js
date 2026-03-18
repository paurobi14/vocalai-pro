'use strict';

require('dotenv').config();

const Bull   = require('bull');
const config = require('../../config');
const logger = require('../utils/logger').forService('call-worker');
const { db } = require('../services/database');
const twilioService = require('../services/twilio');
const { isWithinCallHours, getNextCallWindow, sanitizePhone } = require('../utils/helpers');

// ── Cola de llamadas ──────────────────────────────────────────
const callQueue = new Bull('calls', {
  redis: config.redis.url,
  defaultJobOptions: {
    attempts:  config.calls.retryMax + 1,
    backoff:   { type: 'fixed', delay: config.calls.retryDelayHours * 3_600_000 },
    removeOnComplete: 100,
    removeOnFail:     200,
  },
});

// ── Procesar cada llamada ─────────────────────────────────────
callQueue.process('make-call', 3, async (job) => {
  const { callId, contactId, campaignId, phoneNumber, lang } = job.data;
  const log = logger.child({ callId, jobId: job.id });

  log.info('Processing call job', { attempt: job.attemptsMade + 1 });

  // Verificar horario laboral
  if (!isWithinCallHours()) {
    const next = getNextCallWindow();
    log.info('Outside call hours, delaying', { next });
    throw new Error(`Outside call hours. Next window: ${next.toISOString()}`);
  }

  // Verificar contacto activo
  const { rows } = await db.query(
    'SELECT phone, do_not_call, preferred_lang FROM contacts WHERE id = $1',
    [contactId]
  );

  if (!rows.length) {
    log.warn('Contact not found, skipping');
    return { skipped: true, reason: 'contact_not_found' };
  }

  const contact = rows[0];

  if (contact.do_not_call) {
    log.info('Contact on do-not-call list, skipping');
    await db.query(
      'UPDATE calls SET status = $1, outcome = $2 WHERE id = $3',
      ['canceled', 'rejected', callId]
    );
    return { skipped: true, reason: 'do_not_call' };
  }

  const phone = sanitizePhone(phoneNumber || contact.phone);

  const twilioSid = await twilioService.initiateCall({
    contactId,
    campaignId,
    phoneNumber: phone,
    callId,
    lang: lang || contact.preferred_lang || config.languages.default,
  });

  log.info('Call initiated', { twilioSid });
  return { success: true, twilioSid };
});

// ── Eventos ───────────────────────────────────────────────────
callQueue.on('completed', (job, result) => {
  if (!result.skipped) {
    logger.info('Job completed', { jobId: job.id, callId: job.data.callId });
  }
});

callQueue.on('failed', async (job, err) => {
  logger.warn('Job failed', {
    jobId:   job.id,
    callId:  job.data.callId,
    attempt: job.attemptsMade,
    error:   err.message,
  });

  if (job.attemptsMade >= job.opts.attempts) {
    await db.query(
      'UPDATE calls SET status = $1, outcome = $2 WHERE id = $3',
      ['failed', 'failed', job.data.callId]
    ).catch(() => {});
  }
});

callQueue.on('error', (err) => {
  logger.error('Queue error', { error: err.message });
});

logger.info('Call worker started');

process.on('SIGTERM', async () => {
  await callQueue.close();
  process.exit(0);
});

module.exports = { callQueue };
