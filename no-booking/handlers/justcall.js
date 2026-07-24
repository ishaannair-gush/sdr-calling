const axios = require('axios');
const { logAdd, CAMPAIGN_NAMES } = require('../../lib/adds-log');
const { logSkip } = require('../../lib/skip-log');

const CAMPAIGN_ALL   = '3085672';
const CAMPAIGN_RETIRE = '3085673';

function getHeaders() {
  return {
    Authorization: `${process.env.JUSTCALL_API_KEY}:${process.env.JUSTCALL_API_SECRET}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function isAlreadyInCampaignError(error) {
  const status = error?.response?.status;
  const message = String(error?.response?.data?.message || '').toLowerCase();
  return status === 400 && message.includes('already exists in campaign');
}

async function addToCampaign(lead, campaignId) {
  const rawPhone = (lead.phone || lead.phone_number || lead.user_provided_phone_number || '').trim();
  if (!rawPhone) {
    logSkip({ campaignId, campaignName: CAMPAIGN_NAMES[String(campaignId)] || '', email: lead.email, reason: 'Missing phone number' });
    throw new Error('Lead phone is missing');
  }

  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 7) {
    logSkip({ campaignId, campaignName: CAMPAIGN_NAMES[String(campaignId)] || '', email: lead.email, phone: rawPhone, reason: `Invalid phone: "${rawPhone}"` });
    throw new Error(`Lead phone too short: "${rawPhone}"`);
  }
  const phoneNumber = digits.length === 10 ? `+1${digits}` : `+${digits}`;

  const rawEmail = (lead.email || '').trim();
  const validEmail = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(rawEmail) ? rawEmail : undefined;

  const payload = {
    campaign_id: campaignId,
    name: lead.full_name || '',
    phone_number: phoneNumber,
    ...(validEmail ? { email: validEmail } : {}),
  };

  try {
    await axios.post(
      'https://api.justcall.io/v2.1/sales_dialer/campaigns/contact',
      payload,
      { headers: getHeaders() }
    );
  } catch (error) {
    if (isAlreadyInCampaignError(error)) {
      console.log(`Already in JustCall campaign ${campaignId}: ${phoneNumber}`);
      logSkip({ campaignId, campaignName: CAMPAIGN_NAMES[String(campaignId)] || '', email: validEmail, phone: phoneNumber, reason: 'Already in JustCall campaign' });
      return;
    }
    throw error;
  }

  console.log(`Added to JustCall campaign ${campaignId}`);
  // Fire-and-forget: dashboard add-counts; never blocks or fails the add.
  logAdd({
    campaignId,
    campaignName: CAMPAIGN_NAMES[String(campaignId)] || '',
    email: validEmail,
    phone: phoneNumber,
  });
}

async function addToJustCall(lead) {
  const tasks = [addToCampaign(lead, CAMPAIGN_ALL)];

  if (/retire/i.test(lead.company_name || '')) {
    tasks.push(addToCampaign(lead, CAMPAIGN_RETIRE));
  }

  await Promise.all(tasks);
}

module.exports = { addToJustCall, addToCampaign };
