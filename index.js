/**
 * SDR Calling — unified scheduler for the three JustCall SalesDialer workflows.
 *
 *  - no-booking/sync-form-leads-campaign.js  daily  → campaign #3190752
 *  - no-show/sync-noshow-campaign.js         daily 7am ET  → campaign #3190746
 *  - lead-estimator/trigger.py               long-running 60s poller → campaign #3309032
 *
 * No Booking used to also run sync-nurture-campaign.js against a "leadform"
 * Google Sheet fed by an external form-lead automation. That automation died
 * (last row July 14, 2026) and was retired — No Booking now sources solely
 * from comparing gw_form_leads against gist.gtm_inbound_demo_bookings in
 * Postgres (sync-form-leads-campaign.js).
 */

require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const express = require('express');

const running = {};

function runJob(name, cmd, args, cwd) {
  if (running[name]) {
    console.log(`[scheduler] ${name} still running — skipping this tick`);
    return;
  }
  running[name] = true;
  console.log(`[scheduler] starting ${name}`);
  const child = spawn(cmd, args, { cwd, env: process.env });
  child.stdout.on('data', (c) => process.stdout.write(`[${name}] ${c}`));
  child.stderr.on('data', (c) => process.stderr.write(`[${name}] ${c}`));
  child.on('exit', (code) => {
    console.log(`[scheduler] ${name} exited with code ${code}`);
    running[name] = false;
  });
  child.on('error', (err) => {
    console.error(`[scheduler] ${name} failed to start: ${err.message}`);
    running[name] = false;
  });
}

// ── No Booking: form-leads once a day — gates on a 1-day-old lead minimum, so
//    a daily run gives the demo-bookings table a full day to catch up before we
//    decide someone is a no-booking (booking 1h after the form is filled is
//    nowhere near enough to slip through) ─────────────────────────────────────
const NB = path.join(__dirname, 'no-booking');
setInterval(() => runJob('sync-form-leads', process.execPath, [path.join(NB, 'sync-form-leads-campaign.js')], NB), 24 * 60 * 60 * 1000);

// ── No Show: daily at 7:00 America/New_York ──────────────────────────────────
const NS = path.join(__dirname, 'no-show');
let lastNoshowDate = null;
setInterval(() => {
  const now = new Date();
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const dateKey = `${et.year}-${et.month}-${et.day}`;
  if (et.hour === '07' && lastNoshowDate !== dateKey) {
    lastNoshowDate = dateKey;
    runJob('sync-noshow', process.execPath, [path.join(NS, 'sync-noshow-campaign.js'), '--commit'], NS);
  }
}, 60 * 1000);

// ── Lead Estimator: long-running python poller, restart on exit ──────────────
const LE = path.join(__dirname, 'lead-estimator');
function startLeadEstimator() {
  console.log('[scheduler] starting lead-estimator poller');
  const child = spawn(process.env.PYTHON_BIN || 'python3', ['-u', path.join(LE, 'trigger.py')], { cwd: LE, env: process.env });
  child.stdout.on('data', (c) => process.stdout.write(`[lead-estimator] ${c}`));
  child.stderr.on('data', (c) => process.stderr.write(`[lead-estimator] ${c}`));
  child.on('exit', (code) => {
    console.error(`[scheduler] lead-estimator exited with code ${code} — restarting in 30s`);
    setTimeout(startLeadEstimator, 30 * 1000);
  });
  child.on('error', (err) => {
    console.error(`[scheduler] lead-estimator failed to start: ${err.message} — retrying in 60s`);
    setTimeout(startLeadEstimator, 60 * 1000);
  });
}
startLeadEstimator();

// ── Health endpoint + dashboard ───────────────────────────────────────────────
const { dashboardHandler } = require('./lib/dashboard');
const app = express();
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/', dashboardHandler);
app.get('/health', (_req, res) => res.json({ ok: true, running }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[scheduler] SDR Calling up on :${port} — form-leads daily, noshow daily 7am ET, lead-estimator 60s poll`));
