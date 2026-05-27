#!/usr/bin/env python3
"""Rebuild all trend artifacts under docs/data/ from data/history/*.json.

Outputs:
- price-trends.jsonl       overall daily stats (kept for backward compat)
- trends-by-network.jsonl  daily stats grouped by company (gas station network)
- trends-by-region.jsonl   daily stats grouped by region (group of municipalities)
- station-history.json     full per-station time series with metadata

Run this whenever new history is added (fetch_prices.py calls it at the end)
or manually to recover if any derived file drifts.
"""

import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "data" / "history"
OUT_DIR = ROOT / "docs" / "data"

FUELS = ("petrol95", "diesel", "lpg")

# Mirror of the REGIONS map in docs/app.js. Keep them in sync — if app.js
# adds a municipality, add it here too, otherwise that station's prices
# won't be included in any region aggregate.
REGIONS = {
    "Vilniaus": ["Vilniaus m.", "Vilniaus r.", "Elektrėnų", "Šalčininkų r.", "Širvintų r.", "Švenčionių r.", "Trakų r.", "Ukmergės r."],
    "Kauno": ["Kauno m.", "Kauno r.", "Jonavos r.", "Kaišiadorių r.", "Kėdainių r.", "Prienų r.", "Raseinių r.", "Birštono"],
    "Klaipėdos": ["Klaipėdos m.", "Klaipėdos r.", "Kretingos r.", "Neringos", "Palangos m.", "Skuodo r.", "Šilutės r."],
    "Šiaulių": ["Šiaulių m.", "Šiaulių r.", "Akmenės r.", "Joniškio r.", "Kelmės r.", "Pakruojo r.", "Radviliškio r."],
    "Panevėžio": ["Panevėžio m.", "Panevėžio r.", "Biržų r.", "Kupiškio r.", "Pasvalio r.", "Rokiškio r."],
    "Alytaus": ["Alytaus m.", "Alytaus r.", "Druskininkų", "Lazdijų r.", "Varėnos r."],
    "Marijampolės": ["Marijampolės", "Kalvarijos", "Kazlų Rūdos", "Šakių r.", "Vilkaviškio r."],
    "Tauragės": ["Tauragės r.", "Jurbarko r.", "Pagėgių", "Šilalės r."],
    "Telšių": ["Telšių r.", "Mažeikių r.", "Plungės r.", "Rietavo"],
    "Utenos": ["Utenos r.", "Anykščių r.", "Ignalinos r.", "Molėtų r.", "Visagino", "Zarasų r."],
}


def region_for(municipality: str) -> str | None:
    if not municipality:
        return None
    m = municipality.strip()
    for region, prefixes in REGIONS.items():
        if any(m.startswith(p) for p in prefixes):
            return region
    return None


def stats_for_prices(prices: list[float]) -> dict | None:
    if not prices:
        return None
    return {
        "min": round(min(prices), 3),
        "avg": round(sum(prices) / len(prices), 3),
        "median": round(statistics.median(prices), 3),
        "max": round(max(prices), 3),
    }


def stats_per_fuel(stations: list[dict]) -> dict:
    out = {}
    for fuel in FUELS:
        prices = [s["prices"][fuel] for s in stations if s["prices"].get(fuel) is not None]
        out[fuel] = stats_for_prices(prices)
    return out


def load_history() -> list[tuple[str, list[dict]]]:
    """Return [(date, stations), ...] sorted ascending by date."""
    days = []
    for path in sorted(HISTORY_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        days.append((data["date"], data["stations"]))
    return days


def write_overall(days: list[tuple[str, list[dict]]]) -> None:
    path = OUT_DIR / "price-trends.jsonl"
    with open(path, "w", encoding="utf-8") as f:
        for date, stations in days:
            entry = {"date": date, **stats_per_fuel(stations)}
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"Wrote {path}")


def write_grouped(days, key_fn, key_name, out_name):
    """Group stations by key_fn(station) per day and write JSONL.

    Lines are sorted by (date, key) so diffs stay small day-to-day.
    """
    path = OUT_DIR / out_name
    with open(path, "w", encoding="utf-8") as f:
        for date, stations in days:
            groups: dict[str, list[dict]] = defaultdict(list)
            for s in stations:
                k = key_fn(s)
                if k:
                    groups[k].append(s)
            for k in sorted(groups.keys()):
                bucket = groups[k]
                entry = {
                    "date": date,
                    key_name: k,
                    "count": len(bucket),
                    **stats_per_fuel(bucket),
                }
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"Wrote {path}")


def write_station_history(days: list[tuple[str, list[dict]]]) -> None:
    """One file containing every station's full time series.

    Format (compact, designed for ~1-2 MB gzipped at one year of data):
        {
          "dates": ["2026-04-09", ...],
          "stations": {
            "<id>": {
              "company": "...",
              "address": "...",
              "municipality": "...",
              "p95":   [1.799, 1.78, null, ...],
              "diesel":[...],
              "lpg":   [...]
            },
            ...
          }
        }

    Missing days are encoded as null. Station metadata is taken from
    the latest day a station appears in.
    """
    dates = [d for d, _ in days]

    # Discover all station ids and capture latest metadata for each.
    meta: dict[str, dict] = {}
    for _, stations in days:
        for s in stations:
            meta[s["id"]] = {
                "company": s.get("company"),
                "address": s.get("address"),
                "municipality": s.get("municipality"),
            }

    # Initialize per-station arrays.
    fuel_key = {"petrol95": "p95", "diesel": "diesel", "lpg": "lpg"}
    series: dict[str, dict] = {
        sid: {
            **m,
            **{fuel_key[f]: [None] * len(dates) for f in FUELS},
        }
        for sid, m in meta.items()
    }

    for i, (_, stations) in enumerate(days):
        for s in stations:
            sid = s["id"]
            row = series[sid]
            for f in FUELS:
                row[fuel_key[f]][i] = s["prices"].get(f)

    out = {"dates": dates, "stations": series}
    path = OUT_DIR / "station-history.json"
    with open(path, "w", encoding="utf-8") as f:
        # ensure_ascii=False so Lithuanian chars stay human-readable;
        # separators=(",",":") to keep the file tight (it's the largest
        # derived artifact and gets pulled across the network).
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {path}")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    days = load_history()
    if not days:
        print("No history files found, nothing to build.")
        return

    write_overall(days)
    write_grouped(days, lambda s: s.get("company"), "network", "trends-by-network.jsonl")
    write_grouped(days, lambda s: region_for(s.get("municipality", "")), "region", "trends-by-region.jsonl")
    write_station_history(days)
    print(f"Built trends for {len(days)} dates.")


if __name__ == "__main__":
    main()
