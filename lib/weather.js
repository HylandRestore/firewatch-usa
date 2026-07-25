// Real per-incident, multi-altitude wind data via Open-Meteo (free, no API
// key required). Returns surface + elevated wind so the smoke-cone model can
// account for how wind shifts with height rather than using one flat number.
//
// Altitudes reported: 10m (~33ft, near-surface), 80m (~262ft), 120m (~394ft),
// 180m (~590ft). Open-Meteo doesn't have a "50ft" level specifically — 10m is
// the closest standard level to that and is what most surface-wind products
// (including NWS) report at anyway.
//
// IMPORTANT: this always fetches wind for a specific TARGET TIME — the
// incident's actual creation time, not "right now." A smoke cone has to
// reflect what the wind was actually doing when the fire happened, not
// whatever the wind happens to be when someone later clicks on it in the
// app. Two Open-Meteo endpoints are used depending on how far back that is:
//   - forecast API w/ past_days: near-real-time blend, good for anything in
//     roughly the last week (covers active/recent incidents accurately).
//   - archive API (ERA5 reanalysis): true historical record, used for
//     anything older — this is what makes a year of incident history
//     meaningful instead of every old record showing today's random wind.

const LEVELS = [10, 80, 120, 180];
const RECENT_THRESHOLD_DAYS = 6; // forecast API vs archive API cutover

// Extra surface variables needed for the v1 risk model (see lib/risk.js):
//   - relative_humidity_2m, precipitation: wet-deposition / washout of smoke
//     particulates (rain and, to a lesser extent, high humidity scrub PM2.5
//     out of the plume — standard input to EPA/NOAA air-quality dispersion
//     models).
//   - cloud_cover, is_day, shortwave_radiation: inputs to the Pasquill-Gifford
//     atmospheric-stability classification (Turner 1970 "Workbook of
//     Atmospheric Dispersion Estimates") — see computeStabilityClass() below.
//   - boundary_layer_height: the mixing-layer depth. A shallow boundary layer
//     traps smoke near the surface instead of letting it mix upward — this is
//     literally the key input NOAA's HRRR-Smoke / BlueSky Framework use to
//     forecast ground-level smoke concentration, so it's included here too.
//     NOTE: boundary_layer_height is served by Open-Meteo's forecast API but
//     may not be available on the archive (ERA5 reanalysis) endpoint for
//     older dates — extraction below null-checks it and falls back to a
//     simple day/night estimate rather than failing.
const EXTRA_SURFACE_VARS = [
  'relative_humidity_2m', 'precipitation', 'cloud_cover', 'is_day',
  'shortwave_radiation', 'boundary_layer_height',
];

function hourlyVarString() {
  return LEVELS.flatMap(m => [`wind_speed_${m}m`, `wind_direction_${m}m`])
    .concat(['temperature_2m'], EXTRA_SURFACE_VARS)
    .join(',');
}

// ── Atmospheric stability classification ─────────────────────────────────
// Simplified Pasquill-Gifford / Turner insolation-based method, collapsed
// from the textbook A-F(-G) letter classes onto the 1-5 numeric scale this
// app already uses in lib/smokeCone.js's STABILITY_MULT (1 = very unstable /
// strong daytime mixing, 5 = very stable / calm clear night, smoke hugs the
// ground). Reference: Turner, D.B. (1970), "Workbook of Atmospheric
// Dispersion Estimates," EPA — the standard, widely-taught method for
// estimating stability class from routine surface observations (wind speed +
// insolation/cloudiness) when direct turbulence measurements aren't
// available, which is exactly our situation (we only have Open-Meteo's
// modeled surface fields, not a met tower).
function computeStabilityClass({ windSpeedMs, cloudCoverPct, isDay, shortwaveRadiation }) {
  const wind = windSpeedMs ?? 5;
  const cloud = cloudCoverPct ?? 50;
  const day = isDay == null ? true : !!isDay;

  if (!day) {
    // Night: thin/broken cloud (or overcast) prevents radiative cooling, so
    // the surface layer stays closer to neutral. Clear, calm nights are the
    // classic setup for a strong radiation inversion (class 5).
    if (cloud >= 50) return 3;
    if (wind < 3) return 5;
    if (wind < 5) return 4;
    return 3;
  }

  // Day: use incoming shortwave radiation as the insolation proxy (Turner's
  // method uses solar altitude + cloud cover; shortwave_radiation folds both
  // together in W/m^2). Strong sun + light wind = most unstable (class 1);
  // any meaningful wind mechanically mixes the boundary layer toward neutral
  // regardless of how strong the sun is.
  const insolation = shortwaveRadiation == null
    ? (cloud < 30 ? 'strong' : cloud < 70 ? 'moderate' : 'slight')
    : (shortwaveRadiation > 600 ? 'strong' : shortwaveRadiation > 300 ? 'moderate' : 'slight');

  if (wind < 2) return insolation === 'strong' ? 1 : insolation === 'moderate' ? 2 : 3;
  if (wind < 3) return insolation === 'strong' ? 2 : insolation === 'moderate' ? 2 : 3;
  if (wind < 5) return insolation === 'strong' ? 2 : insolation === 'moderate' ? 3 : 3;
  if (wind < 6) return 3;
  return 3; // strong mechanical mixing dominates at high wind regardless of sun
}

