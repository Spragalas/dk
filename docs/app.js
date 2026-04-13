(() => {
  "use strict";

  const MAP_CENTER = [55.17, 23.88];
  const MAP_ZOOM = 8;

  let map, markerCluster, allStations, currentFuel = "petrol95", averages;
  let historyDates = [];
  let companyFilterPopulated = false;
  let clusterMode = "min"; // "min" or "max"
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
    const company = document.getElementById("company-select");
    if (company) state.company = company.value;
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
      document.querySelectorAll(".mode-tab").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === clusterMode);
      });
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
    setupFilters();
    setupNearMe();
    setupHistory(saved);

    // Restore company filter after data loads, and history date
    const historyDate = saved.historyDate || null;
    loadData("data/stations.json", historyDate || undefined).then(() => {
      if (saved.company) {
        document.getElementById("company-select").value = saved.company;
        renderMarkers();
      }
    });
  }

  async function setupHistory(saved) {
    try {
      const resp = await fetch("data/history-index.json");
      historyDates = await resp.json();

      const select = document.getElementById("history-select");
      // Most recent first
      for (const date of [...historyDates].reverse()) {
        const opt = document.createElement("option");
        opt.value = date;
        opt.textContent = date;
        select.appendChild(opt);
      }

      // Restore saved history date
      if (saved && saved.historyDate && historyDates.includes(saved.historyDate)) {
        select.value = saved.historyDate;
      }

      select.addEventListener("change", () => {
        const date = select.value;
        if (date) {
          loadData(`data/stations.json`, date);
          saveState();
        }
      });
    } catch {
      // No history available yet
    }
  }

  async function loadData(url, historyDate) {
    try {
      let data;
      if (historyDate) {
        // Load from history — but history files don't have coords,
        // so load current stations.json for coords and overlay history prices
        const [currentResp, histResp] = await Promise.all([
          fetch("data/stations.json"),
          fetch(`data/history/${historyDate}.json`),
        ]);
        const current = await currentResp.json();
        const hist = await histResp.json();

        // Build coord map from current data
        const coordMap = {};
        for (const s of current.stations) {
          coordMap[s.id] = { lat: s.lat, lng: s.lng };
        }

        // Merge coords into history stations
        for (const s of hist.stations) {
          const coords = coordMap[s.id] || {};
          s.lat = coords.lat || null;
          s.lng = coords.lng || null;
        }

        data = {
          date: hist.date,
          stations: hist.stations,
          averages: computeAverages(hist.stations),
        };
      } else {
        const resp = await fetch(url);
        data = await resp.json();
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
      { label: "Mažiausia", value: min },
      { label: "Vidutin\u0117", value: avg },
      { label: "Didžiausia", value: max },
    ]
      .map((r) => `<div class="avg-row">
        <span class="avg-label">${r.label}</span>
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
    const companyFilter = document.getElementById("company-select").value;
    const searchFilter = document.getElementById("search-input").value.toLowerCase();
    const radiusKm = nearMeActive ? parseInt(document.getElementById("radius-input").value) : null;

    let candidates = [];
    for (const station of allStations) {
      if (station.lat == null || station.lng == null) continue;
      if (companyFilter && station.company !== companyFilter) continue;
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
      // Re-render markers to pick up new colors
      if (allStations) renderMarkers();
    });
  }

  function setupPanelToggle() {
    const btn = document.getElementById("panel-toggle");
    const body = document.getElementById("panel-body");
    btn.addEventListener("click", () => {
      body.classList.toggle("collapsed");
      btn.innerHTML = body.classList.contains("collapsed") ? "&#9660;" : "&#9650;";
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
    document.querySelectorAll(".mode-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        clusterMode = btn.dataset.mode;
        renderMarkers();
        saveState();
      });
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

  function setupFilters() {
    document.getElementById("company-select").addEventListener("change", () => {
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
    const companies = [...new Set(allStations.map((s) => s.company))].sort();
    const select = document.getElementById("company-select");
    for (const company of companies) {
      const opt = document.createElement("option");
      opt.value = company;
      opt.textContent = company;
      select.appendChild(opt);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
