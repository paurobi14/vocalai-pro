'use strict';

const axios   = require('axios');
const config  = require('../../config');
const logger  = require('../utils/logger').forService('elevenlabs');
const { ElevenLabsError } = require('../utils/errors');
const { withRetry }       = require('../utils/helpers');

const BASE_URL = config.elevenlabs.baseUrl;

// ── Configuración de voz por idioma ──────────────────────────
const VOICE_SETTINGS = {
  es: { stability: 0.5, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true },
  ca: { stability: 0.5, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true },
  en: { stability: 0.45, similarity_boost: 0.80, style: 0.15, use_speaker_boost: true },
};

// ── Sintetizar texto a voz ────────────────────────────────────
/**
 * Convierte texto a audio usando la voz clonada del empresario.
 * Devuelve el audio en base64 (formato Twilio μ-law 8kHz).
 */
async function synthesize({ text, lang = 'es', voiceId = null }) {
  if (!text || text.trim().length === 0) {
    throw new ElevenLabsError('No text provided for synthesis');
  }

  const activeVoiceId = voiceId || config.elevenlabs.voiceId;
  if (!activeVoiceId) {
    throw new ElevenLabsError('No voice ID configured. Set ELEVENLABS_VOICE_ID in .env');
  }

  const voiceSettings = VOICE_SETTINGS[lang] || VOICE_SETTINGS.es;

  try {
    const response = await withRetry(
      () => axios.post(
        `${BASE_URL}/text-to-speech/${activeVoiceId}/stream`,
        {
          text,
          model_id:       config.elevenlabs.modelId,
          voice_settings: voiceSettings,
          output_format:  'ulaw_8000', // Formato que acepta Twilio directamente
        },
        {
          headers: {
            'xi-api-key':   config.elevenlabs.apiKey,
            'Content-Type': 'application/json',
            'Accept':       'audio/basic',
          },
          responseType: 'arraybuffer',
          timeout:      10000,
        }
      ),
      { maxAttempts: 2, delayMs: 500 }
    );

    const audioBase64 = Buffer.from(response.data).toString('base64');

    logger.debug('Audio synthesized', {
      chars:  text.length,
      lang,
      bytes:  response.data.byteLength,
    });

    return audioBase64;

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.detail?.message || err.message;

    if (status === 401) throw new ElevenLabsError('Invalid ElevenLabs API key');
    if (status === 422) throw new ElevenLabsError(`Invalid voice ID: ${activeVoiceId}`);
    if (status === 429) throw new ElevenLabsError('ElevenLabs rate limit exceeded');

    throw new ElevenLabsError(`Synthesis failed: ${message}`);
  }
}

// ── Listar voces disponibles ──────────────────────────────────
async function listVoices() {
  try {
    const response = await axios.get(`${BASE_URL}/voices`, {
      headers: { 'xi-api-key': config.elevenlabs.apiKey },
    });
    return response.data.voices.map((v) => ({
      id:          v.voice_id,
      name:        v.name,
      category:    v.category,
      description: v.description,
      previewUrl:  v.preview_url,
    }));
  } catch (err) {
    throw new ElevenLabsError(`Failed to list voices: ${err.message}`);
  }
}

// ── Clonar voz desde audio ────────────────────────────────────
async function cloneVoice({ name, description, audioBuffer, fileName }) {
  try {
    const FormData = require('form-data');
    const form     = new FormData();

    form.append('name', name);
    form.append('description', description || `Voz clonada de ${name}`);
    form.append('files', audioBuffer, { filename: fileName, contentType: 'audio/mpeg' });

    const response = await axios.post(`${BASE_URL}/voices/add`, form, {
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        ...form.getHeaders(),
      },
      timeout: 60000, // La clonación puede tardar hasta 1 minuto
    });

    logger.info('Voice cloned successfully', { name, voiceId: response.data.voice_id });

    return {
      voiceId: response.data.voice_id,
      name:    response.data.name,
    };
  } catch (err) {
    throw new ElevenLabsError(`Voice cloning failed: ${err.message}`);
  }
}

// ── Verificar API key ─────────────────────────────────────────
async function checkHealth() {
  try {
    const response = await axios.get(`${BASE_URL}/user`, {
      headers: { 'xi-api-key': config.elevenlabs.apiKey },
      timeout: 5000,
    });
    return {
      ok:              true,
      charactersUsed:  response.data.subscription?.character_count,
      charactersLimit: response.data.subscription?.character_limit,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { synthesize, listVoices, cloneVoice, checkHealth };
