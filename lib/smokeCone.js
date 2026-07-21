// Couples fire intensity/duration with real multi-altitude wind to produce a
// smoke-cone geometry per incident. Pure math, no DOM dependency, so both the
// server (for persistence + risk scoring) and any future client code can call
// the same model and get the same answer.

const STABILITY_MULT = [1.6, 1.3, 1.0, 0.7, 0.5]; // class 1 (very unstable) .. 5 (very stable)
const STABILITY_LABELS = ['Very Unstable', 'Unstable', 'Neutral', 'Stable', 'Very Stable'];

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

// Circular mean of two wind directions, weighted.
function blendDirections(dirA, dirB, weightB) {
  const wa = 1 - weightB, wb = weightB;
  const x = wa * Math.cos(toRad(dirA)) + wb * Math.cos(toRad(dirB));
  const y = wa * Math.sin(toRad(dirA)) + wb * Math.sin(toRad(dirB));
  let deg = toDeg(Math.atan2(y, x));
  if (deg < 0) deg += 360;
  return deg;
}

// Hotter/more intense fires loft smoke higher, where it's carried by
// upper-level (80m) transport wind rather than surface wind. This blends
// surface and 80m wind by fire intensity to get one effective transport wind
// — the "coupling" of fire behavior to the wind profile.
//
// wind_dir_deg (from Open-Meteo/NWS) is meteorological convention: the
// direction the wind is blowing FROM. Smoke travels the opposite way, so
// travel_bearing_deg (what the geometry/containment-check code actually
// uses) is that plus 180 — the compass bearing smoke moves TOWARD.
function effectiveTransportWind(weather, frpMw) {
  const surface = weather.surface || { wind_speed_ms: 5, wind_dir_deg: 220 };
  const lvl80 = (weather.levels || []).find(l => l.altitude_m === 80) || surface;

  const plumeWeight = Math.max(0.15, Math.min(0.75, (frpMw || 80) / 2000));
  const fromDir = blendDirections(surface.wind_dir_deg ?? 220, lvl80.wind_dir_deg ?? surface.wind_dir_deg ?? 220, plumeWeight);
  const speed = (1 - plumeWeight) * (surface.wind_speed_ms ?? 5) + plumeWeight * (lvl80.wind_speed_ms ?? surface.wind_speed_ms ?? 5);
  const travelBearing = (fromDir + 180) % 360;

  return { from_dir_deg: fromDir, travel_bearing_deg: travelBearing, speed_ms: speed, plume_weight: plumeWeight };
}

// Reach grows with fire intensity, saturates over the first ~8-12 hours of
// duration (a fire doesn't keep extending its smoke reach linearly forever —
// once it's burning steadily, reach is governed by current wind + intensity,
// not by how long ago it started), and is modulated by wind speed + stability.
function computeReach(frpMw, durationHours, windSpeedMs, stabilityClass) {
  const base = frpMw > 1500 ? 90000 : frpMw > 500 ? 55000 : frpMw > 100 ? 32000 : 16000;
  const stabMult = STABILITY_MULT[(stabilityClass || 3) - 1] || 1.0;
  const durationFactor = 0.4 + 0.6 * (1 - Math.exp(-(durationHours || 1) / 8));
  const windContribution = (windSpeedMs || 5) * 2000; // m/s -> extra meters of reach
  return (base * stabMult * durationFactor) + windContribution;
}

function halfWidthDegrees(frpMw) {
  if (frpMw > 1500) return 55;
  if (frpMw > 500) return 42;
  if (frpMw > 100) return 30;
  return 20;
}

// Returns a GeoJSON-style [lon,lat] ring for the smoke cone polygon.
// bearingDeg is a standard compass bearing (0=N, 90=E, 180=S, 270=W) for the
// direction the plume travels TOWARD — the same convention distanceBearing()
// below produces, so the drawn polygon and the containment check always agree.
function coneGeometry(lat, lon, bearingDeg, reachM, halfWidthDeg, steps = 28) {
  const latM = 1 / 111320;
  const lonM = 1 / (111320 * Math.cos(toRad(lat)));
  const centerRad = toRad(bearingDeg);
  const perpRad = toRad(bearingDeg + 90);
  const ring = [];

  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const along = reachM * frac;
    const spread = reachM * Math.sin(frac * Math.PI) * halfWidthDeg / 180 * 0.5;
    const dlat = along * latM * Math.cos(centerRad) + spread * latM * Math.cos(perpRad);
    const dlon = along * lonM * Math.sin(centerRad) + spread * lonM * Math.sin(perpRad);
    ring.push([lon + dlon, lat + dlat]);
  }
  for (let i = steps; i >= 0; i--) {
    const frac = i / steps;
    const along = reachM * frac;
    const spread = reachM * Math.sin(frac * Math.PI) * halfWidthDeg / 180 * 0.5;
    const dlat = along * latM * Math.cos(centerRad) - spread * latM * Math.cos(perpRad);
    const dlon = along * lonM * Math.sin(centerRad) - spread * lonM * Math.sin(perpRad);
    ring.push([lon + dlon, lat + dlat]);
  }
  ring.push(ring[0]);
  return ring;
}

// Main entry point: fire + weather in, full smoke-cone model out.
function computeSmokeCone({ lat, lon, frp, durationHours, weather, stabilityClass = 3 }) {
  const wind = effectiveTransportWind(weather, frp);
  const reachM = computeReach(frp, durationHours, wind.speed_ms, stabilityClass);
  const halfWidth = halfWidthDegrees(frp);
  const ring = coneGeometry(lat, lon, wind.travel_bearing_deg, reachM, halfWidth);

  return {
    dir_deg: wind.from_dir_deg,                    // wind FROM direction — for display ("12mph SW")
    travel_bearing_deg: wind.travel_bearing_deg,    // smoke travel bearing — used for geometry/containment
    speed_ms: wind.speed_ms,
    plume_weight: wind.plume_weight,
    reach_m: reachM,
    half_width_deg: halfWidth,
    stability_class: stabilityClass,
    stability_label: STABILITY_LABELS[stabilityClass - 1] || 'Neutral',
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

// Point-in-cone test + distance/bearing, used by the risk model to decide
// which structures actually fall inside the plume vs. just nearby.
function distanceBearing(lat, lon, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat), dLon = toRad(lon2 - lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  let bearing = toDeg(Math.atan2(y, x));
  if (bearing < 0) bearing += 360;
  return { distance_m: distance, bearing_deg: bearing };
}

// bearingDeg: compass bearing from the fire to the structure (from
// distanceBearing). coneTravelBearingDeg: cone.travel_bearing_deg — NOT
// cone.dir_deg (that's the wind FROM direction, 180° off from travel).
function isWithinCone(bearingDeg, coneTravelBearingDeg, halfWidthDeg, distanceM, reachM) {
  if (distanceM > reachM) return false;
  let diff = Math.abs(bearingDeg - coneTravelBearingDeg) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff <= halfWidthDeg;
}

module.exports = {
  computeSmokeCone, distanceBearing, isWithinCone,
  STABILITY_MULT, STABILITY_LABELS, effectiveTransportWind, computeReach,
};
