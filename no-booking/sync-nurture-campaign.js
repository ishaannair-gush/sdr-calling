/**
 * sync-nurture-campaign.js
 *
 * Every 15 minutes:
 *  1. Checks Postgres for new demo bookings and marks "Demos Booked = yes" on leadform rows.
 *  2. Finds leads that are >= 15 min old, not demo-booked, and not already queued for nurture.
 *  3. Adds those leads to JustCall campaign #3190752 (Meta_No_Booking).
 *  4. Marks "JC Nurture = yes" on each processed row to prevent re-queuing.
 *
 * Usage:
 *   node sync-nurture-campaign.js            # normal 15-min-age gate
 *   node sync-nurture-campaign.js --backfill # no age gate — process all leads
 */

require('dotenv').config();
const { google } = require('googleapis');
const { Client } = require('pg');
const { addToCampaign } = require('./handlers/justcall');

const SHEET_ID            = process.env.GOOGLE_SHEETS_ID;
const NURTURE_CAMPAIGN_ID = '3190752';
const MIN_AGE_MS          = 15 * 60 * 1000;

const isBackfill = process.argv.includes('--backfill');

function colLetter(idx) {
  let result = '';
  idx += 1;
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    idx = Math.floor((idx - 1) / 26);
  }
  return result;
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

async function getSheetsClient() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : undefined;
  const auth = new google.auth.GoogleAuth({
    credentials,
    keyFile: credentials ? undefined : process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchDemoBookings(pgClient) {
  const { rows } = await pgClient.query(`
    SELECT prospect_email, prospect_phone_number
    FROM gist.gtm_inbound_demo_bookings
    WHERE prospect_email IS NOT NULL OR prospect_phone_number IS NOT NULL
  `);
  return rows;
}

async function run() {
  console.log(`[sync-nurture] Starting${isBackfill ? ' (backfill mode)' : ''}...`);

  const sheets = await getSheetsClient();

  // ── Read full sheet ────────────────────────────────────────────────────────
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'leadform!A:Z',
  });

  const rows = data.values || [];
  if (rows.length < 2) {
    console.log('[sync-nurture] No leads in sheet.');
    return;
  }

  const headers = rows[0];
  const col = (name) => headers.findIndex(h => h === name);

  const timestampIdx   = col('Timestamp');
  const fullNameIdx    = col('Full Name');
  const emailIdx       = col('Email');
  const phoneIdx       = col('Phone');
  const phoneNumberIdx = col('Phone Number');
  const userPhoneIdx   = col('User Provided Phone');
  const demoBookedIdx  = col('Demos Booked');
  let   jcNurtureIdx   = col('JC Nurture');

  // Add "JC Nurture" column header if it doesn't exist yet
  if (jcNurtureIdx === -1) {
    jcNurtureIdx = headers.length;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `leadform!${colLetter(jcNurtureIdx)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['JC Nurture']] },
    });
    console.log(`[sync-nurture] Added "JC Nurture" header at column ${colLetter(jcNurtureIdx)}`);
  }

  // ── Fetch demo bookings from Postgres (close connection before API calls) ──
  const pg = new Client({
    host:     'gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com',
    user:     'airbyte_user',
    password: 'airbyte_user_password',
    database: 'gw_prod',
    ssl:      { rejectUnauthorized: false },
  });
  await pg.connect();
  const bookings = await fetchDemoBookings(pg);
  await pg.end();
  console.log(`[sync-nurture] ${bookings.length} demo bookings loaded`);

  const bookedEmails = new Set();
  const bookedLast10 = new Set();

  for (const b of bookings) {
    const e = normalizeEmail(b.prospect_email);
    const p = normalizePhone(b.prospect_phone_number);
    if (e) bookedEmails.add(e);
    if (p) bookedLast10.add(p.slice(-10));
  }

  const now = Date.now();
  const demoUpdates = [];
  const qualifying  = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const email     = normalizeEmail(row[emailIdx]       || '');
    const phone     = normalizePhone(row[phoneIdx]       || '');
    const phoneNum  = normalizePhone(row[phoneNumberIdx] || '');
    const userPhone = normalizePhone(row[userPhoneIdx]   || '');
    const demoBkd   = (row[demoBookedIdx] || '').toLowerCase().trim();
    const jcNurture = (row[jcNurtureIdx]  || '').toLowerCase().trim();
    const timestamp = row[timestampIdx]   || '';

    const phones = [phone, phoneNum, userPhone].filter(Boolean);
    const hasBooking =
      (email && bookedEmails.has(email)) ||
      phones.some(p => bookedLast10.has(p.slice(-10)));

    if (hasBooking && demoBkd !== 'yes' && demoBookedIdx !== -1) {
      demoUpdates.push({
        range:  `leadform!${colLetter(demoBookedIdx)}${i + 1}`,
        values: [['yes']],
      });
    }

    if (!hasBooking && jcNurture !== 'yes') {
      const leadAge = now - new Date(timestamp).getTime();
      if (isBackfill || (!isNaN(leadAge) && leadAge >= MIN_AGE_MS)) {
        qualifying.push({
          rowNum:                     i + 1,
          full_name:                  row[fullNameIdx]    || '',
          email:                      row[emailIdx]       || '',
          phone:                      row[phoneIdx]       || '',
          phone_number:               row[phoneNumberIdx] || '',
          user_provided_phone_number: row[userPhoneIdx]   || '',
        });
      }
    }
  }

  // Flush "Demos Booked" updates
  if (demoUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: demoUpdates },
    });
    console.log(`[sync-nurture] Marked ${demoUpdates.length} leads as "Demos Booked = yes"`);
  } else {
    console.log('[sync-nurture] No new demo-booked leads to mark');
  }

  console.log(`[sync-nurture] ${qualifying.length} leads qualify for nurture campaign`);

  // Add qualifying leads to campaign with rate-limit handling (300ms between calls,
  // 3s back-off + one retry on 429, batch-write JC Nurture every 50 rows)
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  let added = 0;
  const nurtureUpdates = [];

  for (const lead of qualifying) {
    const label = `${lead.full_name || lead.email || 'unknown'} (row ${lead.rowNum})`;
    let ok = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await addToCampaign(lead, NURTURE_CAMPAIGN_ID);
        ok = true;
        break;
      } catch (err) {
        if (err?.response?.status === 429 && attempt === 0) {
          console.warn(`[sync-nurture] Rate limited — backing off 3s for ${label}`);
          await delay(3000);
        } else {
          const apiBody = err?.response?.data ? JSON.stringify(err.response.data) : '';
          console.error(`[sync-nurture] Failed for ${label}: ${err.message}${apiBody ? ` | api=${apiBody}` : ''}`);
          break;
        }
      }
    }

    if (ok) {
      nurtureUpdates.push({
        range:  `leadform!${colLetter(jcNurtureIdx)}${lead.rowNum}`,
        values: [['yes']],
      });
      added++;
      console.log(`[sync-nurture] Added to campaign: ${label}`);

      // Flush sheet updates in batches of 50 to not lose progress
      if (nurtureUpdates.length >= 50) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { valueInputOption: 'RAW', data: nurtureUpdates.splice(0) },
        });
      }
    }

    await delay(300);
  }

  // Final flush
  if (nurtureUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: nurtureUpdates },
    });
  }

  console.log(`[sync-nurture] Done. ${added}/${qualifying.length} leads added to campaign #${NURTURE_CAMPAIGN_ID}`);
}

run().catch(err => {
  console.error('[sync-nurture] Fatal:', err.message);
  process.exit(1);
});
