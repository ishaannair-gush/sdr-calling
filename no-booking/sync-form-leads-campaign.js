/**
 * sync-form-leads-campaign.js
 *
 * Finds Meta leads in gw_form_leads who never booked a demo
 * (absent from gist.gtm_inbound_demo_bookings) and adds them to
 * JustCall campaign #3190752 (Meta_No_Booking).
 *
 * "Meta" is identified by utm_source matching: facebook, fb, meta, ig,
 * instagram, insta, etc.
 *
 * Leads must be >= 1 day old before they're considered, so the demo-bookings
 * table has time to catch up — otherwise a lead that actually booked can look
 * like a no-booking and get added to nurture before the booking lands.
 * Runs once a day; regular runs look at leads between 1 and 2 days old, so a
 * single missed run doesn't drop anyone.
 *
 * Usage:
 *   node sync-form-leads-campaign.js           # process leads 1-2 days old
 *   node sync-form-leads-campaign.js --backfill # process all leads >= 1 day old
 */

require('dotenv').config();
const { Client } = require('pg');
const { addToCampaign } = require('./handlers/justcall');

const NURTURE_CAMPAIGN_ID = '3190752';
const MIN_AGE_INTERVAL    = '1 day';   // gate: leads must be at least this old
const LOOKBACK_INTERVAL   = '24 hours'; // buffer for regular runs (job is daily), so a missed run doesn't lose a lead
const isBackfill = process.argv.includes('--backfill');

const PG_CONFIG = {
  host:     'gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com',
  user:     'airbyte_user',
  password: 'airbyte_user_password',
  database: 'gw_prod',
  ssl:      { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  query_timeout: 30000,
};

async function fetchFormLeads(pg) {
  // Age gate: never consider a lead until it's at least 1 day old (backfill included).
  const ageGate = `AND gfl.created_at <= NOW() - INTERVAL '${MIN_AGE_INTERVAL}'`;
  // Regular runs additionally bound the window to leads that just crossed the age
  // gate since the last run (with buffer), so we're not rescanning all history.
  const timeFilter = isBackfill
    ? ''
    : `AND gfl.created_at >= NOW() - INTERVAL '${MIN_AGE_INTERVAL} ${LOOKBACK_INTERVAL}'`;

  const { rows } = await pg.query(`
    SELECT DISTINCT ON (LOWER(TRIM(gfl.email)))
      gfl.email,
      gfl.phone,
      gfl.utm_source,
      gfl.created_at
    FROM gw_form_leads gfl
    WHERE gfl.phone IS NOT NULL
      AND TRIM(gfl.phone) != ''
      ${ageGate}
      AND (
        LOWER(gfl.utm_source) LIKE '%facebook%'
        OR LOWER(gfl.utm_source) LIKE '%instagram%'
        OR LOWER(gfl.utm_source) LIKE '%insta%'
        OR LOWER(gfl.utm_source) LIKE '%instr%'
        OR LOWER(gfl.utm_source) LIKE '%meta%'
        OR LOWER(gfl.utm_source) LIKE '%fb%'
        OR LOWER(gfl.utm_source) LIKE '%face%'
        OR LOWER(gfl.utm_source) LIKE '%book%'
        OR LOWER(gfl.utm_source) LIKE '%ig%'
        OR LOWER(gfl.utm_source) = 'fg'
        OR LOWER(gfl.utm_source) LIKE '%lizzi%'
      )
      AND LOWER(TRIM(gfl.email)) NOT IN (
        SELECT LOWER(TRIM(prospect_email))
        FROM gist.gtm_inbound_demo_bookings
        WHERE prospect_email IS NOT NULL
          AND TRIM(prospect_email) != ''
      )
      ${timeFilter}
    ORDER BY LOWER(TRIM(gfl.email)), gfl.created_at DESC
  `);
  return rows;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log(`[sync-form-leads] Starting${isBackfill ? ' (backfill mode, >= 1 day old)' : ` (1 day to 1 day + ${LOOKBACK_INTERVAL} old)`}...`);

  const pg = new Client(PG_CONFIG);
  await pg.connect();
  let leads;
  try {
    leads = await fetchFormLeads(pg);
  } finally {
    await pg.end().catch(() => {});
  }

  console.log(`[sync-form-leads] ${leads.length} Meta form leads with no booking found`);

  let added = 0, skipped = 0, failed = 0;

  for (const lead of leads) {
    const label = lead.email;
    let outcome = 'failed';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await addToCampaign(
          { email: lead.email, phone: lead.phone, full_name: '' },
          NURTURE_CAMPAIGN_ID
        );
        outcome = 'added';
        break;
      } catch (err) {
        const status = err?.response?.status;
        const msg = String(err?.response?.data?.message || err.message || '').toLowerCase();

        if (status === 400 && msg.includes('already exists in campaign')) {
          outcome = 'skipped';
          break;
        }

        if (status === 429 && attempt === 0) {
          console.warn(`[sync-form-leads] Rate limited — backing off 3s for ${label}`);
          await delay(3000);
        } else {
          console.error(`[sync-form-leads] Failed for ${label}: ${err.message}`);
          break;
        }
      }
    }

    if (outcome === 'added') { added++; console.log(`[sync-form-leads] Added to campaign: ${label}`); }
    else if (outcome === 'skipped') skipped++;
    else failed++;

    await delay(300);
  }

  console.log(
    `[sync-form-leads] Done. added=${added} skipped=${skipped} failed=${failed} total=${leads.length}`
  );
}

run().catch(err => {
  console.error('[sync-form-leads] Fatal:', err.message);
  process.exit(1);
});
