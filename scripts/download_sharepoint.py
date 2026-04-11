#!/usr/bin/env python3
"""Download the latest fuel price Excel file from ena.lt via SharePoint.

1. Scrapes ena.lt to find today's SharePoint link
2. Uses Playwright to download the Excel file from SharePoint
"""

import re
import sys
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

ENA_PAGE = "https://www.ena.lt/degalu-kainos-degalinese/"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "downloads"


def get_sharepoint_link(target_date: str | None = None) -> tuple[str, str]:
    """Scrape ena.lt for the latest SharePoint download link.

    Returns (sharepoint_url, date_string).
    """
    resp = requests.get(ENA_PAGE, timeout=15)
    resp.raise_for_status()
    html = resp.text

    # Find all SharePoint links with their associated dates
    # Pattern: links like https://ltenergagen.sharepoint.com/...
    # Near text like "2026-04-11" or "(2026-04-11)"
    sp_pattern = r'href="(https://ltenergagen\.sharepoint\.com[^"]+)"'
    date_pattern = r'(\d{4}-\d{2}-\d{2})'

    matches = list(re.finditer(sp_pattern, html))
    if not matches:
        raise RuntimeError("No SharePoint links found on ena.lt")

    # For each SP link, find the nearest date
    links_with_dates = []
    for m in matches:
        url = m.group(1)
        # Search surrounding context (500 chars before and after) for a date
        start = max(0, m.start() - 500)
        end = min(len(html), m.end() + 500)
        context = html[start:end]
        dates = re.findall(date_pattern, context)
        if dates:
            # Take the date closest to the link
            links_with_dates.append((url, dates[-1]))

    if not links_with_dates:
        raise RuntimeError("Found SharePoint links but couldn't extract dates")

    # Sort by date descending to get the latest
    links_with_dates.sort(key=lambda x: x[1], reverse=True)

    if target_date:
        # Find specific date
        for url, date in links_with_dates:
            if date == target_date:
                return url, date
        raise RuntimeError(f"No SharePoint link found for date {target_date}")

    # Return the latest
    return links_with_dates[0]


def download_from_sharepoint(url: str, output_path: Path) -> None:
    """Use Playwright to download Excel file from SharePoint."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        # Use ?download=1 to trigger direct download
        download_url = url.split("?")[0] + "?download=1"
        print(f"Downloading from: {download_url}")

        with page.expect_download(timeout=30000) as download_info:
            # goto will error because download starts, that's expected
            try:
                page.goto(download_url, timeout=30000)
            except Exception:
                pass

        download = download_info.value
        download.save_as(str(output_path))
        print(f"Saved to {output_path}")

        browser.close()


def main():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    target_date = None
    if len(sys.argv) > 1:
        target_date = sys.argv[1]

    # Get SharePoint link
    sp_url, date_str = get_sharepoint_link(target_date)
    print(f"Found link for {date_str}: {sp_url}")

    # Download
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / f"dk-{date_str}.xlsx"

    if output_path.exists():
        print(f"File already exists: {output_path}")
    else:
        download_from_sharepoint(sp_url, output_path)

    # Verify it's a valid Excel file
    import openpyxl
    wb = openpyxl.load_workbook(output_path, read_only=True)
    sheet = wb.sheetnames[0]
    print(f"Valid Excel file, sheet: {sheet}")
    wb.close()

    # Output the path for the next script to use
    print(f"OUTPUT_PATH={output_path}")
    print(f"OUTPUT_DATE={date_str}")


if __name__ == "__main__":
    main()
