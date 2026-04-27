#!/usr/bin/env python3
"""Local dev server with geocache editor API.

Serves:
  - /editor -> dev/editor.html
  - /* -> docs/* (the main site)
  - /api/stations -> data/latest.json
  - /api/geocache -> GET/POST data/geocache.json

NOT for production. Only for local editing of geocache coordinates.
"""

import json
import os
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DOCS_DIR = ROOT / "docs"
DEV_DIR = ROOT / "dev"


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS_DIR), **kwargs)

    def do_GET(self):
        if self.path == "/editor" or self.path == "/editor/":
            self._serve_file(DEV_DIR / "editor.html", "text/html")
        elif self.path == "/api/stations":
            self._serve_file(DATA_DIR / "latest.json", "application/json")
        elif self.path == "/api/geocache":
            self._serve_file(DATA_DIR / "geocache.json", "application/json")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/geocache":
            self._handle_geocache_update()
        else:
            self.send_error(404)

    def _serve_file(self, path: Path, content_type: str):
        if not path.exists():
            self.send_error(404, f"File not found: {path.name}")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", len(data))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle_geocache_update(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            updates = json.loads(body)
        except json.JSONDecodeError as e:
            self.send_error(400, f"Invalid JSON: {e}")
            return

        # Load current geocache
        geocache_path = DATA_DIR / "geocache.json"
        geocache = {}
        if geocache_path.exists():
            with open(geocache_path, encoding="utf-8") as f:
                geocache = json.load(f)

        # Apply updates — merge all fields from the client
        count = 0
        for station_id, data in updates.items():
            if station_id not in geocache:
                geocache[station_id] = {}
            for key, value in data.items():
                geocache[station_id][key] = value
            count += 1

        # Save geocache (and mirror to docs/data so the live site picks it up)
        with open(geocache_path, "w", encoding="utf-8") as f:
            json.dump(geocache, f, ensure_ascii=False, indent=2)
        docs_geocache_path = DOCS_DIR / "data" / "geocache.json"
        if docs_geocache_path.exists():
            with open(docs_geocache_path, "w", encoding="utf-8") as f:
                json.dump(geocache, f, ensure_ascii=False, indent=2)

        # Propagate coordinate changes to latest.json and docs/data/stations.json
        updated_files = self._propagate_coords(updates, geocache)

        # Respond
        resp = json.dumps({"updated": count}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)
        print(f"Updated {count} geocache entries")
        if updated_files:
            print(f"Propagated coords to: {', '.join(updated_files)}")

    def _propagate_coords(self, updates, geocache):
        """Update lat/lng in latest.json and docs/data/stations.json to match geocache."""
        files = [
            DATA_DIR / "latest.json",
            DOCS_DIR / "data" / "stations.json",
        ]
        updated = []
        for path in files:
            if not path.exists():
                continue
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            changed = False
            for station in data.get("stations", []):
                if station.get("id") in updates:
                    geo = geocache.get(station["id"], {})
                    station["lat"] = geo.get("lat")
                    station["lng"] = geo.get("lng")
                    changed = True
            if changed:
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                updated.append(path.name)
        return updated

    def log_message(self, format, *args):
        if "/api/" in str(args[0]) or "editor" in str(args[0]):
            super().log_message(format, *args)


def main():
    port = 8000
    server = HTTPServer(("", port), DevHandler)
    print(f"Dev server running at http://localhost:{port}")
    print(f"  Main site: http://localhost:{port}/")
    print(f"  Editor:    http://localhost:{port}/editor")
    print(f"  API:       http://localhost:{port}/api/stations")
    print(f"             http://localhost:{port}/api/geocache")
    print()
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")


if __name__ == "__main__":
    main()
