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


def nominatim_search(query: str, headers: dict, structured: dict = None) -> list | None:
    """Single Nominatim request with 429 retry logic."""
    params = {
        "format": "json",
        "limit": 1,
        "countrycodes": "lt",
    }
    if structured:
        params.update(structured)
    else:
        params["q"] = query

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
    """Clean Lithuanian address suffixes for Nominatim.

    - "k." / "km." — stripped (village indicator). The village name is used as
      the city component in structured search to avoid street-name confusion.
    - "r. sav." / "m. sav." / "sav." — stripped from municipality names
    """
    import re
    text = re.sub(r"\s+k\.\s*,", ",", text)
    text = re.sub(r"\s+k\.(\s*)$", r"\1", text)
    text = re.sub(r"\s+km\.\s*,", ",", text)
    text = re.sub(r"\s+km\.(\s*)$", r"\1", text)
    # Strip municipality suffixes
    text = re.sub(r"\s+[rm]\.\s*sav\.\s*$", "", text)
    text = re.sub(r"\s+sav\.\s*$", "", text)
    return text.strip()


def parse_address_parts(address: str, municipality: str = "") -> tuple[str, str]:
    """Split address into (street, city) parts for structured Nominatim search.

    Handles formats like:
      "Palijoniškio g. 1, Utena" -> ("Palijoniškio g. 1", "Utena")
      "Vilnius, Kalvarijų g. 161A" -> ("Kalvarijų g. 161A", "Vilnius")
      "Veiverių k., Kauno g. 1" -> ("Kauno g. 1", "Veiverių")
      "Pietarių k. Kauno g. 164" -> ("Kauno g. 164", "Pietarių")
    """
    clean = clean_for_nominatim(address)
    clean_muni = clean_for_nominatim(municipality) if municipality else ""
    parts = [p.strip() for p in clean.split(",") if p.strip()]

    street_indicators = ["g.", "pr.", "pl.", "kelias", "kelio", "al."]

    if len(parts) >= 2:
        # Find which part is the street and which is the city/village
        street_parts = []
        city_parts = []
        for part in parts:
            if any(ind in part.lower() for ind in street_indicators):
                street_parts.append(part)
            else:
                city_parts.append(part)

        street = " ".join(street_parts) if street_parts else ""
        city = city_parts[0] if city_parts else ""

        # If we found a street but no city, use municipality
        if street and not city:
            city = clean_muni

        return street, city

    # Single part — might be just a village name or just a street
    if any(ind in clean.lower() for ind in street_indicators):
        return clean, clean_muni
    return "", clean


def geocode_address(address: str, municipality: str) -> dict | None:
    """Try to geocode an address, return {lat, lng, display_name} or None."""
    headers = {"User-Agent": USER_AGENT}

    clean_addr = clean_for_nominatim(address)
    clean_muni = clean_for_nominatim(municipality)
    street, city = parse_address_parts(address, municipality)

    VAGUE_TYPES = {"city", "town", "village", "county", "state", "administrative", "municipality"}

    def is_specific(result):
        rtype = result.get("type", "")
        rclass = result.get("class", "")
        return rtype not in VAGUE_TYPES and rclass != "boundary"

    # Strategy 1: Structured search (most reliable)
    if street and city:
        results = nominatim_search(None, headers, structured={
            "street": street,
            "city": city,
            "country": "Lithuania",
        })
        if results and is_specific(results[0]):
            r = results[0]
            return {
                "lat": float(r["lat"]),
                "lng": float(r["lon"]),
                "display_name": r.get("display_name", ""),
            }
        time.sleep(RATE_LIMIT_SECONDS)

    # Strategy 2: Free text with just the address
    results = nominatim_search(f"{clean_addr}, Lithuania", headers)
    if results and is_specific(results[0]):
        r = results[0]
        return {
            "lat": float(r["lat"]),
            "lng": float(r["lon"]),
            "display_name": r.get("display_name", ""),
        }
    time.sleep(RATE_LIMIT_SECONDS)

    # Strategy 3: Free text with municipality added
    results = nominatim_search(f"{clean_addr}, {clean_muni}, Lithuania", headers)
    if results and is_specific(results[0]):
        r = results[0]
        return {
            "lat": float(r["lat"]),
            "lng": float(r["lon"]),
            "display_name": r.get("display_name", ""),
        }
    time.sleep(RATE_LIMIT_SECONDS)

    # Last resort: municipality centroid
    results = nominatim_search(f"{clean_muni}, Lithuania", headers)
    if results:
        r = results[0]
        print(f"  Using municipality fallback: {r.get('display_name', '')[:60]}")
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
