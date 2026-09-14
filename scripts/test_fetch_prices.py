#!/usr/bin/env python3
"""Self-checks for the bits of the pipeline that broke in Sept 2026:
picking a day out of the consolidated yearly workbook, and reaching far
enough back to close a gap in history. Run: python scripts/test_fetch_prices.py
"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_prices as fp


class FakeSheet:
    """Minimal stand-in for an openpyxl read-only worksheet."""

    def __init__(self, rows):
        self._rows = rows

    def iter_rows(self, min_row=1, max_row=None, values_only=True):
        end = len(self._rows) if max_row is None else max_row
        return iter(self._rows[min_row - 1:end])


HEADER = ("Įmonė", "Savivaldybė", "Adresas", "Degalų tipas", "Kaina (EUR/l)", "Pateikimo data")


def test_long_format_picks_one_day():
    ws = FakeSheet([
        HEADER,
        ("Orlen", "Kauno m. sav.", "Kaunas, Vytauto pr. 1, 44000", "95 benzinas", 1.5, "2026-09-10"),
        ("Orlen", "Kauno m. sav.", "Kaunas, Vytauto pr. 1, 44000", "Dyzelinas", 1.6, "2026-09-10"),
        ("Orlen", "Kauno m. sav.", "Kaunas, Vytauto pr. 1, 44000", "95 benzinas", 1.7, "2026-09-11"),
    ])
    day = fp._parse_long_format(ws, 1, "2026-09-11")
    assert len(day) == 1, day
    assert day[0]["prices"] == {"petrol95": 1.7, "diesel": None, "lpg": None}, day[0]
    # An unpublished day yields nothing, which is how the caller detects it.
    assert fp._parse_long_format(ws, 1, "2026-09-14") == []
    # No date wanted -> every row, the legacy one-file-per-day behaviour.
    assert fp._parse_long_format(ws, 1)[0]["prices"]["petrol95"] == 1.7


def test_backfill_start_covers_the_whole_gap(tmp_history):
    target = date(2026, 9, 14)
    # No history at all -> just the normal trailing window.
    assert fp._backfill_start(target) == date(2026, 8, 31)
    # A fresh run stays on the trailing window, not the whole archive.
    tmp_history("2026-06-18", "2026-09-11")
    assert fp._backfill_start(target) == date(2026, 8, 31)
    # A long outage reaches back to the newest file we have.
    (fp.HISTORY_DIR / "2026-09-11.json").unlink()
    assert fp._backfill_start(target) == date(2026, 6, 18)


def main():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        fp.HISTORY_DIR = Path(d)

        def tmp_history(*dates):
            for s in dates:
                (fp.HISTORY_DIR / f"{s}.json").write_text("{}")

        test_long_format_picks_one_day()
        test_backfill_start_covers_the_whole_gap(tmp_history)
    print("ok")


if __name__ == "__main__":
    main()
