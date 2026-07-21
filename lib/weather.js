// Real per-incident, multi-altitude wind data via Open-Meteo (free, no API
// key required). Returns surface + elevated wind so the smoke-cone model can
// account for how wind shifts with height rather than using one flat number.
//
// Altitudes reported: 10m (~33ft, near-surface), 80m (~262ft), 120m (~394ft),
// 180m (~590ft). Open-Meteo doesn't have a "50ft" level specifically — 10m is
// the closest standard level to that and is what most surface-wind products
// (including NWS) report at anyway.

const LEVELS = [10, 80, 120, 180];

async function fetchIncidentWeather(lat, lon) {
  const hourlyVars = LEVELS
    .flatMap(m => [`wind_speed_${m}m`, `wind_direction_${m}m`])
    .concat(['temperature_2m'])
    .join(',');

  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&hourly=${hourlyVars}` +
    `&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&wind_speed_unit=ms&timezone=UTC`;

  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('open-meteo ' + r.status);
  const data = await r.json();

  const now = data.current || {};
  const times = (data.hourly && data.hourly.time) || [];
  // nearest hourly index to "now" — current hour, floor to the hour
  const nowIso = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  let idx = times.findIndex(t => t.startsWith(nowIso));
  if (idx < 0) idx = 0;

  const levels = LEVELS.map(m => {
    const spd = data.hourly ? data.hourly[`wind_speed_${m}m`]?.[idx] : null;
    const dir = data.hourly ? data.hourly[`wind_direction_${m}m`]?.[idx] : null;
    return { altitude_m: m, wind_speed_ms: spd ?? null, wind_dir_deg: dir ?? null };
  });

  return {
    observed_at: new Date().toISOString(),
    surface: {
      altitude_m: 0,
      wind_speed_ms: now.wind_speed_10m ?? levels[0]?.wind_speed_ms ?? null,
      wind_dir_deg: now.wind_direction_10m ?? levels[0]?.wind_dir_deg ?? null,
      gust_ms: now.wind_gusts_10m ?? null,
      temperature_c: now.temperature_2m ?? null,
    },
    levels,
    source: 'open-meteo',
    raw: { current: now },
  };
}

// Fallback if Open-Meteo is unreachable — used so the app degrades instead of
// breaking. Marked clearly as an estimate, never silently passed off as live.
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
