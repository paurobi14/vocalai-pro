'use strict';

const { Pool } = require('pg');
const config   = require('../../config');
const logger   = require('../utils/logger').forService('database');

// ── Pool de conexiones ───────────────────────────────────────
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 20 }
  : config.db;

const pool = new Pool(poolConfig);

pool.on('connect', () => logger.debug('New DB connection established'));
pool.on('error',  (err) => logger.error('Idle DB connection error', { error: err.message }));

// ── Helper de queries ────────────────────────────────────────
const db = {
  query:  (text, params) => pool.query(text, params),
  pool,

  // Transacción helper
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

// ── Schema DDL ───────────────────────────────────────────────
const SCHEMA_SQL = `
-- Empresas cliente
CREATE TABLE IF NOT EXISTS companies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  industry      VARCHAR(100),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Contactos de cada empresa
CREATE TABLE IF NOT EXISTS contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(30)  NOT NULL,
  email         VARCHAR(255),
  position      VARCHAR(100),
  preferred_lang VARCHAR(5) DEFAULT 'es' CHECK (preferred_lang IN ('es', 'ca', 'en')),
  call_count    INTEGER DEFAULT 0,
  last_called_at TIMESTAMPTZ,
  do_not_call   BOOLEAN DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Campañas de llamadas
CREATE TABLE IF NOT EXISTS campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  script_es     TEXT,    -- Guión en español
  script_ca     TEXT,    -- Guión en catalán
  script_en     TEXT,    -- Guión en inglés
  voice_id      VARCHAR(100),  -- ElevenLabs voice ID para esta campaña
  status        VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  start_date    DATE,
  end_date      DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Llamadas individuales
CREATE TABLE IF NOT EXISTS calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  campaign_id     UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  twilio_call_sid VARCHAR(100) UNIQUE,
  status          VARCHAR(30) DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','queued','initiated','ringing','in-progress',
                                    'completed','busy','no-answer','failed','canceled')),
  duration_secs   INTEGER,
  detected_lang   VARCHAR(5),
  outcome         VARCHAR(30) CHECK (outcome IN ('appointment_set','callback','rejected','no_answer','failed',NULL)),
  transcript      TEXT,
  recording_url   VARCHAR(500),
  retry_count     INTEGER DEFAULT 0,
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Citas agendadas por la IA
CREATE TABLE IF NOT EXISTS appointments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id             UUID REFERENCES calls(id) ON DELETE SET NULL,
  contact_id          UUID REFERENCES contacts(id) ON DELETE CASCADE,
  google_event_id     VARCHAR(255),
  google_calendar_id  VARCHAR(255),
  title               VARCHAR(255) NOT NULL,
  description         TEXT,
  start_time          TIMESTAMPTZ NOT NULL,
  end_time            TIMESTAMPTZ NOT NULL,
  location            VARCHAR(255),
  meeting_url         VARCHAR(500),
  status              VARCHAR(20) DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed','cancelled','rescheduled')),
  reminder_sent       BOOLEAN DEFAULT FALSE,
  confirmation_sent   BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Conversaciones de las llamadas
CREATE TABLE IF NOT EXISTS conversation_turns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     UUID REFERENCES calls(id) ON DELETE CASCADE,
  turn_index  INTEGER NOT NULL,
  speaker     VARCHAR(10) CHECK (speaker IN ('ai', 'human')),
  content     TEXT,
  lang        VARCHAR(5),
  intent      VARCHAR(50),  -- 'greeting','interest','objection','confirm_appointment','farewell',etc
  timestamp_ms INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_contacts_phone      ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_company    ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_calls_contact       ON calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_calls_status        ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_scheduled     ON calls(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_start  ON appointments(start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversation_call   ON conversation_turns(call_id);

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_companies_updated_at') THEN
    CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contacts_updated_at') THEN
    CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_appointments_updated_at') THEN
    CREATE TRIGGER trg_appointments_updated_at BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
`;

// ── Inicializar schema ───────────────────────────────────────
async function initializeSchema() {
  try {
    await db.query(SCHEMA_SQL);
    logger.info('Database schema initialized successfully');
  } catch (err) {
    logger.error('Failed to initialize database schema', { error: err.message });
    throw err;
  }
}

// ── Health check ─────────────────────────────────────────────
async function checkHealth() {
  const result = await db.query('SELECT NOW() as time, version() as version');
  return {
    connected: true,
    time:      result.rows[0].time,
    version:   result.rows[0].version.split(' ').slice(0, 2).join(' '),
  };
}

module.exports = { db, initializeSchema, checkHealth };
