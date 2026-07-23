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

function hourlyVarString() {
  return LEVELS.flatMap(m => [`wind_speed_${m}m`, `wind_direction_${m}m`]).concat(['temperature_2m']).join(',');
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

  return {
    observed_at: times[idx] ? times[idx] + ':00Z' : target.toISOString(),
    target_time: target.toISOString(),
    surface: {
      altitude_m: 0,
      wind_speed_ms: levels[0]?.wind_speed_ms ?? null,
      wind_dir_deg: levels[0]?.wind_dir_deg ?? null,
      gust_ms: null,
      temperature_c: data.hourly.temperature_2m?.[idx] ?? null,
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
  return {
    observed_at: new Date().toISOString(),
    surface: { altitude_m: 0, wind_speed_ms: spd, wind_dir_deg: dir, gust_ms: null, temperature_c: null },
    levels: [10, 80, 120, 180].map(m => ({ altitude_m: m, wind_speed_ms: spd * (1 + m / 400), wind_dir_deg: dir })),
    source: 'estimate',
    raw: null,
  };
}

module.exports = { fetchIncidentWeather, estimateWeather, LEVELS };
