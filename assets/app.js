import { AIRPORTS } from './airports.js';
import { AIRLINES, AIRCRAFT_TYPES, ROUTES, CAMERAS, QUICK_HUBS } from './data.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const L = window.L;
const EARTH_R = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('es-ES');
const fmtInt = (n) => nf.format(Math.round(Number(n) || 0));
const fmt1 = (n) => (Number(n) || 0).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  view: 'radar',
  camsOpen: false,
  previousView: 'radar',
  map: null,
  tiles: null,
  center: { lat: 40.4168, lon: -3.7038 },
  zoom: 6.4,
  radiusNm: 250,
  refreshMs: 10000,
  paused: false,
  follow: false,
  showGround: false,
  showTrails: true,
  showLabels: true,
  showAirports: true,
  altMin: 0,
  altMax: 50000,
  units: 'imperial',
  planes: [],
  source: 'connecting',
  lastUpdate: null,
  fetching: false,
  refreshTimer: null,
  demoTimer: null,
  demoActive: false,
  hasLoadedOnce: false,
  selectedFlight: null,
  selectedAirport: null,
  selectedRoute: null,
  trace: null,
  weather: null,
  iss: null,
  markers: new Map(),
  trails: new Map(),
  trailLines: new Map(),
  traceLine: null,
  traceGlow: null,
  routeMatches: new Map(),
  airportCounts: new Map(),
  airportMarkers: [],
  feedFilter: '',
  feedSort: 'alt',
  routeFilter: '',
  routeRegion: 'all',
  airportFilter: '',
  camFilter: 'all',
  cams: CAMERAS.slice(),
  selectedCam: null,
  camSearchBusy: false,
  searchItems: [],
  searchIndex: -1,
  panelSignature: '',
  planeLayer: null,
  trailLayer: null,
  airportLayer: null,
  routeLayer: null,
  issLayer: null,
  selectionLayer: null,
  canvasRenderer: null,
  weatherTimer: null,
  issTimer: null,
  clockTimer: null,
  routeObjects: [],
  routeById: new Map(),
  toastCount: 0
};

const airportByIata = new Map();
const airportByIcao = new Map();
for (const a of AIRPORTS) {
  const obj = { iata: a[0], icao: a[1], name: a[2], city: a[3], country: a[4], lat: a[5], lon: a[6], alt: a[7], tz: a[8], type: a[9] };
  airportByIata.set(obj.iata, obj);
  airportByIcao.set(obj.icao, obj);
}
const MAJOR_IATAS = new Set(QUICK_HUBS.map((h) => h.iata));

/* ============================================================
   API
============================================================ */
const api = {
  async json(url, timeout = 16000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 160); } catch {}
        throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ''}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },
  point(lat, lon, radius) {
    return this.json(`/api/adsb/point?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${radius}`);
  },
  callsign(q) {
    return this.json(`/api/adsb/callsign/${encodeURIComponent(q)}`, 12000);
  },
  registration(q) {
    return this.json(`/api/adsb/reg/${encodeURIComponent(q)}`, 12000);
  },
  hex(q) {
    return this.json(`/api/adsb/hex/${encodeURIComponent(q)}`, 12000);
  },
  trace(hex) {
    return this.json(`/api/adsb/trace/${encodeURIComponent(hex)}`, 12000);
  },
  airport(icao) {
    return this.json(`/api/airport/${encodeURIComponent(icao)}`, 10000);
  },
  weather(lat, lon) {
    return this.json(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, 12000);
  },
  iss() {
    return this.json(`/api/iss`, 10000);
  },
  health() {
    return this.json(`/api/health`, 8000);
  },
  yt(q) {
    return this.json(`/api/yt/search?q=${encodeURIComponent(q)}`, 22000);
  }
};

/* ============================================================
   GEO MATH
============================================================ */
function haversine(a, b) {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const dφ = rad(b.lat - a.lat);
  const dλ = rad(b.lon - a.lon);
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(a, b) {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const dλ = rad(b.lon - a.lon);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function destination(p, brg, distKm) {
  const δ = distKm / EARTH_R;
  const θ = rad(brg);
  const φ1 = rad(p.lat);
  const λ1 = rad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}
function greatCircle(a, b, n = 64) {
  const φ1 = rad(a.lat);
  const λ1 = rad(a.lon);
  const φ2 = rad(b.lat);
  const λ2 = rad(b.lon);
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2)));
  if (d < 1e-9) return [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }];
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    let lon = deg(Math.atan2(y, x));
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push({ lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon });
  }
  return pts;
}
function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}
function lonDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}
function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/* ============================================================
   DATA NORMALIZATION
============================================================ */
function normalizeAircraft(a) {
  if (!a || typeof a !== 'object') return null;
  const flight = String(a.flight || '').trim();
  const reg = String(a.r || '').trim();
  const type = String(a.t || '').trim();
  if (!flight && !reg) return null;
  if (flight.includes('@@')) return null;
  if (type === 'TWR' || reg === 'TWR' || type === 'GND' || reg === 'GND') return null;
  const lat = Number(a.lat);
  const lon = Number(a.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ground = a.alt_baro === 'ground' || a.alt_baro === 'GND';
  const alt = ground ? 0 : Number(a.alt_baro) || 0;
  return {
    hex: String(a.hex || '').toLowerCase(),
    flight: flight || reg || '—',
    reg: reg || '—',
    type: type || '—',
    lat,
    lon,
    alt,
    onGround: ground || alt === 0,
    gs: Number(a.gs) || 0,
    track: Number(a.track) || 0,
    baroRate: Number(a.baro_rate) || 0,
    squawk: String(a.squawk || '—'),
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    category: String(a.category || ''),
    seenPos: Number(a.seen_pos) || 0,
    messages: Number(a.messages) || 0,
    sim: false
  };
}

function makeDemoTraffic() {
  const prefixes = ['IBE', 'VLG', 'RYR', 'DLH', 'AFR', 'BAW', 'KLM', 'SWR', 'TAP', 'ITY', 'UAE', 'QTR', 'THY', 'SIA', 'CPA', 'JAL', 'ANA', 'UAL', 'DAL', 'AAL', 'SWA', 'JBU', 'AMX', 'AVA', 'GLO', 'TAM', 'ARG', 'QFA', 'SAA', 'ETH', 'SAS', 'NAX', 'FIN', 'LOT', 'EZY', 'WZZ'];
  const regs = ['EC-MAD', 'EC-NIF', 'G-EUUU', 'D-AIXA', 'F-HTYA', 'PH-BKA', 'HB-JCA', 'CS-TUA', 'EI-DEB', 'A6-EDA', '9V-SKA', 'B-HLY', 'JA873J', 'HL8008', 'N198UA', 'N824NW', 'N912DE', 'N338AN', 'N8642E', 'N492JB', 'XA-AMX', 'CC-BGA', 'PR-AIB', 'PT-MUA', 'LV-GKB', 'LV-ARG', 'VH-QPA', 'ZS-SAA', 'ET-AOP', 'SE-ROE', 'OH-LKN', 'SP-LRA'];
  const types = ['A320', 'A21N', 'B738', 'B789', 'A359', 'B77W', 'E190', 'AT76', 'B38M', 'A20N'];
  const planes = [];
  const count = 58;
  for (let i = 0; i < count; i++) {
    const p = prefixes[i % prefixes.length] + (100 + Math.floor(Math.random() * 899));
    const onGround = Math.random() < 0.16;
    const alt = onGround ? 0 : 3500 + Math.floor(Math.random() * 39000);
    const gs = onGround ? 0 : 120 + Math.floor(Math.random() * 360);
    const lat = state.center.lat + (Math.random() - 0.5) * (state.radiusNm / 60) * 1.7;
    const lon = state.center.lon + (Math.random() - 0.5) * (state.radiusNm / 60) * 1.7 / Math.max(0.2, Math.cos(rad(state.center.lat)));
    planes.push({
      hex: (Math.random().toString(16).slice(2, 8) + '0000000').slice(0, 6),
      flight: p,
      reg: regs[i % regs.length],
      type: types[i % types.length],
      lat,
      lon,
      alt,
      onGround,
      gs,
      track: Math.floor(Math.random() * 360),
      baroRate: onGround ? 0 : Math.floor((Math.random() - 0.5) * 1600),
      squawk: String(1000 + Math.floor(Math.random() * 6000)),
      emergency: null,
      category: 'A3',
      seenPos: Math.random() * 2,
      messages: Math.floor(Math.random() * 9000),
      sim: true
    });
  }
  return planes;
}

function startDemo(reason = '') {
  if (state.demoActive) return;
  state.demoActive = true;
  state.planes = makeDemoTraffic();
  state.source = 'demo';
  state.lastUpdate = Date.now();
  setStatus('DEMO', 'warn');
  renderPlanes();
  updateStats();
  renderPanel(true);
  updateRouteMatches();
  state.demoTimer = setInterval(() => {
    if (state.paused || !state.demoActive) return;
    const dt = 2;
    for (const p of state.planes) {
      if (p.onGround) continue;
      const dist = (p.gs * 1.852 * dt) / 3600;
      const np = destination(p, p.track, dist);
      p.lat = np.lat;
      p.lon = np.lon;
      p.alt = clamp(p.alt + p.baroRate * (dt / 60), 0, 48000);
      p.seenPos = 0;
    }
    renderPlanes();
    updateStats();
    updateRouteMatches();
    if (state.view === 'radar' && !state.selectedFlight) updateFeedOnly();
    if (state.selectedFlight) updateSelectedLive();
  }, 2000);
  toast(reason || 'ADS-B no disponible', 'Modo demostración: tráfico simulado alrededor del centro del mapa.', 'warn');
}

function stopDemo() {
  if (!state.demoActive) return;
  state.demoActive = false;
  clearInterval(state.demoTimer);
  state.demoTimer = null;
}

function setStatus(text, kind = 'live') {
  const pill = $('#statusPill');
  if (!pill) return;
  pill.className = 'statuspill' + (kind === 'warn' ? ' is-warn' : kind === 'error' ? ' is-error' : '');
  pill.querySelector('span').textContent = text;
}

/* ============================================================
   ROUTE CATALOG
============================================================ */
function buildRouteCatalog() {
  const seen = new Set();
  const list = [];
  for (const [a, b, region] of ROUTES) {
    const A = airportByIata.get(a);
    const B = airportByIata.get(b);
    if (!A || !B) continue;
    const key = [a, b].sort().join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    const dist = haversine(A, B);
    if (dist < 90) continue;
    const points = greatCircle(A, B, 56);
    const segs = [];
    let total = 0;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
    }
    const origin = A;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const x1 = (p1.lon - origin.lon) * 111.32 * Math.cos(rad(origin.lat));
      const y1 = (p1.lat - origin.lat) * 110.574;
      const x2 = (p2.lon - origin.lon) * 111.32 * Math.cos(rad(origin.lat));
      const y2 = (p2.lat - origin.lat) * 110.574;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const brg = (deg(Math.atan2(x2 - x1, y2 - y1)) + 360) % 360;
      segs.push({ x1, y1, x2, y2, len, cum: total, brg });
      total += len;
    }
    const centerLon = minLon + lonDiff(minLon, maxLon) / 2;
    list.push({
      id: key,
      from: A,
      to: B,
      region: region || 'Global',
      distKm: dist,
      points,
      segs,
      totalKm: total || dist,
      centerLat: (minLat + maxLat) / 2,
      centerLon,
      halfLat: (maxLat - minLat) / 2,
      halfLon: Math.abs(lonDiff(minLon, maxLon)) / 2,
      initialBearing: bearing(A, B)
    });
  }
  list.sort((a, b) => b.distKm - a.distKm);
  state.routeObjects = list;
  state.routeById = new Map(list.map((r) => [r.id, r]));
}

