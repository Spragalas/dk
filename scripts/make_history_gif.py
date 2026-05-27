#!/usr/bin/env python3
"""Generate an animated GIF of fuel-price-map state for every available history date.

Spawns the dev server, drives the live page with Playwright, snapshots each date,
then stitches the frames into a GIF.

Usage:
  python3 scripts/make_history_gif.py [--fuel petrol95|diesel|lpg]
                                       [--frame-ms 700] [--width 1280] [--height 800]
                                       [--output history.gif]
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "docs" / "data" / "history"
HISTORY_INDEX = ROOT / "docs" / "data" / "history-index.json"
FUELS = ("petrol95", "diesel", "lpg")


def compute_color_ranges(dates: list[str]) -> dict[str, list[float]]:
    """Per-fuel [min, max] price across all history dates."""
    ranges: dict[str, list[float]] = {}
    for date in dates:
        path = HISTORY_DIR / f"{date}.json"
        data = json.loads(path.read_text())
        for station in data.get("stations", []):
            for fuel, price in (station.get("prices") or {}).items():
                if fuel not in FUELS or price is None:
                    continue
                cur = ranges.get(fuel)
                if cur is None:
                    ranges[fuel] = [price, price]
                else:
                    if price < cur[0]: cur[0] = price
                    if price > cur[1]: cur[1] = price
    return ranges


def find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def wait_for_server(port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"dev server did not come up on port {port}")


def capture_frames(port: int, dates: list[str], fuel: str, width: int, height: int,
                   out_dir: Path, color_ranges: dict[str, list[float]],
                   center: str | None, zoom: float | None) -> list[Path]:
    frames: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": width, "height": height},
                                  device_scale_factor=1)
        # Decline cookies before the page's inline banner script reads localStorage,
        # so the banner never appears in screenshots.
        ctx.add_init_script(
            "try { localStorage.setItem('cookie-consent', 'declined'); } catch (e) {}"
        )
        page = ctx.new_page()
        params = {"colorRange": json.dumps(color_ranges, separators=(",", ":"))}
        if center: params["center"] = center
        if zoom is not None: params["zoom"] = str(zoom)
        from urllib.parse import urlencode
        page.goto(f"http://127.0.0.1:{port}/?{urlencode(params)}",
                  wait_until="networkidle")

        # Pick the requested fuel tab.
        page.evaluate(
            """(fuel) => {
                const btn = document.querySelector(`.fuel-tab[data-fuel="${fuel}"]`);
                if (btn) btn.click();
            }""",
            fuel,
        )

        # Make sure history-index has populated the select.
        page.wait_for_function(
            "document.querySelectorAll('#history-select option').length > 1",
            timeout=10_000,
        )
        # Let initial map tiles settle.
        page.wait_for_timeout(1500)

        for date in dates:
            page.evaluate(
                """(date) => {
                    const sel = document.getElementById('history-select');
                    sel.value = date;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                }""",
                date,
            )
            # Wait for the data swap + marker re-render.
            page.wait_for_function(
                "(d) => document.getElementById('history-select').value === d",
                arg=date,
                timeout=5_000,
            )
            page.wait_for_timeout(800)

            frame_path = out_dir / f"frame-{date}.png"
            page.screenshot(path=str(frame_path), full_page=False)
            frames.append(frame_path)
            print(f"  captured {date}")

        browser.close()
    return frames


def build_gif(frames: list[Path], output: Path, frame_ms: int) -> None:
    images = [Image.open(f).convert("P", palette=Image.ADAPTIVE) for f in frames]
    images[0].save(
        output,
        save_all=True,
        append_images=images[1:],
        duration=frame_ms,
        loop=0,
        optimize=True,
        disposal=2,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fuel", default="petrol95",
                        choices=["petrol95", "diesel", "lpg"])
    parser.add_argument("--frame-ms", type=int, default=700)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--output", default=str(ROOT / "history.gif"))
    parser.add_argument("--center", default="55.17,22.60",
                        help="lat,lng map center (default shifts Lithuania right of the panel).")
    parser.add_argument("--zoom", type=float, default=7.8)
    parser.add_argument("--keep-frames", action="store_true",
                        help="Keep intermediate PNG frames next to the gif.")
    args = parser.parse_args()

    dates = json.loads(HISTORY_INDEX.read_text())
    if not dates:
        print("No history dates found.", file=sys.stderr)
        return 1
    print(f"Found {len(dates)} dates: {dates[0]} → {dates[-1]}")

    color_ranges = compute_color_ranges(dates)
    for fuel, (lo, hi) in color_ranges.items():
        print(f"  {fuel}: {lo:.3f} – {hi:.3f} €")

    port = find_free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
         "--directory", str(ROOT / "docs")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(port)
        print(f"Serving docs/ on http://127.0.0.1:{port}")

        with TemporaryDirectory(prefix="dk-frames-") as tmp:
            tmp_dir = Path(tmp)
            frames = capture_frames(port, dates, args.fuel,
                                    args.width, args.height, tmp_dir, color_ranges,
                                    args.center, args.zoom)

            output = Path(args.output)
            build_gif(frames, output, args.frame_ms)
            print(f"Wrote {output} ({output.stat().st_size / 1024:.1f} KB)")

            if args.keep_frames:
                kept = output.with_suffix("")
                kept.mkdir(exist_ok=True)
                for f in frames:
                    (kept / f.name).write_bytes(f.read_bytes())
                print(f"Frames kept in {kept}/")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    return 0


if __name__ == "__main__":
    sys.exit(main())
