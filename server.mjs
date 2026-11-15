import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'OjoDeDios/1.0 (demo dashboard)';
const WINDY_KEY = process.env.WINDY_API_KEY || '';
const ADSB_DAILY_LIMIT = Number(process.env.ADSB_DAILY_LIMIT || 500);
let adsbDay = new Date().toISOString().slice(0, 10);
let adsbRequests = 0;
function adsbQuota() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== adsbDay) { adsbDay = today; adsbRequests = 0; }
  if (adsbRequests >= ADSB_DAILY_LIMIT) {
    const err = new Error('Cuota diaria de adsb.lol alcanzada');
    err.status = 429;
    throw err;
  }
  adsbRequests++;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
  if (cache.size > 400) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const data = await fn();
  cacheSet(key, data, ttlMs);
  return data;
}

function sendJson(res, data, status = 200, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  });
  res.end(body);
}

async function upstream(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      ...(opts.headers || {})
    },
    signal: AbortSignal.timeout(opts.timeout || 15000),
    redirect: 'follow'
  });
  return res;
}

function badRequest(res, message) {
  sendJson(res, { error: message }, 400);
}

/* ============================================================
   ADS-B
============================================================ */
async function adsbPoint(url, res) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radius = Number(url.searchParams.get('radius') || 250);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return badRequest(res, 'lat/lon inválidos');
  if (!Number.isFinite(radius) || radius <= 0 || radius > 250) return badRequest(res, 'radius debe estar entre 1 y 250 NM');
  const key = `adsb:point:${lat.toFixed(3)}:${lon.toFixed(3)}:${Math.round(radius)}`;
  try {
    const data = await cached(key, 8000, async () => {
      adsbQuota();
      const upstreamRes = await upstream(`https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.round(radius)}`);
      if (!upstreamRes.ok) throw new Error(`ADS-B HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'ADS-B no disponible', detail: String(err.message || err) }, err.status || 502);
  }
}

async function adsbFilter(kind, value, res) {
  if (!value || !/^[A-Za-z0-9-]{1,16}$/.test(value)) return badRequest(res, 'filtro inválido');
  const pathMap = { callsign: 'callsign', reg: 'reg', hex: 'hex' };
  const key = `adsb:${kind}:${value.toLowerCase()}`;
  try {
    const data = await cached(key, 10000, async () => {
      adsbQuota();
      const upstreamRes = await upstream(`https://api.adsb.lol/v2/${pathMap[kind]}/${encodeURIComponent(value)}`);
      if (!upstreamRes.ok) throw new Error(`ADS-B HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'ADS-B no disponible', detail: String(err.message || err) }, err.status || 502);
  }
}

async function adsbTrace(hex, res) {
  if (!hex || !/^[0-9a-fA-F]{2,8}$/.test(hex)) return badRequest(res, 'hex inválido');
  try {
    const data = await cached(`adsb:trace:${hex.toLowerCase()}`, 30000, async () => {
      adsbQuota();
      const upstreamRes = await upstream(`https://api.adsb.lol/1/trace/recent/${encodeURIComponent(hex)}`);
      if (!upstreamRes.ok) throw new Error(`ADS-B HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'Traza no disponible', detail: String(err.message || err) }, err.status || 502);
  }
}

async function airport(icao, res) {
  if (!icao || !/^[A-Za-z]{4}$/.test(icao)) return badRequest(res, 'ICAO inválido');
  try {
    const data = await cached(`airport:${icao.toUpperCase()}`, 3600000, async () => {
      adsbQuota();
      const upstreamRes = await upstream(`https://api.adsb.lol/api/0/airport/${encodeURIComponent(icao)}`);
      if (!upstreamRes.ok) throw new Error(`Airport HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'Aeropuerto no disponible', detail: String(err.message || err) }, err.status || 502);
  }
}

/* ============================================================
   WEATHER / ISS
============================================================ */
async function weather(url, res) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return badRequest(res, 'lat/lon inválidos');
  const key = `weather:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  try {
    const data = await cached(key, 600000, async () => {
      const q = new URLSearchParams({
        latitude: lat.toFixed(3),
        longitude: lon.toFixed(3),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
        timezone: 'auto',
        forecast_days: '1'
      });
      const upstreamRes = await upstream(`https://api.open-meteo.com/v1/forecast?${q.toString()}`);
      if (!upstreamRes.ok) throw new Error(`Open-Meteo HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'Meteorología no disponible', detail: String(err.message || err) }, 502);
  }
}

async function iss(res) {
  try {
    const data = await cached('iss', 10000, async () => {
      const upstreamRes = await upstream('https://api.wheretheiss.at/v1/satellites/25544');
      if (!upstreamRes.ok) throw new Error(`ISS HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'ISS no disponible', detail: String(err.message || err) }, 502);
  }
}

async function opensky(url, res) {
  const bbox = url.searchParams.get('bbox');
  let q = '';
  if (bbox) {
    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return badRequest(res, 'bbox inválido');
    q = `?lamin=${parts[0]}&lomin=${parts[1]}&lamax=${parts[2]}&lomax=${parts[3]}`;
  }
  try {
    const data = await cached(`opensky:${q}`, 12000, async () => {
      const upstreamRes = await upstream(`https://opensky-network.org/api/states/all${q}`);
      if (!upstreamRes.ok) throw new Error(`OpenSky HTTP ${upstreamRes.status}`);
      return await upstreamRes.json();
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'OpenSky no disponible', detail: String(err.message || err) }, 502);
  }
}

/* ============================================================
   WINDY (opcional, requiere clave del servidor)
============================================================ */
async function windy(url, res) {
  if (!WINDY_KEY) return sendJson(res, { error: 'WINDY_API_KEY no configurada en el servidor' }, 503);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return badRequest(res, 'lat/lon inválidos');
  try {
    const q = new URLSearchParams({ nearby: `${lat.toFixed(2)},${lon.toFixed(2)},100`, limit: '20', include: 'categories,images,location,player,urls' });
    const upstreamRes = await upstream(`https://api.windy.com/webcams/api/v3/webcams?${q.toString()}`, {
      headers: { 'x-windy-api-key': WINDY_KEY }
    });
    if (!upstreamRes.ok) throw new Error(`Windy HTTP ${upstreamRes.status}`);
    const data = await upstreamRes.json();
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'Windy no disponible', detail: String(err.message || err) }, 502);
  }
}

/* ============================================================
   YOUTUBE LIVE SEARCH
============================================================ */
function extractJsonAfter(html, marker) {
  let i = html.indexOf(marker);
  if (i < 0) return null;
  i += marker.length;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.simpleText) return node.simpleText;
  if (node.runs) return node.runs.map((r) => r.text || '').join('');
  return '';
}

function isLiveRenderer(r) {
  const badges = (r.badges || []).map((b) => b?.metadataBadgeRenderer?.label || '').join(' ');
  const overlay = (r.thumbnailOverlays || []).map((o) => o?.thumbnailOverlayTimeStatusRenderer?.style || '').join(' ');
  return /LIVE|EN VIVO|EN DIRECTO|\bDIRECTO\b/i.test(badges) || /LIVE|DIRECTO/i.test(overlay);
}

function collectLiveVideos(data, out) {
  if (!data || typeof data !== 'object') return;
  for (const key of ['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer']) {
    const r = data[key];
    if (!r || !r.videoId) continue;
    if (!isLiveRenderer(r)) continue;
    const title = textOf(r.title) || textOf(r.headline);
    const channel = textOf(r.ownerText) || textOf(r.longBylineText) || textOf(r.shortBylineText);
    const channelId = r.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      || r.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      || '';
    if (title) out.push({ title, channel, channelId, videoId: r.videoId });
  }
  for (const k of Object.keys(data)) {
    if (k === 'trackingParams' || k === 'responseContext') continue;
    collectLiveVideos(data[k], out);
  }
}

async function youtubeSearch(url, res) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (q.length < 2) return badRequest(res, 'consulta demasiado corta');
  try {
    const data = await cached(`yt:${q.toLowerCase()}`, 600000, async () => {
      const upstreamRes = await upstream(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgJAAQ%3D%3D`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'Cookie': 'CONSENT=YES+1'
        },
        timeout: 22000
      });
      if (!upstreamRes.ok) throw new Error(`YouTube HTTP ${upstreamRes.status}`);
      const html = await upstreamRes.text();
      const initial = extractJsonAfter(html, 'var ytInitialData = ');
      const found = [];
      collectLiveVideos(initial, found);
      const seen = new Set();
      const results = [];
      for (const v of found) {
        if (seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        results.push(v);
        if (results.length >= 14) break;
      }
      return { results, query: q };
    });
    sendJson(res, data);
  } catch (err) {
    sendJson(res, { error: 'Búsqueda de cámaras no disponible', detail: String(err.message || err) }, 502);
  }
}

/* ============================================================
   STATIC
============================================================ */
async function serveStatic(pathname, res, method = 'GET') {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    const body = await readFile(filePath);
    const cacheControl = ext === '.html' ? 'no-cache' : ext === '.js' || ext === '.css' ? 'public, max-age=300' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    if (method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ============================================================
   ROUTER
============================================================ */
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, { error: 'Method not allowed' }, 405, { Allow: 'GET,OPTIONS' });
      return;
    }
    try {
      if (pathname === '/api/health') {
        sendJson(res, { ok: true, upstream: 'adsb.lol', windy: !!WINDY_KEY, adsbRequests, adsbLimit: ADSB_DAILY_LIMIT, time: new Date().toISOString() });
      } else if (pathname === '/api/adsb/point') {
        await adsbPoint(url, res);
      } else if (pathname.startsWith('/api/adsb/callsign/')) {
        await adsbFilter('callsign', decodeURIComponent(pathname.split('/')[4] || ''), res);
      } else if (pathname.startsWith('/api/adsb/reg/')) {
        await adsbFilter('reg', decodeURIComponent(pathname.split('/')[4] || ''), res);
      } else if (pathname.startsWith('/api/adsb/hex/')) {
        await adsbFilter('hex', decodeURIComponent(pathname.split('/')[4] || ''), res);
      } else if (pathname.startsWith('/api/adsb/trace/')) {
        await adsbTrace(decodeURIComponent(pathname.split('/')[4] || ''), res);
      } else if (pathname.startsWith('/api/airport/')) {
        await airport(decodeURIComponent(pathname.split('/')[3] || ''), res);
      } else if (pathname === '/api/weather') {
        await weather(url, res);
      } else if (pathname === '/api/iss') {
        await iss(res);
      } else if (pathname === '/api/opensky') {
        await opensky(url, res);
      } else if (pathname === '/api/windy') {
        await windy(url, res);
      } else if (pathname === '/api/yt/search') {
        await youtubeSearch(url, res);
      } else {
        sendJson(res, { error: 'Not found' }, 404);
      }
    } catch (err) {
      sendJson(res, { error: 'Error interno', detail: String(err.message || err) }, 500);
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET,HEAD' });
    res.end('Method not allowed');
    return;
  }
  await serveStatic(pathname, res, req.method);
});

server.listen(PORT, HOST, () => {
  console.log(`Ojo de Dios · http://localhost:${PORT}`);
  console.log(`ADS-B proxy: api.adsb.lol${WINDY_KEY ? ' · Windy webcams enabled' : ''}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);