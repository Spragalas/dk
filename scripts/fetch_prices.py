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


MINI_TREND_DAYS = 14


def attach_recent_prices(stations: list[dict], current_date: str) -> tuple[list[dict], list[str], dict]:
    """Embed last-N-days price history per station for popup sparklines.

    Reads the trailing MINI_TREND_DAYS history files (including `current_date`)
    and writes, per station, arrays aligned to a shared `recentDates` list.
    Missing days for a station become null. Returning enriched stations and
    the shared date list lets the frontend render a sparkline without any
    extra fetch.

    Also computes the Lithuania-wide average per fuel for each of those days
    so the popup sparkline can overlay a market-comparison line.
    """
    dates = sorted(f.stem for f in HISTORY_DIR.glob("*.json") if f.stem <= current_date)
    recent = dates[-MINI_TREND_DAYS:]
    if not recent:
        return stations, [], {fuel: [] for fuel in ("petrol95", "diesel", "lpg")}

    per_day: dict[str, list[dict]] = {}
    for d in recent:
        with open(HISTORY_DIR / f"{d}.json", encoding="utf-8") as f:
            hist = json.load(f)
        per_day[d] = hist["stations"]
    per_day_map = {d: {s["id"]: s["prices"] for s in per_day[d]} for d in recent}

    # Country-wide averages per fuel, aligned to `recent`.
    recent_averages = {fuel: [] for fuel in ("petrol95", "diesel", "lpg")}
    for d in recent:
        for fuel in recent_averages:
            vals = [s["prices"].get(fuel) for s in per_day[d] if s["prices"].get(fuel) is not None]
            recent_averages[fuel].append(round(sum(vals) / len(vals), 3) if vals else None)

    enriched = []
    for s in stations:
        sid = s["id"]
        recent_prices = {fuel: [] for fuel in ("petrol95", "diesel", "lpg")}
        for d in recent:
            day_prices = per_day_map[d].get(sid) or {}
            for fuel in recent_prices:
                recent_prices[fuel].append(day_prices.get(fuel))
        entry = dict(s)
        entry["recentPrices"] = recent_prices
        enriched.append(entry)
    return enriched, recent, recent_averages


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
                from download_sharepoint import get_sharepoint_links, download_from_sharepoint_any
                sp_urls, sp_date = get_sharepoint_links(date_str)
                if sp_date != date_str:
                    print(f"SharePoint has {sp_date} but need {date_str} — data not published yet, skipping")
                    sys.exit(0)
                dl_dir = DATA_DIR / "downloads"
                dl_dir.mkdir(parents=True, exist_ok=True)
                xlsx_path = str(dl_dir / f"dk-{date_str}.xlsx")
                download_from_sharepoint_any(sp_urls, Path(xlsx_path))
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
    enriched, recent_dates, recent_averages = attach_recent_prices(enriched, date_str)
    averages = compute_averages(stations)

    frontend_data = {
        "date": date_str,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "averages": averages,
        "recentDates": recent_dates,
        "recentAverages": recent_averages,
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

    # Rebuild all derived trend artifacts (overall/network/region/station).
    # build_trends reads data/history/*.json from scratch each run, so it
    # also self-heals if any of the jsonl files drifted.
    import build_trends
    build_trends.main()


if __name__ == "__main__":
    main()
