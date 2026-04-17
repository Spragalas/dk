#!/usr/bin/env python3
"""Rebuild docs/data/price-trends.jsonl from all data/history/*.json files.

Run this once to backfill, or to recover if the jsonl ever drifts.
Normal daily updates happen via fetch_prices.py, which appends a single
line each time a new history file is written.
"""

import json
from pathlib import Path

from fetch_prices import compute_trend_stats

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "data" / "history"
OUT_PATH = ROOT / "docs" / "data" / "price-trends.jsonl"


def main():
    entries = []
    for path in sorted(HISTORY_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as f:
            hist = json.load(f)
        stats = compute_trend_stats(hist["stations"])
        entries.append({"date": hist["date"], **stats})

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"Wrote {len(entries)} entries to {OUT_PATH}")


if __name__ == "__main__":
    main()