function matchRoute(plane, route) {
  if (Math.abs(plane.lat - route.centerLat) > route.halfLat + 2.5) return null;
  if (Math.abs(lonDiff(route.centerLon, plane.lon)) > route.halfLon + 2.5) return null;
  const px = lonDiff(route.from.lon, plane.lon) * 111.32 * Math.cos(rad(route.from.lat));
  const py = (plane.lat - route.from.lat) * 110.574;
  let best = Infinity;
  let bestFrac = 0;
  let bestBrg = 0;
  for (const s of route.segs) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - s.x1) * dx + (py - s.y1) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const cx = s.x1 + t * dx;
    const cy = s.y1 + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) {
      best = d;
      bestFrac = (s.cum + t * s.len) / (route.totalKm || 1);
      bestBrg = s.brg;
    }
  }
  if (best > 55) return null;
  if (bestFrac < 0.015 || bestFrac > 0.985) return null;
  const toB = bearing(plane, route.to);
  const toA = bearing(plane, route.from);
  const align = Math.min(
    angleDiff(plane.track, toB),
    angleDiff(plane.track, toA),
    angleDiff(plane.track, bestBrg),
    angleDiff(plane.track, (bestBrg + 180) % 360)
  );
  if (align > 55) return null;
  return { dist: best, frac: bestFrac, bearing: bestBrg };
}

function updateRouteMatches() {
  const matches = new Map();
  for (const route of state.routeObjects) {
    let count = 0;
    const sample = [];
    for (const p of state.planes) {
      if (p.onGround) continue;
      const m = matchRoute(p, route);
      if (!m) continue;
      count++;
      if (sample.length < 4) sample.push(p);
    }
    matches.set(route.id, { count, sample });
  }
  state.routeMatches = matches;
  updateAirportCounts();
  if (state.selectedRoute) renderPanel();
}

function updateAirportCounts() {
  const counts = new Map();
  const hubs = QUICK_HUBS.map((h) => ({ iata: h.iata, ap: airportByIata.get(h.iata) })).filter((h) => h.ap);
  for (const h of hubs) counts.set(h.iata, 0);
  for (const p of state.planes) {
    if (p.onGround) continue;
    for (const h of hubs) {
      if (haversine(p, h.ap) < 80) counts.set(h.iata, (counts.get(h.iata) || 0) + 1);
    }
  }
  state.airportCounts = counts;
}

/* ============================================================
   MAP
============================================================ */
function initMap() {
  if (!L) {
    toast('Leaflet no disponible', 'No se pudo cargar el motor del mapa. Revisa la carpeta vendor/leaflet.', 'error');
    return;
  }
  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 18,
    zoomSnap: 0.25,
    zoomDelta: 0.75,
    wheelPxPerZoomLevel: 90,
    preferCanvas: false
  }).setView([state.center.lat, state.center.lon], state.zoom);

  const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>';
  const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, attribution
  });
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
  });
  const light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, attribution
  });
  const terrain = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS'
  });
  dark.addTo(map);
  state.tiles = { dark, satellite, light, terrain };
  state.map = map;
  state.canvasRenderer = L.canvas({ padding: 0.4 });
  state.planeLayer = L.layerGroup().addTo(map);
  state.trailLayer = L.layerGroup().addTo(map);
  state.airportLayer = L.layerGroup().addTo(map);
  state.routeLayer = L.layerGroup().addTo(map);
  state.selectionLayer = L.layerGroup().addTo(map);
  state.issLayer = L.layerGroup().addTo(map);

  map.on('moveend', onMapMove);
  map.on('zoomend', onMapMove);
  map.on('dragstart', () => {
    if (state.follow) {
      state.follow = false;
      updateFollowUI();
    }
  });
  map.on('click', () => closeSearch());

  renderAirportMarkers();
  renderQuickHubs();
  restoreHash();
  updateCenterLabel();
  setTimeout(() => map.invalidateSize(), 200);
}

function onMapMove() {
  if (!state.map) return;
  const c = state.map.getCenter();
  state.center = { lat: c.lat, lon: c.lng };
  state.zoom = state.map.getZoom();
  updateCenterLabel();
  updateHash();
  clearTimeout(state._moveTimer);
  state._moveTimer = setTimeout(() => {
    renderAirportMarkers();
    scheduleRefresh(600);
    scheduleWeather();
  }, 350);
}

function updateCenterLabel() {
  const lat = state.center.lat;
  const lon = state.center.lon;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'O';
  $('#centerLabel').textContent = `${Math.abs(lat).toFixed(2)}° ${ns} · ${Math.abs(lon).toFixed(2)}° ${ew}`;
  $('#radiusLabel').textContent = `${state.radiusNm} NM`;
  $('#radiusBadge').textContent = `${state.radiusNm} NM`;
  $('#radiusOut').textContent = `${state.radiusNm} NM`;
  $('#coverageLabel').textContent = state.zoom <= 5 ? 'cobertura del centro' : 'cobertura local';
}

function setBasemap(name) {
  if (!state.map || !state.tiles) return;
  Object.values(state.tiles).forEach((layer) => state.map.removeLayer(layer));
  state.tiles[name].addTo(state.map);
  state.tiles[name].bringToBack();
  $$('#layerGrid .layerchip').forEach((b) => b.classList.toggle('is-active', b.dataset.basemap === name));
}

function renderAirportMarkers() {
  if (!state.map || !state.airportLayer) return;
  state.airportLayer.clearLayers();
  state.airportMarkers = [];
  if (!state.showAirports) return;
  const zoom = state.map.getZoom();
  const center = state.center;
  const near = [];
  if (zoom >= 7) {
    for (const a of airportByIata.values()) {
      const d = haversine(center, a);
      if (d < 900) near.push({ a, d });
    }
    near.sort((x, y) => x.d - y.d);
    const added = new Set();
    for (let i = 0; i < Math.min(130, near.length); i++) {
      addAirportMarker(near[i].a, false);
      added.add(near[i].a.iata);
    }
    for (const h of QUICK_HUBS) {
      const a = airportByIata.get(h.iata);
      if (!a || added.has(a.iata)) continue;
      addAirportMarker(a, true);
      added.add(a.iata);
    }
    return;
  }
  for (const h of QUICK_HUBS) {
    const a = airportByIata.get(h.iata);
    if (a) addAirportMarker(a, true);
  }
}

