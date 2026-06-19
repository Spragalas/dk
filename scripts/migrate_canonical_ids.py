#!/usr/bin/env python3
"""One-time migration to canonical station ids.

In mid-2026 the data source changed its address format (city-first, postal
code appended), which changed the value of `make_station_id`. To keep one
stable identity per physical station across that change, `make_station_id`
was rewritten to a format-independent canonical token key. This script
rewrites every existing artifact keyed by the old ids onto the new ids:

  * data/geocache.json          (keys: station id -> coords)
  * data/history/*.json         (stations[].id)

Derived files (docs/data/stations.json, station-history.json, the trend
jsonl files, the docs/ history copies) are regenerated from these by the
normal fetch_prices.py run, so they are not touched here.

Idempotent: `make_station_id` is a pure function of municipality+address, so
re-running recomputes the same ids whether the stored id is old or new.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import HISTORY_DIR, DATA_DIR, make_station_id


def build_old_to_new() -> dict[str, str]:
    """Map each id currently stored in history files to its canonical id."""
    old2new: dict[str, str] = {}
    for path in HISTORY_DIR.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        for s in data["stations"]:
            new_id = make_station_id(str(s["municipality"]), str(s["address"]))
            old2new[s["id"]] = new_id
    return old2new


def migrate_geocache(old2new: dict[str, str]) -> None:
    path = DATA_DIR / "geocache.json"
    geocache = json.loads(path.read_text(encoding="utf-8"))

    def better(candidate: dict, existing: dict) -> bool:
        # Prefer an entry that has coordinates and isn't flagged for review.
        cand_ok = candidate.get("lat") is not None and not candidate.get("review")
        exist_ok = existing.get("lat") is not None and not existing.get("review")
        return cand_ok and not exist_ok

    migrated: dict[str, dict] = {}
    remapped = 0
    for old_id, val in geocache.items():
        new_id = old2new.get(old_id, old_id)  # keep orphans under their old key
        if old_id != new_id:
            remapped += 1
        if new_id in migrated and not better(val, migrated[new_id]):
            continue
        migrated[new_id] = val

    path.write_text(json.dumps(migrated, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"geocache: {len(geocache)} -> {len(migrated)} entries ({remapped} remapped)")


def migrate_history() -> None:
    total_files = 0
    total_dropped = 0
    for path in sorted(HISTORY_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        seen: set[str] = set()
        new_stations = []
        dropped = 0
        for s in data["stations"]:
            new_id = make_station_id(str(s["municipality"]), str(s["address"]))
            if new_id in seen:
                dropped += 1  # benign duplicate (e.g. nbsp / dual postal code)
                continue
            seen.add(new_id)
            s["id"] = new_id
            new_stations.append(s)
        data["stations"] = new_stations
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        total_files += 1
        total_dropped += dropped
    print(f"history: rewrote {total_files} files, dropped {total_dropped} duplicate rows")


def main():
    old2new = build_old_to_new()
    changed = sum(1 for k, v in old2new.items() if k != v)
    print(f"id map: {len(old2new)} ids, {changed} change under canonical scheme")
    migrate_geocache(old2new)
    migrate_history()
    print("Migration complete.")


if __name__ == "__main__":
    main()
