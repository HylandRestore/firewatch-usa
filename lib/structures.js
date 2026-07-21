// Real building-footprint lookup via OSM Overpass — replaces the old
// randomized structuresAtRisk() simulation with actual structures that exist
// at real coordinates near an incident.

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Cap radius so Overpass doesn't time out / rate-limit us on huge smoke cones.
// Smoke cones larger than this still get the full geometry client-side; we
// just don't fetch every building across a 60km cone in one call.
const MAX_RADIUS_M = 9000;
const MAX_RESULTS = 400;

async function fetchStructuresNear(lat, lon, radiusMeters) {
  const radius = Math.min(radiusMeters || 5000, MAX_RADIUS_M);
  const query = `
    [out:json][timeout:25];
    (
      way["building"](around:${radius},${lat},${lon});
      relation["building"](around:${radius},${lat},${lon});
    );
    out center tags ${MAX_RESULTS};
  `.trim();

  let lastErr;
  for (const endpoint of ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('overpass ' + r.status);
      const data = await r.json();
      return parseOverpass(data);
    } catch (e) {
      lastErr = e;
      continue; // try next mirror
    }
  }
  throw lastErr || new Error('overpass failed');
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
