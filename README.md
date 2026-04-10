# Degalų kainos Lietuvoje

Interactive map of fuel prices at Lithuanian gas stations, updated daily.

## Features

- Daily automatic price updates at 11:00 Vilnius time
- Interactive map with 700+ gas stations
- Filter by fuel type (95 benzinas, dyzelinas, SND), company, or search by address
- Color-coded markers: green (below average), yellow (average), red (above average)
- Price change indicators vs previous day
- Price history stored as daily snapshots

## Data Source

Fuel prices are published by the Lithuanian Energy Agency (LEA) at [ena.lt](https://www.ena.lt).

**Attribution required**: Duomenys: LEA. Naudojant šią informaciją, būtina nurodyti šaltinį – LEA bei pirminį(-ius) šaltinį(-ius).

## Tech Stack

- **Data pipeline**: Python (openpyxl, requests)
- **Geocoding**: Nominatim / OpenStreetMap
- **Frontend**: Leaflet.js, vanilla HTML/CSS/JS
- **Hosting**: GitHub Pages
- **Automation**: GitHub Actions (daily cron)

## Local Development

```bash
pip install -r scripts/requirements.txt
python scripts/fetch_prices.py           # Fetch today's prices
python scripts/geocode.py                # Geocode addresses
python3 -m http.server -d docs 8000     # Serve at localhost:8000
```

## Manual Data Fetch

```bash
python scripts/fetch_prices.py 2026-04-09   # Fetch specific date
```
