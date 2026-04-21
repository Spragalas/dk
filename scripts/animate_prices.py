#!/usr/bin/env python3
"""Render an animated GIF of fuel price changes across Lithuania over time.

For every date in data/history, plots each station on a country outline,
coloured by price relative to that day's average:
  green  — below average (cheaper)
  yellow — near average
  red    — above average

One GIF is written per fuel type into animations/.
"""
import argparse
import io
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "data" / "history"
GEOCACHE_FILE = ROOT / "data" / "geocache.json"
BORDER_FILE = ROOT / "docs" / "data" / "lithuania-border.geojson"
OUT_DIR = ROOT / "animations"

FUELS = [
    ("petrol95", "95 benzinas"),
    ("diesel", "Dyzelinas"),
    ("lpg", "SND"),
]

COLOR_LOW = "#2ecc71"
COLOR_MID = "#f1c40f"
COLOR_HIGH = "#e74c3c"


def price_color(price, avg):
    ratio = price / avg
    if ratio < 0.98:
        return COLOR_LOW
    if ratio > 1.02:
        return COLOR_HIGH
    return COLOR_MID


def load_border_rings(path):
    g = json.loads(path.read_text())
    geom = g["geometry"] if g.get("type") == "Feature" else g
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    if geom["type"] == "MultiPolygon":
        return [poly[0] for poly in geom["coordinates"]]
    raise ValueError(f"Unsupported geometry: {geom['type']}")


def render_fuel_gif(fuel, label, dates, geocache, border_rings, out_path, fps, size):
    # Lithuania spans roughly 6.1 deg lon x 2.65 deg lat; pick a landscape canvas
    # wide enough to fit the map plus top/bottom captions.
    width = size
    height = int(round(size * 0.60))
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100)
    fig.patch.set_facecolor("white")
    ax = fig.add_axes([0.02, 0.08, 0.96, 0.80])

    date_text = fig.text(0.04, 0.93, "", fontsize=22, fontweight="bold", va="top", ha="left")
    title_text = fig.text(
        0.5, 0.955, f"Fuel prices in Lithuania — {label}",
        fontsize=14, va="top", ha="center", color="#222",
    )
    avg_text = fig.text(0.04, 0.04, "", fontsize=11, va="bottom", ha="left", color="#444")
    fig.text(
        0.96, 0.04,
        "green < avg   yellow ~ avg   red > avg\ndata: LEA (ena.lt)",
        fontsize=9, va="bottom", ha="right", color="#555",
    )
    # silence unused-var warning from linters
    _ = title_text

    frames = []
    for date_str in dates:
        snap = json.loads((HISTORY_DIR / f"{date_str}.json").read_text())
        stations = snap["stations"]

        prices = [s["prices"].get(fuel) for s in stations]
        prices = [p for p in prices if p is not None]
        avg = sum(prices) / len(prices) if prices else None

        xs, ys, cs = [], [], []
        if avg is not None:
            for s in stations:
                p = s["prices"].get(fuel)
                if p is None:
                    continue
                geo = geocache.get(s["id"])
                if not geo:
                    continue
                xs.append(geo["lng"])
                ys.append(geo["lat"])
                cs.append(price_color(p, avg))

        ax.clear()
        for ring in border_rings:
            rx = [pt[0] for pt in ring]
            ry = [pt[1] for pt in ring]
            ax.fill(rx, ry, facecolor="#f2f2f2", edgecolor="#2b2b2b", linewidth=1.0, zorder=1)
        ax.scatter(xs, ys, c=cs, s=18, edgecolor="#1a1a1a", linewidths=0.3, zorder=2)

        ax.set_xlim(20.85, 26.95)
        ax.set_ylim(53.85, 56.5)
        ax.set_aspect("equal")
        ax.axis("off")

        date_text.set_text(date_str)
        avg_txt = f"{avg:.3f}" if avg is not None else "-"
        avg_text.set_text(f"avg {avg_txt} EUR/L   stations {len(xs)}")

        buf = io.BytesIO()
        fig.savefig(buf, format="png", facecolor="white")
        buf.seek(0)
        frame = Image.open(buf).convert("RGB")
        frames.append(frame)

    plt.close(fig)

    # All frames share the same figure size, so dimensions match.
    duration_ms = int(round(1000 / fps))
    palette_frames = [f.convert("P", palette=Image.Palette.ADAPTIVE, colors=128) for f in frames]
    palette_frames[0].save(
        out_path,
        save_all=True,
        append_images=palette_frames[1:],
        duration=duration_ms,
        loop=0,
        optimize=True,
        disposal=2,
    )
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fuel", choices=[f[0] for f in FUELS], help="render only one fuel")
    ap.add_argument("--fps", type=float, default=1.2, help="frames per second (default 1.2)")
    ap.add_argument("--size", type=int, default=900, help="output size in pixels (default 900)")
    args = ap.parse_args()

    OUT_DIR.mkdir(exist_ok=True)
    geocache = json.loads(GEOCACHE_FILE.read_text())
    border_rings = load_border_rings(BORDER_FILE)
    dates = sorted(p.stem for p in HISTORY_DIR.glob("*.json"))
    if not dates:
        raise SystemExit("no history files in data/history")

    targets = [(k, v) for k, v in FUELS if not args.fuel or k == args.fuel]
    for fuel, label in targets:
        out_path = OUT_DIR / f"{fuel}.gif"
        render_fuel_gif(fuel, label, dates, geocache, border_rings, out_path, args.fps, args.size)
        size_kb = out_path.stat().st_size / 1024
        print(f"wrote {out_path.relative_to(ROOT)}  {len(dates)} frames  {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
