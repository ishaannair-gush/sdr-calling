# SDR Calling — JustCall SalesDialer Workflows

One Railway service running the three workflows that add contacts to JustCall SalesDialer campaigns. `index.js` is the scheduler; `entrypoint.sh` materializes Google credentials from env and starts it.

| Workflow | Script | Campaign | Schedule |
|---|---|---|---|
| No Show | `no-show/sync-noshow-campaign.js --commit` | #3190746 (Meta_No_Show — Meta + Google Ads no-shows) | daily 7am ET |
| No Booking | `no-booking/sync-form-leads-campaign.js` | #3190752 (Meta_No_Booking) | daily |
| Lead Estimator | `lead-estimator/trigger.py` | #3309032 | long-running, polls sheet every 60s |

No Booking sources leads purely from Postgres: `gw_form_leads` (Meta-attributed form
fills) compared against `gist.gtm_inbound_demo_bookings` — anyone who filled a form
and never booked qualifies. It used to also pull from a `leadform` Google Sheet fed
by an external form-lead automation, but that automation stopped writing rows on
July 14, 2026; the sheet-based script (`sync-nurture-campaign.js`) was retired.

All hit `POST https://api.justcall.io/v2.1/sales_dialer/campaigns/contact`.

## History

Consolidated July 9, 2026 from:
- `meta-lead-pipeline` (Railway) — the three node scripts. The originals there are paused via a `PAUSE_SALESDIALER_ADDS` guard (set to `false` to re-enable them in the old service).
- `calcom-webhook` (Railway) — real-time Meta no-show adds, paused via its `PAUSE_SALES_DIALER=true` env var.
- `Documents/meta/leor/` — the Lead Estimator poller.

## Run locally

```bash
npm install
pip3 install -r lead-estimator/requirements.txt
cp .env.example .env   # fill in values
node index.js
```

Individual scripts run standalone too, e.g. `node no-show/sync-noshow-campaign.js` (dry-run without `--commit`).

## Deploy

Dockerfile-based (node 20 + python 3). Set the variables from `.env.example` on the Railway service; `GOOGLE_CREDENTIALS_JSON` / `GOOGLE_SERVICE_ACCOUNT_JSON` are the service-account JSON content (one line).

Notes:
- `lead-estimator/.trigger_state.json` lives on the container filesystem. On a fresh deploy it bootstraps from the current sheet row count (history is skipped), so rows submitted while the service is down are not picked up — run `lead-estimator/backfill.py` if that matters.
- Postgres credentials for the node scripts are hardcoded in the scripts themselves; the python poller reads `DB_*` env vars.
