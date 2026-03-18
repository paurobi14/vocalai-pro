'use strict';

const WebSocket = require('ws');
const logger    = require('../utils/logger').forService('audio-stream');
const { db }    = require('./database');

let aiService, elevenlabsService;
const getAI = () => aiService || (aiService = require('./ai'));
const getEL = () => elevenlabsService || (elevenlabsService = require('./elevenlabs'));

const activeSessions = new Map();

class CallSession {
  constructor({ callId, lang, ws }) {
    this.callId    = callId;
    this.lang      = lang;
    this.ws        = ws;
    this.streamSid = null;
    this.buffer    = [];
    this.history   = [];
    this.active    = true;
    this.silenceTimer = null;
    logger.info('Session created', { callId, lang });
  }

  sendAudio(base64Audio) {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: base64Audio } }));
  }

  sendMark(label) {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: label } }));
  }

  destroy() {
    this.active = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    activeSessions.delete(this.callId);
    logger.info('Session destroyed', { callId: this.callId });
  }
}

function createAudioStreamServer(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/stream/audio')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const callId = url.searchParams.get('callId');
    const lang   = url.searchParams.get('lang') || 'es';

    if (!callId) { ws.close(1008, 'Missing callId'); return; }

    const session = new CallSession({ callId, lang, ws });
    activeSessions.set(callId, session);

    ws.on('message', (data) => handleTwilioMessage(session, data));
    ws.on('close',   ()     => handleSessionClose(session));
    ws.on('error',   (err)  => logger.error('WS error', { callId, error: err.message }));
  });

  logger.info('Audio stream WebSocket server ready');
  return wss;
}

async function handleTwilioMessage(session, rawData) {
  let msg;
  try { msg = JSON.parse(rawData); } catch { return; }

  switch (msg.event) {
    case 'connected':
      logger.debug('Twilio WS connected', { callId: session.callId });
      break;
    case 'start':
      session.streamSid = msg.start.streamSid;
      logger.info('Stream started', { callId: session.callId });
      await handleAIGreeting(session);
      break;
    case 'media':
      session.buffer.push(msg.media.payload);
      resetSilenceDetection(session);
      break;
    case 'mark':
      logger.debug('Mark received', { callId: session.callId, name: msg.mark.name });
      break;
    case 'stop':
      session.destroy();
      break;
  }
}

function resetSilenceDetection(session) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  session.silenceTimer = setTimeout(() => {
    if (session.buffer.length > 0) {
      const chunks = [...session.buffer];
      session.buffer = [];
      processCallerSpeech(session, chunks);
    }
  }, 1500);
}

async function processCallerSpeech(session, audioChunks) {
  try {
    const transcript = await transcribeAudio(audioChunks, session.lang);
    if (!transcript || transcript.trim().length < 2) return;

    logger.info('Caller said', { callId: session.callId, text: transcript.substring(0, 80) });

    await saveConversationTurn(session.callId, 'human', transcript, session.lang);
    session.history.push({ role: 'user', content: transcript });

    const aiResponse = await getAI().generateResponse({
      callId:   session.callId,
      history:  session.history,
      lang:     session.lang,
      userText: transcript,
    });

    if (!aiResponse) return;

    await saveConversationTurn(session.callId, 'ai', aiResponse.text, session.lang, aiResponse.intent);
    session.history.push({ role: 'assistant', content: aiResponse.text });

    const audioBase64 = await getEL().synthesize({ text: aiResponse.text, lang: session.lang });
    session.sendAudio(audioBase64);
    session.sendMark(`ai_turn_${session.history.length}`);

    // Agendar cita automáticamente
    if (aiResponse.action === 'create_appointment' && aiResponse.appointmentData) {
      const calendarService = require('./calendar');
      await calendarService.createAppointmentFromCall({
        callId: session.callId,
        data:   aiResponse.appointmentData,
        lang:   session.lang,
      });
      logger.info('Appointment created from inbound call', { callId: session.callId });
    }

    // Guardar mensaje para el empresario
    if (aiResponse.action === 'save_message' && aiResponse.messageData) {
      await db.query(
        `INSERT INTO conversation_turns (call_id, turn_index, speaker, content, lang, intent)
         VALUES ($1, $2, 'human', $3, $4, 'message')`,
        [session.callId, session.history.length, JSON.stringify(aiResponse.messageData), session.lang]
      );
      logger.info('Message saved', { callId: session.callId });
    }

    // Transferir llamada a persona real
    if (aiResponse.action === 'transfer_call') {
      await handleTransfer(session);
    }

    if (aiResponse.intent === 'farewell') {
      setTimeout(() => { if (session.active) session.ws.close(); }, 3000);
    }

  } catch (err) {
    logger.error('Error processing speech', { callId: session.callId, error: err.message });
  }
}

async function handleTransfer(session) {
  try {
    const { rows } = await db.query(
      `SELECT co.notes AS transfer_phone FROM calls ca
       LEFT JOIN contacts ct ON ca.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ca.id = $1`, [session.callId]
    );
    const transferPhone = rows[0]?.transfer_phone;
    if (transferPhone) {
      const twilio = require('./twilio');
      const { rows: callRows } = await db.query('SELECT twilio_call_sid FROM calls WHERE id=$1', [session.callId]);
      if (callRows[0]?.twilio_call_sid) {
        await twilio.client.calls(callRows[0].twilio_call_sid).update({
          twiml: `<Response><Dial>${transferPhone}</Dial></Response>`
        });
        logger.info('Call transferred', { callId: session.callId, to: transferPhone });
      }
    }
  } catch (err) {
    logger.error('Transfer failed', { callId: session.callId, error: err.message });
  }
}

async function handleAIGreeting(session) {
  try {
    const greeting = await getAI().generateGreeting({ callId: session.callId, lang: session.lang });
    await saveConversationTurn(session.callId, 'ai', greeting, session.lang, 'greeting');
    session.history.push({ role: 'assistant', content: greeting });
    const audioBase64 = await getEL().synthesize({ text: greeting, lang: session.lang });
    session.sendAudio(audioBase64);
    session.sendMark('greeting');
  } catch (err) {
    logger.error('Error sending greeting', { callId: session.callId, error: err.message });
  }
}

async function transcribeAudio(audioChunks, lang) {
  return null;
}

async function saveConversationTurn(callId, speaker, content, lang, intent = null) {
  const { rows } = await db.query('SELECT COUNT(*) as cnt FROM conversation_turns WHERE call_id=$1', [callId]);
  const turnIndex = parseInt(rows[0].cnt, 10);
  await db.query(
    `INSERT INTO conversation_turns (call_id, turn_index, speaker, content, lang, intent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [callId, turnIndex, speaker, content, lang, intent]
  );
}

async function handleSessionClose(session) {
  session.destroy();
  try {
    const { rows } = await db.query(
      `SELECT speaker, content FROM conversation_turns WHERE call_id=$1 ORDER BY turn_index`, [session.callId]
    );
    const transcript = rows.map(r => `[${r.speaker.toUpperCase()}]: ${r.content}`).join('\n');
    await db.query('UPDATE calls SET transcript=$1 WHERE id=$2', [transcript, session.callId]);
  } catch (err) {
    logger.error('Error saving transcript', { callId: session.callId, error: err.message });
  }
}

function getSession(callId) { return activeSessions.get(callId) || null; }

module.exports = { createAudioStreamServer, getSession };
