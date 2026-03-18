'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config    = require('../../config');
const logger    = require('../utils/logger').forService('ai');
const { db }    = require('./database');
const { AIError } = require('../utils/errors');
const { detectLanguageBasic } = require('../utils/helpers');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── System prompt para recepcionista virtual ──────────────────
const RECEPTIONIST_PROMPT = {
  es: (businessName, ownerName, faq, transferPhone) => `
Eres la recepcionista virtual de ${businessName}, hablando con la voz de ${ownerName}.
Eres amable, profesional y eficiente. Tu objetivo es atender al cliente al 100%.

INFORMACIÓN DE LA EMPRESA:
${faq || 'Responde de forma general y ofrece agendar una cita para más información.'}

CAPACIDADES:
1. Responder preguntas frecuentes sobre la empresa
2. Agendar citas en el calendario
3. Tomar mensajes para el equipo
4. Transferir llamadas urgentes al ${transferPhone || 'equipo'}

REGLAS:
- Habla siempre en el idioma del cliente (ES, CA o EN)
- Sé breve — máximo 2-3 frases por turno
- Nunca digas que eres una IA
- Si el cliente quiere hablar con una persona real → ofrece transferir o tomar un mensaje
- Si es urgente → transfiere la llamada
- Si quiere cita → extrae fecha, hora y motivo

Responde SIEMPRE en este JSON exacto:
{
  "text": "lo que dices en voz alta",
  "intent": "greeting|faq|appointment|message|transfer|farewell|other",
  "action": null,
  "appointmentData": null,
  "messageData": null
}

Si intent es "appointment":
{
  "text": "Perfecto, le agendo para el...",
  "intent": "appointment",
  "action": "create_appointment",
  "appointmentData": { "date": "2026-03-20", "time": "10:00", "duration": 30, "reason": "motivo de la visita" },
  "messageData": null
}

Si intent es "message":
{
  "text": "Le dejo el mensaje al equipo...",
  "intent": "message",
  "action": "save_message",
  "appointmentData": null,
  "messageData": { "from": "nombre del cliente", "phone": "teléfono si lo da", "content": "contenido del mensaje" }
}

Si intent es "transfer":
{
  "text": "Le transfiero ahora mismo...",
  "intent": "transfer",
  "action": "transfer_call",
  "appointmentData": null,
  "messageData": null
}`,

  ca: (businessName, ownerName, faq, transferPhone) => `
Ets la recepcionista virtual de ${businessName}, parlant amb la veu de ${ownerName}.
Ets amable, professional i eficient.

INFORMACIÓ DE L'EMPRESA:
${faq || 'Respon de forma general i ofereix concertar una cita per a més informació.'}

REGLES:
- Parla sempre en l'idioma del client
- Màxim 2-3 frases per torn
- Mai diguis que ets una IA
- Si vol una persona real → ofereix transferir o deixar un missatge

Respon SEMPRE en aquest JSON exacte:
{
  "text": "el que dius en veu alta",
  "intent": "greeting|faq|appointment|message|transfer|farewell|other",
  "action": null,
  "appointmentData": null,
  "messageData": null
}`,

  en: (businessName, ownerName, faq, transferPhone) => `
You are the virtual receptionist of ${businessName}, speaking with ${ownerName}'s voice.
You are friendly, professional and efficient.

COMPANY INFO:
${faq || 'Answer generally and offer to schedule an appointment for more information.'}

RULES:
- Always speak in the client's language
- Maximum 2-3 sentences per turn
- Never say you are an AI
- If they want a real person → offer to transfer or take a message

Always respond in this exact JSON:
{
  "text": "what you say out loud",
  "intent": "greeting|faq|appointment|message|transfer|farewell|other",
  "action": null,
  "appointmentData": null,
  "messageData": null
}`
};

