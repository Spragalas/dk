#!/usr/bin/env python3
"""Fetch daily fuel prices from ena.lt and produce JSON files."""

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import openpyxl
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"
DOCS_DATA = ROOT / "docs" / "data"

VILNIUS_TZ = ZoneInfo("Europe/Vilnius")

EXPECTED_HEADERS = [
    "Data",
    "Įmonė (Degalinių tinklas)",
    "Degalinės vieta (Savivaldybė)",
    "Degalinės vieta (Gyvenvietė, gatvė)",
    "95 benzinas",
    "Dyzelinas",
    "SND",
]


def build_url(date: datetime) -> str:
    year = date.year
    date_str = date.strftime("%Y-%m-%d")
    return (
        f"https://www.ena.lt/uploads/{year}-EDAC/"
        f"dk-degalinese-{year}/dk-{date_str}.xlsx"
    )


def make_station_id(municipality: str, address: str) -> str:
    """Deterministic ID from municipality + address."""
    raw = f"{municipality}|{address}".lower()
    # Simple slug: replace non-alnum with dashes
    slug = ""
    for ch in raw:
        if ch.isalnum() or ch in "-|":
            slug += ch
        else:
            slug += "-"
    # collapse multiple dashes
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")


def parse_price(value) -> float | None:
    if isinstance(value, (int, float)):
        return round(float(value), 3)
    return None


def parse_excel(path: str) -> list[dict]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Degalų kainos"]

    # Validate headers at row 8
    headers = [cell.value for cell in list(ws.iter_rows(min_row=8, max_row=8))[0]][:7]
    for i, expected in enumerate(EXPECTED_HEADERS):
        actual = headers[i]
        if actual != expected:
            print(f"WARNING: Column {i} header mismatch: expected '{expected}', got '{actual}'")

    stations = []
    for row in ws.iter_rows(min_row=9, values_only=True):
        # Stop at summary/empty rows
        if row[1] is None:
            break

        date_val = row[0]
        company = row[1]
        municipality = row[2]
        address = row[3]
        p95 = parse_price(row[4])
        diesel = parse_price(row[5])
        lpg = parse_price(row[6])

        station_id = make_station_id(str(municipality), str(address))

        stations.append({
            "id": station_id,
            "company": company,
            "municipality": municipality,
            "address": address,
            "prices": {
                "petrol95": p95,
                "diesel": diesel,
                "lpg": lpg,
            },
        })

    wb.close()
    return stations


def compute_price_changes(today: list[dict], yesterday_path: Path) -> dict:
    """Return {station_id: {petrol95: delta, diesel: delta, lpg: delta}}."""
    if not yesterday_path.exists():
        return {}

    with open(yesterday_path) as f:
        prev_data = json.load(f)

    prev_map = {s["id"]: s["prices"] for s in prev_data["stations"]}
    changes = {}

    for station in today:
        sid = station["id"]
        prev_prices = prev_map.get(sid)
        if not prev_prices:
            continue
        delta = {}
        for fuel in ("petrol95", "diesel", "lpg"):
            cur = station["prices"].get(fuel)
            prev = prev_prices.get(fuel)
            if cur is not None and prev is not None:
                delta[fuel] = round(cur - prev, 3)
            else:
                delta[fuel] = None
        changes[sid] = delta

    return changes


def compute_averages(stations: list[dict]) -> dict:
    sums = {"petrol95": 0, "diesel": 0, "lpg": 0}
    counts = {"petrol95": 0, "diesel": 0, "lpg": 0}
    for s in stations:
        for fuel in sums:
            p = s["prices"].get(fuel)
            if p is not None:
                sums[fuel] += p
                counts[fuel] += 1
    return {
        fuel: round(sums[fuel] / counts[fuel], 3) if counts[fuel] > 0 else None
        for fuel in sums
    }


def add_price_changes(stations: list[dict], changes: dict) -> list[dict]:
    """Add price change data to stations."""
    result = []
    for s in stations:
        entry = dict(s)
        entry["priceChange"] = changes.get(s["id"])
        result.append(entry)
    return result


def update_history_index():
    """Rebuild docs/data/history-index.json from data/history/ files."""
    dates = sorted([
        f.stem for f in HISTORY_DIR.glob("*.json")
    ])
    with open(DOCS_DATA / "history-index.json", "w") as f:
        json.dump(dates, f)


