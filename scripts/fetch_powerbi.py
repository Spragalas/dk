#!/usr/bin/env python3
"""Fetch fuel prices from the LEA Power BI dataset embedded on ena.lt.

ena.lt embeds a public ("publish to web") Power BI report on its fuel-prices
page. The report's data model contains a `degalu_kainos` table with the full
per-station, per-fuel, per-day history — the same numbers as the daily Excel
files, verified byte-for-byte. Unlike the SharePoint Excel (which only exposes
the latest day), this dataset lets us read any past date, so it doubles as a
backfill source and a more reliable primary source.

Everything is resolved dynamically from the ena.lt page (embed token -> cluster
-> model id) so the fetcher keeps working if those identifiers change.
"""

import base64
import datetime as dt
import json
import re
import uuid
from typing import Optional

import requests

ENA_PAGE = "https://www.ena.lt/degalu-kainos-degalinese/"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36"

# Power BI table/columns holding the per-station daily detail.
ENTITY = "degalu_kainos"
COLS = [
    "Data",
    "Įmonė (Degalinių tinklas)",
    "Degalinės vieta (Savivaldybė)",
    "Degalinės vieta (Gyvenvietė, gatvė)",
    "Degalų tipas",
    "Kaina",
]
FUEL_MAP = {"95 benzinas": "petrol95", "Dyzelinas": "diesel", "SND": "lpg"}

# Max rows a single querydata call returns; we page by date to stay well under.
_WINDOW = 30000


class PowerBIError(RuntimeError):
    pass


class PowerBIClient:
    """Resolves and queries the public Power BI report behind ena.lt."""

    def __init__(self, session: Optional[requests.Session] = None):
        self.s = session or requests.Session()
        self.s.headers.update({"User-Agent": USER_AGENT})
        self.resource_key: str = ""
        self.host: str = ""
        self.model_id: int = 0
        self.dataset_id: str = ""
        self.report_id: str = ""

    # -- resolution -------------------------------------------------------
    def _embed_token(self) -> str:
        html = self.s.get(ENA_PAGE, timeout=20).text
        m = re.search(r"app\.powerbi\.com/view\?r=([A-Za-z0-9_-]+)", html)
        if not m:
            raise PowerBIError("No Power BI embed found on ena.lt page")
        return m.group(1)

    def _resolve_cluster(self, token: str) -> None:
        view = self.s.get(f"https://app.powerbi.com/view?r={token}", timeout=20).text
        m = re.search(r"https://(wabi-[a-z0-9-]+?)-redirect\.analysis\.windows\.net", view)
        if not m:
            raise PowerBIError("Could not resolve Power BI cluster")
        # The data API lives on the '-api' host, not the '-redirect' one.
        self.host = f"{m.group(1)}-api.analysis.windows.net"

    def connect(self) -> "PowerBIClient":
        token = self._embed_token()
        decoded = json.loads(base64.b64decode(token + "=" * (-len(token) % 4)))
        self.resource_key = self.report_id = decoded["k"]
        self._resolve_cluster(token)
        r = self.s.get(
            f"https://{self.host}/public/reports/{self.resource_key}"
            "/modelsAndExploration?preferReadOnlySession=true",
            headers=self._headers(),
            timeout=30,
        )
        if r.status_code != 200:
            raise PowerBIError(f"modelsAndExploration failed: HTTP {r.status_code}")
        model = r.json()["models"][0]
        self.model_id = model["id"]
        self.dataset_id = model["dbName"]
        return self

    def _headers(self) -> dict:
        return {
            "X-PowerBI-ResourceKey": self.resource_key,
            "ActivityId": str(uuid.uuid4()),
            "RequestId": str(uuid.uuid4()),
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json",
            "Origin": "https://app.powerbi.com",
            "Referer": "https://app.powerbi.com/",
        }

    # -- querying ---------------------------------------------------------
    def _query_body(self, start: str, end: str) -> dict:
        def column(prop):
            return {"Column": {"Expression": {"SourceRef": {"Source": "d"}}, "Property": prop}}

        selects = [{**column(p), "Name": f"d.{i}"} for i, p in enumerate(COLS)]
        where = [{"Condition": {"And": {
            "Left": {"Comparison": {"ComparisonKind": 2, "Left": column("Data"),
                     "Right": {"Literal": {"Value": f"datetime'{start}T00:00:00'"}}}},
            "Right": {"Comparison": {"ComparisonKind": 3, "Left": column("Data"),
                      "Right": {"Literal": {"Value": f"datetime'{end}T00:00:00'"}}}},
        }}}]
        return {"version": "1.0.0", "queries": [{"Query": {"Commands": [{
            "SemanticQueryDataShapeCommand": {
                "Query": {"Version": 2, "From": [{"Name": "d", "Entity": ENTITY, "Type": 0}],
                          "Select": selects, "Where": where},
                "Binding": {"Primary": {"Groupings": [{"Projections": [0, 1, 2, 3, 4, 5]}]},
                            "DataReduction": {"DataVolume": 4,
                                              "Primary": {"Window": {"Count": _WINDOW}}},
                            "Version": 1}}}]},
            "QueryId": "",
            "ApplicationContext": {"DatasetId": self.dataset_id,
                                   "Sources": [{"ReportId": self.report_id}]}}],
            "cancelQueries": [], "modelId": self.model_id}

    def query_rows(self, start: str, end: str) -> list[list]:
        """Return raw [Data_ms, company, muni, addr, fuel, price] rows for [start, end)."""
        r = self.s.post(f"https://{self.host}/public/reports/querydata?synchronous=true",
                        headers=self._headers(), data=json.dumps(self._query_body(start, end)),
                        timeout=90)
        if r.status_code != 200:
            raise PowerBIError(f"querydata failed: HTTP {r.status_code}: {r.text[:200]}")
        return _parse_dsr(r.json())


