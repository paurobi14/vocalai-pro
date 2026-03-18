'use strict';

const twilio        = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const config        = require('../../config');
const logger        = require('../utils/logger').forService('twilio');
const { db }        = require('./database');
const { TwilioError, CallSchedulingError } = require('../utils/errors');
const { withRetry, isWithinCallHours, getNextCallWindow, formatDuration } = require('../utils/helpers');

// ── Cliente Twilio — se crea solo cuando se necesita ─────────
let _client = null;
function getClient() {
  if (!_client) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new TwilioError('Twilio credentials not configured');
    _client = twilio(sid, token);
  }
  return _client;
}

// Exportar client como getter para compatibilidad
Object.defineProperty(module.exports, 'client', { get: getClient });

async function initiateCall({ contactId, campaignId, phoneNumber, callId, lang }) {
  if (!isWithinCallHours()) {
    const next = getNextCallWindow();
    throw new CallSchedulingError(`Outside call hours. Next window: ${next.toISOString()}`);
  }

  let twilioSid;
  try {
    const call = await withRetry(
      () => getClient().calls.create({
        to:   phoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
        url:  `${process.env.APP_URL}/api/webhooks/twilio/voice?callId=${callId}`,
        statusCallback:       `${process.env.APP_URL}/api/webhooks/twilio/status?callId=${callId}`,
        statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        machineDetection:     'Enable',
        machineDetectionTimeout: 4000,
        asyncAmdStatusCallback: `${process.env.APP_URL}/api/webhooks/twilio/amd?callId=${callId}`,
        timeout:   30,
        timeLimit: config.calls.maxDuration,
      }),
      { maxAttempts: 2, delayMs: 1000 }
    );
    twilioSid = call.sid;
  } catch (err) {
    throw new TwilioError(`Failed to initiate call: ${err.message}`);
  }

  await db.query(
    `UPDATE calls SET twilio_call_sid=$1, status='initiated', started_at=NOW() WHERE id=$2`,
    [twilioSid, callId]
  );
  logger.info('Call initiated', { callId, twilioSid });
  return twilioSid;
}

function buildVoiceResponse({ callId, lang = 'es' }) {
  const twiml   = new VoiceResponse();
  const connect = twiml.connect();
  const appUrl  = process.env.APP_URL || 'http://localhost:3000';
  const wsHost  = appUrl.replace('https://', '').replace('http://', '');
  const stream  = connect.stream({
    url:  `wss://${wsHost}/api/stream/audio?callId=${callId}&lang=${lang}`,
    name: `vocalai_${callId}`,
  });
  stream.parameter({ name: 'callId',    value: callId });
  stream.parameter({ name: 'lang',      value: lang });
  stream.parameter({ name: 'timestamp', value: Date.now().toString() });
  return twiml.toString();
}

function buildActionResponse(action, opts = {}) {
  const twiml = new VoiceResponse();
  switch (action) {
    case 'say': {
      const langMap = { es: 'es-ES', ca: 'es-ES', en: 'en-GB' };
      twiml.say({ voice: 'Polly.Conchita', language: langMap[opts.lang] || 'es-ES' }, opts.text || '');
      break;
    }
    case 'pause':   twiml.pause({ length: opts.seconds || 1 }); break;
    case 'hangup':
      if (opts.farewell) twiml.say({ voice: 'Polly.Conchita', language: 'es-ES' }, opts.farewell);
      twiml.hangup();
      break;
    case 'voicemail':
      twiml.say({ voice: 'Polly.Conchita', language: 'es-ES' }, 'Le contactaremos en otra ocasión. Gracias.');
      twiml.hangup();
      break;
    default: twiml.pause({ length: 1 });
  }
  return twiml.toString();
}

async function handleStatusCallback({ callId, twilioSid, callStatus, callDuration, answeredBy }) {
  const statusMap = {
    'initiated':'initiated','ringing':'ringing','in-progress':'in-progress',
    'completed':'completed','busy':'busy','no-answer':'no-answer',
    'failed':'failed','canceled':'canceled',
  };
  const status   = statusMap[callStatus] || callStatus;
  const duration = callDuration ? parseInt(callDuration, 10) : null;
  const terminal = ['completed','busy','no-answer','failed','canceled'];

  await db.query(
    `UPDATE calls SET status=$1, duration_secs=COALESCE($2,duration_secs),
     ended_at=CASE WHEN $1=ANY($3::text[]) THEN NOW() ELSE ended_at END,
     metadata=metadata||$4 WHERE id=$5`,
    [status, duration, terminal, JSON.stringify({ answeredBy, twilioSid }), callId]
  );
  logger.info(`Call status → ${callStatus}`, { callId });
  if (['busy','no-answer','failed'].includes(callStatus)) await scheduleRetryIfNeeded(callId);
}

async function handleAMD({ callId, twilioSid, answeredBy }) {
  logger.info('AMD result', { callId, answeredBy });
  if (['machine_start','fax'].includes(answeredBy)) {
    try { await getClient().calls(twilioSid).update({ status: 'completed' }); } catch (_) {}
    await db.query(
      `UPDATE calls SET outcome='no_answer', metadata=metadata||'{"answeredBy":"machine"}' WHERE id=$1`,
      [callId]
    );
    await scheduleRetryIfNeeded(callId);
  }
}

async function scheduleRetryIfNeeded(callId) {
  const { rows } = await db.query(
    'SELECT retry_count, contact_id, campaign_id FROM calls WHERE id=$1', [callId]
  );
  if (!rows.length) return;
  const { retry_count, contact_id, campaign_id } = rows[0];
  if (retry_count >= config.calls.retryMax) { logger.info('Max retries reached', { callId }); return; }
  const scheduledAt = new Date(Date.now() + config.calls.retryDelayHours * 3_600_000);
  await db.query(
    `INSERT INTO calls (contact_id, campaign_id, status, retry_count, scheduled_at)
     VALUES ($1,$2,'scheduled',$3,$4)`,
    [contact_id, campaign_id, retry_count + 1, scheduledAt]
  );
  logger.info('Retry scheduled', { callId, scheduledAt, attempt: retry_count + 1 });
}

async function cancelCall(twilioSid) {
  await withRetry(() => getClient().calls(twilioSid).update({ status: 'canceled' }));
  logger.info('Call canceled', { twilioSid });
}

async function getRecordingUrl(twilioSid) {
  const recordings = await getClient().recordings.list({ callSid: twilioSid, limit: 1 });
  if (!recordings.length) return null;
  return `https://api.twilio.com${recordings[0].uri.replace('.json', '.mp3')}`;
}

async function lookupPhone(phoneNumber) {
  try {
    const result = await getClient().lookups.v2.phoneNumbers(phoneNumber).fetch({ fields: 'line_type_intelligence' });
    return { valid: result.valid, country: result.countryCode, lineType: result.lineTypeIntelligence?.type || 'unknown', national: result.nationalFormat };
  } catch (err) {
    throw new TwilioError(`Phone lookup failed: ${err.message}`);
  }
}

module.exports = {
  initiateCall, buildVoiceResponse, buildActionResponse,
  handleStatusCallback, handleAMD, scheduleRetryIfNeeded,
  cancelCall, getRecordingUrl, lookupPhone,
  get client() { return getClient(); },
};
