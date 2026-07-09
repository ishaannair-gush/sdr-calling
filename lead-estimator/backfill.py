"""
backfill.py — one-time run to process all existing sheet rows through the
full eligibility + enrichment + JustCall pipeline.

Uses FullEnrich bulk API (batches of 50) for efficiency instead of
enriching contacts one-by-one.
"""

import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

warnings.filterwarnings("ignore")

import psycopg2
import requests
from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build

load_dotenv(Path(__file__).parent / ".env")

CREDS_FILE  = Path(__file__).parent / "credentials.json"
SHEET_ID    = "1tILspL_RlrXvikmaGfdXYL3qPP_2-v3hnPDDe1B_2vg"
SHEET_TAB   = "Sheet1"
HEADERS     = [
    "Email ID", "Website URL", "Q1 leads", "Q2 leads",
    "Q3 leads", "Q4 leads", "ACV", "Timestamp",
    "Key", "CTA clicked", "Call booked", "Industry", "Business Niche",
]
CAMPAIGN_ID     = os.environ["JUSTCALL_CAMPAIGN_ID"]
BATCH_SIZE      = 50
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S  = 300
FULLENRICH_URL  = "https://app.fullenrich.com/api/v1/contact/enrich/bulk"

FREE_EMAIL_DOMAINS = {
    "gmail.com","yahoo.com","yahoo.co.in","yahoo.co.uk","hotmail.com",
    "outlook.com","live.com","icloud.com","me.com","mac.com",
    "aol.com","protonmail.com","proton.me","zoho.com","yandex.com",
    "mail.com","gmx.com","gmx.net","rediffmail.com","msn.com",
    "inbox.com","fastmail.com","hey.com","pm.me",
}
SKIP_DOMAINS  = {"gushwork.ai"}
SKIP_PREFIXES = ("test","demo","noreply","no-reply","info+test","hello+test")

# ── Helpers ───────────────────────────────────────────────────────────────────
def norm(url):
    if not url: return ""
    if not url.startswith(("http://","https://")): url = "https://" + url
    return (urlparse(url).hostname or "").removeprefix("www.")

def is_junk(email):
    email = email.strip().lower()
    if not email or "@" not in email: return True
    local, domain = email.rsplit("@", 1)
    return domain in SKIP_DOMAINS or any(local.startswith(p) for p in SKIP_PREFIXES)

def is_free(email):
    email = email.strip().lower()
    return "@" in email and email.rsplit("@",1)[1] in FREE_EMAIL_DOMAINS

def get_db():
    return psycopg2.connect(
        host=os.environ["DB_HOST"], user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"], dbname=os.environ["DB_NAME"],
        port=5432, sslmode="require",
    )

