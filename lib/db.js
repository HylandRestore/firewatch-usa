// Persistence via Supabase's REST API (PostgREST), not a raw Postgres
// connection. This avoids needing the DB password at all — just the project
// URL and a secret API key from Supabase (Project Settings -> API).
//
// Whole module degrades gracefully to "no persistence" if SUPABASE_URL /
// SUPABASE_KEY aren't set, so the rest of the app works standalone before
// those exist.
//
// IMPORTANT: the secret key bypasses row-level security. It must only ever
// live server-side (Render env var / local .env, both gitignored) — never in
// the HTML file that ships to browsers.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
let schemaVerified = false;

function isEnabled() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

function headers(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rest(method, path, body, extraHeaders) {
  if (!isEnabled()) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: headers(extraHeaders),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`[db] ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
      return null;
    }
    const text = await r.text();
    return text ? JSON.parse(text) : [];
  } catch (e) {
    console.error(`[db] ${method} ${path} failed:`, e.message);
    return null;
  }
}

async function init() {
  if (!isEnabled()) {
    console.warn('[db] SUPABASE_URL / SUPABASE_KEY not set — running without persistence (in-memory only).');
    return;
  }
  // Sanity check: does the schema exist yet? We can't run DDL through the
  // REST API — the user has to paste db/schema.sql into the Supabase SQL
  // Editor once. This just confirms it's been done and gives a clear error
  // if not.
  const res = await rest('GET', 'model_versions?select=version&limit=1');
  if (res === null) {
    console.error('[db] Could not read from Supabase. Either credentials are wrong, or db/schema.sql ' +
      'hasn\'t been run yet in the Supabase SQL Editor (Project -> SQL Editor -> paste db/schema.sql -> Run).');
    return;
  }
  schemaVerified = true;
  console.log('[db] Connected to Supabase REST API, schema verified.');
}

function ready() { return isEnabled() && schemaVerified; }

async function upsertIncident(inc) {
  if (!ready()) return;
  await rest('POST', 'incidents?on_conflict=id', {
    id: inc.id, source: inc.source, incident_type: inc.incident_type || null,
    structure_type: inc.structure_type || null, status: inc.status || 'active',
    alarm: inc.alarm || null, line1: inc.line1 || null, city: inc.city || null,
    county: inc.county || null, state: inc.state || null, zip: inc.zip || null,
    lat: inc.lat, lon: inc.lon, frp: inc.frp || null, detections: inc.detections || 1,
    created_at: inc.created_at || new Date().toISOString(),
    updated_at: inc.updated_at || new Date().toISOString(),
    closed_at: inc.closed_at || null,
    raw_payload: inc.raw_payload || null,
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function getIncidentById(id) {
  if (!ready()) return null;
  const res = await rest('GET', `incidents?id=eq.${encodeURIComponent(id)}&select=id,lat,lon,frp,created_at&limit=1`);
  return res && res[0] ? res[0] : null;
}

async function recentIncidents(limit = 200) {
  if (!ready()) return null;
  const res = await rest('GET', `incidents?select=*&order=created_at.desc&limit=${limit}`);
  return res;
}

async function insertWeatherSnapshot(incidentId, snap) {
  if (!ready()) return;
  await rest('POST', 'weather_snapshots', {
    incident_id: incidentId,
    observed_at: snap.observed_at || new Date().toISOString(),
    altitude_m: snap.altitude_m, wind_speed_ms: snap.wind_speed_ms, wind_dir_deg: snap.wind_dir_deg,
    gust_ms: snap.gust_ms || null, temperature_c: snap.temperature_c || null,
    source: snap.source || 'open-meteo', raw: snap.raw || null,
  }, { Prefer: 'return=minimal' });
}

async function upsertStructure(s) {
  if (!ready()) return;
  await rest('POST', 'structures?on_conflict=id', {
    id: s.id, osm_id: s.osm_id || null, osm_type: s.osm_type || null,
    lat: s.lat, lon: s.lon, geom: s.geom || null, building_type: s.building_type || null,
    name: s.name || null, address: s.address || null, fetched_at: s.fetched_at || new Date().toISOString(),
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function insertRiskAssessment(r) {
  if (!ready()) return;
  await rest('POST', 'incident_structures', {
    incident_id: r.incident_id, structure_id: r.structure_id,
    computed_at: r.computed_at || new Date().toISOString(),
    distance_m: r.distance_m, bearing_deg: r.bearing_deg, wind_dir_deg: r.wind_dir_deg,
    wind_speed_ms: r.wind_speed_ms, stability_class: r.stability_class,
    smoke_cone_reach_m: r.smoke_cone_reach_m, in_cone: r.in_cone,
    risk_score: r.risk_score, risk_tier: r.risk_tier,
    model_version: r.model_version || 'v0-heuristic', inputs: r.inputs || null,
  }, { Prefer: 'return=minimal' });
}

async function insertFeedback(f) {
  if (!ready()) return null;
  const res = await rest('POST', 'feedback_outcomes', {
    incident_structure_id: f.incident_structure_id,
    inspected_at: f.inspected_at || new Date().toISOString(),
    damage_observed: f.damage_observed ?? null, damage_severity: f.damage_severity || null,
    source: f.source || 'manual', notes: f.notes || null, raw: f.raw || null,
  }, { Prefer: 'return=representation' });
  return res && res[0] ? res[0] : null;
}

async function getModelCoefficients(version = 'v0-heuristic') {
  if (!ready()) return null;
  const res = await rest('GET', `model_versions?version=eq.${version}&select=coefficients&limit=1`);
  return res && res[0] ? res[0].coefficients : null;
}

module.exports = {
  init, isEnabled: ready,
  upsertIncident, getIncidentById, recentIncidents,
  insertWeatherSnapshot, upsertStructure,
  insertRiskAssessment, insertFeedback, getModelCoefficients,
};
