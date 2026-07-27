/**
 * Durable log of every add/skip event across all SalesDialer workflows, in its
 * own dedicated table (sdr_calling_activity_log) — this module only ever
 * creates and writes that one table, never an existing one. Reuses the DB
 * credentials the lead-estimator workflow already connects with.
 * Logging must never break a caller: every failure here is swallowed after a
 * console.warn.
 */

const path = require('path');
const { Client } = require('pg');

if (!process.env.DB_HOST) {
  require('dotenv').config({ path: path.join(__dirname, '..', 'lead-estimator', '.env') });
}

const TABLE = 'sdr_calling_activity_log';
let ensured = false;

function dbConfig() {
  return {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 5432),
    ssl: { rejectUnauthorized: false },
  };
}

async function ensureTable(client) {
  if (ensured) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      campaign_id TEXT NOT NULL,
      campaign_name TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('added', 'skipped')),
      email TEXT,
      phone TEXT,
      reason TEXT
    )
  `);
  ensured = true;
}

async function logActivity({ campaignId, campaignName, eventType, email, phone, reason }) {
  if (!process.env.DB_HOST) return;
  const client = new Client(dbConfig());
  try {
    await client.connect();
    await ensureTable(client);
    await client.query(
      `INSERT INTO ${TABLE} (campaign_id, campaign_name, event_type, email, phone, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [String(campaignId || ''), campaignName || '', eventType, email || '', phone || '', reason || '']
    );
  } catch (err) {
    console.warn(`[activity-log] failed to log ${eventType} (${campaignId}): ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { logActivity, TABLE };