def main():
    # Usage: fetch_prices.py [DATE] [--file PATH]
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("date", nargs="?", help="Target date YYYY-MM-DD")
    parser.add_argument("--file", help="Path to local Excel file (skip download)")
    args = parser.parse_args()

    if args.date:
        target_date = datetime.strptime(args.date, "%Y-%m-%d")
    else:
        target_date = datetime.now(VILNIUS_TZ)

    date_str = target_date.strftime("%Y-%m-%d")
    history_file = HISTORY_DIR / f"{date_str}.json"

    # Idempotent: skip if already fetched
    if history_file.exists():
        print(f"Data for {date_str} already exists, skipping fetch.")
        # Still regenerate stations.json in case geocache was updated
    else:
        if args.file:
            # Use provided local file
            xlsx_path = args.file
            print(f"Using local file: {xlsx_path}")
            stations = parse_excel(xlsx_path)
        else:
            # Try download from ena.lt first, fall back to SharePoint via Playwright
            url = build_url(target_date)
            print(f"Downloading {url} ...")
            try:
                resp = requests.get(url, timeout=30, allow_redirects=True)
                if resp.status_code == 200:
                    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
                        tmp.write(resp.content)
                        xlsx_path = tmp.name
                    stations = parse_excel(xlsx_path)
                    os.unlink(xlsx_path)
                else:
                    raise requests.HTTPError(f"Status {resp.status_code}")
            except (requests.HTTPError, requests.RequestException) as e:
                print(f"Direct download failed ({e}), trying SharePoint...")
                from download_sharepoint import get_sharepoint_link, download_from_sharepoint
                sp_url, sp_date = get_sharepoint_link(date_str)
                if sp_date != date_str:
                    print(f"SharePoint has {sp_date} but need {date_str} — data not published yet, skipping")
                    sys.exit(0)
                dl_dir = DATA_DIR / "downloads"
                dl_dir.mkdir(parents=True, exist_ok=True)
                xlsx_path = str(dl_dir / f"dk-{date_str}.xlsx")
                download_from_sharepoint(sp_url, Path(xlsx_path))
                stations = parse_excel(xlsx_path)

        print(f"Parsed {len(stations)} stations")

        # Save history
        history_data = {
            "date": date_str,
            "stations": stations,
        }
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        with open(history_file, "w", encoding="utf-8") as f:
            json.dump(history_data, f, ensure_ascii=False, indent=2)
        print(f"Saved {history_file}")

    # Load today's data
    with open(history_file, encoding="utf-8") as f:
        today_data = json.load(f)

    stations = today_data["stations"]

    # Find previous day's file for price changes
    prev_date = target_date - timedelta(days=1)
    # Search backwards up to 7 days for most recent previous data
    changes = {}
    for i in range(1, 8):
        check_date = target_date - timedelta(days=i)
        prev_file = HISTORY_DIR / f"{check_date.strftime('%Y-%m-%d')}.json"
        if prev_file.exists():
            changes = compute_price_changes(stations, prev_file)
            print(f"Computed price changes vs {check_date.strftime('%Y-%m-%d')}")
            break

    # Add price changes
    enriched = add_price_changes(stations, changes)
    averages = compute_averages(stations)

    frontend_data = {
        "date": date_str,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "averages": averages,
        "stations": enriched,
    }

    # Write latest.json and docs/data/stations.json
    with open(DATA_DIR / "latest.json", "w", encoding="utf-8") as f:
        json.dump(frontend_data, f, ensure_ascii=False, indent=2)

    DOCS_DATA.mkdir(parents=True, exist_ok=True)
    with open(DOCS_DATA / "stations.json", "w", encoding="utf-8") as f:
        json.dump(frontend_data, f, ensure_ascii=False, indent=2)

    print(f"Updated stations.json with {len(enriched)} stations")

    # Copy geocache to docs for frontend access
    geocache_path = DATA_DIR / "geocache.json"
    if geocache_path.exists():
        shutil.copy2(geocache_path, DOCS_DATA / "geocache.json")

    # Copy history files to docs for frontend access
    docs_history = DOCS_DATA / "history"
    docs_history.mkdir(parents=True, exist_ok=True)
    for src in HISTORY_DIR.glob("*.json"):
        shutil.copy2(src, docs_history / src.name)

    # Update history index
    update_history_index()
    print("Updated history-index.json")


if __name__ == "__main__":
    main()
