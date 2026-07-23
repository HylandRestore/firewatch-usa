// Real building-footprint lookup via OSM Overpass — replaces the old
// randomized structuresAtRisk() simulation with actual structures that exist
// at real coordinates near an incident.

// Multiple public mirrors — if Render's shared outbound IP has been flagged
// by one instance (which can happen on shared PaaS infrastructure, from
// traffic that isn't even ours), the others are independently operated and
// usually unaffected.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Cap radius so Overpass doesn't time out / rate-limit us on huge smoke cones.
// Smoke cones larger than this still get the full geometry client-side; we
// just don't fetch every building across a 60km cone in one call.
const MAX_RADIUS_M = 9000;
const MAX_RESULTS = 400;

// ── Cache ──────────────────────────────────────────────────────────────
// Buildings don't move. With real incident volume hitting this endpoint
// every time someone clicks into an incident (and the risk model recomputing
// on each call), we were tripping Overpass's rate limit (429) fast. Cache
// results by a rounded location+radius bucket for an hour — repeated looks
// at the same incident, or nearby incidents, reuse the same building data
// instead of re-querying.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();

function cacheKey(lat, lon, radius) {
  const rlat = lat.toFixed(3);   // ~111m precision
  const rlon = lon.toFixed(3);
  const rrad = Math.round(radius / 500) * 500; // nearest 500m bucket
  return `${rlat},${rlon},${rrad}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { at: Date.now(), data });
}

// ── Throttle ───────────────────────────────────────────────────────────
// Overpass's fair-use policy is roughly 1 request/sec per IP. Multiple
// incidents being inspected concurrently would otherwise all fire at once
// and immediately get rate-limited. Serialize actual outbound calls with a
// minimum spacing instead of hammering the API in parallel.
const MIN_SPACING_MS = 1100;
let queue = Promise.resolve();
let lastCallAt = 0;

function throttled(fn) {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.catch(() => {}); // don't let one failure break the chain for later calls
  return run;
}

async function fetchStructuresNear(lat, lon, radiusMeters) {
  const radius = Math.min(radiusMeters || 5000, MAX_RADIUS_M);
  const key = cacheKey(lat, lon, radius);
  const cached = cacheGet(key);
  if (cached) return cached;

  const result = await throttled(() => fetchFromOverpass(lat, lon, radius));
  cacheSet(key, result);
  return result;
}

async function tryAllEndpoints(query) {
  let lastErr, sawRateLimit = false;
  for (const endpoint of ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 429) { sawRateLimit = true; throw new Error('overpass 429'); }
      if (!r.ok) throw new Error('overpass ' + r.status);
      const data = await r.json();
      return { ok: true, result: parseOverpass(data) };
    } catch (e) {
      lastErr = e;
      continue; // try next mirror
    }
  }
  return { ok: false, sawRateLimit, lastErr };
}

async function fetchFromOverpass(lat, lon, radius) {
  const query = `
    [out:json][timeout:25];
    (
      way["building"](around:${radius},${lat},${lon});
      relation["building"](around:${radius},${lat},${lon});
    );
    out center tags ${MAX_RESULTS};
  `.trim();

  // First pass across all mirrors.
  let attempt = await tryAllEndpoints(query);
  if (attempt.ok) return attempt.result;

  // If every mirror was rate-limited (not just down), a short burst-cooldown
  // often clears within a few seconds — worth one retry pass before making
  // the caller wait a full minute and click again manually.
  if (attempt.sawRateLimit) {
    await new Promise(r => setTimeout(r, 4000));
    attempt = await tryAllEndpoints(query);
    if (attempt.ok) return attempt.result;
  }

  if (attempt.sawRateLimit) throw new Error('Overpass is rate-limiting us right now — try again in a minute.');
  throw attempt.lastErr || new Error('overpass failed');
}

function parseOverpass(data) {
  const els = data.elements || [];
  return els.map(el => {
    const center = el.center || { lat: el.lat, lon: el.lon };
    const tags = el.tags || {};
    const addrParts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    return {
      id: `osm:${el.type}:${el.id}`,
      osm_id: String(el.id),
      osm_type: el.type,
      lat: center.lat,
      lon: center.lon,
      building_type: tags.building && tags.building !== 'yes' ? tags.building : (tags.amenity || 'residential'),
      name: tags.name || null,
      address: addrParts || null,
    };
  }).filter(s => typeof s.lat === 'number' && typeof s.lon === 'number');
}

module.exports = { fetchStructuresNear, MAX_RADIUS_M };
