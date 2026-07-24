/**
 * Append-only log of leads that were NOT added to a JustCall campaign, with
 * why, in the shared Google Sheet (tab "SDR Skip Log"). Mirrors adds-log.js.
 * Logging must never break the caller: every failure here is swallowed
 * after a console.warn.
 */

const { google } = require('googleapis');

const TAB = 'SDR Skip Log';
let sheetsClient = null;
let tabEnsured = false;

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : undefined;
  const auth = new google.auth.GoogleAuth({
    credentials,
    keyFile: credentials ? undefined : process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function ensureTab(sheets, spreadsheetId) {
  if (tabEnsured) return;
  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  if (!data.sheets.some(s => s.properties.title === TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB}!A:F`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Timestamp', 'Campaign ID', 'Campaign', 'Email', 'Phone', 'Reason']] },
    });
  }
  tabEnsured = true;
}

async function logSkip({ campaignId, campaignName, email, phone, reason }) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) return;
    const sheets = await getSheets();
    await ensureTab(sheets, spreadsheetId);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB}!A:F`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), String(campaignId || ''), campaignName || '', email || '', phone || '', reason || '']],
      },
    });
  } catch (err) {
    console.warn(`[skip-log] failed to log skip (${campaignId}): ${err.message}`);
  }
}

const CAMPAIGN_NAMES = {
  '3190746': 'No Show',
  '3190752': 'No Booking',
  '3309032': 'Lead Estimator',
};

/** Raw skip-log rows since startDate, for joining into the lead detail table. */
async function fetchSkipRows(startDate) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return [];
  let rows = [];
  try {
    const sheets = await getSheets();
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A:F` });
    rows = data.values || [];
  } catch (err) {
    console.warn(`[skip-log] read failed: ${err.message}`);
    return [];
  }
  const out = [];
  for (const [ts, cid, cname, email, phone, reason] of rows.slice(1)) {
    const day = String(ts || '').slice(0, 10);
    if (!day || day < startDate) continue;
    out.push({
      timestamp: ts, day, campaignId: String(cid || ''), campaignName: cname || '',
      email: String(email || '').trim().toLowerCase(), phone: String(phone || ''), reason: reason || '',
    });
  }
  return out;
}

module.exports = { logSkip, fetchSkipRows, CAMPAIGN_NAMES, TAB };
