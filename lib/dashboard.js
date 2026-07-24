/**
 * SDR Calling dashboard — one row per lead, full history since program start:
 *
 *   Occurred → Added (or Skipped, with why) → Dials → Connected → Meeting booked
 *
 * Sources:
 *   - Occurred: Postgres + sheets, by event date, with identity (lib/workflow-stats)
 *   - Added:    "SDR Adds Log" sheet tab (lib/adds-log)
 *   - Skipped:  "SDR Skip Log" sheet tab (lib/skip-log) — logged going forward only,
 *               so leads that were skipped before this tab existed show as Pending.
 *   - Calls:    JustCall SalesDialer calls API, matched to a lead by phone number
 *   - Backlog:  JustCall campaigns API (contacts loaded per campaign)
 */

const axios = require('axios');
const { fetchOccurred } = require('./workflow-stats');
const { fetchAddRows } = require('./adds-log');
const { fetchSkipRows } = require('./skip-log');

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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function identityKey(email, phone) {
  const e = normEmail(email);
  if (e) return 'e:' + e;
  const p = normPhone(phone);
  if (p) return 'p:' + p;
  return null;
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

// ── Assembly: one row per lead ────────────────────────────────────────────────

function buildLeadsForCampaign(cid, occRows, addRows, skipRows, calls) {
  const callsByPhone = new Map();
  for (const call of calls) {
    const p = normPhone(call.contact_number);
    if (!p) continue;
    if (!callsByPhone.has(p)) callsByPhone.set(p, []);
    callsByPhone.get(p).push(call);
  }

  const addByKey = new Map();
  for (const r of addRows) {
    const key = identityKey(r.email, r.phone);
    if (!key) continue;
    const existing = addByKey.get(key);
    if (!existing || r.timestamp > existing.timestamp) addByKey.set(key, r);
  }
  const skipByKey = new Map();
  for (const r of skipRows) {
    const key = identityKey(r.email, r.phone);
    if (!key) continue;
    const existing = skipByKey.get(key);
    if (!existing || r.timestamp > existing.timestamp) skipByKey.set(key, r);
  }

  const leads = new Map(); // key → { occurred, add, skip }
  const ensure = (key) => {
    if (!leads.has(key)) leads.set(key, { occurred: null, add: null, skip: null });
    return leads.get(key);
  };
  for (const r of occRows) {
    const key = identityKey(r.email, r.phone);
    if (!key) continue;
    const lead = ensure(key);
    if (!lead.occurred || r.day < lead.occurred.day) lead.occurred = r;
  }
  for (const [key, r] of addByKey) ensure(key).add = r;
  for (const [key, r] of skipByKey) ensure(key).skip = r;

  return [...leads.entries()].map(([key, l]) => {
    const email = l.occurred?.email || l.add?.email || l.skip?.email || '';
    const phone = l.add?.phone || l.occurred?.phone || l.skip?.phone || '';
    const name = l.occurred?.name || '';
    const day = l.occurred?.day || (l.add?.timestamp || '').slice(0, 10) || (l.skip?.timestamp || '').slice(0, 10) || '';

    const p10 = normPhone(phone);
    const leadCalls = p10 ? (callsByPhone.get(p10) || []) : [];
    let lastCall = null;
    for (const c of leadCalls) {
      if (!lastCall || (c.call_date || '') > (lastCall.call_date || '')) lastCall = c;
    }

    let status = 'pending', statusDetail = '', statusAt = '';
    if (l.add) { status = 'added'; statusAt = l.add.timestamp; }
    else if (l.skip) { status = 'skipped'; statusDetail = l.skip.reason; statusAt = l.skip.timestamp; }

    return {
      key: cid + ':' + key, campaignId: cid, day, name, email, phone,
      occurred: !!l.occurred, status, statusDetail, statusAt,
      dials: leadCalls.length,
      connected: leadCalls.filter(c => classify(c) === 'connected').length,
      meeting: leadCalls.some(isMeeting),
      lastCallDate: lastCall?.call_date || '',
      lastDisposition: lastCall?.call_info?.disposition || '',
    };
  });
}

function buildPayloadFrom(occurred, addRows, skipRows, callsPerCampaign, inventory) {
  const leads = [];
  for (const c of CAMPAIGNS) {
    const rows = buildLeadsForCampaign(
      c.id,
      occurred[c.id] || [],
      addRows.filter(r => r.campaignId === c.id),
      skipRows.filter(r => r.campaignId === c.id),
      callsPerCampaign[c.id] || [],
    );
    leads.push(...rows);
  }
  leads.sort((a, b) => (b.day || '').localeCompare(a.day || '') || (b.statusAt || '').localeCompare(a.statusAt || ''));

  // Backlog: campaign inventory vs unique contacts ever dialed in the window
  const backlog = CAMPAIGNS.map(c => {
    const calls = callsPerCampaign[c.id] || [];
    const ever = new Set();
    let lastDial = null;
    for (const call of calls) {
      const day = call.call_date;
      if (day && (!lastDial || day > lastDial)) lastDial = day;
      ever.add(call.contact_number || call.contact_id);
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
    leads,
    backlog,
    dispositions,
  };
}

async function fetchPayload() {
  const [occurred, addRows, skipRows, inventory, ...calls] = await Promise.all([
    fetchOccurred(FETCH_FROM),
    fetchAddRows(FETCH_FROM),
    fetchSkipRows(FETCH_FROM),
    fetchInventory(),
    ...CAMPAIGNS.map(c => fetchCampaignCalls(c.id, FETCH_FROM)),
  ]);
  const callsPerCampaign = Object.fromEntries(CAMPAIGNS.map((c, i) => [c.id, calls[i]]));
  return buildPayloadFrom(occurred, addRows, skipRows, callsPerCampaign, inventory);
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
<title>SDR Calling — lead detail</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2/src/regular/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2/src/bold/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2/src/fill/style.css">
<style>
  @font-face {
    font-family: "Vert Grotesk Display";
    src: url("/assets/fonts/VertGroteskDisplay-VF.ttf") format("truetype-variations");
    font-weight: 100 900; font-style: normal; font-display: swap;
  }
  @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");

  :root {
    --gw-primary-50: #e5f1ff; --gw-primary-100: #cce2ff; --gw-primary-300: #66a9ff;
    --gw-primary-500: #0070ff; --gw-primary-600: #0061e0; --gw-primary-700: #005cd1; --gw-primary-800: #0048a3;
    --gw-black: #0d0d0d; --gw-neutral-50: #f7f8f9; --gw-neutral-100: #f1f2f3; --gw-neutral-200: #e1e3e8;
    --gw-neutral-300: #cfd1d4; --gw-neutral-500: #959ba4; --gw-neutral-600: #6a7077; --gw-neutral-700: #535a61;
    --gw-success: #1fc16b; --gw-success-bg: #e6f8ef;
    --gw-warning-strong: #9a6b00; --gw-warning-bg: #fff8d6;
    --gw-ink-overlay-04: rgba(1,1,9,0.04);
    --gw-font-display: "Vert Grotesk Display", "Inter", ui-sans-serif, system-ui, sans-serif;
    --gw-font-body: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
    --gw-shadow-s2: 0 3px 50px rgba(0,0,0,0.07);
    --gw-shadow-focus-blue: 0 0 0 4px rgba(0,112,255,0.18);

    --surface-1: #ffffff; --page: var(--gw-neutral-50);
    --ink-1: var(--gw-black); --ink-2: var(--gw-neutral-700); --ink-3: var(--gw-neutral-500);
    --grid: var(--gw-neutral-100); --baseline: var(--gw-neutral-300); --border: var(--gw-neutral-200);
    --up-good: var(--gw-success);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink-1);
         font: 14px/1.45 var(--gw-font-body); letter-spacing: -0.006em; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 24px 20px 48px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand img { width: 22px; height: 22px; display: block; }
  h1 { font-family: var(--gw-font-display); font-size: 20px; font-weight: 700;
       letter-spacing: -0.016em; margin: 0; }
  .sub { color: var(--ink-3); font-size: 12px; margin-top: 6px; }
  .sub .live { color: var(--gw-primary-500); margin-right: 2px; }
  .filters { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 18px 0 20px; }
  .seg { display: flex; gap: 6px; align-items: center; }
  .seg .seg-label { color: var(--ink-3); font-size: 12px; margin-right: 2px; }
  .seg button { background: none; color: var(--ink-2); cursor: pointer; padding: 5px 12px;
                border-radius: 999px; border: 1px solid var(--border); font-size: 13px; font: inherit;
                letter-spacing: -0.006em; transition: background 120ms cubic-bezier(0.22,1,0.36,1), color 120ms cubic-bezier(0.22,1,0.36,1), border-color 120ms cubic-bezier(0.22,1,0.36,1); }
  .seg button:hover { background: var(--gw-ink-overlay-04); }
  .seg button[aria-pressed="true"] { color: #fff; font-weight: 600; background: var(--ink-1); border-color: var(--ink-1); }
  .seg button[aria-pressed="true"]:hover { background: var(--ink-1); }
  .seg button:focus-visible { outline: none; box-shadow: var(--gw-shadow-focus-blue); }
  .search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px;
            padding: 5px 12px; color: var(--ink-2); background: var(--surface-1); }
  .search i { color: var(--ink-3); font-size: 14px; }
  .search input { border: none; outline: none; background: none; color: var(--ink-1); font: inherit;
                  letter-spacing: -0.006em; width: 200px; }
  .search input::placeholder { color: var(--ink-3); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 12px; padding: 14px 16px; }
  .tile .label { color: var(--ink-2); font-size: 12px; }
  .tile .value { font-family: var(--gw-font-display); font-size: 26px; font-weight: 700;
                 letter-spacing: -0.016em; margin-top: 2px; }
  .card { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 16px; box-shadow: var(--gw-shadow-s2); padding: 16px 18px; margin-top: 16px; }
  .card h2 { font-family: var(--gw-font-display); font-size: 15px; font-weight: 700;
             letter-spacing: -0.016em; margin: 0 0 2px; }
  .card .note { color: var(--ink-3); font-size: 12px; margin-bottom: 10px; }
  .scroll-x { overflow-x: auto; }
  table { border-collapse: collapse; margin-top: 8px; font-size: 12.5px; width: 100%; }
  th { text-align: left; color: var(--ink-2); font-weight: 600; white-space: nowrap; cursor: default;
       position: sticky; top: 0; background: var(--surface-1); }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--ink-1); }
  th.sortable .arrow { color: var(--gw-primary-500); margin-left: 3px; }
  th, td { padding: 6px 12px 6px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.dim { color: var(--ink-3); }
  td.wrap-cell { white-space: normal; max-width: 260px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px;
           font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge i { font-size: 12px; }
  .badge.added { background: var(--gw-success-bg); color: var(--gw-success); }
  .badge.skipped { background: var(--gw-warning-bg); color: var(--gw-warning-strong); }
  .badge.pending { background: var(--gw-neutral-100); color: var(--ink-2); }
  .empty { color: var(--ink-3); padding: 20px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><img src="/assets/gushwork-icon.svg" alt=""><h1>SDR Calling — lead detail</h1></div>
  <div class="sub"><i class="ph-fill ph-broadcast live"></i>One row per lead: occurred → added or skipped (with why) → dials → connected → meeting booked.
    Data since ${shortDate(payload.from)}, ${payload.from.slice(0, 4)}. All dates UTC; call dates use the JustCall account timezone.
    Skip reasons are only logged from Jul 22, 2026 onward — earlier misses show as Pending.
    Updated <span id="gen"></span> · refreshes every 10 min</div>

  <div class="filters" aria-label="Filters">
    <div class="seg" id="seg-scope" role="group" aria-label="Campaign">
      <span class="seg-label">Campaign</span>
      <button data-scope="all">All</button>
      ${payload.campaigns.map(c => `<button data-scope="${c.id}">${c.name}</button>`).join('')}
    </div>
    <div class="seg" id="seg-status" role="group" aria-label="Status">
      <span class="seg-label">Status</span>
      <button data-status="all">All</button>
      <button data-status="added">Added</button>
      <button data-status="skipped">Skipped</button>
      <button data-status="pending">Pending</button>
    </div>
    <label class="search">
      <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
      <input id="q" type="search" placeholder="Search name, email, phone…">
    </label>
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="card">
    <h2 id="table-title">Leads</h2>
    <div class="note">Newest first by occurrence date. Matched to JustCall calls by phone number.
      Click a column header to sort.</div>
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
<script>
const DATA = ${JSON.stringify(payload)};

document.getElementById('gen').textContent = new Date(DATA.generatedAt).toLocaleString();

// ── State (scope × status × search × sort), persisted in the URL ─────────────
const params = new URLSearchParams(location.search);
const state = {
  scope: ['all', ...DATA.campaigns.map(c => c.id)].includes(params.get('scope')) ? params.get('scope') : 'all',
  status: ['all', 'added', 'skipped', 'pending'].includes(params.get('status')) ? params.get('status') : 'all',
  q: params.get('q') || '',
  sortKey: 'day',
  sortDir: -1,
};

function pushState() {
  const p = new URLSearchParams({ scope: state.scope, status: state.status });
  if (state.q) p.set('q', state.q);
  history.replaceState(null, '', '?' + p.toString());
}

function bindSeg(id, attr, key) {
  const seg = document.getElementById(id);
  for (const btn of seg.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      state[key] = btn.dataset[attr];
      pushState();
      render();
    });
  }
}
bindSeg('seg-scope', 'scope', 'scope');
bindSeg('seg-status', 'status', 'status');

const qInput = document.getElementById('q');
qInput.value = state.q;
qInput.addEventListener('input', () => {
  state.q = qInput.value.trim().toLowerCase();
  pushState();
  render();
});

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
    cells.forEach(([content, cls]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (content instanceof Node) td.append(content); else td.textContent = content;
      row.append(td);
    });
    table.append(row);
  }
  return table;
}

function badge(status, detail) {
  const span = document.createElement('span');
  span.className = 'badge ' + status;
  const i = document.createElement('i');
  i.className = 'ph-fill ' + (status === 'added' ? 'ph-check-circle' : status === 'skipped' ? 'ph-warning-circle' : 'ph-clock');
  span.append(i, document.createTextNode(status.charAt(0).toUpperCase() + status.slice(1)));
  if (detail) span.title = detail;
  return span;
}

// ── Leads table ──────────────────────────────────────────────────────────────
const SORTERS = {
  day: r => r.day || '',
  campaign: r => r.campaignId,
  name: r => (r.name || r.email || '').toLowerCase(),
  status: r => r.status,
  dials: r => r.dials,
  connected: r => r.connected,
  meeting: r => r.meeting ? 1 : 0,
  lastCallDate: r => r.lastCallDate || '',
};

function filteredLeads() {
  return DATA.leads.filter(l => {
    // A search query looks across every campaign, regardless of the scope filter —
    // otherwise a lead sitting in a different campaign than expected looks "missing".
    if (!state.q && state.scope !== 'all' && l.campaignId !== state.scope) return false;
    if (state.status !== 'all' && l.status !== state.status) return false;
    if (state.q) {
      const hay = (l.name + ' ' + l.email + ' ' + l.phone).toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  });
}

function campaignName(cid) {
  return (DATA.campaigns.find(c => c.id === cid) || {}).name || cid;
}

function renderKpis(rows) {
  const el = document.getElementById('kpis');
  el.replaceChildren();
  const metrics = [
    ['Occurred', rows.filter(r => r.occurred).length],
    ['Added', rows.filter(r => r.status === 'added').length],
    ['Skipped', rows.filter(r => r.status === 'skipped').length],
    ['Pending', rows.filter(r => r.status === 'pending').length],
    ['Dials', rows.reduce((a, r) => a + r.dials, 0)],
    ['Connected', rows.reduce((a, r) => a + r.connected, 0)],
    ['Meetings booked', rows.filter(r => r.meeting).length],
  ];
  for (const [label, value] of metrics) {
    const div = document.createElement('div');
    div.className = 'tile';
    const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'value'; v.textContent = value.toLocaleString();
    div.append(l, v);
    el.append(div);
  }
}

function sortIndicator(key) {
  return state.sortKey === key ? (state.sortDir === 1 ? ' ↑' : ' ↓') : '';
}

function renderLeadsTable(rows) {
  const el = document.getElementById('table');
  el.replaceChildren();
  document.getElementById('table-title').textContent = 'Leads (' + rows.length.toLocaleString() + ')'
    + (state.q && state.scope !== 'all' ? ' — searching all campaigns' : '');

  if (!rows.length) {
    const p = document.createElement('div'); p.className = 'empty'; p.textContent = 'No leads match these filters';
    el.append(p);
    return;
  }

  const sorted = [...rows].sort((a, b) => {
    const fn = SORTERS[state.sortKey];
    const av = fn(a), bv = fn(b);
    if (av < bv) return -1 * state.sortDir;
    if (av > bv) return 1 * state.sortDir;
    return 0;
  });

  const cols = [
    ['day', 'Date', ''], ['campaign', 'Campaign', ''], ['name', 'Name', ''],
    ['email', 'Email', ''], ['phone', 'Phone', ''], ['status', 'Status', ''],
    ['detail', 'Detail', ''], ['dials', 'Dials', 'num'], ['connected', 'Connected', 'num'],
    ['meeting', 'Meeting', ''], ['lastCallDate', 'Last call', ''],
  ];
  const headers = cols.map(([key, label, cls]) => [
    label + (SORTERS[key] ? sortIndicator(key) : ''), cls,
  ]);

  const body = sorted.map(r => [
    [r.day ? new Date(r.day + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'],
    [campaignName(r.campaignId)],
    [r.name || '—', r.name ? '' : 'dim'],
    [r.email || '—', r.email ? '' : 'dim'],
    [r.phone || '—', r.phone ? '' : 'dim'],
    [badge(r.status, r.statusDetail)],
    [r.status === 'skipped' ? r.statusDetail : (r.statusAt ? new Date(r.statusAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'),
      r.status === 'skipped' ? 'wrap-cell' : 'dim'],
    [r.dials.toLocaleString(), 'num'],
    [r.connected.toLocaleString(), 'num'],
    [r.meeting ? 'Yes' : '—', r.meeting ? '' : 'dim'],
    [r.lastCallDate ? (r.lastCallDate.slice(0, 10)) + (r.lastDisposition ? ' — ' + r.lastDisposition : '') : '—',
      r.lastCallDate ? '' : 'dim'],
  ]);

  const table = makeTable(headers, body);
  const ths = table.querySelectorAll('tr:first-child th');
  cols.forEach(([key], i) => {
    if (!SORTERS[key]) return;
    ths[i].classList.add('sortable');
    ths[i].addEventListener('click', () => {
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = key === 'day' ? -1 : 1; }
      render();
    });
  });
  el.append(table);
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
  const scopeName = state.scope === 'all' ? 'All campaigns' : campaignName(state.scope);
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
  for (const btn of document.querySelectorAll('#seg-scope button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.scope === state.scope));
  }
  for (const btn of document.querySelectorAll('#seg-status button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.status === state.status));
  }
  const rows = filteredLeads();
  renderKpis(rows);
  renderLeadsTable(rows);
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
