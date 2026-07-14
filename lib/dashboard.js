/**
 * SDR Calling dashboard — one consistent funnel per workflow:
 *
 *   Occurred → Added → Dials → Contacts dialed → Connected → Meetings booked
 *
 * Every number since June 1, 2026 (program start) is embedded in the page;
 * filters (daily / weekly / monthly × campaign) slice it client-side, so all
 * views always agree. Sources:
 *   - Occurred:  Postgres + sheets, by event date (lib/workflow-stats)
 *   - Added:     "SDR Adds Log" sheet tab, by log date (starts Jul 9, 2026)
 *   - Calls:     JustCall SalesDialer calls API
 *   - Backlog:   JustCall campaigns API (contacts loaded per campaign)
 */

const axios = require('axios');
const { google } = require('googleapis');
const { TAB } = require('./adds-log');
const { fetchOccurred } = require('./workflow-stats');

const CAMPAIGNS = [
  { id: '3190746', name: 'No Show' },
  { id: '3190752', name: 'No Booking' },
  { id: '3309032', name: 'Lead Estimator' },
];

const FETCH_FROM = '2026-06-01'; // program start — the whole history is embedded
const CACHE_TTL_MS = 10 * 60 * 1000;
let payloadCache = null;   // { ts, payload }
let refreshing = null;     // in-flight promise

// ── Helpers ──────────────────────────────────────────────────────────────────

