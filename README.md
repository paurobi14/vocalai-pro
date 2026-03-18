# VocalAI Pro

Sistema de automatización de llamadas empresariales con IA, clonación de voz y calendario integrado.

## Stack
- **Backend:** Node.js + Express
- **IA conversacional:** Claude API (Anthropic)
- **Síntesis de voz:** ElevenLabs (eleven_multilingual_v2)
- **Llamadas:** Twilio Programmable Voice + WebSocket
- **Calendario:** Google Calendar API v3
- **Base de datos:** PostgreSQL
- **Cola de trabajos:** Bull + Redis
- **Idiomas:** Español · Català · English

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env con tus credenciales

# 3. Iniciar PostgreSQL y Redis
# (ver docker-compose.yml para setup rápido)

# 4. Arrancar en desarrollo
npm run dev

# 5. Arrancar worker de llamadas (terminal separada)
npm run worker
```

## Estructura del proyecto

```
vocalai-pro/
├── config/           # Configuración centralizada
├── src/
│   ├── server.js     # Entry point Express
│   ├── middleware/   # Helmet, CORS, rate limit, error handler
│   ├── routes/       # Endpoints de la API
│   ├── services/     # Lógica de negocio (Twilio, ElevenLabs, Calendar, AI)
│   ├── workers/      # Cola de llamadas Bull
│   └── utils/        # Logger, helpers, errores
├── logs/             # Ficheros de log (auto-creados)
├── uploads/          # Muestras de voz (temporal)
├── .env.example      # Template de variables de entorno
└── README.md
```

## Pasos de implementación

- [x] **Paso 1:** Estructura del proyecto + backend base + BD
- [ ] **Paso 2:** Integración Twilio (llamadas salientes + webhooks)
- [ ] **Paso 3:** Motor IA con Claude (conversación multiidioma)
- [ ] **Paso 4:** ElevenLabs (clonación y síntesis de voz)
- [ ] **Paso 5:** Google Calendar (detección de cita + creación evento)
- [ ] **Paso 6:** Cola de llamadas Bull + worker
- [ ] **Paso 7:** API REST completa (contactos, campañas, citas)
- [ ] **Paso 8:** Dashboard web

## Variables de entorno requeridas

Ver `.env.example` para la lista completa documentada.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check básico |
| GET | `/health/detailed` | Estado de todos los servicios |
| POST | `/api/calls` | Iniciar llamada |
| POST | `/api/webhooks/twilio/voice` | Webhook Twilio (voz) |
| POST | `/api/webhooks/twilio/status` | Webhook Twilio (estado) |
| GET | `/api/appointments` | Listar citas |
| GET | `/api/contacts` | Gestionar contactos |

## Licencia

Privado — uso empresarial exclusivo.
