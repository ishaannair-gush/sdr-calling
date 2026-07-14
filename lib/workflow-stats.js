/**
 * Per-workflow "occurred" counts by day (UTC) for the dashboard.
 *
 * "Occurred" = the eligible population per workflow, by event date:
 *   - No Show:        Meta-source no-shows in gist.gtm_inbound_demo_bookings,
 *                     dated by demo_scheduled_date (same filters as the sync script)
 *   - No Booking:     leadform-sheet leads not marked "Demos Booked"
 *                     + Meta gw_form_leads absent from the bookings table
 *   - Lead Estimator: submissions in the Lead Estimator sheet
 *
 * Note these definitions are retroactive: No Booking excludes anyone who has a
 * booking *now*, so historical days shrink as leads book. The dashboard states
 * this next to the numbers.
 */

const { Client } = require('pg');
const { google } = require('googleapis');

const DB_CONFIG = {
  host:     'gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com',
  user:     'airbyte_user',
  password: 'airbyte_user_password',
  database: 'gw_prod',
  ssl:      { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  query_timeout: 30000,
};

const ESTIMATOR_SHEET_ID = '1tILspL_RlrXvikmaGfdXYL3qPP_2-v3hnPDDe1B_2vg';

// ── Occurred sources ─────────────────────────────────────────────────────────

async function noShowsByDay(fromDate) {
  const pg = new Client(DB_CONFIG);
  await pg.connect();
  try {
    const { rows } = await pg.query(`
      WITH latest_rows AS (
        SELECT DISTINCT ON (LOWER(TRIM(b.prospect_email)))
          b.show_status, b.source, b.demo_scheduled_date
        FROM gist.gtm_inbound_demo_bookings b
        WHERE b.is_latest = true
          AND b.prospect_first_name NOT IN ('Test','test','gushwork','Gushwork','df df','df')
          AND b.prospect_email NOT ILIKE '%gushwork%'
          AND LOWER(b.prospect_email) NOT ILIKE '%swapnil%'
          AND LOWER(b.prospect_email) NOT ILIKE '%getclientell%'
        ORDER BY LOWER(TRIM(b.prospect_email)), b.demo_scheduled_date DESC
      )
      SELECT (demo_scheduled_date AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
      FROM latest_rows
      WHERE show_status = 'N'
        AND (demo_scheduled_date AT TIME ZONE 'UTC')::date >= $1::date
        AND (LOWER(source) LIKE '%facebook%' OR LOWER(source) LIKE '%instagram%'
          OR LOWER(source) = 'fb' OR LOWER(source) = 'meta' OR LOWER(source) LIKE '%lizzi%'
          OR LOWER(source) LIKE '%meta%' OR LOWER(source) LIKE '%fb%' OR LOWER(source) LIKE '%book%'
          OR LOWER(source) LIKE '%face%' OR LOWER(source) LIKE '%ig%' OR LOWER(source) LIKE '%fg%'
          OR LOWER(source) LIKE '%insta%' OR LOWER(source) LIKE '%instra%')
      GROUP BY 1
    `, [fromDate]);
    return Object.fromEntries(rows.map(r => [r.day.toISOString().slice(0, 10), r.n]));
  } finally {
    await pg.end().catch(() => {});
  }
}

async function formLeadsNoBookingByDay(fromDate) {
  const pg = new Client(DB_CONFIG);
  await pg.connect();
  try {
    const { rows } = await pg.query(`
      SELECT (gfl.created_at AT TIME ZONE 'UTC')::date AS day,
             COUNT(DISTINCT LOWER(TRIM(gfl.email)))::int AS n
      FROM gw_form_leads gfl
      WHERE (gfl.created_at AT TIME ZONE 'UTC')::date >= $1::date
        AND gfl.phone IS NOT NULL AND TRIM(gfl.phone) != ''
        AND (LOWER(gfl.utm_source) LIKE '%facebook%' OR LOWER(gfl.utm_source) LIKE '%instagram%'
          OR LOWER(gfl.utm_source) LIKE '%insta%' OR LOWER(gfl.utm_source) LIKE '%instr%'
          OR LOWER(gfl.utm_source) LIKE '%meta%' OR LOWER(gfl.utm_source) LIKE '%fb%'
          OR LOWER(gfl.utm_source) LIKE '%face%' OR LOWER(gfl.utm_source) LIKE '%book%'
          OR LOWER(gfl.utm_source) LIKE '%ig%' OR LOWER(gfl.utm_source) = 'fg'
          OR LOWER(gfl.utm_source) LIKE '%lizzi%')
        AND LOWER(TRIM(gfl.email)) NOT IN (
          SELECT LOWER(TRIM(prospect_email)) FROM gist.gtm_inbound_demo_bookings
          WHERE prospect_email IS NOT NULL AND TRIM(prospect_email) != ''
        )
      GROUP BY 1
    `, [fromDate]);
    return Object.fromEntries(rows.map(r => [r.day.toISOString().slice(0, 10), r.n]));
  } finally {
    await pg.end().catch(() => {});
  }
}

function sheetsClient(scopes) {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : undefined;
  const auth = new google.auth.GoogleAuth({
    credentials,
    keyFile: credentials ? undefined : process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes,
  });
  return google.sheets({ version: 'v4', auth });
}

async function bookingIdentitySets() {
  // Live identity sets from the bookings table. The sheet's "Demos Booked"
  // stamp is NOT used: historical stamps over-mark (most have no matching
  // booking in the current table), so the dashboard matches fresh each time.
  const pg = new Client(DB_CONFIG);
  await pg.connect();
  try {
    const { rows } = await pg.query(`
      SELECT LOWER(TRIM(prospect_email)) AS email, prospect_phone_number AS phone
      FROM gist.gtm_inbound_demo_bookings
    `);
    const emails = new Set();
    const phones = new Set();
    for (const r of rows) {
      if (r.email) emails.add(r.email);
      const p = String(r.phone || '').replace(/\D/g, '').slice(-10);
      if (p) phones.add(p);
    }
    return { emails, phones };
  } finally {
    await pg.end().catch(() => {});
  }
}

async function leadformNoBookingByDay(fromDate) {
  const [{ emails, phones }, sheetData] = await Promise.all([
    bookingIdentitySets(),
    sheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly'])
      .spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'leadform!A:U',
      }),
  ]);
  const rows = sheetData.data.values || [];
  if (rows.length < 2) return {};
  const headers = rows[0];
  const idx = (name) => headers.indexOf(name);
  const tsIdx = idx('Timestamp'), emailIdx = idx('Email');
  const phoneIdxs = [idx('Phone'), idx('Phone Number'), idx('User Provided Phone')].filter(i => i !== -1);
  const byDay = {};
  for (const row of rows.slice(1)) {
    const day = String(row[tsIdx] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < fromDate) continue;
    const email = String(row[emailIdx] || '').trim().toLowerCase();
    const leadPhones = phoneIdxs.map(i => String(row[i] || '').replace(/\D/g, '').slice(-10)).filter(Boolean);
    const hasBooking = (email && emails.has(email)) || leadPhones.some(p => phones.has(p));
    if (hasBooking) continue;
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return byDay;
}

