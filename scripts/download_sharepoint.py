#!/usr/bin/env python3
"""Download the fuel price Excel workbook published by ena.lt via SharePoint.

1. Scrapes ena.lt for the SharePoint share link
2. Downloads the workbook using the anonymous guest-share link (`:x:/s/...`),
   falling back to Playwright if needed.

Since 2026-09-09 ena.lt publishes one consolidated workbook per year (all
days in a single `Pateikimo data` column) instead of one file per day, so the
link carries no date of its own — callers pick the day out of the workbook.
"""

import html as html_mod
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests

# The raw-data downloads moved to the /dk-pr-pr-duomenys/ subpage when ena.lt
# split its fuel-price section (Sept 2026). Tried in order.
ENA_PAGES = (
    "https://www.ena.lt/dk-pr-pr-duomenys/",
    "https://www.ena.lt/degalu-kainos-degalinese/",
)
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "downloads"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def get_sharepoint_links() -> list[str]:
    """Scrape ena.lt for SharePoint workbook links, best candidate first.

    ena.lt lists two flavours of link: an internal `/:x:/r/...` viewer URL
    (requires a Microsoft login) and an anonymous `/:x:/s/...` guest-share
    URL. Guest-share links come first so callers try the usable one first.
    """
    for page in ENA_PAGES:
        resp = requests.get(page, timeout=15, headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        # The href in HTML is entity-encoded (e.g. &amp;). Decode so the share
        # token query params (d=..., e=...) stay usable.
        urls = [html_mod.unescape(u) for u in dict.fromkeys(
            re.findall(r'href="(https://ltenergagen\.sharepoint\.com[^"]+)"', resp.text))]
        if urls:
            urls.sort(key=lambda u: 0 if "/:x:/s/" in u else 1)
            return urls
    raise RuntimeError(f"No SharePoint links found on any of {', '.join(ENA_PAGES)}")


def _with_download_param(url: str) -> str:
    """Return the URL with download=1 added/replaced, preserving other params.

    The share-link URL contains a `d=<token>` (and often `e=`) query param
    that authorizes anonymous access. Stripping those triggers a redirect
    to the Microsoft login flow, so we must keep them.
    """
    parts = urlparse(url)
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    params["download"] = "1"
    return urlunparse(parts._replace(query=urlencode(params)))


def _download_with_requests(url: str, output_path: Path) -> bool:
    """Try downloading via a requests Session.

    SharePoint guest-share links redirect to a path that requires the
    `FedAuth` cookie set on the first hop. A Session preserves cookies
    across redirects, which is enough for anonymous shares.
    Returns True on success, False otherwise.
    """
    download_url = _with_download_param(url)
    print(f"Trying requests download: {download_url}")
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    try:
        resp = session.get(download_url, timeout=60, allow_redirects=True, stream=True)
    except requests.RequestException as e:
        print(f"requests download failed: {e}")
        return False

    if resp.status_code != 200:
        print(f"requests download got status {resp.status_code}")
        resp.close()
        return False

    ctype = resp.headers.get("content-type", "")
    if "html" in ctype.lower():
        # Likely a login page or viewer rather than a binary file
        print(f"requests download returned HTML (content-type={ctype})")
        resp.close()
        return False

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=64 * 1024):
            if chunk:
                f.write(chunk)
    print(f"Saved to {output_path}")
    return True


def _download_with_playwright(url: str, output_path: Path) -> None:
    """Fallback: drive a real browser to handle the download."""
    from playwright.sync_api import sync_playwright

    download_url = _with_download_param(url)
    print(f"Falling back to Playwright: {download_url}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        with page.expect_download(timeout=60000) as download_info:
            try:
                page.goto(download_url, timeout=30000)
            except Exception:
                pass

        download = download_info.value
        download.save_as(str(output_path))
        print(f"Saved to {output_path}")

        browser.close()


def download_from_sharepoint(url: str, output_path: Path) -> None:
    """Download the Excel file at `url` to `output_path`.

    Tries a plain requests session first (works for anonymous guest-share
    links) and falls back to Playwright if that doesn't yield a binary.
    """
    if _download_with_requests(url, output_path):
        return
    _download_with_playwright(url, output_path)


def download_from_sharepoint_any(urls: list[str], output_path: Path) -> None:
    """Try each URL in order until one succeeds."""
    last_err: Exception | None = None
    for i, url in enumerate(urls):
        try:
            print(f"Attempting URL {i + 1}/{len(urls)}")
            if _download_with_requests(url, output_path):
                return
        except Exception as e:
            last_err = e
            print(f"URL {i + 1} requests path raised: {e}")

    # All requests attempts failed — try Playwright on the first URL.
    try:
        _download_with_playwright(urls[0], output_path)
        return
    except Exception as e:
        last_err = e

    raise RuntimeError(f"All SharePoint download attempts failed: {last_err}")


def main():
    urls = get_sharepoint_links()
    print(f"Found {len(urls)} link(s)")
    for u in urls:
        print(f"  {u}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / "dk-latest.xlsx"
    download_from_sharepoint_any(urls, output_path)

    # Verify it's a valid Excel file
    import openpyxl
    wb = openpyxl.load_workbook(output_path, read_only=True)
    sheet = wb.sheetnames[0]
    print(f"Valid Excel file, sheet: {sheet}")
    wb.close()

    print(f"OUTPUT_PATH={output_path}")


if __name__ == "__main__":
    main()