function extractHourForTarget(data, target, source) {
  const times = (data.hourly && data.hourly.time) || [];
  if (times.length === 0) throw new Error(source + ': no hourly data returned');
  const targetIso = target.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  let idx = times.findIndex(t => t.startsWith(targetIso));
  if (idx < 0) {
    // Target hour not in range (e.g. incident just created, this hour's
    // data not published yet) — fall back to the closest available hour.
    idx = times.length - 1;
  }

  const levels = LEVELS.map(m => ({
    altitude_m: m,
    wind_speed_ms: data.hourly[`wind_speed_${m}m`]?.[idx] ?? null,
    wind_dir_deg: data.hourly[`wind_direction_${m}m`]?.[idx] ?? null,
  }));

  // boundary_layer_height is sometimes absent (notably on the archive/ERA5
  // endpoint for older dates). Rather than let the risk model silently treat
  // "missing" as "shallow" (which would inflate risk), fall back to a coarse
  // day/night estimate: boundary layers are typically much deeper by day
  // (daytime heating drives vertical mixing) than the shallow nocturnal
  // layer that forms after sunset.
  const rawPbl = data.hourly.boundary_layer_height?.[idx];
  const isDayVal = data.hourly.is_day?.[idx];
  const pblEstimateFallback = (isDayVal == null || isDayVal === 1) ? 900 : 250;

  return {
    observed_at: times[idx] ? times[idx] + ':00Z' : target.toISOString(),
    target_time: target.toISOString(),
    surface: {
      altitude_m: 0,
      wind_speed_ms: levels[0]?.wind_speed_ms ?? null,
      wind_dir_deg: levels[0]?.wind_dir_deg ?? null,
      gust_ms: null,
      temperature_c: data.hourly.temperature_2m?.[idx] ?? null,
      humidity_pct: data.hourly.relative_humidity_2m?.[idx] ?? null,
      precip_mm: data.hourly.precipitation?.[idx] ?? null,
      cloud_cover_pct: data.hourly.cloud_cover?.[idx] ?? null,
      is_day: isDayVal == null ? null : !!isDayVal,
      shortwave_radiation: data.hourly.shortwave_radiation?.[idx] ?? null,
      boundary_layer_height_m: rawPbl != null ? rawPbl : pblEstimateFallback,
      boundary_layer_height_estimated: rawPbl == null,
    },
    levels,
    source,
    raw: null,
  };
}

async function fetchFromForecastApi(lat, lon, target) {
  const daysAgo = Math.max(0, Math.ceil((Date.now() - target.getTime()) / 86400000));
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&hourly=${hourlyVarString()}` +
    `&past_days=${Math.min(daysAgo, 92)}&forecast_days=1` +
    `&wind_speed_unit=ms&timezone=UTC`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('open-meteo forecast ' + r.status);
  const data = await r.json();
  return extractHourForTarget(data, target, 'open-meteo-forecast');
}

async function fetchFromArchiveApi(lat, lon, target) {
  const dateStr = target.toISOString().slice(0, 10); // YYYY-MM-DD
  const url = `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=${dateStr}&end_date=${dateStr}` +
    `&hourly=${hourlyVarString()}` +
    `&wind_speed_unit=ms&timezone=UTC`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('open-meteo archive ' + r.status);
  const data = await r.json();
  return extractHourForTarget(data, target, 'open-meteo-archive');
}

// targetTime: the moment we want wind for — pass the incident's created_at.
// Defaults to now only if no target is given (e.g. ad-hoc calls).
async function fetchIncidentWeather(lat, lon, targetTime) {
  const target = targetTime ? new Date(targetTime) : new Date();
  if (isNaN(target.getTime())) throw new Error('fetchIncidentWeather: invalid targetTime');
  const ageDays = (Date.now() - target.getTime()) / 86400000;

  if (ageDays <= RECENT_THRESHOLD_DAYS) {
    try {
      return await fetchFromForecastApi(lat, lon, target);
    } catch (e) {
      // Forecast API can occasionally lack data for edge-of-window hours —
      // archive API is the fallback of last resort even for "recent" dates.
      return await fetchFromArchiveApi(lat, lon, target);
    }
  }
  return await fetchFromArchiveApi(lat, lon, target);
}

// Fallback if Open-Meteo is unreachable entirely — used so the app degrades
// instead of breaking. Marked clearly as an estimate, never silently passed
// off as live or historical data.
function estimateWeather() {
  const dir = 200 + Math.random() * 60;
  const spd = 4 + Math.random() * 6; // m/s
  const isDayNow = (() => { const h = new Date().getUTCHours(); return h > 12 && h < 24; })(); // rough, UTC-only guess
  return {
    observed_at: new Date().toISOString(),
    surface: {
      altitude_m: 0, wind_speed_ms: spd, wind_dir_deg: dir, gust_ms: null, temperature_c: null,
      humidity_pct: 50, precip_mm: 0, cloud_cover_pct: 50, is_day: isDayNow,
      shortwave_radiation: null, boundary_layer_height_m: isDayNow ? 900 : 250,
      boundary_layer_height_estimated: true,
    },
    levels: [10, 80, 120, 180].map(m => ({ altitude_m: m, wind_speed_ms: spd * (1 + m / 400), wind_dir_deg: dir })),
    source: 'estimate',
    raw: null,
  };
}

module.exports = { fetchIncidentWeather, estimateWeather, computeStabilityClass, LEVELS };
