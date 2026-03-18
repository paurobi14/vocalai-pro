'use strict';

const Bull   = require('bull');
const config = require('../../config');
const logger = require('../utils/logger').forService('queue');
const { db } = require('./database');
const { generateCallId } = require('../utils/helpers');

let _queue = null;

function getQueue() {
  if (!_queue) {
    _queue = new Bull('calls', { redis: config.redis.url });
  }
  return _queue;
}

// ── Añadir una llamada ────────────────────────────────────────
async function enqueueCall({ contactId, campaignId, phoneNumber, lang, delay = 0 }) {
  const callId = generateCallId();

  await db.query(
    `INSERT INTO calls (id, contact_id, campaign_id, status, scheduled_at)
     VALUES ($1, $2, $3, 'queued', NOW() + $4::interval)`,
    [callId, contactId, campaignId || null, `${delay} milliseconds`]
  );

  const job = await getQueue().add('make-call', {
    callId, contactId, campaignId, phoneNumber, lang,
  }, { delay, jobId: callId });

  logger.info('Call enqueued', { callId, jobId: job.id, delay });
  return { callId, jobId: job.id };
}

// ── Añadir campaña completa ───────────────────────────────────
async function enqueueCampaign(campaignId) {
  const { rows: contacts } = await db.query(
    `SELECT ct.id, ct.phone, ct.preferred_lang
     FROM contacts ct
     WHERE ct.do_not_call = FALSE
     AND ct.id NOT IN (
       SELECT contact_id FROM calls
       WHERE campaign_id = $1
       AND status NOT IN ('failed','canceled')
       AND contact_id IS NOT NULL
     )`,
    [campaignId]
  );

  if (!contacts.length) {
    logger.info('No contacts to call', { campaignId });
    return { enqueued: 0 };
  }

  const INTERVAL_MS = 2 * 60 * 1000; // 2 min entre llamadas
  let enqueued = 0;

  for (let i = 0; i < contacts.length; i++) {
    await enqueueCall({
      contactId:   contacts[i].id,
      campaignId,
      phoneNumber: contacts[i].phone,
      lang:        contacts[i].preferred_lang || config.languages.default,
      delay:       i * INTERVAL_MS,
    });
    enqueued++;
  }

  await db.query(
    `UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [campaignId]
  );

  logger.info('Campaign enqueued', { campaignId, enqueued });
  return { enqueued, totalContacts: contacts.length };
}

// ── Cancelar campaña ──────────────────────────────────────────
async function cancelCampaignQueue(campaignId) {
  const queue = getQueue();
  const jobs  = await queue.getJobs(['waiting', 'delayed', 'active']);
  let cancelled = 0;

  for (const job of jobs) {
    if (job.data.campaignId === campaignId) {
      await job.remove();
      cancelled++;
    }
  }

  await db.query(
    `UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1`,
    [campaignId]
  );

  logger.info('Campaign cancelled', { campaignId, cancelled });
  return { cancelled };
}

// ── Estado de la cola ─────────────────────────────────────────
async function getQueueStats() {
  const queue = getQueue();
  return {
    waiting: await queue.getWaitingCount(),
    active:  await queue.getActiveCount(),
    delayed: await queue.getDelayedCount(),
    failed:  await queue.getFailedCount(),
  };
}

module.exports = { enqueueCall, enqueueCampaign, cancelCampaignQueue, getQueueStats };
