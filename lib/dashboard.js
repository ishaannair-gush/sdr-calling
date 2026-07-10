/**
 * SDR Calling dashboard — daily adds per campaign (from the "SDR Adds Log"
 * sheet tab) and JustCall SalesDialer calls with outcomes (from the calls API).
 * Server-side aggregation, single self-contained HTML page at "/".
 */

const axios = require('axios');
const { google } = require('googleapis');
const { TAB, CAMPAIGN_NAMES } = require('./adds-log');
const { buildSummary, bucketDefs } = require('./workflow-stats');

const CAMPAIGNS = [
  { id: '3190746', name: 'No Show' },
  { id: '3190752', name: 'No Booking' },
  { id: '3309032', name: 'Lead Estimator' },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
// One shared raw fetch (calls window = start of last month) serves every range;
// stale data is served immediately while a background refresh runs.
let rawCache = null;      // { ts, adds, callsPerCampaign, summary }
let rawRefreshing = null; // in-flight promise

// ── Helpers ──────────────────────────────────────────────────────────────────

function jcHeaders() {
  const auth = Buffer.from(
    `${process.env.JUSTCALL_API_KEY}:${process.env.JUSTCALL_API_SECRET}`
  ).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json' };
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function rangeDates(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    out.push(dateKey(new Date(now.getTime() - i * 86400000)));
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  if (call.call_info?.type === 'Not Connected' || disposition.includes('no answer')) return 'noanswer';
  if (call.call_info?.type === 'Connected') return 'connected';
  return 'noanswer';
}

async function fetchCampaignCalls(campaignId, startDate) {
  const calls = [];
  let page = 0;
  while (page < 40) {
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

// ── Aggregation ──────────────────────────────────────────────────────────────

async function fetchRaw() {
  // Fetch back to the start of last calendar month so the workflow summary
  // (month-on-month) shares one calls window with the charts.
  const lastMonthStart = bucketDefs().find(b => b.key === 'lastMonth').from;
  const [adds, ...callsPerCampaign] = await Promise.all([
    fetchAdds(lastMonthStart),
    ...CAMPAIGNS.map(c => fetchCampaignCalls(c.id, lastMonthStart)),
  ]);
  const summary = await buildSummary(
    adds,
    Object.fromEntries(CAMPAIGNS.map((c, i) => [c.id, callsPerCampaign[i]]))
  );
  return { ts: Date.now(), adds, callsPerCampaign, summary };
}

async function getRaw() {
  const fresh = rawCache && Date.now() - rawCache.ts < CACHE_TTL_MS;
  if (fresh) return rawCache;
  if (!rawRefreshing) {
    rawRefreshing = fetchRaw()
      .then(raw => { rawCache = raw; return raw; })
      .finally(() => { rawRefreshing = null; });
  }
  // Serve stale immediately if we have anything; otherwise wait for the fetch.
  return rawCache || rawRefreshing;
}

function buildPayload(days, raw) {
  const dates = rangeDates(days);
  const startDate = dates[0];
  const { adds, callsPerCampaign, summary } = raw;

  const calls = {};       // day → cid → count
  const outcomes = {};    // day → { connected, voicemail, noanswer }
  const dispositions = {}; // campaign name → { disposition → count }

  CAMPAIGNS.forEach((c, i) => {
    for (const call of callsPerCampaign[i]) {
      if ((call.call_date || '') < startDate) continue; // charts use the selected range only
      const day = call.call_date;
      ((calls[day] ||= {})[c.id] ||= 0), (calls[day][c.id] += 1);
      const bucket = classify(call);
      (outcomes[day] ||= { connected: 0, voicemail: 0, noanswer: 0 })[bucket] += 1;
      const disp = (call.call_info?.disposition || '').trim() || '(none)';
      ((dispositions[c.name] ||= {})[disp] ||= 0), (dispositions[c.name][disp] += 1);
    }
  });

  const today = dates[dates.length - 1];
  const yesterday = dates[dates.length - 2];
  const sumDay = (obj, day) => Object.values(obj[day] || {}).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

  const totalCallsRange = dates.reduce((a, d) => a + sumDay(calls, d), 0);
  const connectedRange = dates.reduce((a, d) => a + (outcomes[d]?.connected || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    days,
    dates,
    campaigns: CAMPAIGNS,
    summary,
    adds,
    calls,
    outcomes,
    dispositions: Object.fromEntries(
      Object.entries(dispositions).map(([name, m]) => [
        name,
        Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10),
      ])
    ),
    kpis: {
      addsToday: sumDay(adds, today),
      addsYesterday: sumDay(adds, yesterday),
      callsToday: sumDay(calls, today),
      callsYesterday: sumDay(calls, yesterday),
      connectedToday: outcomes[today]?.connected || 0,
      connectedYesterday: outcomes[yesterday]?.connected || 0,
      connectRate: totalCallsRange ? Math.round((connectedRange / totalCallsRange) * 100) : 0,
      totalCallsRange,
    },
  };
}

async function getPayload(days) {
  const raw = await getRaw();
  return buildPayload(days, raw);
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
    --c1: #2a78d6; --c2: #1baf7a; --c3: #eda100;               /* campaigns */
    --o1: #1c5cab; --o2: #3987e5; --o3: #86b6ef;               /* outcomes (ordinal) */
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --up-good: #0ca30c;
      --c1: #3987e5; --c2: #199e70; --c3: #c98500;
      --o1: #184f95; --o2: #2a78d6; --o3: #6da7ec;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink-1);
         font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  .sub { color: var(--ink-3); font-size: 12px; margin-top: 2px; }
  .filters { display: flex; gap: 8px; align-items: center; margin: 18px 0 20px; }
  .filters a { color: var(--ink-2); text-decoration: none; padding: 5px 12px;
               border-radius: 999px; border: 1px solid var(--border); font-size: 13px; }
  .filters a.sel { color: var(--ink-1); font-weight: 600; border-color: var(--baseline); }
  .filters a.sel::before { content: "✓ "; font-weight: 700; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 10px; padding: 14px 16px; }
  .tile .label { color: var(--ink-2); font-size: 12px; }
  .tile .value { font-size: 30px; font-weight: 600; margin-top: 2px; }
  .tile .delta { font-size: 12px; margin-top: 2px; color: var(--ink-3); }
  .tile .delta.up { color: var(--up-good); }
  .card { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 10px; padding: 16px 18px; margin-top: 16px; }
  .card h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .card .note { color: var(--ink-3); font-size: 12px; margin-bottom: 10px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px;
            color: var(--ink-2); margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  svg { display: block; width: 100%; height: auto; }
  .tick { fill: var(--ink-3); font-size: 11px; font-variant-numeric: tabular-nums; }
  .gridline { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--baseline); stroke-width: 1; }
  #tip { position: fixed; pointer-events: none; background: var(--surface-1);
         border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
         font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.12); display: none; z-index: 10; }
  #tip .t-date { color: var(--ink-3); margin-bottom: 4px; }
  #tip .t-row { display: flex; align-items: center; gap: 6px; }
  #tip .t-key { width: 10px; height: 3px; border-radius: 2px; }
  #tip .t-val { font-weight: 600; }
  #tip .t-name { color: var(--ink-2); }
  details { margin-top: 10px; }
  summary { color: var(--ink-2); font-size: 12px; cursor: pointer; }
  table { border-collapse: collapse; margin-top: 8px; font-size: 12px; width: 100%; }
  th { text-align: left; color: var(--ink-2); font-weight: 500; }
  th, td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--grid); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .disp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>SDR Calling — daily monitor</h1>
  <div class="sub">Contacts added to JustCall SalesDialer campaigns and calls made, with outcomes.
    Updated <span id="gen"></span> · refreshes every 10 min</div>

  <div class="filters" aria-label="Date range">
    ${[7, 14, 30].map(d =>
      `<a href="/?days=${d}" class="${payload.days === d ? 'sel' : ''}">Last ${d} days</a>`).join('')}
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="card">
    <h2>Workflow summary — occurred vs added vs called</h2>
    <div class="note">Fixed periods (UTC), independent of the range filter above.
      "Occurred" = eligible events per workflow (no-shows / Meta leads without a booking / estimator submissions).
      "Added" counts are complete from July 9, 2026 — earlier periods show only what was logged.</div>
    <div class="disp-grid" id="summary"></div>
  </div>

  <div class="card">
    <h2>Contacts added per day</h2>
    <div class="note">Successful adds logged by the three workflows. Log starts July 10, 2026
      (July 9 backfilled from the no-show migration run); earlier days show zero, not "no adds".</div>
    <div class="legend" id="leg-adds"></div>
    <div id="chart-adds"></div>
    <details><summary>Data table</summary><div id="table-adds"></div></details>
  </div>

  <div class="card">
    <h2>Calls made per day</h2>
    <div class="note">SalesDialer calls per campaign</div>
    <div class="legend" id="leg-calls"></div>
    <div id="chart-calls"></div>
    <details><summary>Data table</summary><div id="table-calls"></div></details>
  </div>

  <div class="card">
    <h2>Call outcomes per day</h2>
    <div class="note">All three campaigns combined — darker is better</div>
    <div class="legend" id="leg-out"></div>
    <div id="chart-out"></div>
    <details><summary>Data table</summary><div id="table-out"></div></details>
  </div>

  <div class="card">
    <h2>Dispositions (${payload.days}-day range)</h2>
    <div class="note">Top call dispositions per campaign, from JustCall</div>
    <div class="disp-grid" id="disps"></div>
  </div>
</div>
<div id="tip" role="status"></div>
<script>
const DATA = ${JSON.stringify(payload)};

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const CAMP_COLORS = ['--c1', '--c2', '--c3'];
const OUT_SERIES = [
  { key: 'connected', name: 'Connected', color: '--o1' },
  { key: 'voicemail', name: 'Voicemail', color: '--o2' },
  { key: 'noanswer',  name: 'No answer / other', color: '--o3' },
];

document.getElementById('gen').textContent = new Date(DATA.generatedAt).toLocaleString();

// KPI row
const k = DATA.kpis;
function tile(label, value, delta, deltaLabel) {
  const div = document.createElement('div');
  div.className = 'tile';
  const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'value'; v.textContent = value;
  div.append(l, v);
  if (delta !== null) {
    const d = document.createElement('div');
    d.className = 'delta' + (delta > 0 ? ' up' : '');
    d.textContent = (delta >= 0 ? '+' : '') + delta + ' ' + deltaLabel;
    div.append(d);
  }
  return div;
}
const kpis = document.getElementById('kpis');
kpis.append(
  tile('Contacts added today', k.addsToday, k.addsToday - k.addsYesterday, 'vs yesterday'),
  tile('Calls today', k.callsToday, k.callsToday - k.callsYesterday, 'vs yesterday'),
  tile('Connected today', k.connectedToday, k.connectedToday - k.connectedYesterday, 'vs yesterday'),
  tile('Connect rate (' + DATA.days + 'd)', k.connectRate + '%', null, '')
);

// ── Stacked column chart ─────────────────────────────────────────────────────
const tip = document.getElementById('tip');
function showTip(evt, date, rows) {
  tip.replaceChildren();
  const d = document.createElement('div'); d.className = 't-date';
  d.textContent = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  tip.append(d);
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 't-row';
    const key = document.createElement('span'); key.className = 't-key'; key.style.background = r.color;
    const val = document.createElement('span'); val.className = 't-val'; val.textContent = r.value;
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

function stackedChart(elId, series, valueAt) {
  const el = document.getElementById(elId);
  const dates = DATA.dates;
  const W = 1000, plotH = 220, padL = 44, padR = 8, padT = 8, axisH = 26;
  const H = plotH + padT + axisH;
  const n = dates.length;
  const band = (W - padL - padR) / n;
  const barW = Math.min(24, band * 0.6);

  const totals = dates.map(d => series.reduce((a, s) => a + valueAt(d, s), 0));
  const { max: maxV, divs } = niceScale(Math.max(1, ...totals));
  const yOf = v => padT + plotH - (v / maxV) * plotH;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('role', 'img');

  // gridlines + y ticks (4 divisions, clean numbers)
  for (let i = 0; i <= divs; i++) {
    const v = (maxV / divs) * i, y = yOf(v);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', i === 0 ? 'baseline' : 'gridline');
    svg.append(line);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', padL - 6); t.setAttribute('y', y + 3.5);
    t.setAttribute('text-anchor', 'end'); t.setAttribute('class', 'tick');
    t.textContent = v.toLocaleString();
    svg.append(t);
  }

  const surface = css('--surface-1');
  dates.forEach((date, di) => {
    const cx = padL + band * di + band / 2;
    const total = totals[di];
    const x = cx - barW / 2;

    // x labels — thin to ~10
    const every = Math.ceil(n / 10);
    if (di % every === 0) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', cx); t.setAttribute('y', padT + plotH + 16);
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'tick');
      t.textContent = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      svg.append(t);
    }

    if (total > 0) {
      // rounded data-end via clip on the whole stack
      const clipId = elId + '-clip-' + di;
      const clip = document.createElementNS(NS, 'clipPath');
      clip.setAttribute('id', clipId);
      const cr = document.createElementNS(NS, 'rect');
      const topY = yOf(total);
      cr.setAttribute('x', x); cr.setAttribute('y', topY);
      cr.setAttribute('width', barW); cr.setAttribute('height', padT + plotH - topY);
      cr.setAttribute('rx', 4);
      clip.append(cr); svg.append(clip);
      // square the baseline corners (rx rounds all four)
      const sq = document.createElementNS(NS, 'rect');
      sq.setAttribute('x', x); sq.setAttribute('y', Math.max(topY, padT + plotH - 5));
      sq.setAttribute('width', barW); sq.setAttribute('height', 5);
      clip.append(sq);

      let acc = 0;
      series.forEach((s, si) => {
        const v = valueAt(date, s);
        if (!v) return;
        const r = document.createElementNS(NS, 'rect');
        const y0 = yOf(acc + v), y1 = yOf(acc);
        r.setAttribute('x', x);
        r.setAttribute('y', y0 + (si > 0 ? 1 : 0)); // 2px surface gap between segments
        r.setAttribute('width', barW);
        r.setAttribute('height', Math.max(0.5, y1 - y0 - (si > 0 ? 2 : 0) / 2 - 1));
        r.setAttribute('fill', css(s.color));
        r.setAttribute('clip-path', 'url(#' + clipId + ')');
        svg.append(r);
        acc += v;
      });
    }

    // hit target: whole band
    const hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', padL + band * di); hit.setAttribute('y', padT);
    hit.setAttribute('width', band); hit.setAttribute('height', plotH);
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('tabindex', '0');
    const rows = () => series.map(s => ({ name: s.name, value: valueAt(date, s), color: css(s.color) }));
    hit.addEventListener('pointermove', e => showTip(e, date, rows()));
    hit.addEventListener('pointerleave', hideTip);
    hit.addEventListener('focus', e => {
      const b = hit.getBoundingClientRect();
      showTip({ clientX: b.x + b.width / 2, clientY: b.y + 30 }, date, rows());
    });
    hit.addEventListener('blur', hideTip);
    svg.append(hit);
  });

  el.append(svg);
}

function legend(elId, series) {
  const el = document.getElementById(elId);
  for (const s of series) {
    const span = document.createElement('span');
    const i = document.createElement('i'); i.style.background = css(s.color);
    span.append(i, document.createTextNode(s.name));
    el.append(span);
  }
}

function dataTable(elId, series, valueAt) {
  const el = document.getElementById(elId);
  const table = document.createElement('table');
  const tr = document.createElement('tr');
  tr.append(Object.assign(document.createElement('th'), { textContent: 'Date' }));
  for (const s of series) {
    const th = document.createElement('th'); th.className = 'num'; th.textContent = s.name; tr.append(th);
  }
  const thT = document.createElement('th'); thT.className = 'num'; thT.textContent = 'Total'; tr.append(thT);
  table.append(tr);
  for (const d of [...DATA.dates].reverse()) {
    const row = document.createElement('tr');
    row.append(Object.assign(document.createElement('td'), { textContent: d }));
    let tot = 0;
    for (const s of series) {
      const v = valueAt(d, s); tot += v;
      const td = document.createElement('td'); td.className = 'num'; td.textContent = v; row.append(td);
    }
    const tdT = document.createElement('td'); tdT.className = 'num'; tdT.textContent = tot; row.append(tdT);
    table.append(row);
  }
  el.append(table);
}

const campSeries = DATA.campaigns.map((c, i) => ({ ...c, color: CAMP_COLORS[i] }));
const addsAt  = (d, s) => (DATA.adds[d]  || {})[s.id] || 0;
const callsAt = (d, s) => (DATA.calls[d] || {})[s.id] || 0;
const outAt   = (d, s) => (DATA.outcomes[d] || {})[s.key] || 0;

legend('leg-adds', campSeries);  stackedChart('chart-adds', campSeries, addsAt);   dataTable('table-adds', campSeries, addsAt);
legend('leg-calls', campSeries); stackedChart('chart-calls', campSeries, callsAt); dataTable('table-calls', campSeries, callsAt);
legend('leg-out', OUT_SERIES);   stackedChart('chart-out', OUT_SERIES, outAt);     dataTable('table-out', OUT_SERIES, outAt);

// Workflow summary tables (occurred / added / calls / unique called per period)
const sumEl = document.getElementById('summary');
for (const c of DATA.campaigns) {
  const rows = (DATA.summary.byCampaign || {})[c.id] || [];
  const box = document.createElement('div');
  const h = document.createElement('div');
  h.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:2px';
  h.textContent = c.name;
  box.append(h);
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const t of ['Period', 'Occurred', 'Added', 'Calls', 'Contacts called']) {
    const th = document.createElement('th');
    if (t !== 'Period') th.className = 'num';
    th.textContent = t; head.append(th);
  }
  table.append(head);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('td'), { textContent: r.label }));
    for (const v of [r.occurred, r.added, r.calls, r.uniqueCalled]) {
      const td = document.createElement('td'); td.className = 'num';
      td.textContent = v.toLocaleString(); tr.append(td);
    }
    table.append(tr);
  }
  box.append(table);
  // Month-on-month line
  const tm = rows.find(r => r.key === 'thisMonth'), lm = rows.find(r => r.key === 'lastMonth');
  if (tm && lm) {
    const mom = document.createElement('div');
    mom.style.cssText = 'font-size:12px;margin-top:6px';
    mom.className = 'note';
    const pct = (a, b) => b ? Math.round(((a - b) / b) * 100) + '%' : (a ? 'n/a' : '0%');
    mom.textContent = 'MoM (MTD vs full last month): occurred ' + tm.occurred + ' vs ' + lm.occurred +
      ' (' + pct(tm.occurred, lm.occurred) + '), calls ' + tm.calls + ' vs ' + lm.calls +
      ' (' + pct(tm.calls, lm.calls) + ')';
    box.append(mom);
  }
  sumEl.append(box);
}

