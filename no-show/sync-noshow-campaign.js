/**
 * sync-noshow-campaign.js
 *
 * Pulls all Meta-source no-shows from Postgres and adds them to
 * JustCall campaign #3190746 (Meta_No_Show).
 *
 * Usage:
 *   node sync-noshow-campaign.js            # dry-run preview
 *   node sync-noshow-campaign.js --commit   # actually add to campaign
 */

require('dotenv').config();
const { Client } = require('pg');
const { addToCampaign } = require('./handlers/justcall');

const NOSHOW_CAMPAIGN = '3190746';
const isCommit        = process.argv.includes('--commit');

const DB_CONFIG = {
  host:     'gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com',
  user:     'airbyte_user',
  password: 'airbyte_user_password',
  database: 'gw_prod',
  ssl:      { rejectUnauthorized: false },
};

const QUERY = `
WITH base AS (
    SELECT
        *,
        COALESCE(event_url, LOWER(TRIM(prospect_email))) AS booking_key
    FROM gist.gtm_inbound_demo_bookings
),
latest_rows AS (
    SELECT DISTINCT ON (LOWER(TRIM(b.prospect_email)))
        b.prospect_first_name,
        b.prospect_email,
        b.prospect_phone_number,
        b.show_status,
        b.source
    FROM base b
    WHERE b.is_latest = true
      AND b.prospect_first_name NOT IN ('Test','test','gushwork','Gushwork','df df','df')
      AND b.prospect_email NOT ILIKE '%gushwork%'
      AND LOWER(b.prospect_email) NOT ILIKE '%swapnil%'
      AND LOWER(b.prospect_email) NOT ILIKE '%getclientell%'
    ORDER BY LOWER(TRIM(b.prospect_email)), b.demo_scheduled_date DESC
),
finals AS (
    SELECT
        prospect_first_name,
        prospect_email,
        prospect_phone_number,
        show_status,
        CASE
            WHEN LOWER(source) LIKE '%facebook%'
              OR LOWER(source) LIKE '%instagram%'
              OR LOWER(source) = 'fb'
              OR LOWER(source) = 'meta'
              OR LOWER(source) LIKE '%lizzi%'
              OR LOWER(source) LIKE '%meta%'
              OR LOWER(source) LIKE '%fb%'
              OR LOWER(source) LIKE '%book%'
              OR LOWER(source) LIKE '%face%'
              OR LOWER(source) LIKE '%ig%'
              OR LOWER(source) LIKE '%fg%'
              OR LOWER(source) LIKE '%insta%'
              OR LOWER(source) LIKE '%instra%'
            THEN 'Meta'
            ELSE 'Other'
        END AS source_bucket
    FROM latest_rows
)
SELECT prospect_first_name, prospect_email, prospect_phone_number
FROM finals
WHERE show_status = 'N'
  AND source_bucket = 'Meta'
`;

async function run() {
  console.log(`[sync-noshow] Starting${isCommit ? '' : ' (dry-run — pass --commit to apply)'}...`);

  const pg = new Client(DB_CONFIG);
  await pg.connect();
  const { rows } = await pg.query(QUERY);
  await pg.end();

  console.log(`[sync-noshow] ${rows.length} Meta no-shows found`);

  if (!isCommit) {
    rows.slice(0, 10).forEach(r => console.log(`  → ${r.prospect_first_name || r.prospect_email}`));
    if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);
    console.log('[sync-noshow] Dry-run done. Re-run with --commit to add to campaign.');
    return;
  }

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  let added = 0;

  for (const r of rows) {
    const lead = {
      full_name:    r.prospect_first_name  || '',
      email:        r.prospect_email       || '',
      phone_number: r.prospect_phone_number || '',
    };
    const label = lead.full_name || lead.email || 'unknown';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await addToCampaign(lead, NOSHOW_CAMPAIGN);
        console.log(`[sync-noshow] Added: ${label}`);
        added++;
        break;
      } catch (err) {
        if (err?.response?.status === 429 && attempt === 0) {
          console.warn(`[sync-noshow] Rate limited — backing off 3s for ${label}`);
          await delay(3000);
        } else {
          console.error(`[sync-noshow] Failed for ${label}: ${err.message}`);
          break;
        }
      }
    }

    await delay(300);
  }

  console.log(`[sync-noshow] Done. ${added}/${rows.length} added to campaign #${NOSHOW_CAMPAIGN}`);
}

run().catch(err => {
  console.error('[sync-noshow] Fatal:', err.message);
  process.exit(1);
});
