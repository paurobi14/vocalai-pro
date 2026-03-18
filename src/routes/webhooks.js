'use strict';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

const twilioService = require('../services/twilio');
const { db }        = require('../services/database');
const { validateTwilioWebhook } = require('../middleware');
const { generateCallId } = require('../utils/helpers');
const logger = require('../utils/logger').forService('webhooks');

router.use(validateTwilioWebhook);

/**
 * POST /api/webhooks/twilio/inbound
 * Twilio llama aquí cuando alguien llama al número de la empresa.
 * Creamos el registro de llamada y abrimos el stream de audio.
 */
router.post('/twilio/inbound', async (req, res) => {
  const { CallSid, From, To, CallStatus } = req.body;
  const lang = detectLangFromNumber(From) || 'es';
  const callId = generateCallId();

  logger.info('Inbound call received', { callId, from: From, to: To });

  try {
    // Buscar o crear contacto por número
    let contactId = null;
    const { rows: existing } = await db.query(
      'SELECT id FROM contacts WHERE phone = $1', [From]
    );

    if (existing.length) {
      contactId = existing[0].id;
      await db.query(
        'UPDATE contacts SET call_count = call_count + 1, last_called_at = NOW() WHERE id = $1',
        [contactId]
      );
    } else {
      const { rows: newContact } = await db.query(
        `INSERT INTO contacts (name, phone, preferred_lang) VALUES ($1, $2, $3) RETURNING id`,
        [`Llamada entrante ${From}`, From, lang]
      );
      contactId = newContact[0].id;
    }

    // Buscar campaña activa para este número destino
    const { rows: campaigns } = await db.query(
      `SELECT id FROM campaigns WHERE status = 'active' LIMIT 1`
    );
    const campaignId = campaigns[0]?.id || null;

    // Registrar la llamada
    await db.query(
      `INSERT INTO calls (id, contact_id, campaign_id, twilio_call_sid, status, detected_lang, started_at)
       VALUES ($1, $2, $3, $4, 'in-progress', $5, NOW())`,
      [callId, contactId, campaignId, CallSid, lang]
    );

    // Responder con TwiML que abre el stream de audio
    const twiml = twilioService.buildVoiceResponse({ callId, lang });
    res.type('text/xml').send(twiml);

  } catch (err) {
    logger.error('Inbound call error', { error: err.message });
    // Respuesta de fallback si algo falla
    res.type('text/xml').send(`
      <Response>
        <Say language="es-ES" voice="Polly.Conchita">
          Gracias por su llamada. En este momento no podemos atenderle. Por favor, inténtelo de nuevo más tarde.
        </Say>
        <Hangup/>
      </Response>
    `);
  }
});

/**
 * POST /api/webhooks/twilio/voice
 * Mantener compatibilidad con llamadas salientes
 */
router.post('/twilio/voice', (req, res) => {
  const callId = req.query.callId;
  const lang   = req.query.lang || 'es';
  if (!callId) return res.status(400).send('Missing callId');
  const twiml = twilioService.buildVoiceResponse({ callId, lang });
  res.type('text/xml').send(twiml);
});

/**
 * POST /api/webhooks/twilio/status
 * Actualizaciones de estado de la llamada
 */
router.post('/twilio/status', async (req, res) => {
  const callId = req.query.callId;
  const { CallSid, CallStatus, CallDuration, AnsweredBy } = req.body;
  res.sendStatus(200);
  if (!callId) return;
  try {
    await twilioService.handleStatusCallback({
      callId, twilioSid: CallSid, callStatus: CallStatus,
      callDuration: CallDuration, answeredBy: AnsweredBy,
    });
  } catch (err) {
    logger.error('Status callback error', { callId, error: err.message });
  }
});

/**
 * POST /api/webhooks/twilio/amd
 * Detección de contestador (para llamadas salientes)
 */
router.post('/twilio/amd', async (req, res) => {
  const callId = req.query.callId;
  const { CallSid, AnsweredBy } = req.body;
  res.sendStatus(200);
  if (!callId) return;
  try {
    await twilioService.handleAMD({ callId, twilioSid: CallSid, answeredBy: AnsweredBy });
  } catch (err) {
    logger.error('AMD callback error', { callId, error: err.message });
  }
});

// ── Detectar idioma por prefijo de número ─────────────────────
function detectLangFromNumber(phone) {
  if (!phone) return 'es';
  if (phone.startsWith('+44')) return 'en';
  if (phone.startsWith('+1'))  return 'en';
  return 'es'; // Por defecto español para números españoles
}

module.exports = router;
