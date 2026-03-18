'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const router  = express.Router();

const queueService = require('../services/queue');
const { db }       = require('../services/database');
const { validateFields } = require('../middleware');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger').forService('campaigns-api');

router.post('/',
  [
    body('name').notEmpty().trim(),
    body('scriptEs').notEmpty(),
    body('scriptCa').optional().trim(),
    body('scriptEn').optional().trim(),
    body('voiceId').optional().trim(),
  ],
  validateFields,
  async (req, res, next) => {
    try {
      const { name, scriptEs, scriptCa, scriptEn, voiceId } = req.body;
      const { rows } = await db.query(
        `INSERT INTO campaigns (name, script_es, script_ca, script_en, voice_id, status)
         VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
        [name, scriptEs, scriptCa || scriptEs, scriptEn || scriptEs, voiceId || null]
      );
      logger.info('Campaign created', { campaignId: rows[0].id });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { next(err); }
  }
);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*,
         COUNT(DISTINCT ca.id) AS total_calls,
         COUNT(DISTINCT ca.id) FILTER (WHERE ca.outcome = 'appointment_set') AS appointments
       FROM campaigns c
       LEFT JOIN calls ca ON c.id = ca.campaign_id
       GROUP BY c.id ORDER BY c.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.get('/:id',
  [param('id').isUUID()], validateFields,
  async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
      if (!rows.length) throw new NotFoundError('Campaign');
      res.json({ success: true, data: rows[0] });
    } catch (err) { next(err); }
  }
);

router.post('/:id/launch',
  [param('id').isUUID()], validateFields,
  async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
      if (!rows.length) throw new NotFoundError('Campaign');
      if (rows[0].status === 'active') throw new ValidationError('Campaign already active');

      const result = await queueService.enqueueCampaign(req.params.id);
      logger.info('Campaign launched', { campaignId: req.params.id, ...result });
      res.json({ success: true, message: `${result.enqueued} calls queued`, data: result });
    } catch (err) { next(err); }
  }
);

router.post('/:id/pause',
  [param('id').isUUID()], validateFields,
  async (req, res, next) => {
    try {
      const result = await queueService.cancelCampaignQueue(req.params.id);
      res.json({ success: true, message: 'Campaign paused', data: result });
    } catch (err) { next(err); }
  }
);

router.get('/queue/stats', async (req, res, next) => {
  try {
    const stats = await queueService.getQueueStats();
    res.json({ success: true, data: stats });
  } catch (err) { next(err); }
});

module.exports = router;
