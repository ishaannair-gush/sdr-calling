/**
 * Append-only log of successful SalesDialer adds, in the shared Google Sheet
 * (tab "SDR Adds Log"). The dashboard reads this to count adds per day —
 * JustCall has no per-campaign contact listing. Logging must never break an
 * add: every failure here is swallowed after a console.warn.
 */

const { google } = require('googleapis');

const TAB = 'SDR Adds Log';
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
      range: `${TAB}!A:E`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Timestamp', 'Campaign ID', 'Campaign', 'Email', 'Phone']] },
    });
  }
  tabEnsured = true;
}

async function logAdd({ campaignId, campaignName, email, phone }) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) return;
    const sheets = await getSheets();
    await ensureTab(sheets, spreadsheetId);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB}!A:E`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), String(campaignId), campaignName || '', email || '', phone || '']],
      },
    });
  } catch (err) {
    console.warn(`[adds-log] failed to log add (${campaignId}): ${err.message}`);
  }
}

const CAMPAIGN_NAMES = {
  '3190746': 'No Show',
  '3190752': 'No Booking',
  '3309032': 'Lead Estimator',
};

module.exports = { logAdd, CAMPAIGN_NAMES, TAB };