function jcHeaders() {
  const auth = Buffer.from(
    `${process.env.JUSTCALL_API_KEY}:${process.env.JUSTCALL_API_SECRET}`
  ).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json' };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dayOf = (d) => d.toISOString().slice(0, 10);

// ── Adds (from the sheet log) ────────────────────────────────────────────────

async function fetchAdds(startDate) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return {};
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : undefined;
  const auth = new google.auth.GoogleAuth({
    credentials,
    keyFile: credentials ? undefined : process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  let rows = [];
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB}!A:C`,
    });
    rows = data.values || [];
  } catch (err) {
    // Tab does not exist until the first add is logged
    console.warn(`[dashboard] adds log read failed: ${err.message}`);
    return {};
  }
  const byDay = {};
  for (const [ts, cid] of rows.slice(1)) {
    const day = String(ts || '').slice(0, 10);
    if (!day || day < startDate) continue;
    (byDay[day] ||= {})[cid] = ((byDay[day] || {})[cid] || 0) + 1;
  }
  return byDay;
}

// ── Calls (JustCall API) ─────────────────────────────────────────────────────

function classify(call) {
  const info = call.call_info || {};
  const answeredBy = String(info.call_answered_by || '').toLowerCase();
  const disposition = String(info.disposition || '').toLowerCase();
  if (answeredBy.includes('machine') || answeredBy.includes('voicemail')) return 'voicemail';
  if (info.type === 'Not Connected' || disposition.includes('no answer')) return 'noanswer';
  if (info.type === 'Connected') return 'connected';
  return 'noanswer';
}

function isMeeting(call) {
  return String(call.call_info?.disposition || '').toLowerCase().includes('meeting booked');
}

async function fetchCampaignCalls(campaignId, startDate) {
  const calls = [];
  let page = 0;
  while (page < 60) {
    let data;
    try {
      const res = await axios.get('https://api.justcall.io/v2.1/sales_dialer/calls', {
        headers: jcHeaders(),
        params: {
          per_page: 100,
          page,
          campaign_id: campaignId,
          from_datetime: `${startDate} 00:00:00`,
        },
        validateStatus: s => (s >= 200 && s < 300) || s === 429,
      });
      if (res.status === 429) { await sleep(15000); continue; }
      data = res.data;
    } catch (err) {
      console.warn(`[dashboard] calls fetch failed (${campaignId} p${page}): ${err.message}`);
      break;
    }
    const batch = data.data || [];
    if (!batch.length) break;
    calls.push(...batch);
    const oldest = batch[batch.length - 1]?.call_date || '';
    if (oldest && oldest < startDate) break;
    if (!data.next_page_link) break;
    page++;
    await sleep(250);
  }
  return calls.filter(c => (c.call_date || '') >= startDate);
}

async function fetchInventory() {
  const byId = {};
  let page = 0;
  try {
    while (page < 10) {
      const res = await axios.get('https://api.justcall.io/v2.1/sales_dialer/campaigns', {
        headers: jcHeaders(),
        params: { per_page: 50, page },
        validateStatus: s => (s >= 200 && s < 300) || s === 429,
      });
      if (res.status === 429) { await sleep(15000); continue; }
      const batch = res.data.data || [];
      for (const c of batch) {
        if (CAMPAIGNS.some(k => k.id === String(c.id))) {
          byId[String(c.id)] = c.contacts_count?.imported ?? c.contacts_count?.uploaded ?? null;
        }
      }
      if (!res.data.next_page_link || !batch.length) break;
      page++;
      await sleep(250);
    }
  } catch (err) {
    console.warn(`[dashboard] campaigns fetch failed: ${err.message}`);
  }
  return byId; // cid → contacts loaded (null if unavailable)
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function listDays(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); dayOf(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(dayOf(d));
  }
  return out;
}

function weekStart(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return dayOf(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortDate = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

function periodsFor(view, days) {
  const today = days[days.length - 1];
  const seen = new Map(); // key → { key, label, full, days: [] }
  for (const day of days) {
    let key, label, full;
    if (view === 'daily') {
      key = day; label = shortDate(day); full = day;
    } else if (view === 'weekly') {
      key = weekStart(day);
      const end = new Date(key + 'T00:00:00Z');
      end.setUTCDate(end.getUTCDate() + 6);
      const endDay = dayOf(end) > today ? today : dayOf(end);
      label = shortDate(key);
      full = `${shortDate(key)} – ${shortDate(endDay)}`;
    } else {
      key = day.slice(0, 7);
      label = MONTHS[Number(day.slice(5, 7)) - 1];
      full = `${MONTHS_FULL[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
    }
    if (!seen.has(key)) seen.set(key, { key, label, full, days: [] });
    seen.get(key).days.push(day);
  }
  return [...seen.values()];
}

function buildPayloadFrom(adds, occurred, callsPerCampaign, inventory) {
  const today = dayOf(new Date());
  const days = listDays(FETCH_FROM, today);

  // Per-campaign per-day base stats
  const base = {}; // cid → day → { occurred, added, dials, connected, voicemail, noanswer, meetings, contacts:Set }
  const blank = () => ({ occurred: 0, added: 0, dials: 0, connected: 0, voicemail: 0, noanswer: 0, meetings: 0, contacts: new Set() });
  for (const c of CAMPAIGNS) {
    const per = base[c.id] = {};
    for (const [day, n] of Object.entries(occurred[c.id] || {})) {
      if (day < FETCH_FROM || day > today) continue;
      (per[day] ||= blank()).occurred = n;
    }
    for (const [day, byCid] of Object.entries(adds)) {
      if (!byCid[c.id] || day > today) continue;
      (per[day] ||= blank()).added = byCid[c.id];
    }
    for (const call of callsPerCampaign[c.id] || []) {
      const day = call.call_date;
      if (!day || day > today) continue;
      const rec = (per[day] ||= blank());
      rec.dials += 1;
      rec[classify(call)] += 1;
      if (isMeeting(call)) rec.meetings += 1;
      rec.contacts.add(call.contact_number || call.contact_id);
    }
  }

  // Grouped views: view → scope → rows aligned with the view's period list
  const views = {};
  for (const view of ['daily', 'weekly', 'monthly']) {
    const periods = periodsFor(view, days);
    const scopes = {};
    for (const scope of ['all', ...CAMPAIGNS.map(c => c.id)]) {
      const cids = scope === 'all' ? CAMPAIGNS.map(c => c.id) : [scope];
      scopes[scope] = periods.map(p => {
        const row = { occurred: 0, added: 0, dials: 0, connected: 0, voicemail: 0, noanswer: 0, meetings: 0 };
        const uniq = new Set();
        for (const cid of cids) {
          for (const day of p.days) {
            const rec = base[cid][day];
            if (!rec) continue;
            for (const k of Object.keys(row)) row[k] += rec[k];
            for (const v of rec.contacts) uniq.add(v);
          }
        }
        row.unique = uniq.size;
        return row;
      });
    }
    views[view] = { periods: periods.map(({ key, label, full }) => ({ key, label, full })), scopes };
  }

  // Backlog: campaign inventory vs unique contacts ever dialed in the window
  const backlog = CAMPAIGNS.map(c => {
    const ever = new Set();
    let lastDial = null;
    for (const [day, rec] of Object.entries(base[c.id])) {
      if (rec.dials > 0 && (!lastDial || day > lastDial)) lastDial = day;
      for (const v of rec.contacts) ever.add(v);
    }
    const loaded = inventory[c.id];
    return {
      id: c.id, name: c.name, loaded,
      everDialed: ever.size,
      neverDialed: loaded == null ? null : Math.max(0, loaded - ever.size),
      lastDial,
    };
  });

  // Dispositions per scope, full window
  const dispositions = {};
  for (const scope of ['all', ...CAMPAIGNS.map(c => c.id)]) {
    const cids = scope === 'all' ? CAMPAIGNS.map(c => c.id) : [scope];
    const counts = {};
    let total = 0;
    for (const cid of cids) {
      for (const call of callsPerCampaign[cid] || []) {
        const d = (call.call_info?.disposition || '').trim() || '(none)';
        counts[d] = (counts[d] || 0) + 1;
        total++;
      }
    }
    dispositions[scope] = {
      total,
      top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    from: FETCH_FROM,
    campaigns: CAMPAIGNS,
    views,
    backlog,
    dispositions,
  };
}

async function fetchPayload() {
  const [adds, occurred, inventory, ...calls] = await Promise.all([
    fetchAdds(FETCH_FROM),
    fetchOccurred(FETCH_FROM),
    fetchInventory(),
    ...CAMPAIGNS.map(c => fetchCampaignCalls(c.id, FETCH_FROM)),
  ]);
  const callsPerCampaign = Object.fromEntries(CAMPAIGNS.map((c, i) => [c.id, calls[i]]));
  return buildPayloadFrom(adds, occurred, callsPerCampaign, inventory);
}

async function getPayload() {
  const fresh = payloadCache && Date.now() - payloadCache.ts < CACHE_TTL_MS;
  if (fresh) return payloadCache.payload;
  if (!refreshing) {
    refreshing = fetchPayload()
      .then(payload => { payloadCache = { ts: Date.now(), payload }; return payload; })
      .finally(() => { refreshing = null; });
  }
  // Serve stale immediately if we have anything; otherwise wait for the fetch.
  return payloadCache ? payloadCache.payload : refreshing;
}

// ── Page ─────────────────────────────────────────────────────────────────────

function page(payload) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SDR Calling — daily monitor</title>
<style>
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --up-good: #006300;
    --s1: #2a78d6; --s2: #1baf7a; --s3: #eda100;               /* funnel series */
    --o1: #1c5cab; --o2: #3987e5; --o3: #86b6ef;               /* outcomes (ordinal) */
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --up-good: #0ca30c;
      --s1: #3987e5; --s2: #199e70; --s3: #c98500;
      --o1: #184f95; --o2: #2a78d6; --o3: #6da7ec;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink-1);
         font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  .sub { color: var(--ink-3); font-size: 12px; margin-top: 2px; }
  .filters { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; margin: 18px 0 20px; }
  .seg { display: flex; gap: 6px; align-items: center; }
  .seg .seg-label { color: var(--ink-3); font-size: 12px; margin-right: 2px; }
  .seg button { background: none; color: var(--ink-2); cursor: pointer; padding: 5px 12px;
                border-radius: 999px; border: 1px solid var(--border); font-size: 13px; font: inherit; }
  .seg button[aria-pressed="true"] { color: var(--ink-1); font-weight: 600; border-color: var(--baseline); }
  .seg button[aria-pressed="true"]::before { content: "✓ "; font-weight: 700; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 10px; padding: 14px 16px; }
  .tile .label { color: var(--ink-2); font-size: 12px; }
  .tile .value { font-size: 28px; font-weight: 600; margin-top: 2px; }
  .tile .delta { font-size: 12px; margin-top: 2px; color: var(--ink-3); }
  .tile .delta.up { color: var(--up-good); }
  .card { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 10px; padding: 16px 18px; margin-top: 16px; }
  .card h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .card .note { color: var(--ink-3); font-size: 12px; margin-bottom: 10px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px;
            color: var(--ink-2); margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i.sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .legend i.ln { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
  svg { display: block; width: 100%; height: auto; }
  .tick { fill: var(--ink-3); font-size: 11px; font-variant-numeric: tabular-nums; }
  .gridline { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--baseline); stroke-width: 1; }
  .xhair { stroke: var(--baseline); stroke-width: 1; }
  #tip { position: fixed; pointer-events: none; background: var(--surface-1);
         border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
         font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.12); display: none; z-index: 10; }
  #tip .t-date { color: var(--ink-3); margin-bottom: 4px; }
  #tip .t-row { display: flex; align-items: center; gap: 6px; }
  #tip .t-key { width: 10px; height: 3px; border-radius: 2px; }
  #tip .t-val { font-weight: 600; }
  #tip .t-name { color: var(--ink-2); }
  .scroll-x { overflow-x: auto; }
  table { border-collapse: collapse; margin-top: 8px; font-size: 12px; width: 100%; }
  th { text-align: left; color: var(--ink-2); font-weight: 500; white-space: nowrap; }
  th, td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--grid); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.dim { color: var(--ink-3); }
