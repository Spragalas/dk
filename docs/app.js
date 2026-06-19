(() => {
  "use strict";

  const MAP_CENTER = [55.17, 23.88];
  const MAP_ZOOM = 8;

  let map, markerCluster, allStations, currentFuel = "petrol95", averages;
  let recentDates = []; // dates aligned to station.recentPrices arrays
  let recentAverages = null; // { petrol95: [...], diesel: [...], lpg: [...] } aligned to recentDates
  let geocache = {}; // id -> { lat, lng }
  let historyDates = [];
  // Full station roster from the latest dataset. Used so that when viewing an
  // older date, stations that didn't report that day are still shown (greyed,
  // no price) instead of vanishing from the map.
  let baseStations = null;
  // Optional per-fuel color range from ?colorRange=<json>, e.g.
  // ?colorRange={"petrol95":[1.40,1.60],"diesel":[1.30,1.55]}.
  // When set for the current fuel, markers use a continuous gradient instead of
  // the day-relative green/yellow/red bucketing — useful for cross-day comparison.
  const COLOR_RANGES = (() => {
    try {
      const raw = new URLSearchParams(location.search).get("colorRange");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number")) {
          out[k] = v;
        }
      }
      return out;
    } catch { return {}; }
  })();
  let companyFilterPopulated = false;
  let clusterMode = "min"; // "min" or "max"
  let selectedCompanies = null; // null = all, Set = selected
  let selectedRegions = null; // null = all, Set = selected
  let heatmapOn = false;
  let heatLayer = null;
  let ltBorder = null; // GeoJSON geometry (Polygon or MultiPolygon)

  // Lithuania's 10 counties (apskritys) -> municipality prefixes
  const REGIONS = {
    "Vilniaus": ["Vilniaus m.", "Vilniaus r.", "Elektrėnų", "Šalčininkų r.", "Širvintų r.", "Švenčionių r.", "Trakų r.", "Ukmergės r."],
    "Kauno": ["Kauno m.", "Kauno r.", "Jonavos r.", "Kaišiadorių r.", "Kėdainių r.", "Prienų r.", "Raseinių r.", "Birštono"],
    "Klaipėdos": ["Klaipėdos m.", "Klaipėdos r.", "Kretingos r.", "Neringos", "Palangos m.", "Skuodo r.", "Šilutės r."],
    "Šiaulių": ["Šiaulių m.", "Šiaulių r.", "Akmenės r.", "Joniškio r.", "Kelmės r.", "Pakruojo r.", "Radviliškio r."],
    "Panevėžio": ["Panevėžio m.", "Panevėžio r.", "Biržų r.", "Kupiškio r.", "Pasvalio r.", "Rokiškio r."],
    "Alytaus": ["Alytaus m.", "Alytaus r.", "Druskininkų", "Lazdijų r.", "Varėnos r."],
    "Marijampolės": ["Marijampolės", "Kalvarijos", "Kazlų Rūdos", "Šakių r.", "Vilkaviškio r."],
    "Tauragės": ["Tauragės r.", "Jurbarko r.", "Pagėgių", "Šilalės r."],
    "Telšių": ["Telšių r.", "Mažeikių r.", "Plungės r.", "Rietavo"],
    "Utenos": ["Utenos r.", "Anykščių r.", "Ignalinos r.", "Molėtų r.", "Visagino", "Zarasų r."],
  };

  function getRegionForMunicipality(municipality) {
    const m = municipality.trim();
    for (const [region, prefixes] of Object.entries(REGIONS)) {
      if (prefixes.some(p => m.startsWith(p))) return region;
    }
    return null;
  }
  let userLocation = null; // { lat, lng }
  let userMarker = null;
  let nearMeActive = false;

  // --- State persistence ---
  const STATE_KEY = "dk-map-state";

  function saveState() {
    const state = {};
    if (map) {
      const c = map.getCenter();
      state.lat = c.lat;
      state.lng = c.lng;
      state.zoom = map.getZoom();
    }
    state.fuel = currentFuel;
    state.clusterMode = clusterMode;
    state.heatmapOn = heatmapOn;
    if (selectedCompanies) state.companies = [...selectedCompanies];
    if (selectedRegions) state.regions = [...selectedRegions];
    const search = document.getElementById("search-input");
    if (search) state.search = search.value;
    const history = document.getElementById("history-select");
    if (history) state.historyDate = history.value;
    const radius = document.getElementById("radius-input");
    if (radius) state.radius = radius.value;
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY)) || {};
    } catch { return {}; }
  }

  const FUEL_LABELS = {
    petrol95: "95 benzinas",
    diesel: "Dyzelinas",
    lpg: "SND",
  };

  function init() {
    const saved = loadState();
    const params = new URLSearchParams(location.search);

    let initCenter = (saved.lat != null && saved.lng != null) ? [saved.lat, saved.lng] : MAP_CENTER;
    let initZoom = saved.zoom != null ? saved.zoom : MAP_ZOOM;

    // ?center=lat,lng and ?zoom=N override saved/default view (used by screenshot tooling).
    const centerParam = params.get("center");
    if (centerParam) {
      const parts = centerParam.split(",").map(Number);
      if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
        initCenter = parts;
      }
    }
    const mapOpts = {};
    if (params.has("zoom")) {
      const zoomParam = Number(params.get("zoom"));
      if (Number.isFinite(zoomParam)) {
        initZoom = zoomParam;
        if (!Number.isInteger(zoomParam)) mapOpts.zoomSnap = 0;
      }
    }
    map = L.map("map", mapOpts).setView(initCenter, initZoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 18,
    }).addTo(map);

    // Save map position on move/zoom
    map.on("moveend", saveState);

    markerCluster = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: function (cluster) {
        const markers = cluster.getAllChildMarkers();
        const prices = [];
        for (const m of markers) {
          const p = m.stationData && m.stationData.prices[currentFuel];
          if (p != null) prices.push(p);
        }
        let val = null;
        if (prices.length > 0) {
          val = clusterMode === "max" ? Math.max(...prices) : Math.min(...prices);
        }
        const label = val != null ? val.toFixed(3) : "—";
        const color = getColor(val, averages[currentFuel]);
        return L.divIcon({
          html: `<div class="cluster-icon" style="background:${color}">${label}</div>`,
          className: "price-cluster",
          iconSize: [52, 24],
        });
      },
    });
    map.addLayer(markerCluster);

    // Restore fuel tab
    if (saved.fuel) {
      currentFuel = saved.fuel;
      document.querySelectorAll(".fuel-tab").forEach((b) => {
        b.classList.toggle("active", b.dataset.fuel === currentFuel);
      });
    }

    // Restore cluster mode
    if (saved.clusterMode) {
      clusterMode = saved.clusterMode;
      document.getElementById("cluster-checkbox").checked = clusterMode === "max";
    }

    // Restore heatmap toggle
    if (saved.heatmapOn) {
      heatmapOn = true;
      document.getElementById("heatmap-checkbox").checked = true;
    }

    // Restore search input
    if (saved.search) {
      document.getElementById("search-input").value = saved.search;
    }

    // Restore radius
    if (saved.radius) {
      document.getElementById("radius-input").value = saved.radius;
    }

    setupThemeToggle();
    setupPanelToggle();
    setupFuelTabs();
    setupClusterMode();
    setupHeatmapToggle();
    setupFilters();
    setupNearMe();
    setupListView();
    setupTrendsView();
    setupRouteView();
    setupHistory(saved);

    map.on("click", handleRouteMapClick);

    // Border used to clip the heatmap — best-effort, don't block data load.
    fetch("data/lithuania-border.geojson")
      .then((r) => r.json())
      .then((g) => { ltBorder = g; if (heatmapOn && allStations) renderMarkers(); })
      .catch(() => { ltBorder = null; });

    // Load geocache first, then latest station data (always fresh on page load)
    fetch("data/geocache.json")
      .then((r) => r.json())
      .then((gc) => { geocache = gc; })
      .catch(() => { geocache = {}; })
      .then(() => loadData("data/stations.json"))
      .then(() => {
        // Filter state is restored in populateCompanyFilter after data loads
      });
  }

  async function setupHistory(saved) {
    try {
      const resp = await fetch("data/history-index.json");
      historyDates = await resp.json();

      const select = document.getElementById("history-select");
      // Add "latest" option
      const latestOpt = document.createElement("option");
      latestOpt.value = "";
      latestOpt.textContent = "Naujausia";
      select.appendChild(latestOpt);
      // Most recent first
      for (const date of [...historyDates].reverse()) {
        const opt = document.createElement("option");
        opt.value = date;
        opt.textContent = date;
        select.appendChild(opt);
      }

      select.addEventListener("change", () => {
        const date = select.value;
        if (date) {
          loadData(`data/stations.json`, date);
        } else {
          loadData("data/stations.json");
        }
        saveState();
      });
    } catch {
      // No history available yet
    }
  }

  async function loadData(url, historyDate) {
    try {
      let data;
      if (historyDate) {
        const resp = await fetch(`data/history/${historyDate}.json`);
        const hist = await resp.json();
        data = {
          // Averages reflect only the stations that reported that day, so
          // merge them before overlaying the full roster (which adds greyed,
          // priceless entries for stations missing on this date).
          date: hist.date,
          stations: mergeWithBase(hist.stations),
          averages: computeAverages(hist.stations),
        };
      } else {
        const resp = await fetch(url);
        data = await resp.json();
      }

      // Merge coordinates from geocache
      for (const s of data.stations) {
        const geo = geocache[s.id];
        s.lat = geo ? geo.lat : null;
        s.lng = geo ? geo.lng : null;
      }

      // Remember the full roster from the latest dataset for date overlays.
      if (!historyDate) baseStations = data.stations;

      allStations = data.stations;
      averages = data.averages;
      recentDates = data.recentDates || [];
      recentAverages = data.recentAverages || null;

      // Set history select to match
      const histSelect = document.getElementById("history-select");
      if (histSelect.options.length > 0) {
        histSelect.value = data.date;
      }

      renderAverages();
      renderMarkers();
      updateStats();

      if (!companyFilterPopulated) {
        populateCompanyFilter();
        companyFilterPopulated = true;
        // Restore saved filter selections after populating
        const saved = loadState();
        if (saved.companies && companyMultiSelect) {
          companyMultiSelect.setSelected(saved.companies);
        }
        if (saved.regions && regionMultiSelect) {
          regionMultiSelect.setSelected(saved.regions);
        }
      }
    } catch (err) {
      console.error("Failed to load data:", err);
      console.error("Klaida kraunant duomenis");
    }
  }

  // Union the requested day's stations with the latest full roster. Stations
  // that didn't report on `dateStations`' day are kept (with null prices and a
  // `missing` flag) so they render greyed instead of disappearing.
  function mergeWithBase(dateStations) {
    if (!baseStations) return dateStations;
    const byId = new Map();
    for (const s of baseStations) {
      byId.set(s.id, {
        id: s.id,
        company: s.company,
        municipality: s.municipality,
        address: s.address,
        prices: { petrol95: null, diesel: null, lpg: null },
        missing: true,
      });
    }
    for (const s of dateStations) {
      byId.set(s.id, { ...s, missing: false });
    }
    return [...byId.values()];
  }

  function computeAverages(stations) {
    const sums = { petrol95: 0, diesel: 0, lpg: 0 };
    const counts = { petrol95: 0, diesel: 0, lpg: 0 };
    for (const s of stations) {
      for (const fuel of Object.keys(sums)) {
        const p = s.prices[fuel];
        if (p != null) {
          sums[fuel] += p;
          counts[fuel]++;
        }
      }
    }
    const avgs = {};
    for (const fuel of Object.keys(sums)) {
      avgs[fuel] = counts[fuel] > 0 ? Math.round((sums[fuel] / counts[fuel]) * 1000) / 1000 : null;
    }
    return avgs;
  }

  function renderAverages() {
    const el = document.getElementById("averages");
    if (!allStations) return;

    const prices = allStations
      .map((s) => s.prices[currentFuel])
      .filter((p) => p != null);

    if (prices.length === 0) {
      el.innerHTML = `<div class="avg-row"><span class="avg-label">N/A</span></div>`;
      return;
    }

    const min = Math.min(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const max = Math.max(...prices);

    el.innerHTML = [
      { label: "Mažiausia", value: min, color: "var(--green)" },
      { label: "Vidutin\u0117", value: avg, color: "var(--yellow)" },
      { label: "Didžiausia", value: max, color: "var(--red)" },
    ]
      .map((r) => `<div class="avg-row">
        <span class="avg-label"><span class="dot" style="background:${r.color}"></span>${r.label}</span>
        <span class="avg-value">${r.value.toFixed(3)} \u20ac</span>
      </div>`)
      .join("");
  }

  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function parseColor(str) {
    const s = str.trim();
    if (s.startsWith("#")) {
      const h = s.slice(1);
      const n = h.length === 3
        ? h.split("").map((c) => parseInt(c + c, 16))
        : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      return n;
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) return m[1].split(",").slice(0, 3).map((v) => parseInt(v.trim(), 10));
    return [128, 128, 128];
  }

  function lerpColor(c0, c1, f) {
    return [
      Math.round(c0[0] + f * (c1[0] - c0[0])),
      Math.round(c0[1] + f * (c1[1] - c0[1])),
      Math.round(c0[2] + f * (c1[2] - c0[2])),
    ];
  }

  function getColor(price, avg) {
    if (price == null) return "#999";
    const range = COLOR_RANGES[currentFuel];
    if (range) {
      const [lo, hi] = range;
      const t = hi > lo ? Math.max(0, Math.min(1, (price - lo) / (hi - lo))) : 0.5;
      const green = parseColor(getCSSVar("--green"));
      const yellow = parseColor(getCSSVar("--yellow"));
      const red = parseColor(getCSSVar("--red"));
      const [r, g, b] = t <= 0.5
        ? lerpColor(green, yellow, t / 0.5)
        : lerpColor(yellow, red, (t - 0.5) / 0.5);
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (avg == null) return "#999";
    const pct = (price - avg) / avg;
    if (pct < -0.02) return getCSSVar("--green");
    if (pct > 0.02) return getCSSVar("--red");
    return getCSSVar("--yellow");
  }

  function createMarkerIcon(color, price, missing) {
    const label = price != null ? price.toFixed(3) : "—";
    const cls = missing ? "cluster-icon missing" : "cluster-icon";
    return L.divIcon({
      className: "price-cluster",
      html: `<div class="${cls}" style="background:${color}">${label}</div>`,
      iconSize: [52, 24],
      iconAnchor: [26, 12],
    });
  }

  function formatChange(change) {
    if (change == null) return "";
    if (change > 0) return `<span class="change-up"> +${change.toFixed(3)}</span>`;
    if (change < 0) return `<span class="change-down"> ${change.toFixed(3)}</span>`;
    return `<span class="change-none"> 0.000</span>`;
  }

  function createPopup(station, distance) {
    const fuels = [
      { key: "petrol95", label: "95 benzinas" },
      { key: "diesel", label: "Dyzelinas" },
      { key: "lpg", label: "SND" },
    ];

    const priceRows = station.missing
      ? `<div class="no-data">\u0160i\u0105 dien\u0105 duomen\u0173 nepateikta</div>`
      : fuels
          .map((f) => {
            const price = station.prices[f.key];
            const change = station.priceChange ? station.priceChange[f.key] : null;
            const priceStr = price != null ? price.toFixed(3) + " \u20ac" : "neprekiauja";
            return `<div class="price-row">
          <span class="fuel-name">${f.label}</span>
          <span><span class="price-value">${priceStr}</span>${formatChange(change)}</span>
        </div>`;
          })
          .join("");

    const distStr = distance != null
      ? `<div class="distance">${distance < 1 ? (distance * 1000).toFixed(0) + " m" : distance.toFixed(1) + " km"}</div>`
      : "";

    const sparkline = renderPopupSparkline(station);

    return `<div class="station-popup">
      <h3>${station.company}</h3>
      <div class="address">${station.address}</div>
      <div class="company">${station.municipality}</div>
      ${distStr}
      <div class="prices">${priceRows}</div>
      ${sparkline}
    </div>`;
  }

  // Last-N-days price sparkline for the currently selected fuel.
  // Hidden when viewing legacy history (those payloads don't carry
  // recentPrices) or when the station has no data in the window.
  function renderPopupSparkline(station) {
    const series = station.recentPrices && station.recentPrices[currentFuel];
    if (!series || !recentDates.length) return "";
    const points = [];
    for (let i = 0; i < series.length; i++) {
      if (series[i] != null) points.push({ i, v: series[i] });
    }
    if (points.length < 2) return "";

    // Overlay Lithuania-wide avg as a faint dashed comparison line.
    const avgSeries = recentAverages && recentAverages[currentFuel];
    const avgPoints = [];
    if (avgSeries) {
      for (let i = 0; i < avgSeries.length; i++) {
        if (avgSeries[i] != null) avgPoints.push({ i, v: avgSeries[i] });
      }
    }

    const W = 200, H = 44;
    const padX = 4, padY = 8;
    const plotW = W - padX * 2;
    const plotH = H - padY * 2;

    // Include avg in the y-range so the comparison line doesn't get clipped.
    const allVals = points.map(p => p.v).concat(avgPoints.map(p => p.v));
    const vMin = Math.min(...allVals);
    const vMax = Math.max(...allVals);
    const vRange = (vMax - vMin) || 0.001;
    const iMin = 0;
    const iMax = series.length - 1;
    const iRange = (iMax - iMin) || 1;

    const xOf = (i) => padX + ((i - iMin) / iRange) * plotW;
    const yOf = (v) => padY + plotH - ((v - vMin) / vRange) * plotH;

    const pathFor = (pts) => pts.map((p, k) =>
      `${k === 0 ? "M" : "L"} ${xOf(p.i).toFixed(1)} ${yOf(p.v).toFixed(1)}`
    ).join(" ");
    const path = pathFor(points);
    const avgPath = avgPoints.length >= 2 ? pathFor(avgPoints) : "";
    const dots = points.map(p =>
      `<circle cx="${xOf(p.i).toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="1.5" fill="var(--text)"/>`
    ).join("");

    const firstDate = recentDates[points[0].i];
    const lastDate = recentDates[points[points.length - 1].i];
    const first = points[0].v.toFixed(3);
    const last = points[points.length - 1].v.toFixed(3);

    return `<div class="popup-spark">
      <div class="popup-spark-label">${FUEL_LABELS[currentFuel]} • ${firstDate.slice(5)} – ${lastDate.slice(5)}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="popup-spark-svg">
        ${avgPath ? `<path d="${avgPath}" fill="none" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="2 2" stroke-linejoin="round" stroke-linecap="round" opacity="0.75"/>` : ""}
        <path d="${path}" fill="none" stroke="var(--text)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
      </svg>
      <div class="popup-spark-ends"><span>${first} €</span><span>${last} €</span></div>
    </div>`;
  }

  function renderMarkers() {
    markerCluster.clearLayers();
    const avg = averages[currentFuel];
    const searchFilter = document.getElementById("search-input").value.toLowerCase();
    const radiusKm = nearMeActive ? parseInt(document.getElementById("radius-input").value) : null;

    let candidates = [];
    for (const station of allStations) {
      if (station.lat == null || station.lng == null) continue;
      if (selectedCompanies && !selectedCompanies.has(station.company)) continue;
      if (selectedRegions) {
        const region = getRegionForMunicipality(station.municipality);
        if (!region || !selectedRegions.has(region)) continue;
      }
      if (searchFilter) {
        const haystack = `${station.address} ${station.municipality} ${station.company}`.toLowerCase();
        if (!haystack.includes(searchFilter)) continue;
      }

      let distance = null;
      if (nearMeActive && userLocation) {
        distance = haversineDistance(userLocation.lat, userLocation.lng, station.lat, station.lng);
        if (distance > radiusKm) continue;
      }

      candidates.push({ station, distance });
    }

    // Sort by price when near-me is active
    if (nearMeActive) {
      candidates.sort((a, b) => {
        const pa = a.station.prices[currentFuel];
        const pb = b.station.prices[currentFuel];
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });
    }

    for (const { station, distance } of candidates) {
      const price = station.prices[currentFuel];
      const color = getColor(price, avg);
      const marker = L.marker([station.lat, station.lng], {
        icon: createMarkerIcon(color, price, station.missing),
      });
      marker.stationData = station;
      marker.bindPopup(createPopup(station, distance), { maxWidth: 250 });
      markerCluster.addLayer(marker);
    }

    // Update near-me status with count
    if (nearMeActive) {
      const status = document.getElementById("nearme-status");
      status.textContent = `Rasta: ${candidates.length} degalinių per ${radiusKm} km`;
    }

    updateStats(candidates.length);
    renderHeatmap(candidates);
  }

  const HEAT_GRADIENT = [
    [0.0, [30, 64, 175]],     // indigo-800 — cheapest
    [0.3, [56, 189, 248]],    // sky-400
    [0.5, [253, 224, 71]],    // yellow-300 — median
    [0.7, [249, 115, 22]],    // orange-500
    [1.0, [153, 27, 27]],     // red-800 — most expensive
  ];

  function gradientColor(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < HEAT_GRADIENT.length - 1; i++) {
      const [t0, c0] = HEAT_GRADIENT[i];
      const [t1, c1] = HEAT_GRADIENT[i + 1];
      if (t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return [
          Math.round(c0[0] + f * (c1[0] - c0[0])),
          Math.round(c0[1] + f * (c1[1] - c0[1])),
          Math.round(c0[2] + f * (c1[2] - c0[2])),
        ];
      }
    }
    return HEAT_GRADIENT[HEAT_GRADIENT.length - 1][1];
  }

  function renderHeatmap(candidates) {
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }
    if (!heatmapOn) return;

    const priced = candidates
      .map(({ station }) => ({
        lat: station.lat,
        lng: station.lng,
        price: station.prices[currentFuel],
      }))
      .filter((s) => s.price != null);

    if (priced.length === 0) return;

    const prices = priced.map((s) => s.price);
    const sortedPrices = [...prices].sort((a, b) => a - b);
    // Percentile rank spreads price distribution uniformly across [0,1],
    // so the full gradient is used regardless of how tightly prices cluster.
    const percentileRank = (p) => {
      let lo = 0, hi = sortedPrices.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedPrices[mid] < p) lo = mid + 1;
        else hi = mid;
      }
      return lo / sortedPrices.length;
    };

    // IDW interpolation onto a regular grid, rendered to a canvas that
    // Leaflet bilinearly upsamples — giving a smooth price field over all
    // of Lithuania without visible grid lines.
    const pad = 0.2;
    const minLat = Math.min(...priced.map((s) => s.lat)) - pad;
    const maxLat = Math.max(...priced.map((s) => s.lat)) + pad;
    const minLng = Math.min(...priced.map((s) => s.lng)) - pad;
    const maxLng = Math.max(...priced.map((s) => s.lng)) + pad;

    const step = 0.03;
    const maxDistDeg = 0.5;
    const maxDist2 = maxDistDeg * maxDistDeg;
    const falloff2 = (maxDistDeg * 0.6) ** 2; // start fading alpha beyond this

    const rows = Math.floor((maxLat - minLat) / step) + 1;
    const cols = Math.floor((maxLng - minLng) / step) + 1;
    const sumWP = new Float64Array(rows * cols);
    const sumW = new Float64Array(rows * cols);
    const nearest2 = new Float64Array(rows * cols).fill(Infinity);

    const radiusCells = maxDistDeg / step;
    for (const s of priced) {
      const cLat = (s.lat - minLat) / step;
      const cLng = (s.lng - minLng) / step;
      const cosLat = Math.cos((s.lat * Math.PI) / 180);
      const i0 = Math.max(0, Math.floor(cLat - radiusCells));
      const i1 = Math.min(rows - 1, Math.ceil(cLat + radiusCells));
      const j0 = Math.max(0, Math.floor(cLng - radiusCells));
      const j1 = Math.min(cols - 1, Math.ceil(cLng + radiusCells));
      for (let i = i0; i <= i1; i++) {
        const lat = minLat + i * step;
        const dLat = lat - s.lat;
        for (let j = j0; j <= j1; j++) {
          const lng = minLng + j * step;
          const dLng = (lng - s.lng) * cosLat;
          const d2 = dLat * dLat + dLng * dLng;
          if (d2 > maxDist2) continue;
          const idx = i * cols + j;
          const w = 1 / (d2 + 0.0001);
          sumWP[idx] += w * s.price;
          sumW[idx] += w;
          if (d2 < nearest2[idx]) nearest2[idx] = d2;
        }
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(cols, rows);
    const data = img.data;

    for (let i = 0; i < rows; i++) {
      // Canvas Y runs top→bottom; lat runs bottom→top. Flip row index.
      const canvasRow = rows - 1 - i;
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        const px = (canvasRow * cols + j) * 4;
        if (sumW[idx] === 0) {
          data[px + 3] = 0;
          continue;
        }
        const price = sumWP[idx] / sumW[idx];
        const norm = percentileRank(price);
        const [r, g, b] = gradientColor(norm);
        // Fade alpha in the outer ring where only distant stations influence.
        let alpha = 200;
        if (nearest2[idx] > falloff2) {
          const t = (nearest2[idx] - falloff2) / (maxDist2 - falloff2);
          alpha = Math.round(200 * (1 - t));
        }
        data[px] = r;
        data[px + 1] = g;
        data[px + 2] = b;
        data[px + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);

    if (ltBorder) {
      clipCanvasToGeometry(ctx, ltBorder, minLat, maxLat, minLng, maxLng, cols, rows);
    }

    heatLayer = L.imageOverlay(canvas.toDataURL(), [[minLat, minLng], [maxLat, maxLng]], {
      opacity: 0.7,
      interactive: false,
      zIndex: 200,
    }).addTo(map);
  }

  function clipCanvasToGeometry(ctx, geom, minLat, maxLat, minLng, maxLng, cols, rows) {
    const polygons =
      geom.type === "MultiPolygon" ? geom.coordinates :
      geom.type === "Polygon" ? [geom.coordinates] :
      [];
    if (polygons.length === 0) return;

    const lngSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;

    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    for (const rings of polygons) {
      for (const ring of rings) {
        for (let k = 0; k < ring.length; k++) {
          const [lng, lat] = ring[k];
          const x = ((lng - minLng) / lngSpan) * cols;
          const y = ((maxLat - lat) / latSpan) * rows;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
    }
    ctx.fillStyle = "#000";
    ctx.fill("evenodd");
    ctx.restore();
  }

  function updateStats(shown) {
    const total = allStations ? allStations.length : 0;
    const withCoords = allStations ? allStations.filter((s) => s.lat != null).length : 0;
    const displayCount = shown != null ? shown : withCoords;
    document.getElementById("stats").textContent =
      `Rodoma: ${displayCount} / ${total} degaliniu`;
  }

  function setupThemeToggle() {
    const btn = document.getElementById("theme-toggle");
    const saved = localStorage.getItem("theme");
    if (saved === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
      btn.innerHTML = "&#9790;";
    }

    btn.addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        localStorage.setItem("theme", "light");
        btn.innerHTML = "&#9788;";
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem("theme", "dark");
        btn.innerHTML = "&#9790;";
      }
      // Re-render markers and trends to pick up new colors
      if (allStations) renderMarkers();
      if (trendsData.length > 0) renderTrendsChartAndTable();
    });
  }

  function setupPanelToggle() {
    const btn = document.getElementById("panel-toggle");
    const body = document.getElementById("panel-body");
    btn.addEventListener("click", () => {
      body.classList.toggle("collapsed");
      btn.innerHTML = body.classList.contains("collapsed") ? "&#9660;" : "&#9650;";
      setTimeout(() => map.invalidateSize(), 350);
    });
  }

  function setupFuelTabs() {
    document.querySelectorAll(".fuel-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".fuel-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentFuel = btn.dataset.fuel;
        renderAverages();
        renderMarkers();
        saveState();
      });
    });
  }

  function setupClusterMode() {
    const checkbox = document.getElementById("cluster-checkbox");
    checkbox.addEventListener("change", () => {
      clusterMode = checkbox.checked ? "max" : "min";
      renderMarkers();
      saveState();
    });
  }

  function setupHeatmapToggle() {
    const checkbox = document.getElementById("heatmap-checkbox");
    checkbox.addEventListener("change", () => {
      heatmapOn = checkbox.checked;
      if (allStations) renderMarkers();
      saveState();
    });
  }

  function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // km
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function setupNearMe() {
    const btn = document.getElementById("nearme-btn");
    const radiusSelect = document.getElementById("radius-input");
    const status = document.getElementById("nearme-status");

    btn.addEventListener("click", () => {
      if (nearMeActive) {
        // Deactivate
        nearMeActive = false;
        userLocation = null;
        if (userMarker) {
          map.removeLayer(userMarker);
          userMarker = null;
        }
        btn.classList.remove("active");
        btn.innerHTML = "&#9737; Šalia manęs";
        status.textContent = "";
        map.setView(MAP_CENTER, MAP_ZOOM);
        renderMarkers();
        return;
      }

      if (!navigator.geolocation) {
        status.textContent = "Naršyklė nepalaiko vietos nustatymo.";
        return;
      }

      btn.disabled = true;
      status.textContent = "Nustatoma vieta...";

      function onPosition(pos) {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        nearMeActive = true;
        btn.disabled = false;
        btn.classList.add("active");
        btn.innerHTML = "&#10005; Išjungti";
        status.textContent = "";

        // Add user marker
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([userLocation.lat, userLocation.lng], {
          icon: L.divIcon({
            className: "user-location-marker",
            html: '<div class="user-dot"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          zIndexOffset: 1000,
        })
          .addTo(map)
          .bindPopup("Jūsų vieta");

        const radius = parseInt(radiusSelect.value);
        map.setView([userLocation.lat, userLocation.lng], radius <= 10 ? 12 : radius <= 25 ? 10 : 9);
        if (allStations) {
          renderMarkers();
        }
      }

      function onError(err) {
        btn.disabled = false;
        if (err.code === 1) {
          status.textContent = "Vietos prieiga uždrausta.";
        } else if (err.code === 3) {
          status.textContent = "Vietos nustatymas užtruko per ilgai.";
        } else {
          status.textContent = "Nepavyko nustatyti vietos.";
        }
      }

      navigator.geolocation.getCurrentPosition(onPosition, onError, {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 300000,
      });
    });

    radiusSelect.addEventListener("change", () => {
      saveState();
      if (nearMeActive) {
        const radius = parseInt(radiusSelect.value);
        map.setView([userLocation.lat, userLocation.lng], radius <= 10 ? 12 : radius <= 25 ? 10 : 9);
        renderMarkers();
      }
    });
  }

  // --- Multi-select dropdown ---
  // Options:
  //   maxSelected:   number — block further selection past this count.
  //                  Also hides the "Visi" button and changes the empty-label
  //                  text since "all" isn't a valid state when capped.
  //   initialChecked: Set<string> | null — initial selection.
  //                   Defaults to "all checked" (legacy behavior) when omitted.
  function initMultiSelect(containerId, items, onChangeCallback, options = {}) {
    const container = document.getElementById(containerId);
    const btn = container.querySelector(".multi-select-btn");
    const dropdown = container.querySelector(".multi-select-dropdown");
    const optionsDiv = container.querySelector(".multi-select-options");
    const labelSpan = container.querySelector(".multi-select-label");
    const actionsDiv = container.querySelector(".multi-select-actions");

    const maxSelected = options.maxSelected || null;
    const initialChecked = options.initialChecked || null;

    optionsDiv.innerHTML = items.map(item => {
      const value = typeof item === "string" ? item : item.value;
      const label = typeof item === "string" ? item : item.label;
      const checked = initialChecked == null ? true : initialChecked.has(value);
      return `<label class="multi-select-option">
        <input type="checkbox" value="${value.replace(/"/g, "&quot;")}"${checked ? " checked" : ""}>
        <span>${label}</span>
      </label>`;
    }).join("");

    // When a max is set, "Visi" no longer makes sense — hide that action.
    if (maxSelected && actionsDiv) {
      const allBtn = actionsDiv.querySelector('button[data-action="all"]');
      if (allBtn) allBtn.style.display = "none";
    }

    function getSelected() {
      const checked = optionsDiv.querySelectorAll("input:checked");
      const all = optionsDiv.querySelectorAll("input");
      if (!maxSelected && checked.length === all.length) return null; // all selected sentinel
      return new Set([...checked].map(cb => cb.value));
    }

    function updateLabel() {
      const checked = optionsDiv.querySelectorAll("input:checked");
      const all = optionsDiv.querySelectorAll("input");
      if (checked.length === 0) {
        labelSpan.textContent = maxSelected ? "Pasirinkti…" : "Nepasirinkta";
      } else if (!maxSelected && checked.length === all.length) {
        labelSpan.textContent = "Visi";
      } else if (checked.length <= 2) {
        labelSpan.textContent = [...checked].map(cb => cb.value).join(", ");
      } else {
        labelSpan.textContent = `${checked.length}${maxSelected ? "/" + maxSelected : " iš " + all.length}`;
      }
    }

    // Disable unchecked boxes once the cap is hit so a user gets a clear
    // signal rather than a silent click that does nothing.
    function refreshDisabledAtCap() {
      if (!maxSelected) return;
      const checked = optionsDiv.querySelectorAll("input:checked");
      const atCap = checked.length >= maxSelected;
      optionsDiv.querySelectorAll("input").forEach(cb => {
        cb.disabled = atCap && !cb.checked;
      });
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".multi-select-dropdown.open").forEach(d => {
        if (d !== dropdown) d.classList.remove("open");
      });
      dropdown.classList.toggle("open");
    });

    container.querySelectorAll(".multi-select-actions button").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = b.dataset.action;
        optionsDiv.querySelectorAll("input").forEach(cb => { cb.checked = action === "all"; });
        refreshDisabledAtCap();
        updateLabel();
        onChangeCallback(getSelected());
      });
    });

    optionsDiv.addEventListener("change", (e) => {
      // Enforce the cap on the latest click instead of silently allowing it.
      if (maxSelected) {
        const checked = optionsDiv.querySelectorAll("input:checked");
        if (checked.length > maxSelected && e.target.checked) {
          e.target.checked = false;
          return;
        }
      }
      refreshDisabledAtCap();
      updateLabel();
      onChangeCallback(getSelected());
    });

    document.addEventListener("click", (e) => {
      if (!container.contains(e.target)) {
        dropdown.classList.remove("open");
      }
    });

    refreshDisabledAtCap();
    updateLabel();

    return {
      setSelected(values) {
        if (!values) return;
        const valSet = new Set(values);
        optionsDiv.querySelectorAll("input").forEach(cb => {
          cb.checked = valSet.has(cb.value);
        });
        refreshDisabledAtCap();
        updateLabel();
        onChangeCallback(getSelected());
      }
    };
  }

  let companyMultiSelect = null;
  let regionMultiSelect = null;

  function setupFilters() {
    // Region filter (static)
    const regionNames = Object.keys(REGIONS).sort((a, b) => a.localeCompare(b, "lt"));
    regionMultiSelect = initMultiSelect("region-filter", regionNames, (selected) => {
      selectedRegions = selected;
      renderMarkers();
      saveState();
    });

    let searchTimeout;
    document.getElementById("search-input").addEventListener("input", () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        renderMarkers();
        saveState();
      }, 300);
    });
  }

  function populateCompanyFilter() {
    const counts = {};
    for (const s of allStations) {
      counts[s.company] = (counts[s.company] || 0) + 1;
    }
    const companies = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "lt"))
      .map(c => ({ value: c, label: `${c} (${counts[c]})` }));
    companyMultiSelect = initMultiSelect("company-filter", companies, (selected) => {
      selectedCompanies = selected;
      renderMarkers();
      saveState();
    });
  }

  // --- Side Panel Management ---
  let activeSideView = null; // "list" or "trends"

  function openSidePanel(view) {
    const panel = document.getElementById("side-panel");
    const title = document.getElementById("side-panel-title");

    // If same view is open, close it
    if (activeSideView === view) {
      closeSidePanel();
      return;
    }

    // Hide all views
    document.querySelectorAll(".side-view").forEach(v => v.classList.add("hidden"));

    if (view === "list") {
      title.textContent = "Degalinių sąrašas";
      document.getElementById("list-view").classList.remove("hidden");
    } else if (view === "route") {
      title.textContent = "Maršrutas";
      document.getElementById("route-view").classList.remove("hidden");
    } else {
      title.textContent = "Kainų tendencijos";
      document.getElementById("trends-view").classList.remove("hidden");
    }

    panel.classList.remove("hidden");
    document.body.classList.add("side-open");
    activeSideView = view;

    // Update button highlights
    document.getElementById("list-btn").classList.toggle("active", view === "list");
    document.getElementById("trends-btn").classList.toggle("active", view === "trends");
    document.getElementById("route-btn").classList.toggle("active", view === "route");

    // Leaflet needs to know the map container resized
    setTimeout(() => map.invalidateSize(), 350);
  }

  function closeSidePanel() {
    document.getElementById("side-panel").classList.add("hidden");
    document.body.classList.remove("side-open");
    activeSideView = null;
    document.getElementById("list-btn").classList.remove("active");
    document.getElementById("trends-btn").classList.remove("active");
    document.getElementById("route-btn").classList.remove("active");
    stopRoutePicking();
    clearRouteVisuals();
    if (!map.hasLayer(markerCluster)) map.addLayer(markerCluster);
    setTimeout(() => map.invalidateSize(), 350);
  }

  // --- Station List ---
  let listFuel = "petrol95";
  let listSort = "price";

  function setupListView() {
    document.getElementById("list-btn").addEventListener("click", () => {
      listFuel = currentFuel;
      document.querySelectorAll(".list-fuel-tab").forEach(b => {
        b.classList.toggle("active", b.dataset.fuel === listFuel);
      });
      renderStationList();
      openSidePanel("list");
    });

    document.querySelectorAll(".list-fuel-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".list-fuel-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        listFuel = btn.dataset.fuel;
        renderStationList();
      });
    });

    document.querySelectorAll(".sort-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".sort-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        listSort = btn.dataset.sort;
        renderStationList();
      });
    });

    let listSearchTimeout;
    document.getElementById("list-search").addEventListener("input", () => {
      clearTimeout(listSearchTimeout);
      listSearchTimeout = setTimeout(renderStationList, 200);
    });

    // Close button
    document.getElementById("side-panel-close").addEventListener("click", closeSidePanel);
  }

  function renderStationList() {
    if (!allStations) return;
    const container = document.getElementById("station-list");
    const search = document.getElementById("list-search").value.toLowerCase();
    const avg = averages ? averages[listFuel] : null;

    let stations = allStations.filter(s => {
      if (!s.lat || !s.lng) return false;
      if (search) {
        const hay = `${s.company} ${s.address} ${s.municipality}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    if (listSort === "price") {
      stations.sort((a, b) => {
        const pa = a.prices[listFuel], pb = b.prices[listFuel];
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });
    } else if (listSort === "company") {
      stations.sort((a, b) => a.company.localeCompare(b.company, "lt"));
    } else {
      stations.sort((a, b) => a.address.localeCompare(b.address, "lt"));
    }

    const html = stations.map(s => {
      const price = s.prices[listFuel];
      const change = s.priceChange ? s.priceChange[listFuel] : null;
      const priceClass = price == null ? "price-na" :
        avg && (price - avg) / avg < -0.02 ? "price-low" :
        avg && (price - avg) / avg > 0.02 ? "price-high" : "price-mid";
      const priceStr = price != null ? price.toFixed(3) + " \u20ac" : "—";

      let changeStr = "";
      if (change != null && change !== 0) {
        const cls = change > 0 ? "change-up" : "change-down";
        const sign = change > 0 ? "+" : "";
        changeStr = `<div class="station-price-change ${cls}">${sign}${change.toFixed(3)}</div>`;
      }

      return `<div class="station-item" data-lat="${s.lat}" data-lng="${s.lng}">
        <div class="station-info">
          <div class="station-name">${s.company}</div>
          <div class="station-addr">${s.address}, ${s.municipality}</div>
        </div>
        <div class="station-price-col">
          <div class="station-price-val ${priceClass}">${priceStr}</div>
          ${changeStr}
        </div>
      </div>`;
    }).join("");

    container.innerHTML = html;

    container.querySelectorAll(".station-item").forEach(item => {
      item.addEventListener("click", () => {
        const lat = parseFloat(item.dataset.lat);
        const lng = parseFloat(item.dataset.lng);
        map.setView([lat, lng], 15);
      });
    });
  }

  // --- Price Trends ---
  // The trends panel supports four "splits": overall (entire country), by
  // gas-station network, by region, and by individual station. Each split
  // has its own data file; we lazy-load it on first use and cache it.
  //
  // The render path is deliberately uniform: whichever split is active,
  // we compute `trendsData = [{date, stats: {petrol95, diesel, lpg}}, ...]`
  // for the chosen entity, then call the same chart/table renderers.
  let trendsFuel = "petrol95";
  let trendsSplit = "overall"; // "overall" | "network" | "region" | "station"
  let trendsEntity = null;     // station id (single, for "station" split)
  let trendsSelectedNetworks = null; // Set<string> | null (null = all selected)
  let trendsSelectedRegions = null;  // Set<string> | null
  let trendsNetworkMS = null; // multi-select instance (lazy-created)
  let trendsRegionMS = null;
  let trendsSelectedChains = null; // Set<string> | null (competition split)
  let trendsChainMS = null;
  let compUnit = "pct"; // competition premium display: "ct" | "pct"

  // Raw cached payloads, populated on demand by ensureSplitData().
  const trendsRaw = {
    overall: null,   // [{date, petrol95, diesel, lpg}, ...]
    network: null,   // Map<network, [{date, petrol95, diesel, lpg}, ...]>
    region:  null,   // Map<region,  [{date, petrol95, diesel, lpg}, ...]>
    station: null,   // { dates: [...], stations: { id: { company, address, municipality, p95:[], diesel:[], lpg:[] } } }
  };

  // Derived view, refreshed every time the user changes split/entity.
  let trendsData = []; // [{ date, stats: { petrol95: {min,avg,median,max}, ... } }]

  function setupTrendsView() {
    document.getElementById("trends-btn").addEventListener("click", () => {
      trendsFuel = currentFuel;
      // Reopen in whichever mode was last active (prices vs competition).
      setTrendsMode(trendsSplit === "competition" ? "competition" : "prices");
      openSidePanel("trends");
      loadTrendsData();
    });

    document.querySelectorAll(".trends-mode-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        if ((trendsSplit === "competition") === (mode === "competition")) return;
        trendsEntity = null;
        setTrendsMode(mode);
        loadTrendsData();
      });
    });

    document.querySelectorAll(".trends-fuel-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".trends-fuel-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        trendsFuel = btn.dataset.fuel;
        // "Visi degalai" combines all fuels into one view; splits and the
        // entity picker aren't meaningful there, so hide them and snap
        // back to overall.
        if (trendsFuel === "all") {
          if (trendsSplit !== "overall") {
            trendsSplit = "overall";
            document.querySelectorAll(".trends-split-tab").forEach(b => {
              b.classList.toggle("active", b.dataset.split === "overall");
            });
            loadTrendsData();
          } else {
            applySplitVisibility();
            renderTrendsChartAndTable();
          }
        } else {
          applySplitVisibility();
          renderTrendsChartAndTable();
        }
      });
    });

    document.querySelectorAll(".trends-split-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const split = btn.dataset.split;
        if (split === trendsSplit) return;
        document.querySelectorAll(".trends-split-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        trendsSplit = split;
        // Reset the station-specific selection but keep network/region picks
        // sticky across split toggles so the user doesn't lose them.
        trendsEntity = null;
        loadTrendsData();
      });
    });

    // Competition-only ct/% unit toggle. Both units are precomputed, so this is
    // a pure re-render of the verdict + heatmap.
    document.querySelectorAll(".comp-unit-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.unit === compUnit) return;
        compUnit = btn.dataset.unit;
        document.querySelectorAll(".comp-unit-tab").forEach(b => b.classList.toggle("active", b === btn));
        renderTrendsChartAndTable();
      });
    });

    setupStationSearch();
  }

  function applySplitVisibility() {
    const splitTabs = document.getElementById("trends-split-tabs");
    // The split row belongs to the "prices" mode only; the competition mode is
    // a separate trend tab with its own (chain) picker, so hide splits there.
    const isComp = trendsSplit === "competition";
    splitTabs.classList.toggle("hidden", isComp || trendsFuel === "all");
    if (trendsFuel === "all") {
      // Picker is split-driven; if splits are hidden, hide the picker too.
      document.getElementById("trends-entity-picker").classList.add("hidden");
    }
  }

  // Switches the trends panel between its two top-level tabs: "prices" (the
  // fuel/split charts) and "competition" (the network-premium heatmap). The
  // competition tab is single-fuel, so it drops the "Visi degalai" option.
  function setTrendsMode(mode) {
    const isComp = mode === "competition";
    document.querySelectorAll(".trends-mode-tab").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === mode));
    document.querySelector('.trends-fuel-tab[data-fuel="all"]').classList.toggle("hidden", isComp);
    if (isComp) {
      if (trendsFuel === "all") trendsFuel = "petrol95";
      trendsSplit = "competition";
    } else if (trendsSplit === "competition") {
      trendsSplit = "overall";
    }
    document.querySelectorAll(".trends-fuel-tab").forEach(b =>
      b.classList.toggle("active", b.dataset.fuel === trendsFuel));
    document.querySelectorAll(".trends-split-tab").forEach(b =>
      b.classList.toggle("active", b.dataset.split === trendsSplit));
    applySplitVisibility();
  }

  async function loadTrendsData() {
    showLoading("Kraunama...");
    try {
      await ensureSplitData(trendsSplit);
      // Any non-overall split overlays the Lithuania-wide avg as a faint
      // comparison line, so we always need overall data alongside it.
      if (trendsSplit !== "overall") await ensureSplitData("overall");
    } catch (e) {
      console.error(e);
      showLoading("Nepavyko užkrauti duomenų");
      return;
    }
    refreshEntityPicker();
    computeAndRender();
  }

  function showLoading(msg) {
    document.getElementById("trends-chart").innerHTML =
      `<div style="text-align:center;color:var(--text-dim);padding:20px">${msg}</div>`;
    document.getElementById("trends-table").innerHTML = "";
  }

  async function ensureSplitData(split) {
    if (trendsRaw[split]) return;
    if (split === "overall") {
      const text = await (await fetch("data/price-trends.jsonl")).text();
      trendsRaw.overall = parseJsonl(text);
    } else if (split === "network" || split === "region") {
      const file = split === "network" ? "trends-by-network.jsonl" : "trends-by-region.jsonl";
      const text = await (await fetch(`data/${file}`)).text();
      const rows = parseJsonl(text);
      const grouped = new Map();
      const groupKey = split === "network" ? "network" : "region";
      for (const r of rows) {
        if (!grouped.has(r[groupKey])) grouped.set(r[groupKey], []);
        grouped.get(r[groupKey]).push(r);
      }
      for (const arr of grouped.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
      trendsRaw[split] = grouped;
    } else if (split === "station" || split === "competition") {
      // Competition derives chain-vs-cheapest premiums from per-station prices,
      // so it shares the station-history payload with the "station" split.
      if (!trendsRaw.station) {
        trendsRaw.station = await (await fetch("data/station-history.json")).json();
      }
    }
  }

  function parseJsonl(text) {
    return text.trim().split("\n").filter(l => l).map(JSON.parse);
  }

  function refreshEntityPicker() {
    const picker = document.getElementById("trends-entity-picker");
    const label = document.getElementById("trends-entity-label");
    const netMS = document.getElementById("trends-network-multiselect");
    const regMS = document.getElementById("trends-region-multiselect");
    const chainMS = document.getElementById("trends-chain-multiselect");
    const stationSearch = document.getElementById("trends-station-search");
    const stationSugg = document.getElementById("trends-station-suggestions");
    const unitBar = document.getElementById("trends-comp-unit");

    // The ct/% unit toggle only applies to the competition heatmap.
    unitBar.classList.toggle("hidden", trendsSplit !== "competition");

    if (trendsSplit === "overall") {
      picker.classList.add("hidden");
      return;
    }
    picker.classList.remove("hidden");

    // Hide everything, then reveal the one for the active split.
    netMS.classList.add("hidden");
    regMS.classList.add("hidden");
    chainMS.classList.add("hidden");
    stationSearch.classList.add("hidden");
    stationSugg.classList.add("hidden");

    if (trendsSplit === "network") {
      label.textContent = "Tinklas:";
      netMS.classList.remove("hidden");
      if (!trendsNetworkMS) {
        const items = buildEntityItems(trendsRaw.network);
        const top3 = new Set(items.slice(0, 3).map(it => it.value));
        trendsSelectedNetworks = top3;
        trendsNetworkMS = initMultiSelect("trends-network-multiselect", items, (sel) => {
          trendsSelectedNetworks = sel;
          computeAndRender();
        }, { maxSelected: 3, initialChecked: top3 });
      }
    } else if (trendsSplit === "region") {
      label.textContent = "Regionas:";
      regMS.classList.remove("hidden");
      if (!trendsRegionMS) {
        const items = buildEntityItems(trendsRaw.region);
        const top3 = new Set(items.slice(0, 3).map(it => it.value));
        trendsSelectedRegions = top3;
        trendsRegionMS = initMultiSelect("trends-region-multiselect", items, (sel) => {
          trendsSelectedRegions = sel;
          computeAndRender();
        }, { maxSelected: 3, initialChecked: top3 });
      }
    } else if (trendsSplit === "station") {
      label.textContent = "Degalinė:";
      stationSearch.classList.remove("hidden");
      const meta = trendsEntity ? trendsRaw.station.stations[trendsEntity] : null;
      stationSearch.value = meta ? `${meta.company} — ${meta.address}` : "";
    } else if (trendsSplit === "competition") {
      label.textContent = "Tinklas:";
      chainMS.classList.remove("hidden");
      if (!trendsChainMS) {
        const items = buildChainItems();
        // Default to the 10 biggest networks; the user can add any/all of them.
        const topN = new Set(items.slice(0, 10).map(it => it.value));
        trendsSelectedChains = topN;
        trendsChainMS = initMultiSelect("trends-chain-multiselect", items, (sel) => {
          trendsSelectedChains = sel;
          computeAndRender();
        }, { initialChecked: topN });
      }
    }
  }

  // Chain picker items for the competition split, built straight from the
  // station-history payload (ranked by number of stations in the chain).
  function buildChainItems() {
    const counts = new Map();
    for (const s of Object.values(trendsRaw.station.stations)) {
      counts.set(s.company, (counts.get(s.company) || 0) + 1);
    }
    const items = [...counts.entries()].map(([value, count]) => ({
      value, count, label: `${escapeText(value)} <span class="entity-count">(${count})</span>`,
    }));
    items.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "lt"));
    return items;
  }

  // `trendsEntitiesData` holds [{label, rows}] for multi-entity views
  // (network/region). For overall and station views it's null and the
  // chart falls back to the single-series `trendsData`.
  let trendsEntitiesData = null;

  function computeAndRender() {
    trendsData = [];
    trendsEntitiesData = null;
    if (trendsSplit === "overall") {
      const rows = trendsRaw.overall || [];
      trendsData = rows.map(r => ({
        date: r.date,
        stats: { petrol95: r.petrol95, diesel: r.diesel, lpg: r.lpg },
      })).sort((a, b) => a.date.localeCompare(b.date));
    } else if (trendsSplit === "network" || trendsSplit === "region") {
      const grouped = trendsRaw[trendsSplit];
      const selected = trendsSplit === "network" ? trendsSelectedNetworks : trendsSelectedRegions;
      const keys = [...grouped.keys()].sort((a, b) => a.localeCompare(b, "lt"));
      const active = keys.filter(k => !selected || selected.has(k));
      trendsEntitiesData = active.map(k => ({
        label: k,
        rows: (grouped.get(k) || []).map(r => ({
          date: r.date,
          stats: { petrol95: r.petrol95, diesel: r.diesel, lpg: r.lpg },
        })),
      }));
      // Use the longest series as the date axis backbone.
      const longest = trendsEntitiesData.reduce((best, e) => e.rows.length > (best?.rows.length || 0) ? e : best, null);
      trendsData = longest ? longest.rows.map(r => ({ date: r.date, stats: {} })) : [];
    } else if (trendsSplit === "station") {
      if (trendsEntity && trendsRaw.station) {
        const s = trendsRaw.station.stations[trendsEntity];
        if (s) {
          const dates = trendsRaw.station.dates;
          const collapse = (v) => v == null ? null : { min: v, avg: v, median: v, max: v };
          trendsData = dates.map((d, i) => ({
            date: d,
            stats: { petrol95: collapse(s.p95[i]), diesel: collapse(s.diesel[i]), lpg: collapse(s.lpg[i]) },
          }));
        }
      }
    } else if (trendsSplit === "competition") {
      trendsEntitiesData = computeCompetitionSeries();
      const longest = trendsEntitiesData.reduce((best, e) => e.rows.length > (best?.rows.length || 0) ? e : best, null);
      trendsData = longest ? longest.rows.map(r => ({ date: r.date, stats: {} })) : [];
    }
    renderTrendsChartAndTable();
  }

  // Competition view: for each selected chain, how far its daily MEDIAN price
  // sits ABOVE OR BELOW the national average (median across all stations) that
  // day. Negative = cheaper than the market (green), ~0 = at the market (white),
  // positive = pricier (red). Computed for all three fuels so switching the fuel
  // tab is a pure re-render.
  function computeCompetitionSeries() {
    const sd = trendsRaw.station;
    if (!sd) return [];
    const FUELS = [["petrol95", "p95"], ["diesel", "diesel"], ["lpg", "lpg"]];
    const dates = sd.dates;
    const stations = Object.values(sd.stations);
    const median = (arr) => arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null;

    // National average price (median across every station) per fuel per day.
    const natMed = {};
    for (const [fk, ak] of FUELS) {
      natMed[fk] = dates.map((_, i) => {
        const vals = [];
        for (const s of stations) { const v = s[ak][i]; if (v) vals.push(v); }
        vals.sort((a, b) => a - b);
        return median(vals);
      });
    }

    const byChain = new Map();
    for (const s of stations) {
      if (!byChain.has(s.company)) byChain.set(s.company, []);
      byChain.get(s.company).push(s);
    }
    const chains = [...byChain.keys()]
      .filter(c => !trendsSelectedChains || trendsSelectedChains.has(c))
      .sort((a, b) => a.localeCompare(b, "lt"));

    return chains.map(co => ({
      label: co,
      rows: dates.map((d, i) => {
        const stats = {};
        for (const [fk, ak] of FUELS) {
          const nat = natMed[fk][i];
          if (nat == null) continue;
          const vals = byChain.get(co).map(s => s[ak][i]).filter(v => v).sort((a, b) => a - b);
          if (vals.length === 0) continue;
          const dev = median(vals) - nat; // €/L vs the national average (signed)
          // `avg` is the absolute deviation in €; `pct` is the same relative to
          // the average, so the heatmap/verdict can switch units freely.
          stats[fk] = { avg: dev, pct: nat ? dev / nat : null };
        }
        return Object.keys(stats).length ? { date: d, stats } : null;
      }).filter(Boolean),
    })).filter(e => e.rows.length > 0);
  }

  // Renders the plain-language verdict above the competition chart. Pass null
  // (any non-competition view) to hide it.
  function renderCompetitionNote(fuelKey) {
    const el = document.getElementById("trends-competition-note");
    if (!fuelKey || !Array.isArray(trendsEntitiesData) || trendsEntitiesData.length === 0) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }

    const val = (s) => compUnit === "pct" ? s.pct : s.avg; // fraction either way
    const U = compUnit === "pct" ? "%" : "ct";
    const eps = compUnit === "pct" ? 0.005 : 0.01; // "no change" band (0.5 pp / 1 ct)
    const fmt = (x) => (x * 100).toFixed(1); // fraction → ct or percentage points
    const winAvg = (arr, from, len) => {
      const sl = arr.slice(from, from + len);
      return sl.reduce((s, v) => s + v, 0) / sl.length;
    };

    // Per-date average DISTANCE from the market average across the shown chains
    // (absolute deviation). Smaller = networks cluster near the market price.
    const perDate = new Map();
    for (const e of trendsEntitiesData) {
      for (const r of e.rows) {
        const s = r.stats[fuelKey];
        if (!s || val(s) == null) continue;
        if (!perDate.has(r.date)) perDate.set(r.date, []);
        perDate.get(r.date).push(Math.abs(val(s)));
      }
    }
    if (perDate.size === 0) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const dates = [...perDate.keys()].sort();
    const avgSeries = dates.map(d => {
      const a = perDate.get(d);
      return a.reduce((s, v) => s + v, 0) / a.length;
    });

    // Compare the first vs last window of days rather than raw endpoints:
    // daily prices swing on a weekly (weekend) cycle, so two single days can
    // disagree purely by phase. Window averaging gives a robust trend read.
    const w = Math.max(1, Math.min(5, Math.floor(avgSeries.length / 3)));
    const firstAvg = winAvg(avgSeries, 0, w);
    const lastAvg = winAvg(avgSeries, avgSeries.length - w, w);
    const change = lastAvg - firstAvg; // +ve = spread grew = less convergence

    let verdict, cls;
    if (change <= -eps) {
      verdict = `Tinklų kainos PRIARTĖJO prie rinkos vidurkio (vid. skirtumas ${fmt(firstAvg)} → ${fmt(lastAvg)} ${U}) — kainos labiau suvienodėjo, t. y. konkurencija STIPRĖJA.`;
      cls = "up";
    } else if (change >= eps) {
      verdict = `Tinklų kainos NUTOLO nuo rinkos vidurkio (vid. skirtumas ${fmt(firstAvg)} → ${fmt(lastAvg)} ${U}) — kainų skirtumai padidėjo, konkurencijos stiprėjimo nematyti.`;
      cls = "down";
    } else {
      verdict = `Tinklų atstumas iki rinkos vidurkio beveik nepakito (${fmt(firstAvg)} → ${fmt(lastAvg)} ${U}) — aiškaus konkurencijos pokyčio nematyti.`;
      cls = "flat";
    }

    const periodLabel = `${dates[0].slice(5)}–${dates[dates.length - 1].slice(5)}`;
    el.classList.remove("hidden");
    el.innerHTML = `
      <div class="comp-verdict comp-${cls}">${verdict}</div>
      <div class="comp-method">Žemėlapyje – kiek kiekvieno tinklo savaitės <b>mediana</b> skiriasi nuo <b>Lietuvos vidurkio</b> (${FUEL_LABELS[fuelKey]}, ${U}). Žalia = pigiau už vidurkį, balta ≈ vidurkis, raudona = brangiau. ${periodLabel}.</div>`;
  }

  // Heatmap: networks (rows) × weeks (columns), cell colour = how far that
  // network's weekly median sat above (red) or below (green) the national
  // average, white ≈ at the average. A row drifting toward white over the weeks
  // is a network converging on the market price.
  function renderCompetitionHeatmap(fuelKey) {
    const el = document.getElementById("trends-chart");
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    if (!Array.isArray(trendsEntitiesData) || trendsEntitiesData.length === 0) {
      el.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:20px">Pasirinkite bent vieną tinklą</div>`;
      return;
    }

    const dayIndex = (d) => { const [y, m, da] = d.split("-").map(Number); return Date.UTC(y, m - 1, da) / 86400000; };
    const allDates = [...new Set(trendsEntitiesData.flatMap(e => e.rows.map(r => r.date)))].sort();
    if (allDates.length === 0) { el.innerHTML = ""; return; }
    const base = dayIndex(allDates[0]);
    const weekOf = (d) => Math.floor((dayIndex(d) - base) / 7);
    const weeks = [...new Set(allDates.map(weekOf))].sort((a, b) => a - b);
    const weekLabel = {};
    for (const d of allDates) { const wk = weekOf(d); if (weekLabel[wk] == null) weekLabel[wk] = d; }

    const val = (s) => compUnit === "pct" ? s.pct : s.avg; // signed, fraction either way
    const U = compUnit === "pct" ? "%" : "ct";
    // ct shows whole cents; % shows one decimal. Signed: "+5" above avg, "-3" below.
    const mag = (v) => compUnit === "pct" ? (v * 100).toFixed(1) : String(Math.round(v * 100));
    const cellText = (v) => (v > 0 ? "+" : "") + mag(v);

    // Build one deviation-per-week value per network, plus a row mean for sorting.
    const rows = trendsEntitiesData.map(e => {
      const buckets = new Map(); // week -> [deviations]
      for (const r of e.rows) {
        const s = r.stats[fuelKey];
        if (!s || val(s) == null) continue;
        const wk = weekOf(r.date);
        if (!buckets.has(wk)) buckets.set(wk, []);
        buckets.get(wk).push(val(s));
      }
      const cells = weeks.map(wk => {
        const a = buckets.get(wk);
        return a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
      });
      const present = cells.filter(v => v != null);
      const mean = present.length ? present.reduce((s, v) => s + v, 0) / present.length : Infinity;
      return { label: e.label, cells, mean };
    }).filter(r => r.cells.some(v => v != null));

    // Priciest (above average) networks at the top, cheapest at the bottom.
    rows.sort((a, b) => b.mean - a.mean);
    const maxAbs = Math.max(...rows.flatMap(r => r.cells.filter(v => v != null).map(Math.abs)), 0.001);

    // Diverging scale: green (below avg) → white/neutral (at avg) → red (above).
    const swatch = (t) => { // t in [-1, 1]
      const m = Math.min(1, Math.abs(t));
      const hue = t >= 0 ? 8 : 145; // red vs green
      const L = isDark ? 26 + m * 20 : 97 - m * 45;
      const S = isDark ? m * 60 : m * 78;
      return { bg: `hsl(${hue}, ${S}%, ${L}%)`, L };
    };
    const cellColor = (v) => {
      const { bg, L } = swatch(v / maxAbs);
      const fg = isDark ? "#eee" : (L < 60 ? "#fff" : "#222");
      return { bg, fg };
    };

    const headCells = weeks.map(wk => `<th>${weekLabel[wk].slice(5)}</th>`).join("");
    const bodyRows = rows.map(r => {
      const tds = r.cells.map(v => {
        if (v == null) return `<td class="heat-empty">·</td>`;
        const { bg, fg } = cellColor(v);
        return `<td style="background:${bg};color:${fg}">${cellText(v)}</td>`;
      }).join("");
      return `<tr><th class="heat-row-label" title="${escapeAttr(r.label)}">${escapeText(r.label)}</th>${tds}</tr>`;
    }).join("");

    // Diverging colour-scale legend: −max (green) … 0 … +max (red).
    const legendStops = [-1, -0.5, 0, 0.5, 1].map(t => swatch(t).bg).join(", ");

    el.innerHTML = `
      <div class="comp-heat-wrap">
        <table class="comp-heat">
          <thead><tr><th class="heat-corner">Tinklas</th>${headCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <div class="comp-heat-legend">
        <span>−${mag(maxAbs)} ${U}<br>pigiau</span>
        <span class="comp-heat-bar" style="background:linear-gradient(to right, ${legendStops})"></span>
        <span>+${mag(maxAbs)} ${U}<br>brangiau</span>
      </div>`;
  }

  function renderTrendsChartAndTable() {
    if (trendsData.length === 0) {
      const msg = trendsSplit === "station" && !trendsEntity
        ? "Pasirinkite degalinę"
        : "Nėra duomenų";
      document.getElementById("trends-chart").innerHTML =
        `<div style="text-align:center;color:var(--text-dim);padding:20px">${msg}</div>`;
      document.getElementById("trends-table").innerHTML = "";
      document.getElementById("trends-competition-note").classList.add("hidden");
      return;
    }
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    // Competition is always a single-fuel view (premiums for one fuel at a time).
    const showAll = trendsFuel === "all" && trendsSplit !== "competition";
    const compFuel = trendsFuel === "all" ? "petrol95" : trendsFuel;
    const fuels = showAll
      ? [
          { key: "petrol95", label: "95 benzinas", color: isDark ? "#e0e0e0" : "#111111" },
          { key: "diesel", label: "Dyzelinas", color: isDark ? "#888888" : "#666666" },
          { key: "lpg", label: "SND", color: isDark ? "#555555" : "#bbbbbb" },
        ]
      : [{ key: trendsSplit === "competition" ? compFuel : trendsFuel,
          label: FUEL_LABELS[trendsSplit === "competition" ? compFuel : trendsFuel],
          color: isDark ? "#e0e0e0" : "#111111" }];

    if (trendsSplit === "competition") {
      renderCompetitionNote(compFuel);
      renderCompetitionHeatmap(compFuel);
      document.getElementById("trends-table").innerHTML = "";
      return;
    }

    renderCompetitionNote(null);
    renderTrendsChart(fuels, showAll);
    if (Array.isArray(trendsEntitiesData) && trendsEntitiesData.length > 0) {
      // Multi-entity tables would have one column per entity which is
      // unreadable at typical widths. The chart legend already names them.
      document.getElementById("trends-table").innerHTML = "";
    } else {
      renderTrendsTable(fuels, showAll);
    }
  }

  function setupStationSearch() {
    const input = document.getElementById("trends-station-search");
    const sugg = document.getElementById("trends-station-suggestions");
    let activeTimer = null;

    input.addEventListener("input", () => {
      clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        const q = input.value.trim().toLowerCase();
        if (!q || !trendsRaw.station) {
          sugg.classList.add("hidden");
          sugg.innerHTML = "";
          return;
        }
        const matches = [];
        for (const [id, s] of Object.entries(trendsRaw.station.stations)) {
          const hay = `${s.company} ${s.address} ${s.municipality}`.toLowerCase();
          if (hay.includes(q)) {
            matches.push({ id, ...s });
            if (matches.length >= 25) break;
          }
        }
        if (matches.length === 0) {
          sugg.innerHTML = `<div class="trends-station-sugg-item" style="color:var(--text-muted)">Nieko nerasta</div>`;
        } else {
          sugg.innerHTML = matches.map(m =>
            `<div class="trends-station-sugg-item" data-id="${escapeAttr(m.id)}">
               <div>${escapeText(m.company)}</div>
               <div class="suggestion-secondary">${escapeText(m.address)}, ${escapeText(m.municipality || "")}</div>
             </div>`
          ).join("");
          sugg.querySelectorAll(".trends-station-sugg-item[data-id]").forEach(el => {
            el.addEventListener("click", () => {
              trendsEntity = el.dataset.id;
              const meta = trendsRaw.station.stations[trendsEntity];
              input.value = meta ? `${meta.company} — ${meta.address}` : "";
              sugg.classList.add("hidden");
              computeAndRender();
            });
          });
        }
        sugg.classList.remove("hidden");
      }, 150);
    });

    input.addEventListener("focus", () => {
      if (sugg.children.length > 0) sugg.classList.remove("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !sugg.contains(e.target)) {
        sugg.classList.add("hidden");
      }
    });
  }

  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function escapeText(s) { return String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // Build {value, label, count} items sorted by station count descending.
  // The count is taken from the most recent date a group appears in, which
  // is what "most gas stations" intuitively means to the user. Ties break
  // alphabetically so the list is stable day-to-day.
  function buildEntityItems(grouped) {
    const items = [];
    for (const [key, rows] of grouped.entries()) {
      const latest = rows.reduce((b, r) => !b || r.date > b.date ? r : b, null);
      const count = latest && typeof latest.count === "number" ? latest.count : 0;
      items.push({ value: key, label: `${escapeText(key)} <span class="entity-count">(${count})</span>`, count });
    }
    items.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "lt"));
    return items;
  }

  function renderTrendsChart(fuels, showAll) {
    const chartEl = document.getElementById("trends-chart");
    if (trendsData.length < 2) {
      chartEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px">Reikia bent 2 dienų duomenų</div>';
      return;
    }
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";

    const W = 720, H = 340;
    const pad = { top: 30, right: 20, bottom: 50, left: 60 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Overlay Lithuania's overall avg as a faint comparison line for any
    // non-overall split so the user can always see where a network, region,
    // or station sits relative to the whole market. Skipped in "all fuels"
    // mode because that view already has three lines per entity — adding
    // three more market-avg lines would be visual noise.
    const showCompare = trendsSplit !== "overall" && trendsSplit !== "competition" && !showAll && Array.isArray(trendsRaw.overall);
    const compareSeries = {};
    if (showCompare) {
      for (const fuel of ["petrol95", "diesel", "lpg"]) compareSeries[fuel] = {};
      for (const row of trendsRaw.overall) {
        for (const fuel of ["petrol95", "diesel", "lpg"]) {
          if (row[fuel] && typeof row[fuel].avg === "number") {
            compareSeries[fuel][row.date] = row[fuel].avg;
          }
        }
      }
    }

    // Multi-entity mode: network/region splits draw one avg line per selected
    // entity instead of min/avg/max bands. Otherwise we'd need a separate chart
    // per network which is worse UX than overlaying them.
    const multiEntity = Array.isArray(trendsEntitiesData) && trendsEntitiesData.length > 0;

    // Collect all values for y-axis range
    let allVals = [];
    if (multiEntity) {
      for (const entity of trendsEntitiesData) {
        for (const r of entity.rows) {
          for (const f of fuels) {
            const s = r.stats[f.key];
            if (s && typeof s.avg === "number") allVals.push(s.avg);
          }
        }
      }
    } else {
      for (const f of fuels) {
        for (const d of trendsData) {
          const s = d.stats[f.key];
          if (!s) continue;
          if (showAll) {
            allVals.push(s.avg);
          } else {
            allVals.push(s.min, s.avg, s.median, s.max);
          }
        }
        if (showCompare) {
          for (const d of trendsData) {
            const v = compareSeries[f.key][d.date];
            if (typeof v === "number") allVals.push(v);
          }
        }
      }
    }
    if (allVals.length === 0) {
      chartEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px">Nėra duomenų</div>';
      return;
    }

    const minVal = Math.min(...allVals);
    const maxVal = Math.max(...allVals);
    const range = maxVal - minVal || 0.01;
    const yMin = minVal - range * 0.1;
    const yMax = maxVal + range * 0.1;

    // x-axis is calendar-day based so gaps (weekends/holidays) take real width
    // and the line drawn between adjacent points visually interpolates across them.
    function dayIndex(dateStr) {
      const [y, m, d] = dateStr.split("-").map(Number);
      return Date.UTC(y, m - 1, d) / 86400000;
    }
    const dayIdx = trendsData.map(d => dayIndex(d.date));
    const dayMin = dayIdx[0];
    const daySpan = Math.max(1, dayIdx[dayIdx.length - 1] - dayMin);

    function xPos(i) { return pad.left + ((dayIdx[i] - dayMin) / daySpan) * plotW; }
    function yPos(v) { return pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    // Grid lines
    let gridLines = "";
    for (let i = 0; i <= 5; i++) {
      const v = yMin + (i / 5) * (yMax - yMin);
      const y = yPos(v);
      gridLines += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
      gridLines += `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-dim)" font-size="11">${v.toFixed(3)}</text>`;
    }

    // Date labels
    let dateLabels = "";
    const step = Math.max(1, Math.floor(trendsData.length / 6));
    for (let i = 0; i < trendsData.length; i += step) {
      dateLabels += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" fill="var(--text-dim)" font-size="11">${trendsData[i].date.slice(5)}</text>`;
    }
    if ((trendsData.length - 1) % step !== 0) {
      dateLabels += `<text x="${xPos(trendsData.length - 1)}" y="${H - 8}" text-anchor="middle" fill="var(--text-dim)" font-size="11">${trendsData[trendsData.length - 1].date.slice(5)}</text>`;
    }

    let lines = "";

    function makeLine(dataPoints, color, width, dash) {
      if (dataPoints.length < 2) return "";
      const pathD = dataPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
      const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
      return `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>`;
    }

    function makeDots(dataPoints, color, r) {
      return dataPoints.map(p =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}" stroke="var(--bg-panel)" stroke-width="1.5"/>`
      ).join("");
    }

    // Distinct hue per entity for multi-entity mode. HSL spread around the
    // wheel gives enough separation up to ~10–12 entities; beyond that lines
    // start clashing but the dropdown allows users to narrow down.
    const entityColor = (idx, total) =>
      `hsl(${Math.round((idx * 360) / Math.max(total, 1))}, 65%, ${isDark ? 60 : 45}%)`;

    // Always draw the market-avg comparison line first (when applicable) so
    // it sits behind the entity series and acts as a reference baseline.
    if (showCompare) {
      const compareColor = fuels[0].color;
      for (const f of fuels) {
        const pts = [];
        for (let i = 0; i < trendsData.length; i++) {
          const v = compareSeries[f.key][trendsData[i].date];
          if (typeof v === "number") pts.push({ x: xPos(i), y: yPos(v) });
        }
        lines += `<g opacity="0.45">${makeLine(pts, multiEntity ? compareColor : f.color, 1.5, "2 3")}</g>`;
      }
    }

    if (multiEntity) {
      // Build a date -> index lookup once so each entity can be projected
      // onto the shared x-axis even if its series is sparser than the longest.
      const dateToIdx = new Map();
      trendsData.forEach((d, i) => dateToIdx.set(d.date, i));

      trendsEntitiesData.forEach((entity, eIdx) => {
        const color = entityColor(eIdx, trendsEntitiesData.length);
        for (const f of fuels) {
          const pts = [];
          for (const row of entity.rows) {
            const s = row.stats[f.key];
            if (!s || typeof s.avg !== "number") continue;
            const i = dateToIdx.get(row.date);
            if (i == null) continue;
            pts.push({ x: xPos(i), y: yPos(s.avg) });
          }
          // In "all fuels" mode, dash diesel and lpg differently so the same
          // entity color can still be told apart across fuels.
          const dash = !showAll ? null : f.key === "diesel" ? "5 3" : f.key === "lpg" ? "2 3" : null;
          lines += makeLine(pts, color, 2, dash);
        }
      });
    } else {
      for (const f of fuels) {
        if (showAll) {
          const pts = [];
          for (let i = 0; i < trendsData.length; i++) {
            const s = trendsData[i].stats[f.key];
            if (s) pts.push({ x: xPos(i), y: yPos(s.avg) });
          }
          lines += makeLine(pts, f.color, 2.5, null);
          lines += makeDots(pts, f.color, 4);
        } else {
          const minPts = [], avgPts = [], maxPts = [];
          for (let i = 0; i < trendsData.length; i++) {
            const s = trendsData[i].stats[f.key];
            if (!s) continue;
            const x = xPos(i);
            minPts.push({ x, y: yPos(s.min) });
            avgPts.push({ x, y: yPos(s.avg) });
            maxPts.push({ x, y: yPos(s.max) });
          }
          if (minPts.length >= 2) {
            const areaD = minPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")
              + [...maxPts].reverse().map(p => ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("") + " Z";
            lines += `<path d="${areaD}" fill="${f.color}" fill-opacity="0.08"/>`;
          }
          lines += makeLine(minPts, getCSSVar("--green"), 1.5, "4 3");
          lines += makeLine(maxPts, getCSSVar("--red"), 1.5, "4 3");
          lines += makeLine(avgPts, f.color, 2.5, null);
          lines += makeDots(avgPts, f.color, 4);
          lines += makeDots(minPts, getCSSVar("--green"), 3);
          lines += makeDots(maxPts, getCSSVar("--red"), 3);
        }
      }
    }

    // Legend
    let legend = "";
    if (multiEntity) {
      // One row per entity (max 3) plus the market-avg line entry. Easy to
      // read since the cap keeps the chart sparse.
      const items = trendsEntitiesData.map((e, i) => ({
        color: entityColor(i, trendsEntitiesData.length), label: e.label, dash: null,
      }));
      if (showCompare) {
        items.push({ color: fuels[0].color, label: "Lietuva (vidurkis)", dash: "2 3", opacity: 0.45 });
      }
      const perRow = 4;
      const colW = (W - pad.left - pad.right) / perRow;
      items.forEach((item, i) => {
        const row = Math.floor(i / perRow);
        const col = i % perRow;
        const lx = pad.left + col * colW;
        const ly = 10 + row * 12;
        const dashAttr = item.dash ? ` stroke-dasharray="${item.dash}"` : "";
        const op = item.opacity != null ? ` opacity="${item.opacity}"` : "";
        legend += `<line x1="${lx}" y1="${ly}" x2="${lx + 14}" y2="${ly}" stroke="${item.color}" stroke-width="2"${dashAttr}${op}/>`;
        legend += `<text x="${lx + 18}" y="${ly + 3}" fill="var(--text-dim)" font-size="11">${escapeText(item.label)}</text>`;
      });
    } else {
      const legendItems = [];
      if (showAll) {
        fuels.forEach((f) => legendItems.push({ kind: "rect", color: f.color, label: f.label }));
      } else {
        legendItems.push(
          { kind: "line", color: getCSSVar("--green"), dash: "4 3", label: "Mažiausia" },
          { kind: "line", color: fuels[0].color, dash: null, label: trendsSplit === "station" ? "Degalinė" : "Vidurkis" },
          { kind: "line", color: getCSSVar("--red"), dash: "4 3", label: "Didžiausia" },
        );
      }
      if (showCompare) {
        legendItems.push({ kind: "line", color: fuels[0].color, dash: "2 3", opacity: 0.35, label: "Lietuva (vidurkis)" });
      }
      legendItems.forEach((item, i) => {
        const lx = pad.left + i * 110;
        if (item.kind === "rect") {
          legend += `<rect x="${lx}" y="8" width="14" height="3" rx="1.5" fill="${item.color}"/>`;
        } else {
          const dashAttr = item.dash ? ` stroke-dasharray="${item.dash}"` : "";
          const op = item.opacity != null ? ` opacity="${item.opacity}"` : "";
          legend += `<line x1="${lx}" y1="10" x2="${lx + 14}" y2="10" stroke="${item.color}" stroke-width="2"${dashAttr}${op}/>`;
        }
        legend += `<text x="${lx + 18}" y="13" fill="var(--text-dim)" font-size="11">${item.label}</text>`;
      });
    }

    chartEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${gridLines}${dateLabels}${lines}${legend}
    </svg>`;
  }

  function renderTrendsTable(fuels, showAll) {
    const tableEl = document.getElementById("trends-table");

    let headers, rows;
    if (showAll) {
      headers = fuels.map(f => `<th>${f.label}</th>`).join("");
      rows = [...trendsData].reverse().map((d, idx) => {
        const prev = idx < trendsData.length - 1 ? [...trendsData].reverse()[idx + 1] : null;
        const cells = fuels.map(f => {
          const s = d.stats[f.key];
          if (!s) return "<td>—</td>";
          let changeHtml = "";
          if (prev && prev.stats[f.key]) {
            const diff = s.avg - prev.stats[f.key].avg;
            if (Math.abs(diff) > 0.0005) {
              const cls = diff > 0 ? "up" : "down";
              const sign = diff > 0 ? "+" : "";
              changeHtml = `<span class="trend-change ${cls}">${sign}${diff.toFixed(3)}</span>`;
            }
          }
          return `<td>${s.avg.toFixed(3)} \u20ac${changeHtml}</td>`;
        }).join("");
        return `<tr><td>${d.date}</td>${cells}</tr>`;
      }).join("");
    } else {
      headers = `<th>Min</th><th>Mediana</th><th>Vidurkis</th><th>Max</th>`;
      const key = fuels[0].key;
      rows = [...trendsData].reverse().map((d, idx) => {
        const s = d.stats[key];
        if (!s) return `<tr><td>${d.date}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
        const prev = idx < trendsData.length - 1 ? [...trendsData].reverse()[idx + 1] : null;
        const prevS = prev ? prev.stats[key] : null;

        function cell(val, prevVal) {
          let ch = "";
          if (prevVal != null) {
            const diff = val - prevVal;
            if (Math.abs(diff) > 0.0005) {
              const cls = diff > 0 ? "up" : "down";
              const sign = diff > 0 ? "+" : "";
              ch = `<span class="trend-change ${cls}">${sign}${diff.toFixed(3)}</span>`;
            }
          }
          return `<td>${val.toFixed(3)} \u20ac${ch}</td>`;
        }

        return `<tr><td>${d.date}</td>${cell(s.min, prevS?.min)}${cell(s.median, prevS?.median)}${cell(s.avg, prevS?.avg)}${cell(s.max, prevS?.max)}</tr>`;
      }).join("");
    }

    tableEl.innerHTML = `<table class="trends-grid">
      <thead><tr><th>Data</th>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // --- Route Feature ---
  let routeFuel = "petrol95";
  let routeStart = null; // { lat, lng }
  let routeEnd = null;   // { lat, lng }
  let routePickingState = null; // "start", "end", or null
  let routePolyline = null;
  let routeStartMarker = null;
  let routeEndMarker = null;
  let routeStationMarkers = [];
  let routeStop = null; // { lat, lng, stationId }
  let routeStopMarker = null;

  function setupRouteView() {
    document.getElementById("route-btn").addEventListener("click", () => {
      routeFuel = currentFuel;
      document.querySelectorAll(".route-fuel-tab").forEach(b => {
        b.classList.toggle("active", b.dataset.fuel === routeFuel);
      });
      openSidePanel("route");
    });

    document.querySelectorAll(".route-fuel-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".route-fuel-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        routeFuel = btn.dataset.fuel;
        if (routeStart && routeEnd) renderRouteResults();
      });
    });

    // Search inputs with geocoding
    setupRouteSearch("start");
    setupRouteSearch("end");

    // Pick on map buttons
    document.getElementById("route-start-pick").addEventListener("click", () => {
      toggleRoutePicking("start");
    });
    document.getElementById("route-end-pick").addEventListener("click", () => {
      toggleRoutePicking("end");
    });

    // Locate buttons
    document.getElementById("route-start-locate").addEventListener("click", () => {
      geolocateForRoute("start");
    });
    document.getElementById("route-end-locate").addEventListener("click", () => {
      geolocateForRoute("end");
    });

    document.getElementById("route-clear").addEventListener("click", clearRoute);

    document.getElementById("route-radius").addEventListener("change", () => {
      if (routeStart && routeEnd) fetchAndDisplayRoute();
    });
  }

  let routeSearchTimeouts = { start: null, end: null };

  function setupRouteSearch(which) {
    const input = document.getElementById(`route-${which}-input`);
    const suggestionsEl = document.getElementById(`route-${which}-suggestions`);

    input.addEventListener("input", () => {
      clearTimeout(routeSearchTimeouts[which]);
      const query = input.value.trim();
      if (query.length < 2) {
        suggestionsEl.classList.remove("visible");
        return;
      }
      routeSearchTimeouts[which] = setTimeout(() => geocodeSearch(query, which), 400);
    });

    input.addEventListener("focus", () => {
      if (suggestionsEl.children.length > 0) {
        suggestionsEl.classList.add("visible");
      }
    });

    // Close suggestions when clicking outside
    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !suggestionsEl.contains(e.target)) {
        suggestionsEl.classList.remove("visible");
      }
    });
  }

  async function geocodeSearch(query, which) {
    const suggestionsEl = document.getElementById(`route-${which}-suggestions`);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=lt&limit=5&addressdetails=1`;
      const resp = await fetch(url, {
        headers: { "Accept-Language": "lt" }
      });
      const results = await resp.json();

      if (results.length === 0) {
        suggestionsEl.innerHTML = '<div class="route-suggestion" style="color:var(--text-muted)">Nieko nerasta</div>';
        suggestionsEl.classList.add("visible");
        return;
      }

      suggestionsEl.innerHTML = results.map((r, i) => {
        const parts = r.display_name.split(", ");
        const main = parts[0];
        const secondary = parts.slice(1, 3).join(", ");
        return `<div class="route-suggestion" data-idx="${i}">
          <div>${main}</div>
          <div class="suggestion-secondary">${secondary}</div>
        </div>`;
      }).join("");

      suggestionsEl.querySelectorAll(".route-suggestion").forEach((el, i) => {
        el.addEventListener("click", () => {
          const r = results[i];
          const latlng = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
          const input = document.getElementById(`route-${which}-input`);
          input.value = r.display_name.split(", ").slice(0, 2).join(", ");
          input.classList.add("route-set");
          suggestionsEl.classList.remove("visible");
          setRoutePoint(which, latlng);
        });
      });

      suggestionsEl.classList.add("visible");
    } catch {
      suggestionsEl.classList.remove("visible");
    }
  }

  function toggleRoutePicking(which) {
    const btn = document.getElementById(`route-${which}-pick`);
    if (routePickingState === which) {
      stopRoutePicking();
    } else {
      stopRoutePicking(); // clear any other active picking
      routePickingState = which;
      btn.classList.add("active");
      document.getElementById("map").style.cursor = "crosshair";
      document.getElementById("route-status").textContent =
        `Paspauskite žemėlapyje ${which === "start" ? "pradžios" : "pabaigos"} tašką`;
    }
  }

  function stopRoutePicking() {
    routePickingState = null;
    document.getElementById("map").style.cursor = "";
    document.getElementById("route-start-pick").classList.remove("active");
    document.getElementById("route-end-pick").classList.remove("active");
    const statusEl = document.getElementById("route-status");
    if (!routeStart || !routeEnd) {
      statusEl.textContent = "";
    }
  }

  function geolocateForRoute(which) {
    if (!navigator.geolocation) {
      document.getElementById("route-status").textContent = "Naršyklė nepalaiko vietos nustatymo.";
      return;
    }
    const input = document.getElementById(`route-${which}-input`);
    input.value = "Nustatoma vieta...";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        input.value = "Mano vieta";
        input.classList.add("route-set");
        setRoutePoint(which, latlng);
      },
      () => {
        input.value = "";
        document.getElementById("route-status").textContent = "Nepavyko nustatyti vietos.";
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
    );
  }

  function handleRouteMapClick(e) {
    if (!routePickingState) return;
    const which = routePickingState;
    const latlng = { lat: e.latlng.lat, lng: e.latlng.lng };
    const input = document.getElementById(`route-${which}-input`);
    input.value = `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
    input.classList.add("route-set");
    stopRoutePicking();
    setRoutePoint(which, latlng);
  }

  function makeRouteIcon(label, color) {
    return L.divIcon({
      className: "route-marker",
      html: `<div class="route-marker-pin" style="background:${color}">${label}</div>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
    });
  }

  function setRoutePoint(which, latlng) {
    if (which === "start") {
      routeStart = latlng;
      if (routeStartMarker) map.removeLayer(routeStartMarker);
      routeStartMarker = L.marker([latlng.lat, latlng.lng], {
        icon: makeRouteIcon("A", "#111111"),
        zIndexOffset: 900,
      }).addTo(map);
    } else {
      routeEnd = latlng;
      if (routeEndMarker) map.removeLayer(routeEndMarker);
      routeEndMarker = L.marker([latlng.lat, latlng.lng], {
        icon: makeRouteIcon("B", "#555555"),
        zIndexOffset: 900,
      }).addTo(map);
    }

    if (routeStart && routeEnd) {
      fetchAndDisplayRoute();
    }
  }

  async function fetchAndDisplayRoute() {
    const statusEl = document.getElementById("route-status");
    statusEl.textContent = "Ieškomas maršrutas...";

    // Hide main markers, clear old route visuals
    map.removeLayer(markerCluster);
    clearRouteVisuals();

    try {
      let waypoints = `${routeStart.lng},${routeStart.lat}`;
      if (routeStop) waypoints += `;${routeStop.lng},${routeStop.lat}`;
      waypoints += `;${routeEnd.lng},${routeEnd.lat}`;
      const url = `https://router.project-osrm.org/route/v1/driving/${waypoints}?overview=full&geometries=geojson`;
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
        statusEl.textContent = "Nepavyko rasti maršruto.";
        return;
      }

      const route = data.routes[0];
      const coords = route.geometry.coordinates.map(c => [c[1], c[0]]); // [lng,lat] -> [lat,lng]

      // Draw route on map
      routePolyline = L.polyline(coords, {
        color: "#111111",
        weight: 3,
        opacity: 0.6,
      }).addTo(map);

      map.fitBounds(routePolyline.getBounds(), { padding: [50, 50] });

      // Find stations near the route
      const radiusKm = parseInt(document.getElementById("route-radius").value);
      const routeStations = findStationsNearRoute(coords, radiusKm);

      const distKm = (route.distance / 1000).toFixed(0);
      const durMin = Math.round(route.duration / 60);
      const gmapsUrl = buildGoogleMapsUrl();
      statusEl.innerHTML = `Maršrutas: ${distKm} km, ~${durMin} min. Rasta: ${routeStations.length} degalinių<br><a href="${gmapsUrl}" target="_blank" class="gmaps-link">Atidaryti Google Maps</a>`;

      renderRouteStations(routeStations);
    } catch (err) {
      console.error("Route fetch error:", err);
      statusEl.textContent = "Klaida ieškant maršruto. Bandykite dar kartą.";
    }
  }

  function distanceToSegment(point, segStart, segEnd) {
    // Point-to-line-segment distance in km using flat approximation (good enough for short segments)
    const R = 6371;
    const toRad = x => x * Math.PI / 180;
    const lat = toRad(point[0]), lng = toRad(point[1]);
    const lat1 = toRad(segStart[0]), lng1 = toRad(segStart[1]);
    const lat2 = toRad(segEnd[0]), lng2 = toRad(segEnd[1]);

    const midLat = (lat1 + lat2) / 2;
    const cosLat = Math.cos(midLat);

    // Convert to flat coordinates (km)
    const x = (lng - lng1) * cosLat * R;
    const y = (lat - lat1) * R;
    const dx = (lng2 - lng1) * cosLat * R;
    const dy = (lat2 - lat1) * R;

    const segLen2 = dx * dx + dy * dy;
    if (segLen2 === 0) return Math.sqrt(x * x + y * y);

    let t = (x * dx + y * dy) / segLen2;
    t = Math.max(0, Math.min(1, t));

    const projX = t * dx;
    const projY = t * dy;

    return Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
  }

  function findStationsNearRoute(routeCoords, radiusKm) {
    if (!allStations) return [];

    // Sample route coords (every Nth point for performance)
    const step = Math.max(1, Math.floor(routeCoords.length / 200));
    const sampled = [];
    for (let i = 0; i < routeCoords.length - 1; i += step) {
      sampled.push(i);
    }
    if (sampled[sampled.length - 1] !== routeCoords.length - 2) {
      sampled.push(routeCoords.length - 2);
    }

    const results = [];
    for (const station of allStations) {
      if (station.lat == null || station.lng == null) continue;
      const stationPoint = [station.lat, station.lng];

      let minDist = Infinity;
      for (const i of sampled) {
        const d = distanceToSegment(stationPoint, routeCoords[i], routeCoords[i + 1]);
        if (d < minDist) minDist = d;
        if (minDist < radiusKm) break; // early exit
      }

      if (minDist <= radiusKm) {
        results.push({ station, distance: minDist });
      }
    }

    return results;
  }

  function renderRouteResults() {
    if (!routeStart || !routeEnd) return;
    const radiusKm = parseInt(document.getElementById("route-radius").value);
    if (routePolyline) {
      const coords = routePolyline.getLatLngs().map(ll => [ll.lat, ll.lng]);
      const stations = findStationsNearRoute(coords, radiusKm);
      renderRouteStations(stations);
    }
  }

  function renderRouteStations(routeStations) {
    const container = document.getElementById("route-results");
    const avg = averages ? averages[routeFuel] : null;

    // Sort by price
    routeStations.sort((a, b) => {
      const pa = a.station.prices[routeFuel];
      const pb = b.station.prices[routeFuel];
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    });

    // Clear old station markers
    routeStationMarkers.forEach(m => map.removeLayer(m));
    routeStationMarkers = [];

    // Add station markers along route (skip non-stop stations when a stop is selected)
    for (const { station } of routeStations) {
      const isStop = routeStop && routeStop.stationId === station.id;
      if (routeStop && !isStop) continue;
      const price = station.prices[routeFuel];
      const color = getColor(price, avg);
      const marker = L.marker([station.lat, station.lng], {
        icon: createMarkerIcon(color, price),
        zIndexOffset: 800,
      }).addTo(map);
      marker.bindPopup(createPopup(station, null), { maxWidth: 250 });
      routeStationMarkers.push(marker);
    }

    const html = routeStations.map(({ station, distance }) => {
      const price = station.prices[routeFuel];
      const priceClass = price == null ? "price-na" :
        avg && (price - avg) / avg < -0.02 ? "price-low" :
        avg && (price - avg) / avg > 0.02 ? "price-high" : "price-mid";
      const priceStr = price != null ? price.toFixed(3) + " \u20ac" : "—";
      const distStr = distance < 1 ? (distance * 1000).toFixed(0) + " m" : distance.toFixed(1) + " km";
      const isStop = routeStop && routeStop.stationId === station.id;

      return `<div class="station-item ${isStop ? "route-stop-active" : ""}" data-lat="${station.lat}" data-lng="${station.lng}" data-id="${station.id}">
        <div class="station-info">
          <div class="station-name">${station.company}</div>
          <div class="station-addr">${station.address}, ${station.municipality}</div>
          <div class="route-distance">${distStr} nuo kelio</div>
        </div>
        <div class="station-price-col">
          <div class="station-price-val ${priceClass}">${priceStr}</div>
          <button class="route-stop-btn ${isStop ? "active" : ""}" title="${isStop ? "Pašalinti sustojimą" : "Sustoti čia"}">${isStop ? "&#10005;" : "&#9654;"}</button>
        </div>
      </div>`;
    }).join("");

    container.innerHTML = html || '<div style="text-align:center;color:var(--text-dim);padding:20px">Nerasta degalinių šalia maršruto</div>';
    container.classList.toggle("route-has-stop", !!routeStop);

    container.querySelectorAll(".station-item").forEach(item => {
      const stopBtn = item.querySelector(".route-stop-btn");

      item.addEventListener("click", (e) => {
        if (stopBtn.contains(e.target)) return; // handled by stop btn
        const lat = parseFloat(item.dataset.lat);
        const lng = parseFloat(item.dataset.lng);
        map.setView([lat, lng], 15);
      });

      stopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const stationId = item.dataset.id;
        const lat = parseFloat(item.dataset.lat);
        const lng = parseFloat(item.dataset.lng);

        if (routeStop && routeStop.stationId === stationId) {
          // Remove stop
          routeStop = null;
          if (routeStopMarker) { map.removeLayer(routeStopMarker); routeStopMarker = null; }
        } else {
          // Set stop
          routeStop = { lat, lng, stationId };
          if (routeStopMarker) map.removeLayer(routeStopMarker);
          routeStopMarker = L.marker([lat, lng], {
            icon: makeRouteIcon("S", "#16a34a"),  /* keep green — semantic */
            zIndexOffset: 950,
          }).addTo(map);
        }
        fetchAndDisplayRoute();
      });
    });
  }

  function buildGoogleMapsUrl() {
    let url = "https://www.google.com/maps/dir/";
    url += `${routeStart.lat},${routeStart.lng}/`;
    if (routeStop) url += `${routeStop.lat},${routeStop.lng}/`;
    url += `${routeEnd.lat},${routeEnd.lng}`;
    return url;
  }

  function clearRouteVisuals() {
    if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
    routeStationMarkers.forEach(m => map.removeLayer(m));
    routeStationMarkers = [];
    if (routeStopMarker) { map.removeLayer(routeStopMarker); routeStopMarker = null; }
  }

  function clearRoute() {
    routeStart = null;
    routeEnd = null;
    routeStop = null;
    stopRoutePicking();
    clearRouteVisuals();
    if (routeStartMarker) { map.removeLayer(routeStartMarker); routeStartMarker = null; }
    if (routeEndMarker) { map.removeLayer(routeEndMarker); routeEndMarker = null; }
    const startInput = document.getElementById("route-start-input");
    const endInput = document.getElementById("route-end-input");
    startInput.value = "";
    startInput.classList.remove("route-set");
    endInput.value = "";
    endInput.classList.remove("route-set");
    document.getElementById("route-start-suggestions").classList.remove("visible");
    document.getElementById("route-end-suggestions").classList.remove("visible");
    document.getElementById("route-status").textContent = "";
    document.getElementById("route-results").innerHTML = "";
    // Restore main markers
    if (!map.hasLayer(markerCluster)) map.addLayer(markerCluster);
  }

  document.addEventListener("DOMContentLoaded", init);

  // Register service worker — but never on localhost, where a cached SW would
  // serve stale app.js/CSS and mask local edits. On localhost we also actively
  // tear down any previously-registered SW and its caches.
  if ("serviceWorker" in navigator) {
    const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
    if (isLocal) {
      navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
      if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    } else {
      navigator.serviceWorker.register("/sw.js");
    }
  }

  // PWA install prompt
  let deferredPrompt;
  const installBtn = document.getElementById("install-btn");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.classList.remove("hidden");
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    installBtn.classList.add("hidden");
    deferredPrompt = null;
  });
})();