// ── Saludos entrantes por idioma ──────────────────────────────
const INBOUND_GREETINGS = {
  es: (businessName, ownerName) => `Hola, gracias por llamar a ${businessName}. Le atiende ${ownerName}. ¿En qué le puedo ayudar?`,
  ca: (businessName, ownerName) => `Hola, gràcies per trucar a ${businessName}. L'atén ${ownerName}. En què li puc ajudar?`,
  en: (businessName, ownerName) => `Hello, thank you for calling ${businessName}. This is ${ownerName} speaking. How can I help you?`,
};

// ── Obtener configuración de la empresa ───────────────────────
async function getBusinessConfig(callId) {
  const { rows } = await db.query(
    `SELECT
       ca.id, ca.detected_lang,
       cp.script_es AS faq_es, cp.script_ca AS faq_ca, cp.script_en AS faq_en,
       cp.name AS campaign_name,
       co.name AS company_name,
       co.notes AS transfer_phone
     FROM calls ca
     LEFT JOIN campaigns cp ON ca.campaign_id = cp.id
     LEFT JOIN contacts  ct ON ca.contact_id  = ct.id
     LEFT JOIN companies co ON ct.company_id  = co.id
     WHERE ca.id = $1`,
    [callId]
  );
  return rows[0] || null;
}

// ── Generar saludo inicial (llamada entrante) ─────────────────
async function generateGreeting({ callId, lang }) {
  try {
    const ctx = await getBusinessConfig(callId);
    const greeting = INBOUND_GREETINGS[lang] || INBOUND_GREETINGS.es;
    const businessName = ctx?.company_name || 'nuestra empresa';
    const ownerName    = ctx?.campaign_name || 'el equipo';
    return greeting(businessName, ownerName);
  } catch (err) {
    logger.error('Error generating greeting', { callId, error: err.message });
    return INBOUND_GREETINGS.es('nuestra empresa', 'el equipo');
  }
}

// ── Generar respuesta de la IA ────────────────────────────────
async function generateResponse({ callId, history, lang, userText }) {
  try {
    const detectedLang = detectLanguageBasic(userText);
    const activeLang   = detectedLang !== lang ? detectedLang : lang;

    if (activeLang !== lang) {
      await db.query('UPDATE calls SET detected_lang = $1 WHERE id = $2', [activeLang, callId]);
      logger.info('Language switched', { callId, from: lang, to: activeLang });
    }

    const ctx = await getBusinessConfig(callId);
    if (!ctx) throw new AIError('Call context not found');

    const faqMap = { es: ctx.faq_es, ca: ctx.faq_ca, en: ctx.faq_en };
    const faq    = faqMap[activeLang] || ctx.faq_es || '';

    const businessName  = ctx.company_name  || 'nuestra empresa';
    const ownerName     = ctx.campaign_name || 'el equipo';
    const transferPhone = ctx.transfer_phone || '';

    const promptFn = RECEPTIONIST_PROMPT[activeLang] || RECEPTIONIST_PROMPT.es;
    const systemPrompt = promptFn(businessName, ownerName, faq, transferPhone);

    const response = await client.messages.create({
      model:      config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system:     systemPrompt,
      messages:   history.slice(-10),
    });

    const rawText = response.content[0]?.text || '';

    let parsed;
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : rawText);
    } catch {
      parsed = { text: rawText, intent: 'other', action: null, appointmentData: null, messageData: null };
    }

    logger.info('AI response', { callId, intent: parsed.intent, action: parsed.action, lang: activeLang });

    return {
      text:            parsed.text || '',
      intent:          parsed.intent || 'other',
      action:          parsed.action || null,
      appointmentData: parsed.appointmentData || null,
      messageData:     parsed.messageData || null,
      lang:            activeLang,
    };

  } catch (err) {
    logger.error('Error generating response', { callId, error: err.message });
    throw new AIError(`AI response failed: ${err.message}`);
  }
}

async function detectIntent(text, lang = 'es') {
  return 'other';
}

module.exports = { generateGreeting, generateResponse, detectIntent };