async function estimatorByDay(fromDate) {
  const sheets = sheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: ESTIMATOR_SHEET_ID,
    range: 'Sheet1!H:H', // Timestamp column
  });
  const rows = (data.values || []).slice(1);
  const byDay = {};
  for (const [ts] of rows) {
    const day = String(ts || '').slice(0, 10);
    if (!day || day < fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return byDay;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Occurred counts per campaign per UTC day, from fromDate (YYYY-MM-DD).
 * Returns { campaignId: { day: n } }. Each source fails soft to {}.
 */
async function fetchOccurred(fromDate) {
  const [noShow, formLeads, leadform, estimator] = await Promise.all([
    noShowsByDay(fromDate).catch(e => (console.warn(`[stats] noshow: ${e.message}`), {})),
    formLeadsNoBookingByDay(fromDate).catch(e => (console.warn(`[stats] formleads: ${e.message}`), {})),
    leadformNoBookingByDay(fromDate).catch(e => (console.warn(`[stats] leadform: ${e.message}`), {})),
    estimatorByDay(fromDate).catch(e => (console.warn(`[stats] estimator: ${e.message}`), {})),
  ]);

  const noBooking = {};
  for (const src of [formLeads, leadform]) {
    for (const [d, n] of Object.entries(src)) noBooking[d] = (noBooking[d] || 0) + n;
  }

  return { '3190746': noShow, '3190752': noBooking, '3309032': estimator };
}

module.exports = { fetchOccurred };
