import json
import os
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

warnings.filterwarnings("ignore")

import psycopg2
import requests
from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build

load_dotenv(Path(__file__).parent / ".env")

# ── Config ────────────────────────────────────────────────────────────────────
CREDS_FILE   = Path(__file__).parent / "credentials.json"
SHEET_ID     = "1tILspL_RlrXvikmaGfdXYL3qPP_2-v3hnPDDe1B_2vg"
SHEET_TAB    = "Sheet1"
STATE_FILE   = Path(__file__).parent / ".trigger_state.json"
POLL_SECONDS = 60  # check every 60 seconds

HEADERS = [
    "Email ID", "Website URL", "Q1 leads", "Q2 leads",
    "Q3 leads", "Q4 leads", "ACV", "Timestamp",
    "Key", "CTA clicked", "Call booked", "Industry", "Business Niche",
]

# ── Google Sheets client ───────────────────────────────────────────────────────
def get_sheet_service():
    creds = service_account.Credentials.from_service_account_file(
        str(CREDS_FILE),
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
    )
    return build("sheets", "v4", credentials=creds)


def fetch_rows(service):
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range=SHEET_TAB)
        .execute()
    )
    rows = result.get("values", [])
    if not rows:
        return []
    # skip header row, convert each row to dict
    return [
        dict(zip(HEADERS, row + [""] * (len(HEADERS) - len(row))))
        for row in rows[1:]
    ]


# ── State helpers ──────────────────────────────────────────────────────────────
# The container filesystem is wiped on every deploy, so the local state file is
# only a cache. The durable copy lives in the dashboard spreadsheet (tab
# "LE State", cell B2) — without it, every deploy skipped all rows that arrived
# since the previous run.
STATE_TAB = "LE State"


def _state_sheet_service():
    creds = service_account.Credentials.from_service_account_file(
        str(CREDS_FILE),
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds)


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    sheet_id = os.environ.get("GOOGLE_SHEETS_ID")
    if sheet_id:
        try:
            svc = _state_sheet_service()
            result = svc.spreadsheets().values().get(
                spreadsheetId=sheet_id, range=f"'{STATE_TAB}'!A2:B2"
            ).execute()
            row = (result.get("values") or [[]])[0]
            if len(row) >= 2 and str(row[1]).isdigit():
                print(f"[state] restored from sheet: last_seen_count={row[1]}")
                state = {"last_seen_count": int(row[1]), "last_run": row[0]}
                STATE_FILE.write_text(json.dumps(state, indent=2))  # cache for the 60s loop
                return state
        except Exception as e:
            print(f"[state] sheet read failed ({e}) — will bootstrap")
    # No state anywhere (true first run): last_seen_count=None makes the main
    # loop bootstrap from the current sheet size instead of re-processing history.
    return {"last_seen_count": None, "last_run": None}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))
    sheet_id = os.environ.get("GOOGLE_SHEETS_ID")
    if not sheet_id:
        return
    try:
        svc = _state_sheet_service()
        try:
            svc.spreadsheets().values().update(
                spreadsheetId=sheet_id,
                range=f"'{STATE_TAB}'!A1:B2",
                valueInputOption="RAW",
                body={"values": [
                    ["last_run", "last_seen_count"],
                    [state["last_run"] or "", state["last_seen_count"]],
                ]},
            ).execute()
        except Exception as e:
            if "Unable to parse range" not in str(e):
                raise
            svc.spreadsheets().batchUpdate(
                spreadsheetId=sheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": STATE_TAB}}}]},
            ).execute()
            save_state(state)
    except Exception as e:
        print(f"[state] sheet write failed: {e}")