function addAirportMarker(a, major) {
  const isSel = state.selectedAirport && state.selectedAirport.iata === a.iata;
  const html = `<div class="airport-pin ${major ? 'is-major' : ''} ${isSel ? 'is-selected' : ''}">
    ${isSel ? '<span class="airport-pulse"></span>' : ''}
    <span class="dot"></span>
    <span class="ap-label">${esc(a.iata)}</span>
  </div>`;
  const marker = L.marker([a.lat, a.lon], {
    icon: L.divIcon({ className: 'airport-wrap', html, iconSize: [18, 18], iconAnchor: [9, 9] }),
    keyboard: false,
    zIndexOffset: major ? -40 : -80,
    riseOnHover: true
  });
  marker.on('click', (e) => {
    if (L && e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    selectAirport(a.iata);
  });
  marker.addTo(state.airportLayer);
  state.airportMarkers.push(marker);
}

function renderQuickHubs() {
  const grid = $('#hubGrid');
  if (!grid) return;
  grid.innerHTML = QUICK_HUBS.slice(0, 12).map((h) => {
    const a = airportByIata.get(h.iata);
    if (!a) return '';
    return `<button class="hubchip" data-iata="${h.iata}" title="${esc(a.name)}"><b>${h.iata}</b><span>${esc(h.label)}</span></button>`;
  }).join('');
}/* ============================================================
   PLANES
============================================================ */
function altitudeColor(alt) {
  if (alt <= 0) return '#64748b';
  if (alt < 10000) return '#38bdf8';
  if (alt < 20000) return '#34d399';
  if (alt < 33000) return '#fbbf24';
  if (alt < 40000) return '#fb923c';
  return '#c084fc';
}
function altitudeBand(alt) {
  if (alt <= 0) return 'TIERRA';
  if (alt < 10000) return 'BAJO';
  if (alt < 20000) return 'MEDIO';
  if (alt < 33000) return 'CRUCERO';
  if (alt < 40000) return 'ALTO';
  return 'MUY ALTO';
}
function planeIcon(p, selected) {
  const color = p.emergency ? '#f87171' : altitudeColor(p.alt);
  const label = p.flight;
  const cls = ['plane', selected ? 'is-selected' : '', p.sim ? 'is-sim' : '', p.onGround ? 'is-ground' : '', p.emergency ? 'is-emergency' : ''].filter(Boolean).join(' ');
  return L.divIcon({
    className: 'plane-wrap',
    html: `<div class="${cls}" style="--c:${color};--rot:${p.track}deg">
      <div class="glyph"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2c.8 0 1.2.6 1.3 1.5l.4 4.9 7.4 4.3v2.2l-7.2-2.1.3 5 2.4 1.8v1.6L12 20.6l-4.6.8v-1.6l2.4-1.8.3-5L2.9 15v-2.2l7.4-4.3.4-4.9c.1-.9.5-1.5 1.3-1.5Z" fill="currentColor"/></svg></div>
      <span class="plabel">${esc(label)}</span>
    </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function visiblePlanes() {
  return state.planes.filter((p) => {
    if (!p.onGround && (p.alt < state.altMin || p.alt > state.altMax)) return false;
    if (p.onGround && !state.showGround) return false;
    return true;
  });
}

function renderPlanes() {
  if (!state.map) return;
  const list = visiblePlanes();
  const live = new Set(list.map((p) => p.hex));
  for (const [hex, marker] of state.markers) {
    if (!live.has(hex) && hex !== state.selectedFlight) {
      state.planeLayer.removeLayer(marker);
      state.markers.delete(hex);
    }
  }
  for (const p of list) {
    const selected = p.hex === state.selectedFlight;
    const existing = state.markers.get(p.hex);
    if (!existing) {
      const marker = L.marker([p.lat, p.lon], {
        icon: planeIcon(p, selected),
        keyboard: false,
        zIndexOffset: selected ? 900 : 0,
        riseOnHover: true
      });
      marker.on('click', (e) => {
        if (L && e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        selectAircraft(p.hex, null, false);
      });
      marker.addTo(state.planeLayer);
      state.markers.set(p.hex, marker);
    } else {
      existing.setLatLng([p.lat, p.lon]);
      const el = existing.getElement();
      if (el) {
        const root = el.querySelector('.plane');
        if (root) {
          root.style.setProperty('--c', p.emergency ? '#f87171' : altitudeColor(p.alt));
          root.style.setProperty('--rot', `${p.track}deg`);
          const glyph = root.querySelector('.glyph');
          if (glyph) glyph.style.transform = `rotate(${p.track}deg)`;
          root.classList.toggle('is-selected', selected);
          root.classList.toggle('is-ground', p.onGround);
          root.classList.toggle('is-emergency', !!p.emergency);
          root.classList.toggle('is-sim', !!p.sim);
          const label = root.querySelector('.plabel');
          if (label && label.textContent !== p.flight) label.textContent = p.flight;
        }
      }
      existing.setZIndexOffset(selected ? 900 : 0);
    }
    updateTrail(p);
  }
  pruneTrails(live);
  updateStats();
  updateRouteMatches();
  if (state.view === 'radar' && !state.selectedFlight) updateFeedOnly();
  if (state.selectedAirport) updateAirportBoardOnly();
}

function updateTrail(p) {
  if (!state.showTrails) return;
  const prev = state.trails.get(p.hex);
  const last = prev && prev[prev.length - 1];
  if (last && haversine(last, p) < 0.25) return;
  const arr = prev ? prev.slice(-35) : [];
  arr.push({ lat: p.lat, lon: p.lon });
  state.trails.set(p.hex, arr);
  let line = state.trailLines.get(p.hex);
  if (!line) {
    line = L.polyline([], {
      color: altitudeColor(p.alt),
      weight: 1.2,
      opacity: 0.38,
      renderer: state.canvasRenderer,
      interactive: false
    }).addTo(state.trailLayer);
    state.trailLines.set(p.hex, line);
  }
  line.setLatLngs(arr.map((q) => [q.lat, q.lon]));
  line.setStyle({ color: altitudeColor(p.alt) });
}

function pruneTrails(live) {
  for (const [hex, line] of state.trailLines) {
    if (!live.has(hex) && hex !== state.selectedFlight) {
      state.trailLayer.removeLayer(line);
      state.trailLines.delete(hex);
      state.trails.delete(hex);
    }
  }
  for (const [, line] of state.trailLines) {
    line.setStyle({ opacity: state.showTrails ? 0.38 : 0 });
  }
}

function updateStats() {
  const planes = state.planes;
  const airborne = planes.filter((p) => !p.onGround);
  const ground = planes.filter((p) => p.onGround);
  const ceiling = airborne.reduce((m, p) => Math.max(m, p.alt), 0);
  const fastest = airborne.reduce((m, p) => Math.max(m, p.gs), 0);
  $('#statAirborne').textContent = state.source === 'connecting' ? '—' : fmtInt(airborne.length);
  $('#statGround').textContent = state.source === 'connecting' ? '—' : fmtInt(ground.length);
  $('#statCeiling').textContent = state.source === 'connecting' ? '—' : `${fmtInt(ceiling / 1000)}k`;
  $('#statFastest').textContent = state.source === 'connecting' ? '—' : `${fmtInt(fastest)} kt`;
  $('#statUpdated').textContent = state.lastUpdate ? new Date(state.lastUpdate).toISOString().slice(11, 19) : '—';
  $('#radarSource').textContent = state.source === 'demo' ? 'SIMULACIÓN' : state.source === 'live' ? 'EN VIVO' : 'CONECTANDO';
  $('#radarSource').style.color = state.source === 'demo' ? 'var(--gold)' : '';
}

/* ============================================================
   SELECTION / FOLLOW
============================================================ */
function selectAircraft(hex, data = null, follow = true) {
  let p = state.planes.find((x) => x.hex === hex);
  if (!p && data) {
    const n = normalizeAircraft(data);
    if (n) {
      n.hex = hex;
      state.planes.push(n);
      p = n;
    }
  }
  if (!p) return;
  state.selectedFlight = p.hex;
  state.selectedAirport = null;
  state.selectedRoute = null;
  state.view = 'radar';
  setActiveNav('radar');
  state.follow = !!follow;
  state.routeLayer.clearLayers();
  state.selectionLayer.clearLayers();
  state.traceLine = null;
  state.traceGlow = null;
  if (state.map) {
    const z = Math.max(state.map.getZoom(), 7.5);
    state.map.flyTo([p.lat, p.lon], z, { duration: 1.1 });
  }
  clearTraceLine();
  fetchTrace(p.hex);
  renderPanel(true);
  updateFollowUI();
  renderPlanes();
  updateHash();
}

function clearSelection() {
  state.selectedFlight = null;
  state.trace = null;
  clearTraceLine();
  state.routeLayer.clearLayers();
  state.selectionLayer.clearLayers();
  state.traceLine = null;
  state.traceGlow = null;
  state.follow = false;
  renderPanel(true);
  renderPlanes();
  updateHash();
}

function updateFollowUI() {
  const btn = $('#followBtn');
  if (btn) {
    btn.classList.toggle('is-active', state.follow);
    btn.querySelector('span').textContent = state.follow ? 'Siguiendo' : 'Seguir';
  }
}

function clearTraceLine() {
  if (state.traceLine) {
    state.routeLayer.removeLayer(state.traceLine);
    state.traceLine = null;
  }
  if (state.traceGlow) {
    state.routeLayer.removeLayer(state.traceGlow);
    state.traceGlow = null;
  }
}

function drawTrace(points, color = '#f5c451') {
  clearTraceLine();
  if (!state.map || !points || points.length < 2) return;
  const coords = points.map((p) => [p.lat, p.lon]);
  state.traceGlow = L.polyline(coords, { color, weight: 6, opacity: 0.12, renderer: state.canvasRenderer, interactive: false }).addTo(state.routeLayer);
  state.traceLine = L.polyline(coords, { color, weight: 1.8, opacity: 0.75, dashArray: '3 4', renderer: state.canvasRenderer, interactive: false }).addTo(state.routeLayer);
}

function drawRoute(route) {
  if (!state.map || !state.routeLayer) return;
  state.routeLayer.clearLayers();
  state.traceLine = null;
  state.traceGlow = null;
  if (!route) return;
  const coords = route.points.map((p) => [p.lat, p.lon]);
  L.polyline(coords, {
    color: '#f5c451',
    weight: 2,
    opacity: 0.9,
    renderer: state.canvasRenderer,
    interactive: false
  }).addTo(state.routeLayer);
  L.circleMarker([route.from.lat, route.from.lon], {
    radius: 5, color: '#f5c451', weight: 1.5, fillColor: '#04101a', fillOpacity: 1
  }).addTo(state.routeLayer).bindTooltip(`${route.from.iata} · ${route.from.city}`, { direction: 'top', className: 'airport-tip' });
  L.circleMarker([route.to.lat, route.to.lon], {
    radius: 5, color: '#5eead4', weight: 1.5, fillColor: '#04101a', fillOpacity: 1
  }).addTo(state.routeLayer).bindTooltip(`${route.to.iata} · ${route.to.city}`, { direction: 'top', className: 'airport-tip' });
}

function fitRoute(route) {
  if (!state.map) return;
  const b = L.latLngBounds(route.points.map((p) => [p.lat, p.lon]));
  state.map.fitBounds(b, { padding: [70, 70], maxZoom: 8 });
}

function selectRoute(id) {
  const route = state.routeById.get(id);
  if (!route) return;
  state.selectedRoute = route;
  state.selectedFlight = null;
  state.selectedAirport = null;
  state.view = 'routes';
  setActiveNav('routes');
  state.selectionLayer.clearLayers();
  drawRoute(route);
  fitRoute(route);
  fetchTraceIfNeeded();
  renderPanel(true);
  updateHash();
}

function clearRoute() {
  state.selectedRoute = null;
  state.routeLayer.clearLayers();
  state.traceLine = null;
  state.traceGlow = null;
  renderPanel(true);
  updateHash();
}

/* ============================================================
   AIRPORTS
============================================================ */
function selectAirport(iata) {
  const ap = airportByIata.get(iata);
  if (!ap) return;
  state.selectedAirport = ap;
  state.selectedFlight = null;
  state.selectedRoute = null;
  state.view = 'airports';
  setActiveNav('airports');
  state.follow = false;
  state.routeLayer.clearLayers();
  state.traceLine = null;
  state.traceGlow = null;
  if (state.map) state.map.flyTo([ap.lat, ap.lon], Math.max(state.map.getZoom(), 8), { duration: 1.2 });
  drawAirportSelection(ap);
  fetchAirportWeather(ap);
  renderPanel(true);
  updateHash();
}

function drawAirportSelection(ap) {
  if (!state.map) return;
  state.selectionLayer.clearLayers();
  L.circle([ap.lat, ap.lon], {
    radius: 40 * 1.852,
    color: '#f5c451',
    weight: 1,
    opacity: 0.4,
    dashArray: '4 6',
    fillColor: '#f5c451',
    fillOpacity: 0.03,
    renderer: state.canvasRenderer
  }).addTo(state.selectionLayer);
  const sel = state.airportMarkers.find((m) => {
    const ll = m.getLatLng();
    return Math.abs(ll.lat - ap.lat) < 1e-6 && Math.abs(ll.lng - ap.lon) < 1e-6;
  });
  if (sel) sel.setZIndexOffset(1000);
}

function airportTraffic(ap) {
  return state.planes
    .map((p) => {
      const dist = haversine(ap, p);
      const brg = bearing(ap, p);
      return { p, dist, brg };
    })
    .filter((x) => x.dist < 80)
    .sort((a, b) => a.dist - b.dist);
}

function classifyTraffic(item) {
  const { p, dist } = item;
  if (p.onGround) return { label: 'TIERRA', cls: 'is-ground' };
  if (p.baroRate > 180 && p.alt < 18000 && dist < 45) return { label: 'SALIDA', cls: 'is-dep' };
  if (p.baroRate < -180) return { label: 'LLEGADA', cls: 'is-arr' };
  return { label: 'SOBREVUELO', cls: 'is-over' };
}

function airportWeather(ap) {
  if (state.weather && state.weather.lat !== undefined && haversine(state.weather, ap) < 60) return state.weather;
  return null;
}

function updateAirportBoardOnly() {
  if (!state.selectedAirport) return;
  const ap = state.selectedAirport;
  const traffic = airportTraffic(ap);
  const arrivals = traffic.filter((x) => classifyTraffic(x).label === 'LLEGADA');
  const departures = traffic.filter((x) => classifyTraffic(x).label === 'SALIDA');
  const over = traffic.filter((x) => classifyTraffic(x).label === 'SOBREVUELO');
  const board = $('#airportBoard');
  if (!board) return;
  board.innerHTML = `
    <div class="board">
      <div class="board-col"><h3>LLEGADAS</h3>${boardRows(arrivals)}</div>
      <div class="board-col"><h3>SALIDAS</h3>${boardRows(departures)}</div>
    </div>`;
  const stats = $('#airportBoardStats');
  if (stats) stats.innerHTML = `<div class="overview-item"><span>En aproximación</span><b>${arrivals.length}</b></div>
    <div class="overview-item"><span>En salida</span><b>${departures.length}</b></div>
    <div class="overview-item"><span>Sobrevolando</span><b>${over.length}</b></div>`;
}

/* ============================================================
   TRACE / SPARKLINE
============================================================ */
async function fetchTrace(hex) {
  if (!hex) return;
  try {
    const data = await api.trace(hex);
    const trace = (data.trace || []).map((t) => {
      if (Array.isArray(t)) {
        const lat = Number(t[1]);
        const lon = Number(t[2]);
        const alt = Number(t[3]);
        return { t: Number(t[0]) || 0, lat, lon, alt: Number.isFinite(alt) ? alt : 0, gs: Number(t[4]) || 0, track: Number(t[5]) || 0 };
      }
      return null;
    }).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    state.trace = { points: trace, desc: data.desc || '', r: data.r || '', t: data.t || '' };
    if (state.selectedFlight === hex) {
      drawTrace(trace, '#f5c451');
      updateSparkline();
      const title = $('#traceTitle');
      if (title) title.textContent = state.trace.desc || 'ÚLTIMOS MINUTOS';
    }
  } catch {
    state.trace = null;
    if (state.selectedFlight === hex) updateSparkline();
  }
}

function fetchTraceIfNeeded() {
  if (state.selectedFlight) fetchTrace(state.selectedFlight);
}

function sparklineSVG(points) {
  if (!points || points.length < 2) {
    return `<div class="empty" style="padding:16px 0"><span>Sin histórico reciente. La estela se construye con las últimas posiciones del radar.</span></div>`;
  }
  const w = 300;
  const h = 58;
  const pad = 4;
  const alts = points.map((p) => p.alt);
  const min = Math.min(...alts);
  const max = Math.max(...alts);
  const span = Math.max(1, max - min);
  const xs = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const ys = (a) => h - pad - ((a - min) / span) * (h - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.alt).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(points.length - 1).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5eead4" stop-opacity=".28"/><stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#sparkFill)"/>
    <path d="${line}" fill="none" stroke="#5eead4" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${pad}" y="${pad + 7}" fill="#607890" font-size="7" font-family="JetBrains Mono, monospace">${fmtInt(max / 1000)}k ft</text>
    <text x="${pad}" y="${h - pad}" fill="#607890" font-size="7" font-family="JetBrains Mono, monospace">${fmtInt(min / 1000)}k ft</text>
  </svg>`;
}

function updateSparkline() {
  const wrap = $('#sparkWrap');
  if (!wrap) return;
  const pts = state.trace && state.trace.points ? state.trace.points.slice(-45) : [];
  wrap.innerHTML = sparklineSVG(pts);
}

/* ============================================================
   WEATHER / ISS
============================================================ */
const WMO = {
  0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Niebla', 48: 'Niebla engelante', 51: 'Llovizna ligera', 53: 'Llovizna', 55: 'Llovizna intensa',
  56: 'Llovizna engelante', 57: 'Llovizna engelante', 61: 'Lluvia ligera', 63: 'Lluvia', 65: 'Lluvia intensa',
  66: 'Lluvia engelante', 67: 'Lluvia engelante', 71: 'Nieve ligera', 73: 'Nieve', 75: 'Nieve intensa',
  77: 'Granos de nieve', 80: 'Chubascos ligeros', 81: 'Chubascos', 82: 'Chubascos violentos',
  85: 'Chubascos de nieve', 86: 'Chubascos de nieve', 95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo'
};
const weatherLabel = (code) => WMO[code] || 'Cielo variable';
const weatherIcon = (code) => (code === 0 || code === 1 ? 'i-sun' : 'i-cloud');
const windDir = (d) => compass(d || 0);

function fmtTemp(c) {
  if (c === null || c === undefined || Number.isNaN(Number(c))) return '—';
  return state.units === 'imperial' ? `${fmtInt(c * 9 / 5 + 32)}°F` : `${fmtInt(c)}°C`;
}
function fmtWind(kmh) {
  if (kmh === null || kmh === undefined) return '—';
  return state.units === 'imperial' ? `${fmtInt(kmh * 0.539957)} kt` : `${fmtInt(kmh)} km/h`;
}

async function scheduleWeather() {
  clearTimeout(state.weatherTimer);
  state.weatherTimer = setTimeout(() => fetchWeather(state.center.lat, state.center.lon), 400);
}

async function fetchWeather(lat, lon) {
  try {
    const w = await api.weather(lat, lon);
    state.weather = { ...w, lat, lon, fetched: Date.now() };
    updateWeatherChip();
    if (state.panelSignature.includes('weather') || (state.selectedAirport && haversine(state.selectedAirport, { lat, lon }) < 60)) renderPanel();
  } catch {
    /* weather is non-critical */
  }
}

function fetchAirportWeather(ap) {
  api.weather(ap.lat, ap.lon).then((w) => {
    state.weather = { ...w, lat: ap.lat, lon: ap.lon, fetched: Date.now() };
    updateWeatherChip();
    if (state.selectedAirport && state.selectedAirport.iata === ap.iata) renderPanel();
  }).catch(() => {});
}

function updateWeatherChip() {
  if (!state.weather) return;
  const cur = state.weather.current || {};
  const temp = fmtTemp(cur.temperature_2m);
  $('#weatherTemp').textContent = temp;
  $('#weatherDesc').textContent = weatherLabel(cur.weather_code);
  const chip = $('#weatherChip');
  const use = chip.querySelector('use');
  if (use) use.setAttribute('href', `#${weatherIcon(cur.weather_code)}`);
}

async function fetchISS() {
  try {
    const iss = await api.iss();
    if (!iss || !Number.isFinite(iss.latitude)) return;
    state.iss = iss;
    $('#issLabel').textContent = `${iss.latitude.toFixed(1)}°, ${iss.longitude.toFixed(1)}°`;
    if (!state.map) return;
    const html = `<div class="iss-pin"><svg class="i"><use href="#i-satellite"></use></svg></div>`;
    if (state._issMarker) {
      state._issMarker.setLatLng([iss.latitude, iss.longitude]);
    } else {
      state._issMarker = L.marker([iss.latitude, iss.longitude], {
        icon: L.divIcon({ className: 'iss-wrap', html, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false,
        zIndexOffset: 600
      }).addTo(state.issLayer);
      state._issMarker.bindTooltip(`ISS · ${Math.round(iss.altitude)} km · ${fmtInt(iss.velocity)} km/h`, { direction: 'top', className: 'airport-tip' });
      state._issMarker.on('click', (e) => {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        state.map.flyTo([iss.latitude, iss.longitude], Math.min(state.map.getZoom(), 4), { duration: 1.2 });
      });
    }
    if (state.panelSignature.includes('weather')) renderPanel();
  } catch {
    $('#issLabel').textContent = 'sin señal';
  }
}

/* ============================================================
   TRAFFIC FETCH LOOP
============================================================ */
function scheduleRefresh(delay = null) {
  clearTimeout(state.refreshTimer);
  if (state.paused) return;
  state.refreshTimer = setTimeout(refreshTraffic, delay === null ? state.refreshMs : delay);
}

async function refreshTraffic() {
  if (!state.map || state.paused || state.fetching) {
    scheduleRefresh();
    return;
  }
  state.fetching = true;
  try {
    const c = state.center;
    const data = await api.point(c.lat, c.lon, state.radiusNm);
    const ac = (data.ac || []).map(normalizeAircraft).filter(Boolean);
    if (state.selectedFlight) {
      const prev = state.planes.find((x) => x.hex === state.selectedFlight);
      if (prev && !ac.some((x) => x.hex === state.selectedFlight)) ac.push(prev);
    }
    state.planes = ac;
    state.source = 'live';
    state.lastUpdate = Date.now();
    state.hasLoadedOnce = true;
    stopDemo();
    setStatus('EN VIVO');
    renderPlanes();
    updateStats();
    updateRouteMatches();
    if (state.view === 'radar' && !state.selectedFlight) updateFeedOnly();
    if (state.selectedAirport) updateAirportBoardOnly();
    if (state.selectedFlight) {
      const p = state.planes.find((x) => x.hex === state.selectedFlight);
      if (p) updateSelectedLive();
    }
    renderPanel();
  } catch (err) {
    const msg = String(err.message || err);
    if (!state.hasLoadedOnce || state.planes.length === 0) {
      startDemo(`No se pudo contactar con ADS-B (${msg.slice(0, 90)}).`);
    } else {
      setStatus('SIN DATOS', 'warn');
    }
  } finally {
    state.fetching = false;
    scheduleRefresh();
  }
}

function updateFeedOnly() {
  const feed = $('#feedList');
  if (!feed) return;
  feed.innerHTML = feedRows();
}

function updateSelectedLive() {
  const p = state.planes.find((x) => x.hex === state.selectedFlight);
  if (!p) return;
  if (state.follow && state.map) {
    const c = state.map.getCenter();
    if (haversine(c, p) > 8) state.map.panTo([p.lat, p.lon], { animate: true, duration: 0.8 });
  }
  const board = $('#flightLive');
  if (board) {
    const dist = haversine(state.center, p);
    const brg = bearing(state.center, p);
    board.innerHTML = `
      <div class="metric"><span>ALTITUD</span><b>${fmtInt(p.alt)}<small>ft</small></b></div>
      <div class="metric"><span>VELOCIDAD</span><b>${fmtInt(p.gs)}<small>kt</small></b></div>
      <div class="metric"><span>RUMBO</span><b>${fmtInt(p.track)}°<small>${compass(p.track)}</small></b></div>
      <div class="metric"><span>DISTANCIA</span><b>${fmtInt(dist)}<small>km</small></b></div>`;
  }
  const kv = $('#flightLiveKv');
  if (kv) {
    kv.innerHTML = `
      <div class="kv"><span>Matrícula</span><b>${esc(p.reg)}</b></div>
      <div class="kv"><span>Tipo</span><b>${esc(typeName(p.type))}</b></div>
      <div class="kv"><span>Squawk</span><b>${esc(p.squawk)}</b></div>
      <div class="kv"><span>Régimen</span><b>${p.baroRate > 0 ? '+' : ''}${fmtInt(p.baroRate)} ft/min</b></div>
      <div class="kv"><span>Posición</span><b>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</b></div>
      <div class="kv"><span>Rumbo al centro</span><b>${fmtInt(brg)}° ${compass(brg)}</b></div>`;
  }
}/* ============================================================
   PANELS
============================================================ */
function setActiveNav(view) {
  $$('.navbtn, .mobilenav button').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
}

function setView(view) {
  if (view === 'cams') {
    openCams();
    return;
  }
  closeCams(false);
  const rp = $('#rightPanel');
  if (rp) rp.classList.remove('is-hidden');
  state.view = view;
  setActiveNav(view);
  if (view === 'radar') {
    state.selectedRoute = null;
    state.selectedAirport = null;
    state.selectionLayer && state.selectionLayer.clearLayers();
    state.routeLayer && state.routeLayer.clearLayers();
  }
  if (view === 'routes') {
    state.selectedFlight = null;
    state.selectedAirport = null;
    state.selectedRoute = null;
  }
  if (view === 'airports') {
    state.selectedFlight = null;
    state.selectedRoute = null;
    state.selectedAirport = null;
    state.selectionLayer && state.selectionLayer.clearLayers();
  }
  renderPanel(true);
  setTimeout(() => state.map && state.map.invalidateSize(), 220);
}

function panelShell(kicker, title, sub, body, opts = {}) {
  const closeAction = opts.back ? 'panel-back' : 'panel-close';
  return `<div class="panel-head">
      <div><span class="eyebrow">${esc(kicker)}</span><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      <button class="panel-close" data-action="${closeAction}" aria-label="${opts.back ? 'Volver' : 'Cerrar'}"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="panel-scroll">${body}</div>`;
}

function renderPanel(force = false) {
  const panel = $('#rightPanel');
  if (!panel) return;
  if (force) panel.classList.remove('is-hidden');
  const active = document.activeElement;
  const activeId = active && panel.contains(active) ? active.id : null;
  const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const scrollEl = panel.querySelector('.panel-scroll');
  const scroll = scrollEl ? scrollEl.scrollTop : 0;

  let html = '';
  const sig = JSON.stringify({
    v: state.view,
    f: state.selectedFlight,
    a: state.selectedAirport && state.selectedAirport.iata,
    r: state.selectedRoute && state.selectedRoute.id,
    n: state.planes.length,
    src: state.source,
    w: state.weather && state.weather.fetched,
    t: state.lastUpdate,
    ff: state.feedFilter,
    fs: state.feedSort,
    rf: state.routeFilter,
    rr: state.routeRegion,
    af: state.airportFilter
  });
  if (!force && sig === state.panelSignature) return;
  state.panelSignature = sig;

  if (state.selectedFlight) {
    const p = state.planes.find((x) => x.hex === state.selectedFlight);
    if (p) html = flightPanel(p);
    else { state.selectedFlight = null; html = trafficPanel(); }
  } else if (state.selectedAirport) {
    html = airportPanel(state.selectedAirport);
  } else if (state.selectedRoute) {
    html = routePanel(state.selectedRoute);
  } else if (state.view === 'routes') {
    html = routesPanel();
  } else if (state.view === 'airports') {
    html = airportsPanel();
  } else if (state.weather && state.weather.pinned) {
    html = weatherPanel();
  } else {
    html = trafficPanel();
  }

  panel.innerHTML = html;
  const newScroll = panel.querySelector('.panel-scroll');
  if (newScroll) newScroll.scrollTop = scroll;
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus();
      if (selStart !== null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(selStart, selStart); } catch {}
      }
    }
  }
  bindPanelInputs();
  updateFollowUI();
}

function airlineFor(flight) {
  const letters = String(flight || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return AIRLINES[letters.slice(0, 3)] || 'Aviación general';
}
function typeName(t) {
  return AIRCRAFT_TYPES[t] || t || '—';
}
function distFromCenter(p) {
  return haversine(state.center, p);
}
function bearingFromCenter(p) {
  return bearing(state.center, p);
}

function feedRows() {
  const q = state.feedFilter.trim().toUpperCase();
  let list = state.planes.slice();
  if (q) {
    list = list.filter((p) => p.flight.toUpperCase().includes(q) || p.reg.toUpperCase().includes(q) || p.hex.includes(q.toLowerCase()));
  }
  if (state.feedSort === 'alt') list.sort((a, b) => b.alt - a.alt);
  else if (state.feedSort === 'speed') list.sort((a, b) => b.gs - a.gs);
  else list.sort((a, b) => a.flight.localeCompare(b.flight));
  if (!list.length) return '<div class="feed-empty">Sin aeronaves en el área. Prueba a alejar el mapa, ampliar el radio o cambiar de centro.</div>';
  return list.slice(0, 90).map((p) => {
    const dist = distFromCenter(p);
    return `<button class="feed-row ${p.hex === state.selectedFlight ? 'is-selected' : ''}" data-hex="${esc(p.hex)}">
      <span class="fr-cs">${esc(p.flight)}</span>
      <span class="fr-sub"><b>${esc(airlineFor(p.flight))}</b><span>${esc(typeName(p.type))} · ${fmtInt(p.alt)} ft · ${fmtInt(dist)} km</span></span>
      <span class="fr-alt">${fmtInt(p.alt / 1000)}k<small>${p.onGround ? 'tierra' : 'ft'}</small></span>
    </button>`;
  }).join('');
}

function trafficPanel() {
  const live = state.planes.length;
  return `
    <div class="panel-head">
      <div><span class="eyebrow">TRÁFICO EN VIVO</span><h2>${state.source === 'demo' ? 'Simulación' : 'Aeronaves'}</h2><p>${live} objetivos en el área · ${state.radiusNm} NM</p></div>
      <button class="panel-close" data-action="panel-close" aria-label="Cerrar"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="panel-scroll">
      <div class="feed-tools">
        <input id="feedFilter" placeholder="Filtrar por vuelo, matrícula o hex…" value="${esc(state.feedFilter)}">
        <select id="feedSort" aria-label="Ordenar">
          <option value="alt" ${state.feedSort === 'alt' ? 'selected' : ''}>Altitud</option>
          <option value="speed" ${state.feedSort === 'speed' ? 'selected' : ''}>Velocidad</option>
          <option value="cs" ${state.feedSort === 'cs' ? 'selected' : ''}>Vuelo</option>
        </select>
      </div>
      <div class="feed" id="feedList">${feedRows()}</div>
      <div class="panel-section" style="padding:10px 14px">
        <div class="panel-section-title"><span>FUENTE</span><b>${state.source === 'demo' ? 'SIMULADA' : 'ADS-B'}</b></div>
        <p class="tiny">${state.source === 'demo' ? 'El proveedor ADS-B no responde. Se muestran objetivos simulados para que el panel siga siendo explorable.' : 'Posiciones de la red abierta adsb.lol, actualizadas periódicamente. No usar para navegación.'}</p>
        <button class="widebtn ghost" data-action="retry" style="margin-top:8px"><svg class="i"><use href="#i-refresh"></use></svg><span>Reintentar conexión</span></button>
      </div>
    </div>`;
}

function flightPanel(p) {
  const airline = airlineFor(p.flight);
  const dist = distFromCenter(p);
  const brg = bearingFromCenter(p);
  const emergency = p.emergency;
  const squawkAlert = ['7700', '7600', '7500'].includes(p.squawk);
  const est = estimateRoute(p);
  return `
    <div class="panel-head" style="padding-bottom:6px">
      <div><span class="eyebrow">FICHA DE AERONAVE</span><h2>${esc(p.flight)}</h2><p>${esc(airline)}</p></div>
      <button class="panel-close" data-action="panel-back" aria-label="Volver"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="panel-scroll">
      <div class="flight-hero" style="border-top:1px solid var(--line-soft)">
        <div class="flight-callsign"><h2>${esc(p.flight)}</h2><span class="airline">${esc(airline)}</span></div>
        <div class="flight-badges">
          <span class="badge is-live"><i class="live-dot"></i>${p.sim ? 'SIMULADO' : 'EN VIVO'}</span>
          <span class="badge">${esc(typeName(p.type))}</span>
          <span class="badge">${esc(p.reg)}</span>
          ${emergency || squawkAlert ? `<span class="badge is-alert">${emergency ? esc(emergency.toUpperCase()) : 'SQUAWK ' + esc(p.squawk)}</span>` : ''}
          ${p.onGround ? '<span class="badge">EN TIERRA</span>' : `<span class="badge">${altitudeBand(p.alt)}</span>`}
        </div>
      </div>
      <div class="flight-metrics" id="flightLive">
        <div class="metric"><span>ALTITUD</span><b>${fmtInt(p.alt)}<small>ft</small></b></div>
        <div class="metric"><span>VELOCIDAD</span><b>${fmtInt(p.gs)}<small>kt</small></b></div>
        <div class="metric"><span>RUMBO</span><b>${fmtInt(p.track)}°<small>${compass(p.track)}</small></b></div>
        <div class="metric"><span>DISTANCIA</span><b>${fmtInt(dist)}<small>km</small></b></div>
      </div>
      <div class="panel-body">
        <div class="panel-section">
          <div class="panel-section-title"><span>IDENTIFICACIÓN</span><b>HEX ${esc(p.hex.toUpperCase())}</b></div>
          <div class="kvgrid" id="flightLiveKv">
            <div class="kv"><span>Matrícula</span><b>${esc(p.reg)}</b></div>
            <div class="kv"><span>Tipo</span><b>${esc(typeName(p.type))}</b></div>
            <div class="kv"><span>Squawk</span><b>${esc(p.squawk)}</b></div>
            <div class="kv"><span>Régimen</span><b>${p.baroRate > 0 ? '+' : ''}${fmtInt(p.baroRate)} ft/min</b></div>
            <div class="kv"><span>Posición</span><b>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</b></div>
            <div class="kv"><span>Rumbo al centro</span><b>${fmtInt(brg)}° ${compass(brg)}</b></div>
          </div>
        </div>
        <div class="panel-section">
          <div class="panel-section-title"><span>RUTA</span><b>ESTIMADA</b></div>
          <div class="route-estimate">
            <div class="route-node"><b>${est.from ? esc(est.from.iata) : '—'}</b><span>${est.from ? esc(est.from.city) : 'origen no identificado'}</span></div>
            <div class="route-line"><small>${esc(est.label)}</small></div>
            <div class="route-node"><b>${est.to ? esc(est.to.iata) : '—'}</b><span>${est.to ? esc(est.to.city) : 'destino estimado'}</span></div>
          </div>
          <p class="tiny">${esc(est.note)}</p>
        </div>
        <div class="panel-section">
          <div class="panel-section-title"><span>PERFIL DE ALTITUD</span><b id="traceTitle">${state.trace ? esc(state.trace.desc || 'ÚLTIMOS MINUTOS') : 'SIN HISTÓRICO'}</b></div>
          <div id="sparkWrap">${sparklineSVG(state.trace && state.trace.points ? state.trace.points.slice(-45) : [])}</div>
        </div>
        <div class="actionrow">
          <button class="widebtn ${state.follow ? 'is-active' : ''}" id="followBtn" data-action="follow"><svg class="i"><use href="#i-follow"></use></svg><span>${state.follow ? 'Siguiendo' : 'Seguir'}</span></button>
          <button class="widebtn ghost" data-action="center-flight" title="Centrar"><svg class="i"><use href="#i-locate"></use></svg></button>
          <a class="iconlink" href="https://www.flightradar24.com/${encodeURIComponent(p.flight)}" target="_blank" rel="noopener" title="Ver en Flightradar24"><svg class="i"><use href="#i-external"></use></svg></a>
          <a class="iconlink" href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(p.hex)}" target="_blank" rel="noopener" title="Ver en ADS-B Exchange"><svg class="i"><use href="#i-radar"></use></svg></a>
        </div>
      </div>
    </div>`;
}

function estimateRoute(p) {
  const trace = state.trace && state.trace.points ? state.trace.points : [];
  const near = [];
  for (const a of airportByIata.values()) {
    const d = haversine(a, p);
    if (d < 450) near.push({ a, d });
  }
  near.sort((x, y) => x.d - y.d);
  let from = null;
  for (const item of near) {
    const brgOut = bearing(item.a, p);
    const diff = angleDiff(p.track, brgOut);
    if (diff < 55) { from = item.a; break; }
  }
  if (!from && trace.length) {
    for (const t of trace) {
      for (const item of near) {
        if (haversine(item.a, t) < 30) { from = item.a; break; }
      }
      if (from) break;
    }
  }
  let to = null;
  for (const item of near) {
    const brgIn = bearing(p, item.a);
    const diff = angleDiff(p.track, brgIn);
    if (diff < 55 && item.d > 25) { to = item.a; break; }
  }
  if (!from && !to) {
    return { from: null, to: null, label: 'PROYECCIÓN', note: 'Sin aeropuertos cercanos que permitan estimar el origen. La línea señala la proyección de la trayectoria actual, no un plan de vuelo.' };
  }
  if (!to) {
    return { from, to: null, label: 'PROYECCIÓN', note: 'Origen estimado por proximidad y rumbo. El destino no puede confirmarse con ADS-B; se muestra la proyección de la trayectoria.' };
  }
  return { from, to, label: `${fmtInt(haversine(from, to))} KM`, note: 'Ruta estimada por geometría y rumbos observados. No es un plan de vuelo oficial.' };
}

function routePanel(route) {
  const live = state.routeMatches.get(route.id) || { count: 0, sample: [] };
  const minutes = Math.round((route.distKm / 820) * 60);
  return `
    <div class="panel-head" style="padding-bottom:6px">
      <div><span class="eyebrow">RUTA</span><h2>${esc(route.from.iata)} → ${esc(route.to.iata)}</h2><p>${esc(route.region)}</p></div>
      <button class="panel-close" data-action="panel-back" aria-label="Volver"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="panel-scroll">
      <div class="route-detail-hero">
        <div class="route-code"><svg class="i"><use href="#i-route"></use></svg>${esc(route.from.iata)} <span style="color:var(--muted-2)">→</span> ${esc(route.to.iata)}</div>
        <div class="route-cities"><span>${esc(route.from.city)}, ${esc(route.from.country)} → ${esc(route.to.city)}, ${esc(route.to.country)}</span></div>
      </div>
      <div class="route-stats">
        <div class="metric"><span>DISTANCIA</span><b>${fmtInt(route.distKm)}<small>km</small></b></div>
        <div class="metric"><span>DURACIÓN EST.</span><b>${Math.floor(minutes / 60)}h ${minutes % 60}m</b></div>
        <div class="metric"><span>EN RUTA</span><b>${live.count}<small>vuelos</small></b></div>
      </div>
      <div class="panel-body">
        <div class="route-airports">
          <button class="airport-mini" data-iata="${esc(route.from.iata)}"><b>${esc(route.from.iata)}</b><span>${esc(route.from.name)}</span></button>
          <button class="airport-mini" data-iata="${esc(route.to.iata)}"><b>${esc(route.to.iata)}</b><span>${esc(route.to.name)}</span></button>
        </div>
        <div class="panel-section">
          <div class="panel-section-title"><span>VUELOS DETECTADOS EN LA RUTA</span><b>${live.count}</b></div>
          ${live.sample.length ? live.sample.map((p) => `<button class="feed-row" data-hex="${esc(p.hex)}"><span class="fr-cs">${esc(p.flight)}</span><span class="fr-sub"><b>${esc(airlineFor(p.flight))}</b><span>${esc(typeName(p.type))} · ${fmtInt(p.alt)} ft</span></span><span class="fr-alt">${fmtInt(p.gs)}<small>kt</small></span></button>`).join('') : '<div class="feed-empty">Ningún avión coincide ahora con el corredor de esta ruta. La detección compara posición y rumbo con el arco de gran círculo.</div>'}
        </div>
        <div class="panel-section">
          <p class="tiny">La ruta se dibuja como arco de gran círculo. La lista de vuelos no usa planes de vuelo: cruza posiciones ADS-B en vivo con el corredor y filtra por rumbo.</p>
        </div>
      </div>
    </div>`;
}

function routesPanel() {
  const q = state.routeFilter.trim().toUpperCase();
  const regions = ['all', ...Array.from(new Set(state.routeObjects.map((r) => r.region)))];
  let list = state.routeObjects.slice();
  if (state.routeRegion !== 'all') list = list.filter((r) => r.region === state.routeRegion);
  if (q) {
    list = list.filter((r) => `${r.from.iata}${r.to.iata}${r.from.city}${r.to.city}${r.from.country}${r.to.country}`.toUpperCase().includes(q));
  }
  list.sort((a, b) => {
    const ca = (state.routeMatches.get(a.id) || {}).count || 0;
    const cb = (state.routeMatches.get(b.id) || {}).count || 0;
    return cb - ca || a.distKm - b.distKm;
  });
  return `
    <div class="panel-head">
      <div><span class="eyebrow">RUTAS</span><h2>Corredores aéreos</h2><p>${list.length} rutas · ${state.routeObjects.length} en el catálogo</p></div>
      <button class="panel-close" data-action="panel-close" aria-label="Cerrar"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="route-search"><input id="routeFilter" placeholder="Buscar por ciudad, país o código…" value="${esc(state.routeFilter)}"></div>
    <div class="route-filters">${regions.map((r) => `<button class="filterchip ${state.routeRegion === r ? 'is-active' : ''}" data-region="${esc(r)}">${esc(r === 'all' ? 'Todas' : r)}</button>`).join('')}</div>
    <div class="panel-scroll">
      <div class="feed" style="max-height:none">
        ${list.slice(0, 160).map((r) => {
          const c = (state.routeMatches.get(r.id) || {}).count || 0;
          return `<button class="route-row" data-route="${esc(r.id)}">
            <span class="rr-code">${esc(r.from.iata)}<br>${esc(r.to.iata)}</span>
            <span><span class="rr-sub">${esc(r.from.city)} → ${esc(r.to.city)}</span><br><span class="rr-sub">${fmtInt(r.distKm)} km · ${esc(r.region)}</span></span>
            <span class="rr-live ${c ? '' : 'is-zero'}">${c} en ruta</span>
          </button>`;
        }).join('') || '<div class="feed-empty">Sin rutas para ese filtro.</div>'}
      </div>
    </div>`;
}

function airportsPanel() {
  const q = state.airportFilter.trim().toUpperCase();
  let hubs = QUICK_HUBS.map((h) => ({ h, a: airportByIata.get(h.iata) })).filter((x) => x.a);
  if (q) {
    hubs = hubs.filter((x) => `${x.h.iata}${x.h.label}${x.a.name}${x.a.city}${x.a.country}`.toUpperCase().includes(q));
  }
  hubs.sort((a, b) => (state.airportCounts.get(b.h.iata) || 0) - (state.airportCounts.get(a.h.iata) || 0));
  return `
    <div class="panel-head">
      <div><span class="eyebrow">AEROPUERTOS</span><h2>Panel de aeropuertos</h2><p>${QUICK_HUBS.length} hubs principales · tráfico en 80 km</p></div>
      <button class="panel-close" data-action="panel-close" aria-label="Cerrar"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="route-search"><input id="airportFilter" placeholder="Buscar aeropuerto, ciudad o país…" value="${esc(state.airportFilter)}"></div>
    <div class="panel-scroll">
      <div class="feed" style="max-height:none">
        ${hubs.map(({ h, a }) => {
          const c = state.airportCounts.get(h.iata) || 0;
          return `<button class="route-row" data-iata="${esc(h.iata)}">
            <span class="rr-code">${esc(h.iata)}</span>
            <span><span class="rr-sub">${esc(a.city)} · ${esc(a.country)}</span><br><span class="rr-sub">${esc(a.name)}</span></span>
            <span class="rr-live ${c ? '' : 'is-zero'}">${c} cerca</span>
          </button>`;
        }).join('') || '<div class="feed-empty">Sin aeropuertos para ese filtro.</div>'}
      </div>
    </div>`;
}

function airportPanel(ap) {
  const traffic = airportTraffic(ap);
  const arrivals = traffic.filter((x) => classifyTraffic(x).label === 'LLEGADA');
  const departures = traffic.filter((x) => classifyTraffic(x).label === 'SALIDA');
  const over = traffic.filter((x) => classifyTraffic(x).label === 'SOBREVUELO');
  const w = airportWeather(ap);
  const cur = w && w.current ? w.current : {};
  const local = localTime(ap);
  const cam = CAMERAS.find((c) => c.kind === 'airport' && haversine(c, ap) < 80);
  return `
    <div class="panel-head" style="padding-bottom:6px">
      <div><span class="eyebrow">AEROPUERTO</span><h2>${esc(ap.iata)} · ${esc(ap.name)}</h2><p>${esc(ap.city)}, ${esc(ap.country)}</p></div>
      <button class="panel-close" data-action="panel-back" aria-label="Volver"><svg class="i"><use href="#i-close"></use></svg></button>
    </div>
    <div class="panel-scroll">
      <div class="airport-hero">
        <div class="ah-code">${esc(ap.iata)} <span style="color:var(--muted-2);font-size:13px">/ ${esc(ap.icao)}</span></div>
        <div class="ah-name">${esc(ap.name)} · ${esc(ap.city)}</div>
        <div class="ah-meta">
          <span class="badge">${esc(ap.country)}</span>
          <span class="badge">${fmtInt(ap.alt)} ft elev.</span>
          <span class="badge">${esc(local)}</span>
        </div>
      </div>
      <div id="airportBoard">
        <div class="board">
          <div class="board-col"><h3>LLEGADAS</h3>${boardRows(arrivals)}</div>
          <div class="board-col"><h3>SALIDAS</h3>${boardRows(departures)}</div>
        </div>
      </div>
      <div class="panel-body">
        <div class="panel-section">
          <div class="panel-section-title"><span>METEOROLOGÍA</span><b>${esc(weatherLabel(cur.weather_code))}</b></div>
          <div class="weather-grid">
            <div class="metric"><span>TEMPERATURA</span><b>${fmtTemp(cur.temperature_2m)}</b></div>
            <div class="metric"><span>VIENTO</span><b>${fmtWind(cur.wind_speed_10m)} <small>${windDir(cur.wind_direction_10m)}</small></b></div>
            <div class="metric"><span>HUMEDAD</span><b>${cur.relative_humidity_2m ?? '—'}<small>%</small></b></div>
            <div class="metric"><span>PRESIÓN</span><b>${cur.surface_pressure ?? '—'}<small>hPa</small></b></div>
          </div>
        </div>
        <div class="panel-section">
          <div class="panel-section-title"><span>TRÁFICO EN EL ÁREA</span><b>${traffic.length} objetivos</b></div>
          <div class="overview-list" id="airportBoardStats">
            <div class="overview-item"><span>En aproximación</span><b>${arrivals.length}</b></div>
            <div class="overview-item"><span>En salida</span><b>${departures.length}</b></div>
            <div class="overview-item"><span>Sobrevolando</span><b>${over.length}</b></div>
          </div>
          ${over.slice(0, 5).map(({ p, dist }) => `<button class="feed-row" data-hex="${esc(p.hex)}"><span class="fr-cs">${esc(p.flight)}</span><span class="fr-sub"><b>${esc(airlineFor(p.flight))}</b><span>${esc(typeName(p.type))} · ${fmtInt(dist)} km</span></span><span class="fr-alt">${fmtInt(p.alt / 1000)}k<small>ft</small></span></button>`).join('')}
        </div>
        <div class="actionrow" style="padding:10px 15px 14px">
          <button class="widebtn" data-action="center-airport"><svg class="i"><use href="#i-locate"></use></svg><span>Centrar</span></button>
          ${cam ? `<button class="widebtn ghost" data-cam="${esc(cam.id)}"><svg class="i"><use href="#i-cam"></use></svg><span>Cámara</span></button>` : ''}
        </div>
      </div>
    </div>`;
}

function boardRows(list) {
  if (!list.length) return '<div class="board-empty">Sin tráfico ahora</div>';
  return list.slice(0, 8).map(({ p, dist }) => {
    const eta = p.gs > 80 ? Math.max(1, Math.round((dist / (p.gs * 1.852)) * 60)) : null;
    return `<button class="board-row" data-hex="${esc(p.hex)}" style="border:0;background:transparent;text-align:left;width:100%">
      <b>${esc(p.flight)}</b><span>${fmtInt(dist)} km${eta ? ` · ${eta} min` : ''}</span>
    </button>`;
  }).join('');
}

function localTime(ap) {
  try {
    return new Intl.DateTimeFormat('es-ES', { timeZone: ap.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()) + ' local';
  } catch {
    return '—';
  }
}

function weatherPanel() {
  const w = state.weather;
  if (!w) {
    return panelShell('METEOROLOGÍA', 'Cielo', 'Cargando observación…', '<div class="panel-body"><div class="skeleton" style="height:80px"></div></div>');
  }
  const cur = w.current || {};
  const place = w.location || `${w.lat?.toFixed(2)}, ${w.lon?.toFixed(2)}`;
  return panelShell('METEOROLOGÍA', 'Cielo', place, `
    <div class="weather-hero">
      <svg class="i"><use href="#${weatherIcon(cur.weather_code)}"></use></svg>
      <div><b>${fmtTemp(cur.temperature_2m)}</b><span>${esc(weatherLabel(cur.weather_code))} · sensación ${fmtTemp(cur.apparent_temperature)}</span></div>
    </div>
    <div class="weather-grid">
      <div class="metric"><span>VIENTO</span><b>${fmtWind(cur.wind_speed_10m)} <small>${windDir(cur.wind_direction_10m)}</small></b></div>
      <div class="metric"><span>HUMEDAD</span><b>${cur.relative_humidity_2m ?? '—'}<small>%</small></b></div>
      <div class="metric"><span>PRESIÓN</span><b>${cur.surface_pressure ?? '—'}<small>hPa</small></b></div>
      <div class="metric"><span>PRECIPITACIÓN</span><b>${cur.precipitation ?? 0}<small>mm</small></b></div>
    </div>
    <div class="panel-section" style="padding:12px 15px">
      <div class="panel-section-title"><span>ESTACIÓN ESPACIAL</span><b>${state.iss ? 'EN ÓRBITA' : 'SIN SEÑAL'}</b></div>
      <p class="tiny">${state.iss ? `La ISS está sobre ${state.iss.latitude.toFixed(2)}°, ${state.iss.longitude.toFixed(2)}° a ${fmtInt(state.iss.altitude)} km de altura, viajando a ${fmtInt(state.iss.velocity)} km/h.` : 'No se pudo obtener la posición de la ISS. Revisa la conexión.'}</p>
    </div>
    <div class="panel-section" style="padding:0 15px 14px">
      <p class="tiny">Datos de <b>Open-Meteo</b> y <b>Where the ISS at</b>. Consulta no oficial, solo demostración.</p>
    </div>`);
}

/* ============================================================
   CAMS
============================================================ */
function camThumb(cam) {
  return `https://i.ytimg.com/vi/${cam.videoId}/hqdefault.jpg`;
}
function camEmbed(cam) {
  return `https://www.youtube.com/embed/${cam.videoId}?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1`;
}
function camCard(cam) {
  return `<button class="cam-card ${state.selectedCam && state.selectedCam.id === cam.id ? 'is-active' : ''}" data-cam="${esc(cam.id)}">
    <span class="cc-thumb"><img src="${camThumb(cam)}" alt="" loading="lazy"><span class="cc-live">EN VIVO</span></span>
    <span class="cc-meta"><b>${esc(cam.title)}</b><span>${esc(cam.city)} · ${esc(cam.country)}</span><small>${esc(cam.channel)}</small></span>
  </button>`;
}
function renderCams() {
  const list = state.camFilter === 'all' ? state.cams : state.cams.filter((c) => c.kind === state.camFilter);
  $('#camCount').textContent = `${list.length} cámaras`;
  const listEl = $('#camList');
  listEl.innerHTML = list.length ? list.map(camCard).join('') : '<div class="cam-list-empty">No hay cámaras para ese filtro. Prueba otra búsqueda.</div>';
  if (!state.selectedCam || !list.find((c) => c.id === state.selectedCam.id)) {
    if (list.length) selectCam(list[0]);
  } else {
    selectCam(state.selectedCam);
  }
}
function selectCam(cam) {
  if (!cam) return;
  state.selectedCam = cam;
  const player = $('#camPlayer');
  player.innerHTML = `<iframe src="${camEmbed(cam)}" title="${esc(cam.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  $('#camTitle').textContent = cam.title;
  $('#camMetaKicker').textContent = cam.kind === 'airport' ? 'AEROPUERTO EN DIRECTO' : cam.kind === 'space' ? 'ÓRBITA EN DIRECTO' : 'CIUDAD EN DIRECTO';
  $('#camMeta').textContent = `${cam.city} · ${cam.country} · ${cam.channel} · ${cam.lat.toFixed(2)}, ${cam.lon.toFixed(2)}`;
  $$('#camList .cam-card').forEach((el) => el.classList.toggle('is-active', el.dataset.cam === cam.id));
  $$('#dockStrip .dock-card').forEach((el) => el.classList.toggle('is-active', el.dataset.cam === cam.id));
}
function camPrevNext(dir) {
  const list = state.camFilter === 'all' ? state.cams : state.cams.filter((c) => c.kind === state.camFilter);
  if (!list.length) return;
  const i = list.findIndex((c) => state.selectedCam && c.id === state.selectedCam.id);
  const next = list[i < 0 ? 0 : (i + dir + list.length) % list.length];
  selectCam(next);
}
function openCams(city = '') {
  if (!state.camsOpen) state.previousView = state.view;
  state.camsOpen = true;
  state.view = 'cams';
  setActiveNav('cams');
  $('#camsView').hidden = false;
  document.body.classList.add('cams-open');
  if (city) {
    searchCams(city);
  } else {
    state.cams = CAMERAS.slice();
    state.camFilter = 'all';
    $$('#camFilters .filterchip').forEach((b) => b.classList.toggle('is-active', b.dataset.camfilter === 'all'));
    renderCams();
  }
  setTimeout(() => state.map && state.map.invalidateSize(), 220);
}
function closeCams(restore = true) {
  if (!state.camsOpen) return;
  state.camsOpen = false;
  $('#camsView').hidden = true;
  document.body.classList.remove('cams-open');
  state.view = state.previousView || 'radar';
  setActiveNav(state.view);
  renderPanel(true);
  setTimeout(() => state.map && state.map.invalidateSize(), 220);
}
async function searchCams(q) {
  const query = String(q || '').trim();
  if (!query) return;
  state.camSearchBusy = true;
  $('#camCount').textContent = `buscando “${query}”…`;
  $('#camList').innerHTML = '<div class="cam-loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  try {
    const data = await api.yt(query);
    const results = (data.results || []).map((r) => ({
      id: `yt-${r.videoId}`,
      city: query,
      country: 'YouTube Live',
      title: r.title,
      videoId: r.videoId,
      channel: r.channel,
      channelId: r.channelId,
      lat: state.center.lat,
      lon: state.center.lon,
      kind: 'city',
      tags: ['busqueda']
    }));
    state.cams = results.length ? results : CAMERAS.slice();
    state.camFilter = 'all';
    state.selectedCam = null;
    $$('#camFilters .filterchip').forEach((b) => b.classList.toggle('is-active', b.dataset.camfilter === 'all'));
    renderCams();
    if (!results.length) toast('Sin resultados', `No se encontraron cámaras en directo para “${query}”.`, 'warn');
  } catch {
    state.cams = CAMERAS.slice();
    renderCams();
    toast('Búsqueda no disponible', 'El servicio de búsqueda de cámaras no respondió. Se muestran las cámaras destacadas.', 'error');
  } finally {
    state.camSearchBusy = false;
  }
}/* ============================================================
   SEARCH
============================================================ */
function findAirports(q) {
  const s = String(q || '').trim().toUpperCase();
  if (!s) return [];
  const list = AIRPORTS.map((a) => ({ iata: a[0], icao: a[1], name: a[2], city: a[3], country: a[4], lat: a[5], lon: a[6] }));
  const exact = [];
  const starts = [];
  const contains = [];
  for (const a of list) {
    if (a.iata === s || a.icao === s) exact.push(a);
    else if (a.iata.startsWith(s) || a.icao.startsWith(s)) starts.push(a);
    else if (a.name.toUpperCase().includes(s) || a.city.toUpperCase().includes(s) || a.country.toUpperCase().includes(s)) contains.push(a);
  }
  return [...exact, ...starts, ...contains].slice(0, 8);
}

async function runSearch(q) {
  const query = String(q || '').trim();
  const box = $('#searchResults');
  if (query.length < 2) {
    box.hidden = true;
    state.searchItems = [];
    return;
  }
  const airports = findAirports(query);
  const looksFlight = /^[A-Z0-9]{2,8}$/i.test(query) && /\d/.test(query);
  const items = [];
  airports.slice(0, 6).forEach((a) => items.push({ type: 'airport', ap: a }));
  if (looksFlight) {
    box.hidden = false;
    box.innerHTML = '<div class="search-group">Buscando vuelos…</div>';
    try {
    const [cs, reg, hex] = await Promise.allSettled([
      api.callsign(query.toUpperCase()),
      /\d/.test(query) ? api.registration(query.toUpperCase()) : Promise.reject(new Error('skip')),
      /^[0-9a-f]{2,8}$/i.test(query) ? api.hex(query) : Promise.reject(new Error('skip'))
    ]);
      const arrays = [];
      for (const r of [cs, reg, hex]) if (r.status === 'fulfilled' && Array.isArray(r.value.ac)) arrays.push(...r.value.ac);
      const seen = new Set();
      for (const raw of arrays) {
        const n = normalizeAircraft(raw);
        if (!n || seen.has(n.hex)) continue;
        seen.add(n.hex);
        items.unshift({ type: 'flight', p: n, raw });
        if (items.length > 12) break;
      }
    } catch {}
  }
  if (!airports.length && query.length >= 3) {
    items.push({ type: 'cam', q: query });
  }
  state.searchItems = items;
  state.searchIndex = -1;
  renderSearchResults();
}

function renderSearchResults() {
  const box = $('#searchResults');
  if (!state.searchItems.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const flights = state.searchItems.filter((i) => i.type === 'flight').slice(0, 6);
  const airports = state.searchItems.filter((i) => i.type === 'airport').slice(0, 6);
  const cams = state.searchItems.filter((i) => i.type === 'cam');
  let html = '';
  if (flights.length) {
    html += '<div class="search-group">Vuelos y aeronaves</div>';
    html += flights.map((i) => `<button class="search-item" data-search-index="${state.searchItems.indexOf(i)}">
      <svg class="i" style="color:var(--teal);width:15px;height:15px"><use href="#i-plane"></use></svg>
      <span class="si-main"><span class="si-title">${esc(i.p.flight)} · ${esc(i.p.reg)}</span><span class="si-sub">${esc(airlineFor(i.p.flight))} · ${esc(typeName(i.p.type))} · ${fmtInt(i.p.alt)} ft</span></span>
      <span class="si-badge">SEGUIR</span>
    </button>`).join('');
  }
  if (airports.length) {
    html += '<div class="search-group">Aeropuertos</div>';
    html += airports.map((i) => `<button class="search-item" data-search-index="${state.searchItems.indexOf(i)}">
      <svg class="i" style="color:var(--gold);width:15px;height:15px"><use href="#i-plane"></use></svg>
      <span class="si-main"><span class="si-title">${esc(i.ap.iata)} · ${esc(i.ap.city)}</span><span class="si-sub">${esc(i.ap.name)} · ${esc(i.ap.country)}</span></span>
      <span class="si-badge">AEROPUERTO</span>
    </button>`).join('');
  }
  if (cams.length) {
    html += '<div class="search-group">Cámaras</div>';
    html += cams.map((i) => `<button class="search-item" data-search-index="${state.searchItems.indexOf(i)}">
      <svg class="i" style="color:var(--violet);width:15px;height:15px"><use href="#i-cam"></use></svg>
      <span class="si-main"><span class="si-title">Buscar cámaras de ${esc(i.q)}</span><span class="si-sub">Emisiones en directo en YouTube</span></span>
      <span class="si-badge">CÁMARA</span>
    </button>`).join('');
  }
  box.innerHTML = html;
}

function closeSearch() {
  const box = $('#searchResults');
  if (box) box.hidden = true;
  const input = $('#globalSearch');
  if (input && document.activeElement === input) input.blur();
}

function activateSearchItem(index) {
  const item = state.searchItems[index];
  if (!item) return;
  if (item.type === 'flight') {
    closeSearch();
    selectAircraft(item.p.hex, item.raw, true);
    $('#globalSearch').value = '';
    $('#globalSearch').blur();
  } else if (item.type === 'airport') {
    closeSearch();
    selectAirport(item.ap.iata);
    $('#globalSearch').value = '';
    $('#globalSearch').blur();
  } else if (item.type === 'cam') {
    closeSearch();
    openCams(item.q);
  }
}

function updateSearchFocus(delta) {
  const items = $$('#searchResults .search-item');
  if (!items.length) return;
  state.searchIndex = (state.searchIndex + delta + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('is-focus', i === state.searchIndex));
  items[state.searchIndex].scrollIntoView({ block: 'nearest' });
}

/* ============================================================
   TOASTS / CLOCK / HASH
============================================================ */
function toast(title, body = '', kind = 'info') {
  const wrap = $('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'is-error' : kind === 'warn' ? 'is-warn' : ''}`;
  el.innerHTML = `<b>${esc(title)}</b>${body ? esc(body) : ''}`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'opacity .3s, transform .3s';
    setTimeout(() => el.remove(), 350);
  }, 5200);
}

function tickClock() {
  const d = new Date();
  const el = $('#utcClock');
  if (el) el.textContent = d.toISOString().slice(11, 19);
}

function updateHash() {
  if (!state.map) return;
  const c = state.map.getCenter();
  const z = state.map.getZoom();
  let hash = `#${c.lat.toFixed(3)},${c.lng.toFixed(3)},${z.toFixed(2)}`;
  if (state.selectedFlight) hash += `&flight=${state.selectedFlight}`;
  if (state.selectedAirport) hash += `&apt=${state.selectedAirport.iata}`;
  if (state.selectedRoute) hash += `&route=${state.selectedRoute.id}`;
  try { history.replaceState(null, '', hash); } catch {}
}

function restoreHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  const [coords, ...rest] = h.split('&');
  const parts = coords.split(',').map(Number);
  if (parts.length >= 2 && parts.every(Number.isFinite)) {
    state.center = { lat: parts[0], lon: parts[1] };
    state.zoom = parts[2] || 6.4;
    state.map.setView([state.center.lat, state.center.lon], state.zoom);
  }
  for (const r of rest) {
    const [k, v] = r.split('=');
    if (k === 'flight') state.pendingFlight = v;
    if (k === 'apt') state.pendingAirport = v;
    if (k === 'route') state.pendingRoute = v;
  }
}

/* ============================================================
   PREFS / UI BINDING
============================================================ */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('ojodedios:prefs') || '{}');
    if (p.refreshMs) state.refreshMs = p.refreshMs;
    if (p.radiusNm) state.radiusNm = p.radiusNm;
    if (p.units) state.units = p.units;
    if (typeof p.showLabels === 'boolean') state.showLabels = p.showLabels;
    if (typeof p.showGround === 'boolean') state.showGround = p.showGround;
    if (typeof p.showTrails === 'boolean') state.showTrails = p.showTrails;
  } catch {}
  syncControls();
}
function savePrefs() {
  try {
    localStorage.setItem('ojodedios:prefs', JSON.stringify({
      refreshMs: state.refreshMs,
      radiusNm: state.radiusNm,
      units: state.units,
      showLabels: state.showLabels,
      showGround: state.showGround,
      showTrails: state.showTrails
    }));
  } catch {}
}
function syncControls() {
  const range = $('#radiusRange');
  if (range) range.value = state.radiusNm;
  $$('#refreshSeg button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.refresh) === state.refreshMs));
  const tg = $('#toggleGround');
  if (tg) tg.checked = state.showGround;
  const tt = $('#toggleTrails');
  if (tt) tt.checked = state.showTrails;
  const tl = $('#toggleLabels');
  if (tl) tl.checked = state.showLabels;
  const ta = $('#toggleAirports');
  if (ta) ta.checked = state.showAirports;
  const amin = $('#altMin');
  const amax = $('#altMax');
  if (amin) amin.value = state.altMin;
  if (amax) amax.value = state.altMax;
  updateCenterLabel();
  updateAltLabel();
  const pause = $('#pauseBtn');
  if (pause) {
    pause.querySelector('span').textContent = state.paused ? 'Reanudar radar' : 'Pausar radar';
    pause.querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
  }
}

function updateAltLabel() {
  const el = $('#altOut');
  if (el) el.textContent = `${fmtInt(state.altMin / 1000)}k – ${fmtInt(state.altMax / 1000)}k ft`;
}

function renderDock() {
  const strip = $('#dockStrip');
  if (!strip) return;
  strip.innerHTML = CAMERAS.slice(0, 8).map((c) => `<button class="dock-card ${state.selectedCam && state.selectedCam.id === c.id ? 'is-active' : ''}" data-cam="${esc(c.id)}">
    <img src="${camThumb(c)}" alt="" loading="lazy">
    <span class="dc-live">EN VIVO</span>
    <span class="dc-meta"><b>${esc(c.title)}</b><small>${esc(c.city)} · ${esc(c.country)}</small></span>
  </button>`).join('');
}

function closePanelContext() {
  if (state.selectedFlight) { clearSelection(); return; }
  if (state.selectedAirport) {
    state.selectedAirport = null;
    state.selectionLayer && state.selectionLayer.clearLayers();
    renderPanel(true);
    return;
  }
  if (state.selectedRoute) { clearRoute(); return; }
  if (state.weather && state.weather.pinned) {
    state.weather.pinned = false;
    renderPanel(true);
    return;
  }
  $('#rightPanel').classList.toggle('is-hidden');
}

function bindPanelInputs() {
  /* delegated listeners are attached once in bindEvents */
}

function bindEvents() {
  $$('.navbtn, .mobilenav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  const search = $('#globalSearch');
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(search.value), 220);
  });
  search.addEventListener('focus', () => { if (search.value.trim()) runSearch(search.value); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); updateSearchFocus(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); updateSearchFocus(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.searchIndex >= 0) activateSearchItem(state.searchIndex);
      else if (state.searchItems.length) activateSearchItem(0);
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });
  $('#searchResults').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-search-index]');
    if (btn) activateSearchItem(Number(btn.dataset.searchIndex));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchWrap')) closeSearch();
  });

  $$('#layerGrid .layerchip').forEach((b) => b.addEventListener('click', () => setBasemap(b.dataset.basemap)));

  $('#radiusRange').addEventListener('input', (e) => {
    state.radiusNm = Number(e.target.value);
    updateCenterLabel();
    savePrefs();
    scheduleRefresh(500);
  });
  $('#altMin').addEventListener('input', (e) => {
    state.altMin = Math.min(Number(e.target.value), state.altMax - 1000);
    $('#altMin').value = state.altMin;
    updateAltLabel();
    renderPlanes();
  });
  $('#altMax').addEventListener('input', (e) => {
    state.altMax = Math.max(Number(e.target.value), state.altMin + 1000);
    $('#altMax').value = state.altMax;
    updateAltLabel();
    renderPlanes();
  });
  $('#toggleGround').addEventListener('change', (e) => { state.showGround = e.target.checked; renderPlanes(); savePrefs(); });
  $('#toggleTrails').addEventListener('change', (e) => { state.showTrails = e.target.checked; pruneTrails(new Set(visiblePlanes().map((p) => p.hex))); savePrefs(); });
  $('#toggleLabels').addEventListener('change', (e) => { state.showLabels = e.target.checked; document.body.classList.toggle('hide-labels', !state.showLabels); savePrefs(); });
  $('#toggleAirports').addEventListener('change', (e) => { state.showAirports = e.target.checked; renderAirportMarkers(); savePrefs(); });
  $$('#refreshSeg button').forEach((b) => b.addEventListener('click', () => {
    state.refreshMs = Number(b.dataset.refresh);
    $$('#refreshSeg button').forEach((x) => x.classList.toggle('is-active', x === b));
    savePrefs();
    scheduleRefresh(1000);
  }));
  $('#pauseBtn').addEventListener('click', () => {
    state.paused = !state.paused;
    syncControls();
    if (state.paused) {
      clearTimeout(state.refreshTimer);
      setStatus('EN PAUSA', 'warn');
    } else {
      setStatus(state.source === 'demo' ? 'DEMO' : 'EN VIVO', state.source === 'demo' ? 'warn' : 'live');
      scheduleRefresh(800);
    }
  });
  $('#locateBtn').addEventListener('click', locateMe);
  $('#railToggle').addEventListener('click', () => $('#rail').classList.add('is-open'));
  $('#railClose').addEventListener('click', () => $('#rail').classList.remove('is-open'));
  $('#hintClose').addEventListener('click', () => $('#mapHint').classList.add('is-hidden'));

  $('#zoomIn').addEventListener('click', () => state.map && state.map.zoomIn());
  $('#zoomOut').addEventListener('click', () => state.map && state.map.zoomOut());
  $('#resetView').addEventListener('click', () => {
    state.center = { lat: 40.4168, lon: -3.7038 };
    state.zoom = 6.4;
    clearSelection();
    if (state.map) state.map.flyTo([state.center.lat, state.center.lon], state.zoom, { duration: 1 });
  });
  $('#toggleCamsMini').addEventListener('click', () => openCams());
  $('#toggleSettings').addEventListener('click', openSettings);

  $('#weatherChip').addEventListener('click', () => {
    if (!state.weather) { fetchWeather(state.center.lat, state.center.lon); return; }
    state.weather.pinned = true;
    renderPanel(true);
  });
  $('#issChip').addEventListener('click', () => {
    if (state.iss && state.map) state.map.flyTo([state.iss.latitude, state.iss.longitude], Math.min(state.map.getZoom(), 4), { duration: 1.2 });
    else fetchISS();
  });

  $('#openCams').addEventListener('click', () => openCams());
  $('#closeCams').addEventListener('click', () => closeCams());
  $('#camPrev').addEventListener('click', () => camPrevNext(-1));
  $('#camNext').addEventListener('click', () => camPrevNext(1));
  $('#camSearchBtn').addEventListener('click', () => searchCams($('#camSearch').value));
  $('#camSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchCams($('#camSearch').value); });
  $('#camFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-camfilter]');
    if (!b) return;
    state.camFilter = b.dataset.camfilter;
    $$('#camFilters .filterchip').forEach((x) => x.classList.toggle('is-active', x === b));
    state.selectedCam = null;
    renderCams();
  });
  $('#camList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]');
    if (!b) return;
    const cam = state.cams.find((c) => c.id === b.dataset.cam);
    if (cam) selectCam(cam);
  });
  $('#dockStrip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]');
    if (!b) return;
    const cam = CAMERAS.find((c) => c.id === b.dataset.cam);
    openCams();
    if (cam) selectCam(cam);
  });
  $('#hubGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-iata]');
    if (b) selectAirport(b.dataset.iata);
  });

  $('#rightPanel').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    if (action) {
      const a = action.dataset.action;
      if (a === 'panel-close' || a === 'panel-back') closePanelContext();
      else if (a === 'follow') {
        state.follow = !state.follow;
        updateFollowUI();
        renderPanel(true);
      } else if (a === 'center-flight') {
        const p = state.planes.find((x) => x.hex === state.selectedFlight);
        if (p && state.map) state.map.flyTo([p.lat, p.lon], Math.max(state.map.getZoom(), 9), { duration: 1 });
      } else if (a === 'retry') {
        state.hasLoadedOnce = false;
        refreshTraffic();
      } else if (a === 'center-airport') {
        if (state.selectedAirport && state.map) state.map.flyTo([state.selectedAirport.lat, state.selectedAirport.lon], Math.max(state.map.getZoom(), 9), { duration: 1 });
      }
    }
    const hex = e.target.closest('[data-hex]');
    if (hex) { selectAircraft(hex.dataset.hex, null, false); return; }
    const iata = e.target.closest('[data-iata]');
    if (iata) { selectAirport(iata.dataset.iata); return; }
    const route = e.target.closest('[data-route]');
    if (route) { selectRoute(route.dataset.route); return; }
    const cam = e.target.closest('[data-cam]');
    if (cam) {
      const c = CAMERAS.find((x) => x.id === cam.dataset.cam);
      openCams();
      if (c) selectCam(c);
      return;
    }
    const region = e.target.closest('[data-region]');
    if (region) {
      state.routeRegion = region.dataset.region;
      renderPanel(true);
    }
  });

  let panelTimer = null;
  $('#rightPanel').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'feedFilter') {
      state.feedFilter = e.target.value;
      clearTimeout(panelTimer);
      panelTimer = setTimeout(() => renderPanel(), 160);
    } else if (id === 'routeFilter') {
      state.routeFilter = e.target.value;
      clearTimeout(panelTimer);
      panelTimer = setTimeout(() => renderPanel(), 160);
    } else if (id === 'airportFilter') {
      state.airportFilter = e.target.value;
      clearTimeout(panelTimer);
      panelTimer = setTimeout(() => renderPanel(), 160);
    }
  });
  $('#rightPanel').addEventListener('change', (e) => {
    if (e.target.id === 'feedSort') {
      state.feedSort = e.target.value;
      renderPanel(true);
    }
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#settingsDone').addEventListener('click', applySettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
    if (e.key === '/' && !typing) { e.preventDefault(); search.focus(); }
    else if (e.key === 'Escape') {
      if (!$('#settingsModal').hidden) closeSettings();
      else if (state.camsOpen) closeCams();
      else closeSearch();
    } else if (e.key === ' ' && !typing) {
      e.preventDefault();
      $('#pauseBtn').click();
    } else if (!typing && (e.key === 'f' || e.key === 'F')) {
      state.follow = !state.follow;
      updateFollowUI();
    } else if (!typing && (e.key === 'c' || e.key === 'C')) {
      openCams();
    } else if (!typing && (e.key === 'r' || e.key === 'R')) {
      setView('radar');
    } else if (!typing && (e.key === 'a' || e.key === 'A')) {
      setView('airports');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(state.refreshTimer);
    else scheduleRefresh(800);
  });
  window.addEventListener('resize', () => state.map && state.map.invalidateSize());
}