</style>
</head>
<body>
<div class="wrap">
  <h1>SDR Calling — daily monitor</h1>
  <div class="sub">One funnel per workflow: occurred → added → dialed → connected → meeting booked.
    Data since ${shortDate(payload.from)}, ${payload.from.slice(0, 4)}. All dates UTC; call dates use the JustCall account timezone.
    Updated <span id="gen"></span> · refreshes every 10 min</div>

  <div class="filters" aria-label="Filters">
    <div class="seg" id="seg-view" role="group" aria-label="Period">
      <span class="seg-label">Period</span>
      <button data-view="daily">Daily</button>
      <button data-view="weekly">Weekly</button>
      <button data-view="monthly">Monthly</button>
    </div>
    <div class="seg" id="seg-scope" role="group" aria-label="Campaign">
      <span class="seg-label">Campaign</span>
      <button data-scope="all">All</button>
      ${payload.campaigns.map(c => `<button data-scope="${c.id}">${c.name}</button>`).join('')}
    </div>
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="card">
    <h2 id="funnel-title">Pipeline per period</h2>
    <div class="note">Occurred = eligible events by <em>event</em> date (no-shows by demo date,
      Meta leads with no booking <em>today</em> by lead date, estimator submissions) — the No Booking
      definition is retroactive, so past days shrink as leads book.
      Added = campaign adds by <em>log</em> date; the log starts Jul 9, 2026 and its first day is a
      202-contact historical backfill, not that day's new leads.
      Contacts dialed = unique numbers dialed in the period.</div>
    <div class="legend" id="leg-funnel"></div>
    <div id="chart-funnel"></div>
  </div>

  <div class="card">
    <h2 id="out-title">Dial outcomes per period</h2>
    <div class="note">Every dial in the period, by what happened — darker is better.
      Connected = a human answered (JustCall call type, minus no-answer dispositions).</div>
    <div class="legend" id="leg-out"></div>
    <div id="chart-out"></div>
  </div>

  <div class="card">
    <h2 id="table-title">All the numbers</h2>
    <div class="note">Newest first. Same filters as above; every chart value is in this table.</div>
    <div class="scroll-x"><div id="table"></div></div>
  </div>

  <div class="card">
    <h2>Campaign backlog (right now)</h2>
    <div class="note">Contacts loaded in each JustCall campaign vs unique numbers dialed since
      ${shortDate(payload.from)}. "Never dialed" is the pile waiting for calls. Not affected by the filters.</div>
    <div class="scroll-x"><div id="backlog"></div></div>
  </div>

  <div class="card">
    <h2 id="disp-title">Dispositions</h2>
    <div class="note">Top call dispositions set by the reps in JustCall, whole window, selected campaign.</div>
    <div class="scroll-x"><div id="disps"></div></div>
  </div>