def load_booked_sets():
    """Pull all booked emails + domains in one query."""
    try:
        with get_db() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT LOWER(TRIM(prospect_email)), prospect_website
                FROM gist.gtm_inbound_demo_bookings
                WHERE prospect_email IS NOT NULL
            """)
            booked_emails, booked_domains = set(), set()
            for email, website in cur.fetchall():
                if email: booked_emails.add(email)
                d = norm(website or "")
                if d: booked_domains.add(d)
            return booked_emails, booked_domains
    except Exception as e:
        print(f"[DB ERROR] {e}")
        return set(), set()

def name_from_email(email):
    local = email.split("@")[0]
    parts = local.replace(".", " ").replace("_", " ").replace("-", " ").split()
    first = parts[0].capitalize() if parts else "Unknown"
    last  = parts[1].capitalize() if len(parts) > 1 else first
    return first, last

def apollo_headers():
    return {"Content-Type": "application/json", "x-api-key": os.environ["APOLLO_API_KEY"]}

def jc_headers():
    return {
        "Authorization": f"{os.environ['JUSTCALL_API_KEY']}:{os.environ['JUSTCALL_API_SECRET']}",
        "Content-Type": "application/json", "Accept": "application/json",
    }

def apollo_match(email, domain):
    """Return (first, last, linkedin_url) from Apollo, or fall back to email parsing."""
    try:
        r = requests.post(
            "https://api.apollo.io/api/v1/people/match",
            headers=apollo_headers(),
            json={"email": email, "domain": domain},
            timeout=10,
        )
        r.raise_for_status()
        person = r.json().get("person") or {}
        first  = person.get("first_name") or ""
        last   = person.get("last_name") or ""
        li     = person.get("linkedin_url") or ""
        if first or last:
            last = last or first
            return first, last, li
    except Exception:
        pass
    first, last = name_from_email(email)
    return first, last, ""

def fe_headers():
    return {"Authorization": f"Bearer {os.environ['FULLENRICH_API_KEY']}", "Content-Type": "application/json"}

def lm_headers():
    return {"X-API-Key": os.environ["LEADMAGIC_API_KEY"], "Content-Type": "application/json"}

def get_country(email):
    try:
        r = requests.post("https://api.leadmagic.io/email-validate",
            headers=lm_headers(), json={"email": email}, timeout=20)
        r.raise_for_status()
        d = r.json()
        loc = d.get("company_location") or {}
        return loc.get("country", "")
    except:
        return ""

def is_us(country) -> bool:
    return (country or "").lower() in ("united states", "us", "usa")

def add_to_campaign(name, phone, email):
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) == 10:
        e164 = f"+1{digits}"
    elif len(digits) == 11 and digits.startswith("1"):
        e164 = f"+{digits}"
    else:
        print(f"    [SKIP] Non-US phone: {phone}")
        return False
    try:
        r = requests.post(
            "https://api.justcall.io/v2.1/sales_dialer/campaigns/contact",
            headers=jc_headers(),
            json={"campaign_id": CAMPAIGN_ID, "name": name, "phone_number": e164, "email": email},
            timeout=10,
        )
        if r.status_code == 400 and "already exists" in r.text.lower():
            return "dup"
        r.raise_for_status()
        return True
    except Exception as e:
        print(f"    [JC ERROR] {email}: {e}")
        return False

# ── Fetch sheet ───────────────────────────────────────────────────────────────
print("Fetching sheet...")
creds = service_account.Credentials.from_service_account_file(
    str(CREDS_FILE), scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
raw = build("sheets","v4",credentials=creds).spreadsheets().values().get(
    spreadsheetId=SHEET_ID, range=SHEET_TAB).execute().get("values",[])[1:]
all_rows = [dict(zip(HEADERS, r + [""]*(len(HEADERS)-len(r)))) for r in raw]
print(f"Total rows: {len(all_rows)}")

# ── Load booked sets in one DB query ─────────────────────────────────────────
print("Loading booked contacts from DB...")
booked_emails, booked_domains = load_booked_sets()
print(f"Booked: {len(booked_emails)} emails, {len(booked_domains)} domains")

# ── Filter eligible ───────────────────────────────────────────────────────────
print("Filtering eligible contacts...")
eligible = []
for row in all_rows:
    email   = row.get("Email ID","").strip()
    website = row.get("Website URL","").strip()
    if is_junk(email): continue
    if is_free(email): continue
    if email.lower() in booked_emails: continue
    if norm(website) in booked_domains: continue
    eligible.append(row)

print(f"Eligible: {len(eligible)} / {len(all_rows)}")

# ── Location check — US only (parallel) ───────────────────────────────────────
print("Checking locations (US only, 10 threads)...")
us_contacts = []
non_us = 0
loc_errors = 0

def check_location(row):
    email = row["Email ID"].strip()
    country = get_country(email)
    return row, country

with ThreadPoolExecutor(max_workers=10) as pool:
    futures = {pool.submit(check_location, row): row for row in eligible}
    done = 0
    for future in as_completed(futures):
        done += 1
        row, country = future.result()
        email = row["Email ID"].strip()
        if is_us(country):
            us_contacts.append(row)
        elif country:
            non_us += 1
            print(f"  [NON-US] {email} → {country}")
        else:
            loc_errors += 1
            print(f"  [LOC UNKNOWN] {email} — skipping")
        if done % 50 == 0:
            print(f"  Progress: {done}/{len(eligible)} checked, {len(us_contacts)} US so far")

print(f"US contacts: {len(us_contacts)} | Non-US: {non_us} | Unknown: {loc_errors}\n")

# ── Batch enrich via FullEnrich ───────────────────────────────────────────────
batches = [us_contacts[i:i+BATCH_SIZE] for i in range(0, len(us_contacts), BATCH_SIZE)]
print(f"Submitting {len(batches)} batch(es) of up to {BATCH_SIZE}...\n")

stats = {"submitted": 0, "phone_found": 0, "added": 0, "dup": 0, "no_phone": 0, "error": 0}

for b_idx, batch in enumerate(batches):
    print(f"── Batch {b_idx+1}/{len(batches)} ({len(batch)} contacts) ──")

    datas = []
    for row in batch:
        email  = row["Email ID"].strip()
        domain = norm(row.get("Website URL",""))
        first, last, linkedin_url = apollo_match(email, domain)
        contact_data = {
            "firstname": first,
            "lastname":  last,
            "domain":    domain,
            "enrich_fields": ["contact.phones"],
            "custom": {"email": email, "website": row.get("Website URL","")},
        }
        if linkedin_url:
            contact_data["linkedin_profile_url"] = linkedin_url
        datas.append(contact_data)
        time.sleep(0.2)  # stay under Apollo rate limit

    try:
        r = requests.post(FULLENRICH_URL, headers=fe_headers(),
            json={"name": f"leor-backfill-batch-{b_idx+1}", "datas": datas}, timeout=20)
        if r.status_code == 400:
            print(f"  [FE BATCH 400] {r.text[:300]} — retrying one-by-one")
            # Retry each contact individually to skip bad records
            for single_data in datas:
                em = single_data.get("custom", {}).get("email", "?")
                try:
                    rs = requests.post(FULLENRICH_URL, headers=fe_headers(),
                        json={"name": f"leor-single-{em}", "datas": [single_data]}, timeout=15)
                    if rs.status_code == 400:
                        print(f"    [SKIP] Bad contact: {em}")
                        stats["error"] += 1
                        continue
                    rs.raise_for_status()
                    eid = rs.json().get("enrichment_id") or rs.json().get("id")
                    deadline2 = time.time() + POLL_TIMEOUT_S
                    while time.time() < deadline2:
                        time.sleep(POLL_INTERVAL_S)
                        pr = requests.get(f"{FULLENRICH_URL}/{eid}", headers=fe_headers(), timeout=10)
                        pr.raise_for_status()
                        pd = pr.json()
                        if pd.get("status") == "FINISHED":
                            contact_data = (pd.get("datas") or [{}])[0]
                            phones = contact_data.get("contact",{}).get("phones") or contact_data.get("phones") or []
                            phone = phones[0].get("number","") if phones else ""
                            first, last = name_from_email(em)
                            name = f"{first} {last}".strip()
                            stats["submitted"] += 1
                            if phone:
                                stats["phone_found"] += 1
                                result = add_to_campaign(name=name, phone=phone, email=em)
                                if result == "dup": stats["dup"] += 1
                                elif result: stats["added"] += 1; print(f"  [ADDED] {em} → {phone}")
                                else: stats["error"] += 1
                            else:
                                stats["no_phone"] += 1
                            break
                        if pd.get("status") == "FAILED":
                            stats["error"] += 1
                            break
                except Exception as ex:
                    print(f"    [SINGLE ERROR] {em}: {ex}")
                    stats["error"] += 1
            continue
        r.raise_for_status()
        enrichment_id = r.json().get("enrichment_id") or r.json().get("id")
        print(f"  Submitted → enrichment_id: {enrichment_id}")
    except Exception as e:
        print(f"  [FE SUBMIT ERROR] {e}")
        stats["error"] += len(batch)
        continue

    # Poll until done
    deadline = time.time() + POLL_TIMEOUT_S
    results  = None
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        try:
            pr = requests.get(f"{FULLENRICH_URL}/{enrichment_id}", headers=fe_headers(), timeout=10)
            pr.raise_for_status()
            pd = pr.json()
            status = pd.get("status")
            print(f"  status: {status}", end="\r")
            if status == "FINISHED":
                results = pd.get("datas") or []
                print(f"  status: FINISHED — {len(results)} results")
                break
            if status == "FAILED":
                print(f"  FAILED")
                break
        except Exception as e:
            print(f"  [POLL ERROR] {e}")
            break

    if not results:
        stats["error"] += len(batch)
        continue

    # Add contacts with phone to JustCall
    for contact_data in results:
        custom  = contact_data.get("custom") or {}
        email   = custom.get("email","")
        phones  = contact_data.get("contact",{}).get("phones") or contact_data.get("phones") or []
        phone   = phones[0].get("number","") if phones else ""
        first, last = name_from_email(email)
        name    = f"{first} {last}".strip() or email

        stats["submitted"] += 1
        if not phone:
            stats["no_phone"] += 1
            print(f"  [NO PHONE] {email}")
            continue

        stats["phone_found"] += 1
        result = add_to_campaign(name=name, phone=phone, email=email)
        if result == "dup":
            stats["dup"] += 1
            print(f"  [DUP]   {email} → {phone}")
        elif result:
            stats["added"] += 1
            print(f"  [ADDED] {email} → {phone}")
        else:
            stats["error"] += 1

    print()

# ── Summary ───────────────────────────────────────────────────────────────────
print("="*60)
print(f"Eligible contacts : {len(eligible)}")
print(f"US contacts       : {len(us_contacts)}")
print(f"Processed         : {stats['submitted']}")
print(f"Phone found       : {stats['phone_found']}")
print(f"Added to campaign : {stats['added']}")
print(f"Already in camp.  : {stats['dup']}")
print(f"No phone          : {stats['no_phone']}")
print(f"Errors            : {stats['error']}")