function locateMe() {
  if (!navigator.geolocation) {
    toast('Geolocalización no disponible', 'Este navegador no permite obtener tu ubicación.', 'warn');
    return;
  }
  toast('Ubicándote…', 'Pidiendo permiso de ubicación al navegador.', 'info');
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    state.center = { lat, lon };
    state.zoom = 8;
    if (state.map) state.map.flyTo([lat, lon], 8, { duration: 1.4 });
    refreshTraffic();
    toast('Ubicación fijada', `${lat.toFixed(3)}, ${lon.toFixed(3)}`, 'info');
  }, () => {
    toast('Sin ubicación', 'No se pudo obtener tu posición. Revisa los permisos del navegador.', 'error');
  }, { enableHighAccuracy: false, timeout: 8000 });
}

function openSettings() {
  $('#setRefresh').value = String(state.refreshMs);
  $('#setRadius').value = String(state.radiusNm);
  $('#setUnits').value = state.units;
  $('#setLabels').value = state.showLabels ? 'on' : 'off';
  $('#settingsModal').hidden = false;
}
function closeSettings() {
  $('#settingsModal').hidden = true;
}
function applySettings() {
  state.refreshMs = Number($('#setRefresh').value);
  state.radiusNm = Number($('#setRadius').value);
  state.units = $('#setUnits').value;
  state.showLabels = $('#setLabels').value === 'on';
  document.body.classList.toggle('hide-labels', !state.showLabels);
  syncControls();
  savePrefs();
  closeSettings();
  scheduleRefresh(700);
  renderPanel(true);
  renderPlanes();
}

