#!/usr/bin/env python3
"""Download the latest fuel price Excel file from ena.lt via SharePoint.

1. Scrapes ena.lt to find SharePoint links for the target date
2. Downloads the Excel file from SharePoint using the anonymous guest-share
   link (`:x:/s/...`), falling back to Playwright if needed.
"""

import html as html_mod
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests

ENA_PAGE = "https://www.ena.lt/degalu-kainos-degalinese/"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "downloads"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def get_sharepoint_links(target_date: str | None = None) -> tuple[list[str], str]:
    """Scrape ena.lt for SharePoint download links.

    Returns (urls, date_string) where `urls` is a list of candidate URLs for
    the chosen date. ena.lt typically lists two links per date: an internal
    `/:x:/r/...` viewer URL (requires Microsoft login) and an anonymous
    `/:x:/s/...` guest-share URL. We return both so callers can try them in
    preference order (guest share first).
    """
    resp = requests.get(ENA_PAGE, timeout=15, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    html = resp.text

    # ena.lt has placed the date for each SharePoint share link in
    # several spots over time: a `title="Degalų kainos YYYY-MM-DD"`
    # attribute, the anchor's own inner text (e.g. `Naujausios degalų
    # kainos (2026-05-06)` for the freshly-published day with no title),
    # or — historically — an adjacent span. Rather than hard-code those
    # locations, scan each anchor tag for any YYYY-MM-DD; if the tag
    # itself carries none, fall back to the latest date that appears
    # anywhere on the page, which the news headline always advertises
    # (e.g. `Naujausias pranešimas apie degalų kainas (YYYY-MM-DD)`).
    # This keeps the date bound to the same href instead of relying on
    # proximity, while degrading gracefully when ena.lt reshuffles the
    # markup around the link.
    date_pattern = re.compile(r'\d{4}-\d{2}-\d{2}')
    a_tag_pattern = re.compile(
        r'<a\b[^>]*href="(https://ltenergagen\.sharepoint\.com[^"]+)"[^>]*>[^<]*</a>',
        re.IGNORECASE,
    )

    page_dates = date_pattern.findall(html)
    fallback_date = max(page_dates) if page_dates else None

    links_with_dates: list[tuple[str, str]] = []
    for m in a_tag_pattern.finditer(html):
        in_tag = date_pattern.search(m.group(0))
        date_str = in_tag.group(0) if in_tag else fallback_date
        if not date_str:
            continue
        # The href in HTML is entity-encoded (e.g. &amp;). Decode so the
        # share token query params (d=..., e=...) are usable directly.
        links_with_dates.append((html_mod.unescape(m.group(1)), date_str))

    if not links_with_dates:
        print(f"DEBUG: page length={len(html)}, 'sharepoint' in page={'sharepoint' in html.lower()}")
        raise RuntimeError("No SharePoint links with dated titles found on ena.lt")

    available_dates = sorted({d for _, d in links_with_dates}, reverse=True)
    print(f"SharePoint dates available: {available_dates}")

    chosen_date = target_date if target_date in available_dates else available_dates[0]
    if target_date and chosen_date != target_date:
        print(f"No exact match for {target_date}, latest is {chosen_date}")

    # Prefer guest-share links (`:x:/s/...`) over internal viewer links
    # (`:x:/r/...`) — the former works without authentication.
    def link_priority(url: str) -> int:
        return 0 if "/:x:/s/" in url else 1

    urls = [u for u, d in links_with_dates if d == chosen_date]
    urls.sort(key=link_priority)
    return urls, chosen_date


def get_sharepoint_link(target_date: str | None = None) -> tuple[str, str]:
    """Backwards-compatible single-URL accessor (returns highest-priority link)."""
    urls, date_str = get_sharepoint_links(target_date)
    return urls[0], date_str


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
    target_date = None
    if len(sys.argv) > 1:
        target_date = sys.argv[1]

    urls, date_str = get_sharepoint_links(target_date)
    print(f"Found {len(urls)} link(s) for {date_str}")
    for u in urls:
        print(f"  {u}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / f"dk-{date_str}.xlsx"

    if output_path.exists():
        print(f"File already exists: {output_path}")
    else:
        download_from_sharepoint_any(urls, output_path)

    # Verify it's a valid Excel file
    import openpyxl
    wb = openpyxl.load_workbook(output_path, read_only=True)
    sheet = wb.sheetnames[0]
    print(f"Valid Excel file, sheet: {sheet}")
    wb.close()

    print(f"OUTPUT_PATH={output_path}")
    print(f"OUTPUT_DATE={date_str}")


if __name__ == "__main__":
    main()
