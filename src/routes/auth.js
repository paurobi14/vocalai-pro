'use strict';

const express = require('express');
const router  = express.Router();
const calendarService = require('../services/calendar');
const logger = require('../utils/logger').forService('auth');

/**
 * GET /api/auth/google
 * Redirige al cliente a la pantalla de autorización de Google.
 * El empresario hace clic aquí y autoriza el acceso a su calendario.
 */
router.get('/google', (req, res) => {
  const authUrl = calendarService.getAuthUrl();
  logger.info('Redirecting to Google OAuth');
  res.redirect(authUrl);
});

/**
 * GET /api/auth/google/callback
 * Google redirige aquí después de que el empresario autoriza.
 * Guardamos el refresh token para uso futuro.
 */
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    logger.warn('Google OAuth denied', { error });
    return res.send(`
      <h2>Autorización denegada</h2>
      <p>No se pudo conectar con Google Calendar. Por favor, inténtelo de nuevo.</p>
    `);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const tokens = await calendarService.exchangeCodeForTokens(code);

    // En producción guardarías el refresh_token en la BD por empresa
    // Por ahora lo mostramos para que lo copies en el .env
    logger.info('Google OAuth successful');

    res.send(`
      <html>
      <body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
        <h2>✅ Google Calendar conectado correctamente</h2>
        <p>Copia este Refresh Token y ponlo en tu fichero <code>.env</code>:</p>
        <pre style="background:#f5f5f5;padding:12px;border-radius:6px;word-break:break-all">${tokens.refresh_token || 'Ya tenías un token válido'}</pre>
        <p style="color:#666;font-size:14px">
          En el fichero .env, busca la línea <code>GOOGLE_REFRESH_TOKEN=</code> y pega el token después del signo igual.
        </p>
        <p>Puedes cerrar esta ventana.</p>
      </body>
      </html>
    `);
  } catch (err) {
    logger.error('Google OAuth callback error', { error: err.message });
    res.status(500).send(`
      <h2>Error de autorización</h2>
      <p>${err.message}</p>
    `);
  }
});

module.exports = router;