/* ============================================================
   INIT
============================================================ */
function applyPendingHash() {
  if (state.pendingFlight) {
    const hex = state.pendingFlight;
    state.pendingFlight = null;
    if (state.planes.some((p) => p.hex === hex)) setTimeout(() => selectAircraft(hex, null, false), 120);
  }
  if (state.pendingAirport) {
    const iata = state.pendingAirport;
    state.pendingAirport = null;
    setTimeout(() => selectAirport(iata), 200);
  }
  if (state.pendingRoute) {
    const id = state.pendingRoute;
    state.pendingRoute = null;
    setTimeout(() => selectRoute(id), 200);
  }
}

function init() {
  if (!L) {
    toast('Mapa no disponible', 'No se encontró Leaflet. Ejecuta el servidor y recarga la página.', 'error');
    return;
  }
  loadPrefs();
  buildRouteCatalog();
  initMap();
  renderDock();
  bindEvents();
  setActiveNav('radar');
  document.body.classList.toggle('hide-labels', !state.showLabels);
  updateStats();
  renderPanel(true);
  setStatus('CONECTANDO');
  api.health().then((h) => {
    if (h && h.ok === false) toast('Servidor sin proveedor ADS-B', 'Revisa la configuración del proxy.', 'warn');
  }).catch(() => {});
  refreshTraffic();
  scheduleWeather();
  fetchISS();
  tickClock();
  state.clockTimer = setInterval(tickClock, 1000);
  state.issTimer = setInterval(fetchISS, 30000);
  setInterval(() => fetchWeather(state.center.lat, state.center.lon), 600000);
  setTimeout(() => $('#mapHint') && $('#mapHint').classList.add('is-hidden'), 11000);
}

/* Apply pending hash after first traffic snapshot */
const _refresh = refreshTraffic;
refreshTraffic = async function patchedRefresh() {
  await _refresh();
  applyPendingHash();
};

init();