# ── Postgres helpers ───────────────────────────────────────────────────────────
def get_db_conn():
    return psycopg2.connect(
        host=os.environ["DB_HOST"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        dbname=os.environ["DB_NAME"],
        port=int(os.environ.get("DB_PORT", 5432)),
        sslmode="require",
    )


def normalize_domain(url: str) -> str:
    """Strip scheme/www/path so 'https://www.acme.com/foo' → 'acme.com'."""
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    host = urlparse(url).hostname or ""
    return host.removeprefix("www.")


def already_booked(email: str, website_url: str) -> bool:
    """Return True if this contact already has a booking in gtm_inbound_demo_bookings."""
    domain = normalize_domain(website_url)
    query = """
        SELECT 1
        FROM gist.gtm_inbound_demo_bookings
        WHERE LOWER(TRIM(prospect_email)) = %s
           OR (prospect_website IS NOT NULL AND prospect_website ILIKE %s)
        LIMIT 1
    """
    try:
        with get_db_conn() as conn, conn.cursor() as cur:
            cur.execute(query, (email, f"%{domain}%"))
            return cur.fetchone() is not None
    except Exception as e:
        print(f"[DB ERROR] {e}")
        return False  # fail open — don't block the row if DB is unreachable


# ── Filters ───────────────────────────────────────────────────────────────────
SKIP_DOMAINS = {"gushwork.ai"}
SKIP_PREFIXES = ("test", "demo", "noreply", "no-reply", "info+test", "hello+test")
FREE_EMAIL_DOMAINS = {
    "gmail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com",
    "outlook.com", "live.com", "icloud.com", "me.com", "mac.com",
    "aol.com", "protonmail.com", "proton.me", "zoho.com", "yandex.com",
    "mail.com", "gmx.com", "gmx.net", "rediffmail.com", "msn.com",
    "inbox.com", "fastmail.com", "hey.com", "pm.me",
}

def is_junk_email(email: str) -> bool:
    email = email.strip().lower()
    if not email or "@" not in email:
        return True
    local, domain = email.rsplit("@", 1)
    if domain in SKIP_DOMAINS:
        return True
    if any(local.startswith(p) for p in SKIP_PREFIXES):
        return True
    return False

def is_free_email(email: str) -> bool:
    email = email.strip().lower()
    if "@" not in email:
        return False
    domain = email.rsplit("@", 1)[1]
    return domain in FREE_EMAIL_DOMAINS


# ── Phone enrichment ──────────────────────────────────────────────────────────
def _apollo_headers() -> dict:
    return {"Content-Type": "application/json", "x-api-key": os.environ["APOLLO_API_KEY"]}

def _leadmagic_headers() -> dict:
    return {"X-API-Key": os.environ["LEADMAGIC_API_KEY"], "Content-Type": "application/json"}


# ── Location enrichment (LeadMagic email-validate) ────────────────────────────
def enrich_location(email: str) -> dict:
    """
    Validate email via LeadMagic — also returns company_location with city,
    state, country, street address, and postal code.
    Falls back to empty strings if not found.
    """
    try:
        resp = requests.post(
            "https://api.leadmagic.io/email-validate",
            headers=_leadmagic_headers(),
            json={"email": email},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        loc  = data.get("company_location") or {}
        return {
            "city":           loc.get("locality", ""),
            "state":          loc.get("region", ""),
            "country":        loc.get("country", ""),
            "street_address": loc.get("street_address", ""),
            "postal_code":    loc.get("postal_code", ""),
            "company_name":   data.get("company_name", ""),
            "company_size":   data.get("company_size", ""),
            "company_linkedin": data.get("company_linkedin_url", ""),
        }
    except Exception as e:
        print(f"  [LEADMAGIC LOC ERROR] {email}: {e}")
        return {"city": "", "state": "", "country": "", "street_address": "", "postal_code": ""}


# ── Phone enrichment (Apollo → FullEnrich bulk) ───────────────────────────────
FULLENRICH_URL    = "https://app.fullenrich.com/api/v1/contact/enrich/bulk"
FULLENRICH_POLL_S = 5    # seconds between polls
FULLENRICH_MAX_S  = 120  # give up after 2 minutes

def _fullenrich_headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['FULLENRICH_API_KEY']}", "Content-Type": "application/json"}


def enrich_phone(email: str, domain: str) -> str:
    """
    1. Apollo people/match  → first_name, last_name, linkedin_url
    2. FullEnrich bulk enrich (name + domain + linkedin) → poll → mobile phone
    """
    # Step 1: Apollo match — get name + LinkedIn URL
    first, last, linkedin_url = "", "", ""
    try:
        resp = requests.post(
            "https://api.apollo.io/api/v1/people/match",
            headers=_apollo_headers(),
            json={"email": email, "domain": domain},
            timeout=10,
        )
        resp.raise_for_status()
        person       = resp.json().get("person") or {}
        first        = person.get("first_name", "")
        last         = person.get("last_name", "")
        linkedin_url = person.get("linkedin_url", "")
    except Exception as e:
        print(f"  [APOLLO MATCH ERROR] {email}: {e}")

    if not first and not last:
        return ""
    if not last:
        last = first  # FullEnrich requires non-empty lastname

    # Step 2: FullEnrich bulk submit (include LinkedIn URL for higher hit rate)
    contact_data = {
        "firstname": first,
        "lastname":  last,
        "domain":    domain,
        "enrich_fields": ["contact.phones"],
        "custom": {"email": email},
    }
    if linkedin_url:
        contact_data["linkedin_profile_url"] = linkedin_url

    try:
        resp = requests.post(
            FULLENRICH_URL,
            headers=_fullenrich_headers(),
            json={"name": f"leor-{email}", "datas": [contact_data]},
            timeout=15,
        )
        resp.raise_for_status()
        enrichment_id = resp.json().get("enrichment_id") or resp.json().get("id")
    except Exception as e:
        print(f"  [FULLENRICH SUBMIT ERROR] {email}: {e}")
        return ""

    # Step 3: Poll until FINISHED
    deadline = time.time() + FULLENRICH_MAX_S
    while time.time() < deadline:
        time.sleep(FULLENRICH_POLL_S)
        try:
            r = requests.get(
                f"{FULLENRICH_URL}/{enrichment_id}",
                headers=_fullenrich_headers(),
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            if data.get("status") == "FINISHED":
                contact = (data.get("datas") or [{}])[0]
                phones  = contact.get("contact", {}).get("phones") or contact.get("phones") or []
                return phones[0].get("number", "") if phones else ""
            if data.get("status") == "FAILED":
                print(f"  [FULLENRICH] Batch failed for {email}")
                return ""
        except Exception as e:
            print(f"  [FULLENRICH POLL ERROR] {e}")
            return ""

    print(f"  [FULLENRICH] Timed out for {email}")
    return ""


# ── JustCall ──────────────────────────────────────────────────────────────────
def _justcall_headers() -> dict:
    return {
        "Authorization": f"{os.environ['JUSTCALL_API_KEY']}:{os.environ['JUSTCALL_API_SECRET']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def add_to_campaign(name: str, phone: str, email: str) -> bool:
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) == 10:
        e164 = f"+1{digits}"
    elif len(digits) == 11 and digits.startswith("1"):
        e164 = f"+{digits}"
    else:
        print(f"  [JUSTCALL] Non-US phone, skipping: {phone}")
        return False
    payload = {
        "campaign_id": os.environ["JUSTCALL_CAMPAIGN_ID"],
        "name": name,
        "phone_number": e164,
        "email": email,
    }
    try:
        resp = requests.post(
            "https://api.justcall.io/v2.1/sales_dialer/campaigns/contact",
            headers=_justcall_headers(),
            json=payload,
            timeout=10,
        )
        if resp.status_code == 400 and "already exists" in resp.text.lower():
            print(f"  [JUSTCALL] Already in campaign: {e164}")
            return False
        resp.raise_for_status()
        print(f"  [JUSTCALL] Added: {e164}")
        log_add(os.environ["JUSTCALL_CAMPAIGN_ID"], email, e164)
        return True
    except Exception as e:
        print(f"  [JUSTCALL ERROR] {e}")
        return False


def log_add(campaign_id: str, email: str, phone: str):
    """Append the add to the 'SDR Adds Log' tab of the dashboard sheet.
    Best-effort only — never raises into the add path."""
    try:
        sheet_id = os.environ.get("GOOGLE_SHEETS_ID")
        if not sheet_id:
            return
        creds = service_account.Credentials.from_service_account_file(
            str(CREDS_FILE),
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        svc = build("sheets", "v4", credentials=creds)
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range="SDR Adds Log!A:E",
            valueInputOption="RAW",
            body={"values": [[
                datetime.now(timezone.utc).isoformat(),
                str(campaign_id),
                "Lead Estimator",
                email or "",
                phone or "",
            ]]},
        ).execute()
    except Exception as e:
        print(f"  [ADDS-LOG WARN] {e}")


# ── Workflow ───────────────────────────────────────────────────────────────────
def process_row(row: dict):
    email   = row.get("Email ID", "").strip()
    website = row.get("Website URL", "").strip()

    if is_junk_email(email):
        print(f"[SKIP] Internal/test email — {email}")
        return

    if is_free_email(email):
        print(f"[SKIP] Free email — {email}")
        return

    if already_booked(email, website):
        print(f"[SKIP] Already booked — {email} | {website}")
        return

    domain   = normalize_domain(website)
    location = enrich_location(email)

    if location.get("country", "").lower() not in ("united states", "us", "usa"):
        print(f"[SKIP] Non-US location ({location.get('country') or 'unknown'}) — {email}")
        return

    phone = enrich_phone(email, domain)
    loc_str = ", ".join(filter(None, [location["city"], location["state"], location["country"]])) or "not found"
    name    = location.get("company_name") or email.split("@")[0]

    print(f"[PROCESS] {email} | {domain} | {loc_str} | phone: {phone or 'not found'}")

    if phone:
        add_to_campaign(name=name, phone=phone, email=email)
    else:
        print(f"  [SKIP CAMPAIGN] No phone found for {email}")


# ── Main loop ─────────────────────────────────────────────────────────────────
def run():
    service = get_sheet_service()
    print(f"[{datetime.now()}] Trigger started — polling every {POLL_SECONDS}s")

    while True:
        try:
            state = load_state()
            rows  = fetch_rows(service)
            current_count = len(rows)
            last_count    = state["last_seen_count"]

            if last_count is None:
                print(f"[{datetime.now()}] No state file — bootstrapping at {current_count} rows (history skipped)")
                state["last_seen_count"] = current_count
                state["last_run"] = datetime.now(timezone.utc).isoformat()
                save_state(state)
                last_count = current_count

            if current_count > last_count:
                new_rows = rows[last_count:]
                print(f"[{datetime.now()}] {len(new_rows)} new row(s) detected")
                for row in new_rows:
                    process_row(row)
                state["last_seen_count"] = current_count
                state["last_run"] = datetime.now(timezone.utc).isoformat()
                save_state(state)
            else:
                print(f"[{datetime.now()}] No new rows (total: {current_count})")

        except Exception as e:
            print(f"[ERROR] {e}")

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    run()