def _parse_dsr(payload: dict) -> list[list]:
    """Decode Power BI's DataShapeResult (dict-encoded, repeat/null bitmasks)."""
    ds = payload["results"][0]["result"]["data"]["dsr"]["DS"][0]
    value_dicts = ds.get("ValueDicts", {})
    rows: list[list] = []
    for ph in ds.get("PH", []):
        dm = ph[next(iter(ph))]
        if not dm:
            continue
        dict_names = [col.get("DN") for col in dm[0]["S"]]
        ncols = len(dict_names)
        last: list = [None] * ncols
        for row in dm:
            values = row.get("C", [])
            repeat = row.get("R", 0)
            null = row.get("Ø", 0)  # 'Ø' = null bitmask
            out: list = [None] * ncols
            ci = 0
            for i in range(ncols):
                if (null >> i) & 1:
                    out[i] = None
                elif (repeat >> i) & 1:
                    out[i] = last[i]
                else:
                    v = values[ci]
                    ci += 1
                    if dict_names[i] is not None and isinstance(v, int):
                        v = value_dicts[dict_names[i]][v]
                    out[i] = v
            last = out[:]
            rows.append(out)
    return rows


def _make_station(make_station_id, company, muni, addr) -> dict:
    return {
        "id": make_station_id(str(muni), str(addr)),
        "company": company,
        "municipality": muni,
        "address": addr,
        "prices": {"petrol95": None, "diesel": None, "lpg": None},
    }


def stations_by_date(start: str, end: str, make_station_id, parse_price,
                     client: Optional[PowerBIClient] = None) -> dict[str, dict[str, dict]]:
    """Return {date_str: {station_id: station_dict}} for dates in [start, end).

    `make_station_id` and `parse_price` are injected from fetch_prices so the
    ids and price normalisation match the rest of the pipeline exactly.
    """
    client = client or PowerBIClient().connect()
    rows = client.query_rows(start, end)
    if len(rows) >= _WINDOW:
        raise PowerBIError(f"Hit the {_WINDOW}-row cap; narrow the date range")
    result: dict[str, dict[str, dict]] = {}
    for data_ms, company, muni, addr, fuel_type, price in rows:
        if not company or not addr or data_ms is None:
            continue
        fuel = FUEL_MAP.get(str(fuel_type).strip())
        if fuel is None:
            continue
        date = dt.datetime.utcfromtimestamp(data_ms / 1000).strftime("%Y-%m-%d")
        day = result.setdefault(date, {})
        sid = make_station_id(str(muni), str(addr))
        station = day.get(sid) or _make_station(make_station_id, company, muni, addr)
        station["prices"][fuel] = parse_price(price)
        day[sid] = station
    return result


def main():
    import argparse
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from fetch_prices import make_station_id, parse_price

    parser = argparse.ArgumentParser(description="Query the ena.lt Power BI dataset")
    parser.add_argument("start", help="start date YYYY-MM-DD (inclusive)")
    parser.add_argument("end", nargs="?", help="end date YYYY-MM-DD (exclusive); default start+1")
    args = parser.parse_args()
    end = args.end or (dt.date.fromisoformat(args.start) + dt.timedelta(days=1)).isoformat()

    client = PowerBIClient().connect()
    print(f"Connected: host={client.host} model={client.model_id}")
    by_date = stations_by_date(args.start, end, make_station_id, parse_price, client)
    for date in sorted(by_date):
        print(f"  {date}: {len(by_date[date])} stations")


if __name__ == "__main__":
    main()