</div>
<div id="tip" role="status"></div>
<script>
const DATA = ${JSON.stringify(payload)};

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const FUNNEL_SERIES = [
  { key: 'occurred', name: 'Occurred', color: '--s1' },
  { key: 'added',    name: 'Added',    color: '--s2' },
  { key: 'unique',   name: 'Contacts dialed', color: '--s3' },
];
const OUT_SERIES = [
  { key: 'connected', name: 'Connected', color: '--o1' },
  { key: 'voicemail', name: 'Voicemail', color: '--o2' },
  { key: 'noanswer',  name: 'No answer / other', color: '--o3' },
];
const PERIOD_NOUN = { daily: 'day', weekly: 'week', monthly: 'month' };
const CURRENT_LABEL = { daily: 'today (UTC)', weekly: 'this week', monthly: 'this month' };

document.getElementById('gen').textContent = new Date(DATA.generatedAt).toLocaleString();

// ── State (view × scope), persisted in the URL ───────────────────────────────
const params = new URLSearchParams(location.search);
const state = {
  view: ['daily', 'weekly', 'monthly'].includes(params.get('view')) ? params.get('view') : 'daily',
  scope: ['all', ...DATA.campaigns.map(c => c.id)].includes(params.get('scope')) ? params.get('scope') : 'all',
};