// Dispositions tables
const dispEl = document.getElementById('disps');
for (const c of DATA.campaigns) {
  const box = document.createElement('div');
  const h = document.createElement('div');
  h.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:2px';
  h.textContent = c.name;
  box.append(h);
  const list = DATA.dispositions[c.name] || [];
  const table = document.createElement('table');
  const tr = document.createElement('tr');
  tr.append(Object.assign(document.createElement('th'), { textContent: 'Disposition' }));
  const th = document.createElement('th'); th.className = 'num'; th.textContent = 'Calls'; tr.append(th);
  table.append(tr);
  if (!list.length) {
    const r = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 2; td.textContent = 'No calls in range';
    td.style.color = 'var(--ink-3)';
    r.append(td); table.append(r);
  }
  for (const [name, count] of list) {
    const r = document.createElement('tr');
    r.append(Object.assign(document.createElement('td'), { textContent: name }));
    const td = document.createElement('td'); td.className = 'num'; td.textContent = count.toLocaleString();
    r.append(td); table.append(r);
  }
  box.append(table);
  dispEl.append(box);
}
</script>
</body>
</html>`;
}

// Warm the cache at boot so the first visitor doesn't wait for the full fetch.
setTimeout(() => getRaw().catch(e => console.warn(`[dashboard] warmup failed: ${e.message}`)), 5000);

async function dashboardHandler(req, res) {
  try {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const payload = await getPayload(days);
    res.set('Content-Type', 'text/html; charset=utf-8').send(page(payload));
  } catch (err) {
    console.error(`[dashboard] ${err.stack || err.message}`);
    res.status(500).send('dashboard error: ' + err.message);
  }
}

module.exports = { dashboardHandler };
