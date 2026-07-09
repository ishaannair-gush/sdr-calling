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
 * Usage:
 *   node sync-form-leads-campaign.js           # process leads from last 2h
 *   node sync-form-leads-campaign.js --backfill # process all historical leads
 */

require('dotenv').config();
const { Client } = require('pg');
const { addToCampaign } = require('./handlers/justcall');

const NURTURE_CAMPAIGN_ID = '3190752';
const LOOKBACK_INTERVAL   = '2 hours';  // window for regular runs
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
  const timeFilter = isBackfill ? '' : `AND gfl.created_at >= NOW() - INTERVAL '${LOOKBACK_INTERVAL}'`;

  const { rows } = await pg.query(`
    SELECT DISTINCT ON (LOWER(TRIM(gfl.email)))
      gfl.email,
      gfl.phone,
      gfl.utm_source,
      gfl.created_at
    FROM gw_form_leads gfl
    WHERE gfl.phone IS NOT NULL
      AND TRIM(gfl.phone) != ''
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
  console.log(`[sync-form-leads] Starting${isBackfill ? ' (backfill mode)' : ` (last ${LOOKBACK_INTERVAL})`}...`);

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