function bindSeg(id, attr, key) {
  const seg = document.getElementById(id);
  for (const btn of seg.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      state[key] = btn.dataset[attr];
      const p = new URLSearchParams({ view: state.view, scope: state.scope });
      history.replaceState(null, '', '?' + p.toString());
      render();
    });
  }
}
bindSeg('seg-view', 'view', 'view');
bindSeg('seg-scope', 'scope', 'scope');

// ── Tooltip ──────────────────────────────────────────────────────────────────
const tip = document.getElementById('tip');
function showTip(evt, title, rows) {
  tip.replaceChildren();
  const d = document.createElement('div'); d.className = 't-date'; d.textContent = title;
  tip.append(d);
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 't-row';
    const key = document.createElement('span'); key.className = 't-key'; key.style.background = r.color;
    const val = document.createElement('span'); val.className = 't-val'; val.textContent = r.value.toLocaleString();
    const name = document.createElement('span'); name.className = 't-name'; name.textContent = r.name;
    row.append(key, val, name); tip.append(row);
  }
  tip.style.display = 'block';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = evt.clientX + 12, y = evt.clientY - h - 8;
  if (x + w > innerWidth - 8) x = evt.clientX - w - 12;
  if (y < 8) y = evt.clientY + 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { tip.style.display = 'none'; }

// Integer tick steps (data is counts): pick the smallest nice step whose
// 3–5 multiples cover the max, so every gridline lands on a whole number.
function niceScale(rawMax) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  for (const step of steps) {
    if (rawMax <= step * 5) {
      const divs = Math.max(3, Math.ceil(rawMax / step));
      return { max: step * divs, step, divs };
    }
  }
  const step = Math.ceil(rawMax / 5 / 1000) * 1000;
  return { max: step * 5, step, divs: 5 };
}

