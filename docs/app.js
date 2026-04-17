(() => {
  "use strict";

  const MAP_CENTER = [55.17, 23.88];
  const MAP_ZOOM = 8;

  let map, markerCluster, allStations, currentFuel = "petrol95", averages;
  let geocache = {}; // id -> { lat, lng }
  let historyDates = [];
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

    const initCenter = (saved.lat != null && saved.lng != null) ? [saved.lat, saved.lng] : MAP_CENTER;
    const initZoom = saved.zoom != null ? saved.zoom : MAP_ZOOM;

    map = L.map("map").setView(initCenter, initZoom);
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
          date: hist.date,
          stations: hist.stations,
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

      allStations = data.stations;
      averages = data.averages;

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

  function getColor(price, avg) {
    if (price == null || avg == null) return "#999";
    const pct = (price - avg) / avg;
    if (pct < -0.02) return getCSSVar("--green");
    if (pct > 0.02) return getCSSVar("--red");
    return getCSSVar("--yellow");
  }

  function createMarkerIcon(color, price) {
    const label = price != null ? price.toFixed(3) : "—";
    return L.divIcon({
      className: "price-cluster",
      html: `<div class="cluster-icon" style="background:${color}">${label}</div>`,
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

    const priceRows = fuels
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

    return `<div class="station-popup">
      <h3>${station.company}</h3>
      <div class="address">${station.address}</div>
      <div class="company">${station.municipality}</div>
      ${distStr}
      <div class="prices">${priceRows}</div>
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
        icon: createMarkerIcon(color, price),
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
      if (trendsData.length > 0) renderTrends();
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
  function initMultiSelect(containerId, items, onChangeCallback) {
    const container = document.getElementById(containerId);
    const btn = container.querySelector(".multi-select-btn");
    const dropdown = container.querySelector(".multi-select-dropdown");
    const optionsDiv = container.querySelector(".multi-select-options");
    const labelSpan = container.querySelector(".multi-select-label");

    // Populate options — items can be strings or { value, label } objects
    optionsDiv.innerHTML = items.map(item => {
      const value = typeof item === "string" ? item : item.value;
      const label = typeof item === "string" ? item : item.label;
      return `<label class="multi-select-option">
        <input type="checkbox" value="${value}" checked>
        <span>${label}</span>
      </label>`;
    }).join("");

    function getSelected() {
      const checked = optionsDiv.querySelectorAll("input:checked");
      const all = optionsDiv.querySelectorAll("input");
      if (checked.length === all.length) return null; // all selected
      return new Set([...checked].map(cb => cb.value));
    }

    function updateLabel() {
      const checked = optionsDiv.querySelectorAll("input:checked");
      const all = optionsDiv.querySelectorAll("input");
      if (checked.length === 0) {
        labelSpan.textContent = "Nepasirinkta";
      } else if (checked.length === all.length) {
        labelSpan.textContent = "Visi";
      } else if (checked.length <= 2) {
        labelSpan.textContent = [...checked].map(cb => cb.value).join(", ");
      } else {
        labelSpan.textContent = `${checked.length} iš ${all.length}`;
      }
    }

    // Toggle dropdown
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Close other dropdowns
      document.querySelectorAll(".multi-select-dropdown.open").forEach(d => {
        if (d !== dropdown) d.classList.remove("open");
      });
      dropdown.classList.toggle("open");
    });

    // Select all / none
    container.querySelectorAll(".multi-select-actions button").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = b.dataset.action;
        optionsDiv.querySelectorAll("input").forEach(cb => { cb.checked = action === "all"; });
        updateLabel();
        onChangeCallback(getSelected());
      });
    });

    // Checkbox change
    optionsDiv.addEventListener("change", () => {
      updateLabel();
      onChangeCallback(getSelected());
    });

    // Close on outside click
    document.addEventListener("click", (e) => {
      if (!container.contains(e.target)) {
        dropdown.classList.remove("open");
      }
    });

    // Return helpers for state restore
    return {
      setSelected(values) {
        if (!values) return; // keep all checked
        const valSet = new Set(values);
        optionsDiv.querySelectorAll("input").forEach(cb => {
          cb.checked = valSet.has(cb.value);
        });
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
  let trendsFuel = "petrol95";

  function setupTrendsView() {
    document.getElementById("trends-btn").addEventListener("click", () => {
      trendsFuel = currentFuel;
      document.querySelectorAll(".trends-fuel-tab").forEach(b => {
        b.classList.toggle("active", b.dataset.fuel === trendsFuel);
      });
      loadTrendsData();
      openSidePanel("trends");
    });

    document.querySelectorAll(".trends-fuel-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".trends-fuel-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        trendsFuel = btn.dataset.fuel;
        renderTrends();
      });
    });
  }

  let trendsData = []; // [{ date, stats: { petrol95: {min,avg,median,max}, ... } }]

  async function loadTrendsData() {
    if (trendsData.length > 0) {
      renderTrends();
      return;
    }
    const chartEl = document.getElementById("trends-chart");
    chartEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px">Kraunama...</div>';

    try {
      const resp = await fetch("data/price-trends.jsonl");
      const text = await resp.text();
      trendsData = text.trim().split("\n")
        .filter(line => line.length > 0)
        .map(line => {
          const entry = JSON.parse(line);
          return {
            date: entry.date,
            stats: { petrol95: entry.petrol95, diesel: entry.diesel, lpg: entry.lpg },
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      trendsData = [];
    }
    renderTrends();
  }

  function renderTrends() {
    if (trendsData.length === 0) return;

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const showAll = trendsFuel === "all";
    const fuels = showAll
      ? [
          { key: "petrol95", label: "95 benzinas", color: isDark ? "#e0e0e0" : "#111111" },
          { key: "diesel", label: "Dyzelinas", color: isDark ? "#888888" : "#666666" },
          { key: "lpg", label: "SND", color: isDark ? "#555555" : "#bbbbbb" },
        ]
      : [{ key: trendsFuel, label: FUEL_LABELS[trendsFuel], color: isDark ? "#e0e0e0" : "#111111" }];

    renderTrendsChart(fuels, showAll);
    renderTrendsTable(fuels, showAll);
  }

  function renderTrendsChart(fuels, showAll) {
    const chartEl = document.getElementById("trends-chart");
    if (trendsData.length < 2) {
      chartEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px">Reikia bent 2 dienų duomenų</div>';
      return;
    }

    const W = 720, H = 340;
    const pad = { top: 30, right: 20, bottom: 50, left: 60 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Collect all values for y-axis range
    let allVals = [];
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

    function xPos(i) { return pad.left + (i / (trendsData.length - 1)) * plotW; }
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

    for (const f of fuels) {
      if (showAll) {
        // "All fuels" mode: just show avg line per fuel
        const pts = [];
        for (let i = 0; i < trendsData.length; i++) {
          const s = trendsData[i].stats[f.key];
          if (s) pts.push({ x: xPos(i), y: yPos(s.avg) });
        }
        lines += makeLine(pts, f.color, 2.5, null);
        lines += makeDots(pts, f.color, 4);
      } else {
        // Single fuel mode: show min, average, max bands
        const minPts = [], avgPts = [], maxPts = [];
        for (let i = 0; i < trendsData.length; i++) {
          const s = trendsData[i].stats[f.key];
          if (!s) continue;
          const x = xPos(i);
          minPts.push({ x, y: yPos(s.min) });
          avgPts.push({ x, y: yPos(s.avg) });
          maxPts.push({ x, y: yPos(s.max) });
        }

        // Shaded area between min and max
        if (minPts.length >= 2) {
          const areaD = minPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")
            + [...maxPts].reverse().map(p => ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("") + " Z";
          lines += `<path d="${areaD}" fill="${f.color}" fill-opacity="0.08"/>`;
        }

        // Min line (dashed, thin)
        lines += makeLine(minPts, getCSSVar("--green"), 1.5, "4 3");
        // Max line (dashed, thin)
        lines += makeLine(maxPts, getCSSVar("--red"), 1.5, "4 3");
        // Average line (solid, bold)
        lines += makeLine(avgPts, f.color, 2.5, null);
        lines += makeDots(avgPts, f.color, 4);
        lines += makeDots(minPts, getCSSVar("--green"), 3);
        lines += makeDots(maxPts, getCSSVar("--red"), 3);
      }
    }

    // Legend
    let legend = "";
    if (showAll) {
      fuels.forEach((f, i) => {
        const lx = pad.left + i * 130;
        legend += `<rect x="${lx}" y="8" width="14" height="3" rx="1.5" fill="${f.color}"/>`;
        legend += `<text x="${lx + 18}" y="13" fill="var(--text-dim)" font-size="11">${f.label}</text>`;
      });
    } else {
      const items = [
        { label: "Mažiausia", color: getCSSVar("--green"), dash: "4 3" },
        { label: "Vidurkis", color: fuels[0].color, dash: null },
        { label: "Didžiausia", color: getCSSVar("--red"), dash: "4 3" },
      ];
      items.forEach((item, i) => {
        const lx = pad.left + i * 130;
        const dashAttr = item.dash ? ` stroke-dasharray="${item.dash}"` : "";
        legend += `<line x1="${lx}" y1="10" x2="${lx + 14}" y2="10" stroke="${item.color}" stroke-width="2"${dashAttr}/>`;
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

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js");
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
