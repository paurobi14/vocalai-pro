'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const router  = express.Router();

const twilioService  = require('../services/twilio');
const { db }         = require('../services/database');
const { validateFields, callLimiter } = require('../middleware');
const { generateCallId, sanitizePhone } = require('../utils/helpers');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger').forService('calls-api');

/**
 * POST /api/calls
 * Inicia una llamada inmediata a un contacto.
 */
router.post('/',
  callLimiter,
  [
    body('contactId').isUUID().withMessage('Valid contactId required'),
    body('campaignId').optional().isUUID(),
  ],
  validateFields,
  async (req, res, next) => {
    try {
      const { contactId, campaignId } = req.body;

      // Obtener datos del contacto
      const { rows } = await db.query(
        `SELECT c.*, co.name as company_name
         FROM contacts c
         LEFT JOIN companies co ON c.company_id = co.id
         WHERE c.id = $1 AND c.do_not_call = FALSE`,
        [contactId]
      );

      if (!rows.length) throw new NotFoundError('Contact');
      const contact = rows[0];

      if (!contact.phone) throw new ValidationError('Contact has no phone number');

      const phone  = sanitizePhone(contact.phone);
      const callId = generateCallId();

      // Insertar registro de llamada
      await db.query(
        `INSERT INTO calls (id, contact_id, campaign_id, status, scheduled_at)
         VALUES ($1, $2, $3, 'queued', NOW())`,
        [callId, contactId, campaignId || null]
      );

      // Validar número antes de llamar (opcional, consume crédito de Twilio)
      // const lookup = await twilioService.lookupPhone(phone);
      // if (!lookup.valid) throw new ValidationError('Invalid phone number');

      // Iniciar llamada
      const lang     = contact.preferred_lang || 'es';
      const twilioSid = await twilioService.initiateCall({
        contactId,
        campaignId,
        phoneNumber: phone,
        callId,
        lang,
      });

      logger.info('Call initiated via API', { callId, contactId });

      res.status(201).json({
        success:   true,
        callId,
        twilioSid,
        status:    'initiated',
        contact: {
          name:    contact.name,
          company: contact.company_name,
          lang,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/calls
 * Lista llamadas con filtros y paginación.
 */
router.get('/',
  [
    query('status').optional().isIn(['scheduled','queued','initiated','in-progress','completed','failed','no-answer','busy']),
    query('outcome').optional().isIn(['appointment_set','callback','rejected','no_answer','failed']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
  ],
  validateFields,
  async (req, res, next) => {
    try {
      const page    = req.query.page  || 1;
      const limit   = req.query.limit || 20;
      const offset  = (page - 1) * limit;

      const conditions = ['1=1'];
      const params     = [];
      let   pi         = 1;

      if (req.query.status)  { conditions.push(`ca.status = $${pi++}`);  params.push(req.query.status);  }
      if (req.query.outcome) { conditions.push(`ca.outcome = $${pi++}`); params.push(req.query.outcome); }
      if (req.query.from)    { conditions.push(`ca.created_at >= $${pi++}`); params.push(req.query.from); }
      if (req.query.to)      { conditions.push(`ca.created_at <= $${pi++}`); params.push(req.query.to);   }

      const where = conditions.join(' AND ');

      const { rows } = await db.query(
        `SELECT
           ca.id, ca.status, ca.outcome, ca.duration_secs,
           ca.detected_lang, ca.retry_count, ca.started_at, ca.ended_at,
           ct.name   AS contact_name, ct.phone AS contact_phone,
           co.name   AS company_name,
           cp.name   AS campaign_name,
           (ca.duration_secs IS NOT NULL) AS has_recording
         FROM calls ca
         LEFT JOIN contacts  ct ON ca.contact_id  = ct.id
         LEFT JOIN companies co ON ct.company_id  = co.id
         LEFT JOIN campaigns cp ON ca.campaign_id = cp.id
         WHERE ${where}
         ORDER BY ca.created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      );

      const { rows: countRows } = await db.query(
        `SELECT COUNT(*) FROM calls ca WHERE ${where}`,
        params
      );

      res.json({
        success: true,
        data:    rows,
        pagination: {
          page, limit,
          total: parseInt(countRows[0].count, 10),
          pages: Math.ceil(parseInt(countRows[0].count, 10) / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/calls/:id
 * Detalle completo de una llamada incluido el transcript.
 */
router.get('/:id',
  [param('id').isUUID()],
  validateFields,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT ca.*, ct.name AS contact_name, ct.phone, ct.email,
                co.name AS company_name, cp.name AS campaign_name
         FROM calls ca
         LEFT JOIN contacts  ct ON ca.contact_id  = ct.id
         LEFT JOIN companies co ON ct.company_id  = co.id
         LEFT JOIN campaigns cp ON ca.campaign_id = cp.id
         WHERE ca.id = $1`,
        [req.params.id]
      );

      if (!rows.length) throw new NotFoundError('Call');

      const { rows: turns } = await db.query(
        `SELECT turn_index, speaker, content, lang, intent, created_at
         FROM conversation_turns WHERE call_id = $1 ORDER BY turn_index`,
        [req.params.id]
      );

      res.json({
        success: true,
        data: { ...rows[0], conversation: turns },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/calls/:id
 * Cancela una llamada en curso.
 */
router.delete('/:id',
  [param('id').isUUID()],
  validateFields,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT twilio_call_sid, status FROM calls WHERE id = $1`,
        [req.params.id]
      );

      if (!rows.length) throw new NotFoundError('Call');
      const call = rows[0];

      if (!['initiated', 'ringing', 'in-progress'].includes(call.status)) {
        throw new ValidationError('Call cannot be canceled in current status');
      }

      if (call.twilio_call_sid) {
        await twilioService.cancelCall(call.twilio_call_sid);
      }

      await db.query(
        `UPDATE calls SET status = 'canceled', ended_at = NOW() WHERE id = $1`,
        [req.params.id]
      );

      res.json({ success: true, message: 'Call canceled' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/calls/stats/summary
 * Métricas para el dashboard.
 */
router.get('/stats/summary', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                        AS total,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE outcome = 'appointment_set')     AS appointments,
        COUNT(*) FILTER (WHERE status = 'completed')            AS completed,
        COUNT(*) FILTER (WHERE status IN ('no-answer','busy'))  AS no_answer,
        ROUND(AVG(duration_secs) FILTER (WHERE duration_secs > 0)) AS avg_duration,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE outcome = 'appointment_set') /
          NULLIF(COUNT(*) FILTER (WHERE status = 'completed'), 0)
        , 1) AS success_rate
      FROM calls
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