const NS = 'http://www.w3.org/2000/svg';
function mk(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function chartFrame(maxV, n) {
  const W = 1000, plotH = 220, padL = 44, padR = 8, padT = 8, axisH = 26;
  const H = plotH + padT + axisH;
  const band = (W - padL - padR) / n;
  const { max, divs } = niceScale(Math.max(1, maxV));
  const yOf = v => padT + plotH - (v / max) * plotH;
  const xOf = i => padL + band * i + band / 2;
  const svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
  for (let i = 0; i <= divs; i++) {
    const v = (max / divs) * i, y = yOf(v);
    svg.append(mk('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: i === 0 ? 'baseline' : 'gridline' }));
    const t = mk('text', { x: padL - 6, y: y + 3.5, 'text-anchor': 'end', class: 'tick' });
    t.textContent = v.toLocaleString();
    svg.append(t);
  }
  return { svg, W, plotH, padL, padR, padT, band, yOf, xOf };
}

function xLabels(svg, f, periods) {
  const every = Math.ceil(periods.length / 10);
  periods.forEach((p, i) => {
    if (i % every !== 0) return;
    const t = mk('text', { x: f.xOf(i), y: f.padT + f.plotH + 16, 'text-anchor': 'middle', class: 'tick' });
    t.textContent = p.label;
    svg.append(t);
  });
}

function hitBands(svg, f, periods, rowsFor) {
  // One focusable hit target per period; a crosshair hairline tracks the active one.
  const hair = mk('line', { class: 'xhair', y1: f.padT, y2: f.padT + f.plotH, x1: -10, x2: -10, opacity: 0 });
  svg.append(hair);
  periods.forEach((p, i) => {
    const hit = mk('rect', {
      x: f.padL + f.band * i, y: f.padT, width: f.band, height: f.plotH,
      fill: 'transparent', tabindex: 0,
    });
    const show = (evt) => {
      hair.setAttribute('x1', f.xOf(i)); hair.setAttribute('x2', f.xOf(i));
      hair.setAttribute('opacity', 1);
      showTip(evt, p.full, rowsFor(i));
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerleave', () => { hair.setAttribute('opacity', 0); hideTip(); });
    hit.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      show({ clientX: b.x + b.width / 2, clientY: b.y + 30 });
    });
    hit.addEventListener('blur', () => { hair.setAttribute('opacity', 0); hideTip(); });
    svg.append(hit);
  });
}

// ── Multi-line chart (the funnel over time) ──────────────────────────────────
function lineChart(el, periods, rows, series) {
  el.replaceChildren();
  const maxV = Math.max(1, ...rows.flatMap(r => series.map(s => r[s.key])));
  const f = chartFrame(maxV, periods.length);
  xLabels(f.svg, f, periods);
  const surface = css('--surface-1');
  const drawMarkers = periods.length <= 16;
  for (const s of series) {
    const color = css(s.color);
    const dAttr = rows.map((r, i) =>
      (i === 0 ? 'M' : 'L') + f.xOf(i).toFixed(1) + ' ' + f.yOf(r[s.key]).toFixed(1)).join(' ');
    f.svg.append(mk('path', {
      d: dAttr, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    if (drawMarkers) {
      rows.forEach((r, i) => {
        f.svg.append(mk('circle', {
          cx: f.xOf(i), cy: f.yOf(r[s.key]), r: 4.5,
          fill: color, stroke: surface, 'stroke-width': 2,
        }));
      });
    }
  }
  hitBands(f.svg, f, periods, i => series.map(s => ({ name: s.name, value: rows[i][s.key], color: css(s.color) })));
  el.append(f.svg);
}

// ── Stacked column chart (outcomes) ──────────────────────────────────────────
function stackedChart(el, periods, rows, series) {
  el.replaceChildren();
  const totals = rows.map(r => series.reduce((a, s) => a + r[s.key], 0));
  const f = chartFrame(Math.max(1, ...totals), periods.length);
  xLabels(f.svg, f, periods);
  const barW = Math.min(24, f.band * 0.6);
  periods.forEach((p, i) => {
    const total = totals[i];
    if (!total) return;
    const x = f.xOf(i) - barW / 2;
    // rounded data-end via clip on the whole stack, square at the baseline
    const clipId = el.id + '-clip-' + i;
    const clip = mk('clipPath', { id: clipId });
    const topY = f.yOf(total);
    clip.append(mk('rect', { x, y: topY, width: barW, height: f.padT + f.plotH - topY, rx: 4 }));
    clip.append(mk('rect', { x, y: Math.max(topY, f.padT + f.plotH - 5), width: barW, height: 5 }));
    f.svg.append(clip);
    let acc = 0;
    series.forEach((s, si) => {
      const v = rows[i][s.key];
      if (!v) return;
      const y0 = f.yOf(acc + v), y1 = f.yOf(acc);
      f.svg.append(mk('rect', {
        x, y: y0 + (si > 0 ? 1 : 0), width: barW,
        height: Math.max(0.5, y1 - y0 - (si > 0 ? 2 : 1)),
        fill: css(s.color), 'clip-path': 'url(#' + clipId + ')',
      }));
      acc += v;
    });
  });
  hitBands(f.svg, f, periods, i => series.map(s => ({ name: s.name, value: rows[i][s.key], color: css(s.color) })));
  el.append(f.svg);
}

function legend(elId, series, shape) {
  const el = document.getElementById(elId);
  el.replaceChildren();
  for (const s of series) {
    const span = document.createElement('span');
    const i = document.createElement('i'); i.className = shape; i.style.background = css(s.color);
    span.append(i, document.createTextNode(s.name));
    el.append(span);
  }
}

// ── KPI tiles ────────────────────────────────────────────────────────────────
function tile(label, value, delta, deltaLabel) {
  const div = document.createElement('div');
  div.className = 'tile';
  const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'value'; v.textContent = value.toLocaleString();
  div.append(l, v);
  if (delta !== null) {
    const d = document.createElement('div');
    d.className = 'delta' + (delta > 0 ? ' up' : '');
    d.textContent = (delta >= 0 ? '+' : '') + delta.toLocaleString() + ' ' + deltaLabel;
    div.append(d);
  }
  return div;
}

function renderKpis(rows) {
  const el = document.getElementById('kpis');
  el.replaceChildren();
  const cur = rows[rows.length - 1] || {};
  const prev = rows[rows.length - 2] || null;
  const vsLabel = 'vs last ' + PERIOD_NOUN[state.view];
  const metrics = [
    ['Occurred', 'occurred'], ['Added', 'added'], ['Dials', 'dials'],
    ['Contacts dialed', 'unique'], ['Connected', 'connected'], ['Meetings booked', 'meetings'],
  ];
  for (const [label, key] of metrics) {
    const fullLabel = label + ' — ' + CURRENT_LABEL[state.view];
    el.append(tile(fullLabel, cur[key] || 0, prev ? (cur[key] || 0) - (prev[key] || 0) : null, vsLabel));
  }
}

// ── Tables ───────────────────────────────────────────────────────────────────
function makeTable(headers, rows) {
  const table = document.createElement('table');
  const tr = document.createElement('tr');
  headers.forEach(([text, cls]) => {
    const th = document.createElement('th');
    if (cls) th.className = cls;
    th.textContent = text; tr.append(th);
  });
  table.append(tr);
  for (const cells of rows) {
    const row = document.createElement('tr');
    cells.forEach(([text, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text; row.append(td);
    });
    table.append(row);
  }
  return table;
}

function renderTable(periods, rows) {
  const el = document.getElementById('table');
  el.replaceChildren();
  const headers = [['Period'], ...['Occurred', 'Added', 'Dials', 'Contacts dialed', 'Connected', 'Voicemail', 'No answer', 'Meetings'].map(h => [h, 'num'])];
  const body = [];
  for (let i = periods.length - 1; i >= 0; i--) {
    const r = rows[i];
    body.push([
      [periods[i].full],
      ...['occurred', 'added', 'dials', 'unique', 'connected', 'voicemail', 'noanswer', 'meetings']
        .map(k => [r[k].toLocaleString(), 'num']),
    ]);
  }
  el.append(makeTable(headers, body));
}

function renderBacklog() {
  const el = document.getElementById('backlog');
  el.replaceChildren();
  const headers = [['Campaign'], ['In campaign', 'num'], ['Dialed ≥1×', 'num'], ['Never dialed', 'num'], ['Last dial', 'num']];
  const body = DATA.backlog.map(b => [
    [b.name],
    [b.loaded == null ? '—' : b.loaded.toLocaleString(), 'num'],
    [b.everDialed.toLocaleString(), 'num'],
    [b.neverDialed == null ? '—' : b.neverDialed.toLocaleString(), 'num'],
    [b.lastDial || 'never', 'num' + (b.lastDial ? '' : ' dim')],
  ]);
  el.append(makeTable(headers, body));
}

function renderDisps() {
  const el = document.getElementById('disps');
  el.replaceChildren();
  const scopeName = state.scope === 'all' ? 'All campaigns' : DATA.campaigns.find(c => c.id === state.scope).name;
  document.getElementById('disp-title').textContent = 'Dispositions — ' + scopeName;
  const d = DATA.dispositions[state.scope];
  if (!d || !d.total) {
    const p = document.createElement('div'); p.className = 'note'; p.textContent = 'No calls in window';
    el.append(p);
    return;
  }
  const headers = [['Disposition'], ['Calls', 'num'], ['Share', 'num']];
  const body = d.top.map(([name, count]) => [
    [name], [count.toLocaleString(), 'num'], [Math.round((count / d.total) * 100) + '%', 'num'],
  ]);
  el.append(makeTable(headers, body));
}

// ── Render everything for the current state ──────────────────────────────────
function render() {
  for (const btn of document.querySelectorAll('#seg-view button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
  }
  for (const btn of document.querySelectorAll('#seg-scope button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.scope === state.scope));
  }
  const { periods, scopes } = DATA.views[state.view];
  const rows = scopes[state.scope];
  const noun = PERIOD_NOUN[state.view];
  const scopeName = state.scope === 'all' ? 'all campaigns' : DATA.campaigns.find(c => c.id === state.scope).name;

  renderKpis(rows);
  document.getElementById('funnel-title').textContent = 'Pipeline per ' + noun + ' — ' + scopeName;
  legend('leg-funnel', FUNNEL_SERIES, 'ln');
  lineChart(document.getElementById('chart-funnel'), periods, rows, FUNNEL_SERIES);
  document.getElementById('out-title').textContent = 'Dial outcomes per ' + noun + ' — ' + scopeName;
  legend('leg-out', OUT_SERIES, 'sw');
  stackedChart(document.getElementById('chart-out'), periods, rows, OUT_SERIES);
  document.getElementById('table-title').textContent = 'All the numbers — per ' + noun + ', ' + scopeName;
  renderTable(periods, rows);
  renderDisps();
}

renderBacklog();
render();
</script>
</body>
</html>`;
}

// Warm the cache at boot so the first visitor doesn't wait for the full fetch.
setTimeout(() => getPayload().catch(e => console.warn(`[dashboard] warmup failed: ${e.message}`)), 5000);

async function dashboardHandler(req, res) {
  try {
    const payload = await getPayload();
    res.set('Content-Type', 'text/html; charset=utf-8').send(page(payload));
  } catch (err) {
    console.error(`[dashboard] ${err.stack || err.message}`);
    res.status(500).send('dashboard error: ' + err.message);
  }
}

module.exports = { dashboardHandler };
