'use strict';

const { google }  = require('googleapis');
const config      = require('../../config');
const logger      = require('../utils/logger').forService('calendar');
const { db }      = require('./database');
const { CalendarError } = require('../utils/errors');
const { formatDateLocale } = require('../utils/helpers');

// ── Cliente OAuth2 ────────────────────────────────────────────
function getOAuthClient(refreshToken = null) {
  const oauth2Client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken || config.google.refreshToken,
  });

  return oauth2Client;
}

// ── Crear cita desde llamada ──────────────────────────────────
/**
 * Crea un evento en Google Calendar cuando la IA detecta confirmación de cita.
 */
async function createAppointmentFromCall({ callId, data, lang }) {
  try {
    // Obtener datos del contacto y campaña
    const { rows } = await db.query(
      `SELECT
         ct.name AS contact_name, ct.email AS contact_email, ct.phone,
         co.name AS company_name,
         cp.name AS campaign_name
       FROM calls ca
       LEFT JOIN contacts  ct ON ca.contact_id  = ct.id
       LEFT JOIN companies co ON ct.company_id  = co.id
       LEFT JOIN campaigns cp ON ca.campaign_id = cp.id
       WHERE ca.id = $1`,
      [callId]
    );

    if (!rows.length) throw new CalendarError('Call not found');
    const ctx = rows[0];

    // Construir fecha/hora del evento
    const startTime = new Date(`${data.date}T${data.time}:00`);
    const endTime   = new Date(startTime.getTime() + (data.duration || 30) * 60 * 1000);

    if (isNaN(startTime.getTime())) {
      throw new CalendarError(`Invalid date/time: ${data.date} ${data.time}`);
    }

    // Crear evento en Google Calendar
    const eventData = {
      summary:     `Reunión con ${ctx.contact_name} — ${ctx.company_name || ''}`.trim(),
      description: buildEventDescription(ctx, data, lang),
      start: {
        dateTime: startTime.toISOString(),
        timeZone: config.calls.timezone,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: config.calls.timezone,
      },
      attendees: ctx.contact_email
        ? [{ email: ctx.contact_email, displayName: ctx.contact_name }]
        : [],
      reminders: {
        useDefault: false,
        overrides:  [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
      conferenceData: data.modality === 'Zoom' ? undefined : undefined,
      location: data.modality === 'presencial' ? data.notes : '',
      colorId: '2', // Verde
    };

    const auth     = getOAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const event = await calendar.events.insert({
      calendarId:            config.google.calendarId,
      resource:              eventData,
      sendUpdates:           'all', // Envía invitación por email al contacto
      conferenceDataVersion: 1,
    });

    const googleEventId = event.data.id;

    // Guardar cita en BD
    const { rows: apptRows } = await db.query(
      `INSERT INTO appointments
         (call_id, contact_id, google_event_id, google_calendar_id,
          title, description, start_time, end_time, location, status)
       SELECT
         ca.id, ca.contact_id, $1, $2, $3, $4, $5, $6, $7, 'confirmed'
       FROM calls ca WHERE ca.id = $8
       RETURNING id`,
      [
        googleEventId,
        config.google.calendarId,
        eventData.summary,
        eventData.description,
        startTime.toISOString(),
        endTime.toISOString(),
        data.notes || '',
        callId,
      ]
    );

    // Actualizar outcome de la llamada
    await db.query(
      `UPDATE calls SET outcome = 'appointment_set' WHERE id = $1`,
      [callId]
    );

    logger.info('Appointment created', {
      callId,
      appointmentId: apptRows[0]?.id,
      googleEventId,
      start:         startTime.toISOString(),
      contact:       ctx.contact_name,
    });

    return {
      appointmentId:  apptRows[0]?.id,
      googleEventId,
      eventUrl:       event.data.htmlLink,
      startTime:      startTime.toISOString(),
      endTime:        endTime.toISOString(),
      contactName:    ctx.contact_name,
    };

  } catch (err) {
    if (err instanceof CalendarError) throw err;
    throw new CalendarError(`Failed to create appointment: ${err.message}`);
  }
}

// ── Descripción del evento ────────────────────────────────────
function buildEventDescription(ctx, data, lang) {
  const lines = {
    es: [
      `Reunión concertada automáticamente por VocalAI Pro`,
      ``,
      `Contacto: ${ctx.contact_name}`,
      ctx.contact_email ? `Email: ${ctx.contact_email}` : '',
      ctx.phone         ? `Teléfono: ${ctx.phone}`       : '',
      ctx.company_name  ? `Empresa: ${ctx.company_name}` : '',
      ``,
      `Modalidad: ${data.modality || 'Por confirmar'}`,
      data.notes ? `Notas: ${data.notes}` : '',
    ],
    ca: [
      `Reunió concertada automàticament per VocalAI Pro`,
      ``,
      `Contacte: ${ctx.contact_name}`,
      ctx.contact_email ? `Email: ${ctx.contact_email}` : '',
      ctx.phone         ? `Telèfon: ${ctx.phone}`       : '',
      ctx.company_name  ? `Empresa: ${ctx.company_name}` : '',
      ``,
      `Modalitat: ${data.modality || 'Per confirmar'}`,
      data.notes ? `Notes: ${data.notes}` : '',
    ],
    en: [
      `Meeting automatically scheduled by VocalAI Pro`,
      ``,
      `Contact: ${ctx.contact_name}`,
      ctx.contact_email ? `Email: ${ctx.contact_email}` : '',
      ctx.phone         ? `Phone: ${ctx.phone}`         : '',
      ctx.company_name  ? `Company: ${ctx.company_name}` : '',
      ``,
      `Modality: ${data.modality || 'To be confirmed'}`,
      data.notes ? `Notes: ${data.notes}` : '',
    ],
  };

  return (lines[lang] || lines.es).filter(Boolean).join('\n');
}

// ── Cancelar cita ─────────────────────────────────────────────
async function cancelAppointment(appointmentId) {
  const { rows } = await db.query(
    'SELECT google_event_id, google_calendar_id FROM appointments WHERE id = $1',
    [appointmentId]
  );

  if (!rows.length) throw new CalendarError('Appointment not found');

  const { google_event_id, google_calendar_id } = rows[0];

  const auth     = getOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId: google_calendar_id || config.google.calendarId,
    eventId:    google_event_id,
    sendUpdates: 'all',
  });

  await db.query(
    `UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [appointmentId]
  );

  logger.info('Appointment cancelled', { appointmentId, googleEventId: google_event_id });
}

// ── Generar URL de autorización OAuth ────────────────────────
function getAuthUrl() {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope:       config.google.scopes,
    prompt:      'consent',
  });
}

// ── Intercambiar código por refresh token ─────────────────────
async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuthClient();
  const { tokens }   = await oauth2Client.getToken(code);

  logger.info('OAuth tokens obtained', { hasRefreshToken: !!tokens.refresh_token });

  return tokens;
}

module.exports = {
  createAppointmentFromCall,
  cancelAppointment,
  getAuthUrl,
  exchangeCodeForTokens,
};
