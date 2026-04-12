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


def genitive_to_nominative(name: str) -> list[str]:
    """Convert Lithuanian genitive village name to possible nominative forms.

    Village names in data are genitive (kilmininkas), but OSM/Nominatim uses
    nominative (vardininkas). Returns multiple candidates since Lithuanian
    declension is ambiguous.

    Examples:
      "Zujūnų" -> ["Zujūnai"]           (masc plural: -ų -> -ai)
      "Mastaičių" -> ["Mastaičiai"]      (masc plural: -ių -> -iai)
      "Giraitės" -> ["Giraitė"]          (fem singular: -ės -> -ė)
      "Bukiškio" -> ["Bukiškis"]         (masc singular: -io -> -is)
      "Slabados" -> ["Slabada"]          (fem singular: -os -> -a)
      "Gavaltuvos" -> ["Gavaltuvа"]      (fem singular: -os -> -a)
    """
    candidates = []

    # Handle multi-word names (e.g. "Didžiosios Riešės")
    # Apply conversion to the last word
    words = name.split()
    if len(words) > 1:
        last = words[-1]
        prefix_words = words[:-1]
        for form in genitive_to_nominative(last):
            # Also try converting prefix words
            candidates.append(f"{' '.join(prefix_words)} {form}")
        # Try converting each prefix word too
        for pw in prefix_words:
            for form in genitive_to_nominative(pw):
                candidates.append(f"{form} {last}")
        return candidates

    # Single word conversions (ordered by frequency for village names)
    if name.endswith("ių"):
        candidates.append(name[:-2] + "iai")   # Mastaičių -> Mastaičiai
    if name.endswith("ų"):
        candidates.append(name[:-1] + "ai")    # Zujūnų -> Zujūnai
        candidates.append(name[:-1] + "os")    # rare: -ų -> -os
    if name.endswith("ės"):
        candidates.append(name[:-2] + "ė")     # Giraitės -> Giraitė
    if name.endswith("io"):
        candidates.append(name[:-2] + "is")    # Bukiškio -> Bukiškis
    if name.endswith("os"):
        candidates.append(name[:-2] + "a")     # Slabados -> Slabada
        candidates.append(name[:-2] + "ė")     # Nausodės... no, this is -ės
    if name.endswith("aus"):
        candidates.append(name[:-3] + "us")    # rare: -aus -> -us
    if name.endswith("ens"):
        candidates.append(name[:-3] + "uo")    # rare

    # Always include the original genitive form as fallback
    if name not in candidates:
        candidates.append(name)

    return candidates


def extract_village_name(address: str) -> str | None:
    """Extract village/settlement name from address.

    Patterns:
      "Veiverių k., Kauno g. 1" -> "Veiverių"
      "Bukiškio k. Ukmergės g.437" -> "Bukiškio"
      "Mastaičių k." -> "Mastaičių"
      "Padustėlis, V. Striogos g. 4A" -> "Padustėlis"
      "Didžiosios Riešės k." -> "Didžiosios Riešės"
    """
    import re
    # Match "Name k." or "Name km." pattern
    m = re.search(r"([\w\s]+?)\s+k[m]?\.", address)
    if m:
        return m.group(1).strip()

    # Match "Name mstl." (miestelis = small town)
    m = re.search(r"([\w\s]+?)\s+mstl\.", address)
    if m:
        return m.group(1).strip()

    return None


def geocode_address(address: str, municipality: str, company: str = "") -> dict | None:
    """Try to geocode an address, return {lat, lng, display_name} or None.

    Returns dict with extra key "review": True if result is approximate.
    """
    headers = {"User-Agent": USER_AGENT}

    clean_addr = clean_for_nominatim(address)
    clean_muni = clean_for_nominatim(municipality)
    street, city = parse_address_parts(address, municipality)
    village = extract_village_name(address)

    VAGUE_TYPES = {"city", "town", "village", "county", "state", "administrative", "municipality"}

    def is_specific(result):
        rtype = result.get("type", "")
        rclass = result.get("class", "")
        return rtype not in VAGUE_TYPES and rclass != "boundary"

    def make_result(r, review=False):
        return {
            "lat": float(r["lat"]),
            "lng": float(r["lon"]),
            "display_name": r.get("display_name", ""),
            "review": review,
        }

    # Strategy 1: Structured search (street + city)
    if street and city:
        results = nominatim_search(None, headers, structured={
            "street": street,
            "city": city,
            "country": "Lithuania",
        })
        if results and is_specific(results[0]):
            return make_result(results[0])
        time.sleep(RATE_LIMIT_SECONDS)

    # Strategy 2: Free text with just the address
    results = nominatim_search(f"{clean_addr}, Lithuania", headers)
    if results and is_specific(results[0]):
        return make_result(results[0])
    time.sleep(RATE_LIMIT_SECONDS)

    # Strategy 3: Free text with municipality
    results = nominatim_search(f"{clean_addr}, {clean_muni}, Lithuania", headers)
    if results and is_specific(results[0]):
        return make_result(results[0])
    time.sleep(RATE_LIMIT_SECONDS)

    # Strategy 4: Village name in nominative case + company
    # Lithuanian data uses genitive ("Zujūnų k.") but OSM has nominative ("Zujūnai")
    if village:
        nominative_forms = genitive_to_nominative(village)
        all_forms = nominative_forms  # nominative first, genitive included as fallback

        # Try village + company first (most specific)
        if company:
            for form in all_forms:
                results = nominatim_search(f"{company} {form}, Lithuania", headers)
                if results and is_specific(results[0]):
                    print(f"  Resolved via village+company: {company} {form}")
                    return make_result(results[0], review=True)
                time.sleep(RATE_LIMIT_SECONDS)

        # Then just village name
        for form in all_forms:
            results = nominatim_search(f"{form}, Lithuania", headers)
            if results:
                r = results[0]
                print(f"  Resolved via village name: {form}")
                return make_result(r, review=True)
            time.sleep(RATE_LIMIT_SECONDS)

    # Strategy 6: City name from address (for non-village addresses like "Kaunas, Chemijos g. 6")
    if city and city != clean_muni:
        results = nominatim_search(f"{city}, Lithuania", headers)
        if results:
            r = results[0]
            print(f"  Resolved via city name: {city}")
            return make_result(r, review=True)
        time.sleep(RATE_LIMIT_SECONDS)

    # Last resort: municipality centroid
    results = nominatim_search(f"{clean_muni}, Lithuania", headers)
    if results:
        r = results[0]
        print(f"  Municipality fallback: {r.get('display_name', '')[:60]}")
        return make_result(r, review=True)
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
        company = station.get("company", "")
        print(f"[{i+1}/{len(to_geocode)}] Geocoding: {addr}, {muni}")

        result = geocode_address(addr, muni, company)

        if result:
            geocache[sid] = result
            newly_geocoded += 1
            review_flag = " [REVIEW]" if result.get("review") else ""
            print(f"  -> {result['lat']}, {result['lng']}{review_flag}")
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
