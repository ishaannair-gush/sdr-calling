import importlib.util
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).parent
START_AT = datetime.fromisoformat("2026-06-25T06:01:27+00:00")
END_AT = datetime.fromisoformat("2026-07-07T00:00:00+00:00")
BATCH_SIZE = 50
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 300
FULLENRICH_URL = "https://app.fullenrich.com/api/v1/contact/enrich/bulk"

spec = importlib.util.spec_from_file_location("leor_trigger", ROOT / "trigger.py")
trigger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trigger)


def parse_ts(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    for value in (raw, raw.replace("Z", "+00:00")):
        try:
            dt = datetime.fromisoformat(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def name_from_email(email):
    local = email.split("@")[0]
    parts = local.replace(".", " ").replace("_", " ").replace("-", " ").split()
    first = parts[0].capitalize() if parts else "Unknown"
    last = parts[1].capitalize() if len(parts) > 1 else first
    return first, last


def apollo_match(email, domain):
    try:
        r = requests.post(
            "https://api.apollo.io/api/v1/people/match",
            headers=trigger._apollo_headers(),
            json={"email": email, "domain": domain},
            timeout=10,
        )
        r.raise_for_status()
        person = r.json().get("person") or {}
        first = person.get("first_name") or ""
        last = person.get("last_name") or ""
        linkedin_url = person.get("linkedin_url") or ""
        if first or last:
            return first, last or first, linkedin_url
    except Exception:
        pass
    first, last = name_from_email(email)
    return first, last, ""


def submit_batch(batch, batch_num):
    datas = []
    for row in batch:
        email = row["Email ID"].strip()
        domain = trigger.normalize_domain(row.get("Website URL", ""))
        first, last, linkedin_url = apollo_match(email, domain)
        contact_data = {
            "firstname": first,
            "lastname": last,
            "domain": domain,
            "enrich_fields": ["contact.phones"],
            "custom": {"email": email, "website": row.get("Website URL", "")},
        }
        if linkedin_url:
            contact_data["linkedin_profile_url"] = linkedin_url
        datas.append(contact_data)
        time.sleep(0.2)

    r = requests.post(
        FULLENRICH_URL,
        headers=trigger._fullenrich_headers(),
        json={"name": f"leor-july6-backfill-{batch_num}", "datas": datas},
        timeout=20,
    )
    r.raise_for_status()
    enrichment_id = r.json().get("enrichment_id") or r.json().get("id")
    return enrichment_id


def poll_batch(enrichment_id):
    deadline = time.time() + POLL_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        r = requests.get(
            f"{FULLENRICH_URL}/{enrichment_id}",
            headers=trigger._fullenrich_headers(),
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        status = data.get("status")
        if status == "FINISHED":
            return data.get("datas") or []
        if status == "FAILED":
            return []
    return []


def main():
    service = trigger.get_sheet_service()
    all_rows = trigger.fetch_rows(service)
    window_rows = []
    for row in all_rows:
        ts = parse_ts(row.get("Timestamp", ""))
        if ts and START_AT <= ts < END_AT:
            window_rows.append(row)

    print(f"Window rows: {len(window_rows)} / {len(all_rows)}")

    eligible = []
    for row in window_rows:
        email = row.get("Email ID", "").strip()
        website = row.get("Website URL", "").strip()
        if trigger.is_junk_email(email):
            continue
        if trigger.is_free_email(email):
            continue
        if trigger.already_booked(email, website):
            continue
        eligible.append(row)

    print(f"Eligible after junk/free/booked filters: {len(eligible)}")

    us_rows = []
    stats = {"non_us": 0, "loc_unknown": 0, "submitted": 0, "phone_found": 0, "added": 0, "dup": 0, "no_phone": 0, "error": 0}

    def check_location(row):
        email = row["Email ID"].strip()
        location = trigger.enrich_location(email)
        return row, location.get("country", "")

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(check_location, row) for row in eligible]
        for future in as_completed(futures):
            row, country = future.result()
            if (country or "").lower() in ("united states", "us", "usa"):
                us_rows.append(row)
            elif country:
                stats["non_us"] += 1
            else:
                stats["loc_unknown"] += 1

    print(f"US rows: {len(us_rows)} | non_us={stats['non_us']} | loc_unknown={stats['loc_unknown']}")

    batches = [us_rows[i:i + BATCH_SIZE] for i in range(0, len(us_rows), BATCH_SIZE)]
    for idx, batch in enumerate(batches, start=1):
        print(f"Batch {idx}/{len(batches)}: {len(batch)} contacts")
        try:
            enrichment_id = submit_batch(batch, idx)
            results = poll_batch(enrichment_id)
        except Exception as exc:
            print(f"[BATCH ERROR] {exc}")
            stats["error"] += len(batch)
            continue

        for contact_data in results:
            custom = contact_data.get("custom") or {}
            email = custom.get("email", "")
            phones = contact_data.get("contact", {}).get("phones") or contact_data.get("phones") or []
            phone = phones[0].get("number", "") if phones else ""
            first, last = name_from_email(email)
            name = f"{first} {last}".strip() or email

            stats["submitted"] += 1
            if not phone:
                stats["no_phone"] += 1
                print(f"[NO PHONE] {email}")
                continue

            stats["phone_found"] += 1
            result = trigger.add_to_campaign(name=name, phone=phone, email=email)
            if result:
                stats["added"] += 1
                print(f"[ADDED] {email} -> {phone}")
            else:
                stats["dup"] += 1
                print(f"[DUP/SKIP] {email} -> {phone}")
            time.sleep(0.3)

    print(f"SUMMARY {stats}")


if __name__ == "__main__":
    main()
