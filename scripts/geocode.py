#!/usr/bin/env python3
"""Geocode fuel station addresses using Nominatim (OSM).

Saves geocache.json incrementally after each successful lookup,
so progress is preserved if the script is interrupted.
Handles HTTP 429 (rate limit) with exponential backoff.
"""

import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DOCS_DATA = ROOT / "docs" / "data"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "lt-fuel-prices-map/1.0 (https://github.com)"
RATE_LIMIT_SECONDS = 5.0  # conservative to avoid 429s

MAX_RETRIES = 5
BACKOFF_BASE = 30  # seconds; doubles each retry


def save_geocache(geocache: dict, path: Path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(geocache, f, ensure_ascii=False, indent=2)


def nominatim_search(query: str, headers: dict) -> list | None:
    """Single Nominatim request with 429 retry logic."""
    params = {
        "format": "json",
        "limit": 1,
        "countrycodes": "lt",
        "q": query,
    }

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=10)

            if resp.status_code == 429:
                wait = BACKOFF_BASE * (2 ** attempt)
                print(f"  429 rate limited, waiting {wait}s (attempt {attempt + 1}/{MAX_RETRIES})")
                time.sleep(wait)
                continue

            resp.raise_for_status()
            return resp.json()

        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                wait = BACKOFF_BASE * (2 ** attempt)
                print(f"  429 rate limited, waiting {wait}s (attempt {attempt + 1}/{MAX_RETRIES})")
                time.sleep(wait)
                continue
            print(f"  HTTP error for '{query}': {e}")
            return None
        except Exception as e:
            print(f"  Error for '{query}': {e}")
            return None

    print(f"  Gave up after {MAX_RETRIES} retries for '{query}'")
    return None


def clean_for_nominatim(text: str) -> str:
    """Strip Lithuanian suffixes that confuse Nominatim (k., r. sav., m. sav., etc)."""
    import re
    # "Baisogalos k." -> "Baisogala" (approximate: just drop " k." suffix)
    text = re.sub(r"\s+k\.\s*,", ",", text)       # "Foo k., Bar" -> "Foo, Bar"
    text = re.sub(r"\s+k\.(\s*)$", r"\1", text)    # trailing " k."
    # "Radviliškio r. sav." -> "Radviliškis" — too complex for regex, just strip suffix
    text = re.sub(r"\s+[rm]\.\s*sav\.\s*$", "", text)
    text = re.sub(r"\s+sav\.\s*$", "", text)
    return text.strip()


def geocode_address(address: str, municipality: str) -> dict | None:
    """Try to geocode an address, return {lat, lng, display_name} or None."""
    headers = {"User-Agent": USER_AGENT}

    clean_addr = clean_for_nominatim(address)
    clean_muni = clean_for_nominatim(municipality)

    # Address field typically includes city (e.g. "Palijoniškio g. 1, Utena")
    # For village addresses like "Beržų g. 19, Baisogalos k." we clean the "k." suffix
    queries = [
        f"{clean_addr}, Lithuania",
        f"{clean_addr}, {clean_muni}, Lithuania",
        f"{clean_muni}, Lithuania",
    ]

    for query in queries:
        results = nominatim_search(query, headers)

        if results:
            r = results[0]
            return {
                "lat": float(r["lat"]),
                "lng": float(r["lon"]),
                "display_name": r.get("display_name", ""),
            }

        time.sleep(RATE_LIMIT_SECONDS)

    return None


def main():
    latest_path = DATA_DIR / "latest.json"
    if not latest_path.exists():
        print("No latest.json found. Run fetch_prices.py first.")
        return

    with open(latest_path, encoding="utf-8") as f:
        data = json.load(f)

    geocache_path = DATA_DIR / "geocache.json"
    geocache = {}
    if geocache_path.exists():
        with open(geocache_path, encoding="utf-8") as f:
            geocache = json.load(f)

    stations = data["stations"]
    to_geocode = [s for s in stations if s["id"] not in geocache]

    print(f"Total stations: {len(stations)}")
    print(f"Already cached: {len(stations) - len(to_geocode)}")
    print(f"Need geocoding: {len(to_geocode)}")

    failures = []
    newly_geocoded = 0

    for i, station in enumerate(to_geocode):
        sid = station["id"]
        addr = station["address"]
        muni = station["municipality"]
        print(f"[{i+1}/{len(to_geocode)}] Geocoding: {addr}, {muni}")

        result = geocode_address(addr, muni)

        if result:
            geocache[sid] = result
            newly_geocoded += 1
            print(f"  -> {result['lat']}, {result['lng']}")
            # Save incrementally so progress is never lost
            save_geocache(geocache, geocache_path)
        else:
            failures.append({"id": sid, "address": addr, "municipality": muni})
            print(f"  -> FAILED")

    print(f"\nNewly geocoded: {newly_geocoded}")
    print(f"Failed: {len(failures)}")
    print(f"Total cached: {len(geocache)}")

    # Save failures for manual review
    if failures:
        failures_path = DATA_DIR / "geocode-failures.json"
        with open(failures_path, "w", encoding="utf-8") as f:
            json.dump(failures, f, ensure_ascii=False, indent=2)
        print(f"Failures saved to {failures_path}")

    # Regenerate stations.json with updated coordinates
    for station in data["stations"]:
        geo = geocache.get(station["id"], {})
        station["lat"] = geo.get("lat")
        station["lng"] = geo.get("lng")

    DOCS_DATA.mkdir(parents=True, exist_ok=True)
    with open(DOCS_DATA / "stations.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print("Updated docs/data/stations.json with coordinates")


if __name__ == "__main__":
    main()
