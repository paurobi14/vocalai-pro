'use strict';

const express = require('express');
const { param, query } = require('express-validator');
const router  = express.Router();

const calendarService = require('../services/calendar');
const { db }          = require('../services/database');
const { validateFields } = require('../middleware');
const { NotFoundError }  = require('../utils/errors');
const logger = require('../utils/logger').forService('appointments-api');

/**
 * GET /api/appointments
 * Lista todas las citas con filtros.
 */
router.get('/',
  [
    query('status').optional().isIn(['confirmed', 'cancelled', 'rescheduled']),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateFields,
  async (req, res, next) => {
    try {
      const page   = req.query.page  || 1;
      const limit  = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['1=1'];
      const params     = [];
      let pi = 1;

      if (req.query.status) { conditions.push(`a.status = $${pi++}`);      params.push(req.query.status); }
      if (req.query.from)   { conditions.push(`a.start_time >= $${pi++}`); params.push(req.query.from);   }
      if (req.query.to)     { conditions.push(`a.start_time <= $${pi++}`); params.push(req.query.to);     }

      const where = conditions.join(' AND ');

      const { rows } = await db.query(
        `SELECT
           a.id, a.title, a.start_time, a.end_time, a.status,
           a.location, a.google_event_id, a.reminder_sent,
           ct.name AS contact_name, ct.email AS contact_email, ct.phone,
           co.name AS company_name
         FROM appointments a
         LEFT JOIN contacts  ct ON a.contact_id = ct.id
         LEFT JOIN companies co ON ct.company_id = co.id
         WHERE ${where}
         ORDER BY a.start_time ASC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      );

      const { rows: countRows } = await db.query(
        `SELECT COUNT(*) FROM appointments a WHERE ${where}`, params
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
 * GET /api/appointments/:id
 * Detalle de una cita.
 */
router.get('/:id',
  [param('id').isUUID()],
  validateFields,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT a.*, ct.name AS contact_name, ct.email, ct.phone, co.name AS company_name
         FROM appointments a
         LEFT JOIN contacts  ct ON a.contact_id = ct.id
         LEFT JOIN companies co ON ct.company_id = co.id
         WHERE a.id = $1`,
        [req.params.id]
      );

      if (!rows.length) throw new NotFoundError('Appointment');
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/appointments/:id
 * Cancela una cita y la elimina de Google Calendar.
 */
router.delete('/:id',
  [param('id').isUUID()],
  validateFields,
  async (req, res, next) => {
    try {
      await calendarService.cancelAppointment(req.params.id);
      res.json({ success: true, message: 'Appointment cancelled' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/appointments/stats/upcoming
 * Próximas citas para el dashboard.
 */
router.get('/stats/upcoming', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         a.id, a.title, a.start_time, a.end_time, a.status,
         ct.name AS contact_name, co.name AS company_name
       FROM appointments a
       LEFT JOIN contacts  ct ON a.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       WHERE a.start_time >= NOW() AND a.status = 'confirmed'
       ORDER BY a.start_time ASC
       LIMIT 10`
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
