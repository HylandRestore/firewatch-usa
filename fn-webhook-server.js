const express = require('express');
const crypto  = require('crypto');
const db       = require('./lib/db');
const weather  = require('./lib/weather');
const structuresLib = require('./lib/structures');
const smokeCone = require('./lib/smokeCone');
const risk     = require('./lib/risk');
const recalibrateLib = require('./lib/recalibrate');

const app         = express();
const FN_SECRET   = process.env.FN_SECRET || '';
const PORT        = process.env.PORT || 3001;
const TOLERANCE_S = 300;

// Two SEPARATE in-memory stores, both mirrored to Postgres when configured:
//   - incidents: real FireNotification structural incidents, pushed via
//     webhook. This is what /fn-incidents (the FN Feed tab) reads from.
//   - syncedCache: wildfire/simulated incidents synced from the client after
//     it clusters NASA FIRMS detections. Used ONLY as a lookup cache for the
//     weather/smoke-cone/structures endpoints — never exposed via
//     /fn-incidents, so it can't leak into the FN Feed UI.
const incidents   = new Map();
const syncedCache = new Map();
const sseClients  = new Set();

// IMPORTANT: express.json() must NOT be applied globally. /fn-webhook and
// /fn-test/:type read the raw request body themselves (readBody, below) so
// they can verify FN's HMAC signature against the exact raw bytes. A global
// express.json() middleware would consume the request stream first, leaving
// nothing for readBody() to read — its stream listeners attach after the
// stream already ended, so the promise never resolves and the route never
// responds at all. That's exactly what was silently breaking FN delivery:
// zero response ever sent back, so every webhook attempt timed out.
// Only the new JSON API routes get express.json(), applied per-route below.
const jsonBody = express.json({ limit: '1mb' });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

function readBody(req) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    req.on('data', chunk => { buf = Buffer.concat([buf, Buffer.from(chunk)]); });
    req.on('end', () => resolve(buf.toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// ── Geocoding (server-side, for FN structural incidents which only carry
// an address) ────────────────────────────────────────────────────────────
async function geocodeAddress(line1, city, state, zip) {
  try {
    const q = encodeURIComponent(`${line1}, ${city}, ${state} ${zip}, USA`);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'FireWatchUSA/1.0 (contact: chris.hyland.ch@gmail.com)' }, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch (e) { console.warn('[geocode] failed:', e.message); }
  return null;
}

// ── FireNotification webhook ingestion ───────────────────────────────────
app.post('/fn-webhook', async (req, res) => {
  const raw = await readBody(req);
  res.status(200).json({ received: true });
  let envelope;
  try { envelope = JSON.parse(raw); } catch(e) { console.warn('JSON parse error'); return; }
  if (!envelope || !envelope.data) { console.warn('Empty envelope'); return; }
  if (FN_SECRET) {
    const ts  = req.headers['x-fn-timestamp'] || '';
    const sig = req.headers['x-fn-signature']  || '';
    const now = Math.floor(Date.now()/1000);
    if (Math.abs(now - parseInt(ts,10)) > TOLERANCE_S) { console.warn('Timestamp expired'); return; }
    const expected = 'v1='+crypto.createHmac('sha256',FN_SECRET).update(`${ts}.${raw}`).digest('hex');
    if (sig !== expected) { console.warn('Bad signature'); return; }
  }
  await processEnvelope(envelope);
});

async function processEnvelope(envelope) {
  const { id, eventType, occurredAt, webhookId, businessId, data } = envelope;
  if (!data) return;
  const incidentId = data.incidentId || 'unknown';
  console.log(`[${new Date().toISOString()}] ${eventType} — incident ${incidentId}`);

  const existing = incidents.get(incidentId) || {};
  const merged = { ...existing, ...data, _lastEventType:eventType, _lastEventId:id, _lastEventAt:occurredAt, _webhookId:webhookId, _businessId:businessId };
  incidents.set(incidentId, merged);

  const payload = JSON.stringify({ eventType, incidentId, envelope });
  for (const c of sseClients) c.write(`data: ${payload}\n\n`);

  const a = data.address || {};
  if (eventType === 'webhook:incident.created') console.log(`  NEW: ${data.incidentType} at ${a.line1}, ${a.city} ${a.state}`);
  if (eventType === 'webhook:incident.closed')  console.log(`  CLOSED at ${data.closedAt}`);
  if (data.contact) console.log(`  CONTACT: ${data.contact}`);

  // Geocode + persist in the background so the webhook response was already
  // sent above (FN expects a fast 200 ack).
  if (a.line1 && a.city) {
    const geo = await geocodeAddress(a.line1, a.city, a.state, a.zipCode);
    if (geo) {
      merged._lat = geo.lat;
      merged._lon = geo.lon;
      incidents.set(incidentId, merged);
      const frp = 80 + (data.alarm || 1) * 20;
      await db.upsertIncident({
        id: incidentId,
        source: 'fn_structural',
        incident_type: data.incidentType,
        structure_type: (data.incidentType || '').split('|')[0]?.trim(),
        status: data.status,
        alarm: data.alarm,
        line1: a.line1, city: a.city, county: a.county, state: a.state, zip: a.zipCode,
        lat: geo.lat, lon: geo.lon,
        frp,
        created_at: data.createdAt, updated_at: data.updatedAt, closed_at: data.closedAt,
        raw_payload: envelope,
      });

      // Prefetch structures-at-risk in the background (fire-and-forget) so
      // it's usually already cached by the time someone clicks into this
      // incident. Spreads Overpass calls out at the natural rate incidents
      // arrive instead of bunching them up around whenever someone happens
      // to be actively browsing the app.
      computeStructuresAtRisk({ id: incidentId, lat: geo.lat, lon: geo.lon, frp, created_at: data.createdAt, source: 'fn_structural' })
        .catch(e => console.warn(`[prefetch] structures failed for ${incidentId}:`, e.message));
    }
  }
}

app.get('/fn-incidents', (req, res) => {
  const all = Array.from(incidents.values()).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,200);
  res.json({ incidents: all, count: all.length });
});

app.get('/fn-stream', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  for (const [,data] of incidents) res.write(`data: ${JSON.stringify({ eventType:'snapshot', envelope:{ data } })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/fn-test/:type', async (req, res) => {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw); } catch(e) {}
  await processEnvelope({ id:'test_'+Date.now(), eventType:req.params.type, occurredAt:new Date().toISOString(), data:body });
  res.json({ ok: true });
});

// ── Unified incident sync (wildfire clusters from client + anything else) ─
// The browser fetches NASA FIRMS directly (Anthropic sandboxes/servers
// shouldn't proxy that — it's a public, rate-limited, key-scoped feed), then
// clusters it client-side, then calls this so those incidents get the same
// persistence + weather/structure/risk pipeline as FN incidents.
app.post('/api/incidents/sync', jsonBody, async (req, res) => {
  const list = (req.body && req.body.incidents) || [];
  let count = 0;
  for (const f of list) {
    if (!f.id || typeof f.lat !== 'number' || typeof f.lon !== 'number') continue;
    syncedCache.set(f.id, { ...syncedCache.get(f.id), ...f, _lat: f.lat, _lon: f.lon });
    await db.upsertIncident({
      id: f.id,
      source: f.type === 'structural' ? 'firms_structural' : 'firms_wildfire',
      incident_type: f.type,
      status: 'active',
      lat: f.lat, lon: f.lon, frp: f.frp, detections: f.count || 1,
      created_at: f.createdAt || new Date(Date.now() - (f.hoursSince||1)*3600000).toISOString(),
      updated_at: new Date().toISOString(),
      raw_payload: f,
    });
    count++;
  }
  res.json({ synced: count });
});

app.get('/api/incidents', async (req, res) => {
  const dbRows = await db.recentIncidents(parseInt(req.query.limit) || 200);
  if (dbRows) return res.json({ incidents: dbRows, count: dbRows.length, source: 'db' });
  // fallback: in-memory only — merge both stores since this endpoint (unlike
  // /fn-incidents) is meant to represent everything we know about.
  const all = [...incidents.values(), ...syncedCache.values()];
  res.json({ incidents: all, count: all.length, source: 'memory' });
});

// Look up an incident's lat/lon/frp/created_at from whatever we have handy —
// in-memory first (works even with no DB), then Postgres. Checks the FN map
// and the synced-wildfire cache, since either kind of incident can be the
// target of a weather/smoke-cone/structures lookup.
function memoryLookup(id) {
  const m = incidents.get(id) || syncedCache.get(id);
  if (!m) return null;
  const lat = m._lat ?? m.lat;
  const lon = m._lon ?? m.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const a = m.address || {};
  // Which store this came from tells us the fire type (structural vs.
  // wildfire) — needed by the risk model's fire_type_wildfire feature, since
  // wildfire and structure-fire smoke aren't the same hazard profile (see
  // lib/risk.js). Falls back to the synced record's own `source`/`type` for
  // the wildfire cache, since that's set at /api/incidents/sync time.
  const source = incidents.has(id)
    ? 'fn_structural'
    : (m.source || (m.type === 'structural' ? 'firms_structural' : 'firms_wildfire'));
  return {
    id, lat, lon, source,
    frp: m.frp ?? (80 + (m.alarm || 1) * 20),
    created_at: m.createdAt || m.created_at || new Date().toISOString(),
    incident_type: m.incidentType || m.type || null,
    line1: a.line1 || null, city: a.city || null, state: a.state || null, zip: a.zipCode || null,
  };
}

// Lazy geocode fallback: an FN incident can end up with no _lat/_lon if the
// one event that carried its address (usually "incident.created") never
// successfully delivered, even though later events for the same incident
// did. Rather than permanently losing the ability to analyze it, check
// whatever address fields we DO have in the merged record and geocode now,
// on demand, the first time someone actually looks at this incident.
async function lazyGeocodeFallback(id) {
  const m = incidents.get(id);
  if (!m) return null;
  const a = m.address || {};
  if (!a.line1 || !a.city) return null; // truly no address data available anywhere
  const geo = await geocodeAddress(a.line1, a.city, a.state, a.zipCode);
  if (!geo) return null;

  m._lat = geo.lat;
  m._lon = geo.lon;
  incidents.set(id, m);

  const frp = 80 + (m.alarm || 1) * 20;
  await db.upsertIncident({
    id, source: 'fn_structural', incident_type: m.incidentType,
    structure_type: (m.incidentType || '').split('|')[0]?.trim(),
    status: m.status, alarm: m.alarm,
    line1: a.line1, city: a.city, county: a.county, state: a.state, zip: a.zipCode,
    lat: geo.lat, lon: geo.lon, frp,
    created_at: m.createdAt, updated_at: m.updatedAt, closed_at: m.closedAt,
    raw_payload: m,
  });

  return {
    id, lat: geo.lat, lon: geo.lon, frp, source: 'fn_structural', created_at: m.createdAt || new Date().toISOString(),
    incident_type: m.incidentType || null, line1: a.line1 || null, city: a.city || null, state: a.state || null, zip: a.zipCode || null,
  };
}

async function lookupIncident(id) {
  const mem = memoryLookup(id);
  if (mem) return mem;
  const lazy = await lazyGeocodeFallback(id);
  if (lazy) return lazy;
  if (db.isEnabled()) {
    const row = await db.getIncidentById(id);
    if (row) return row;
  }
  return null;
}

// ── Real per-incident weather (surface + elevated) ───────────────────────
app.get('/api/incidents/:id/weather', async (req, res) => {
  const inc = await lookupIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found — sync it first via /api/incidents/sync' });
  try {
    const w = await weather.fetchIncidentWeather(inc.lat, inc.lon, inc.created_at);
    await db.insertWeatherSnapshot(inc.id, { ...w.surface, observed_at: w.observed_at, source: w.source, raw: w.raw });
    for (const lvl of w.levels) await db.insertWeatherSnapshot(inc.id, { ...lvl, observed_at: w.observed_at, source: w.source });
    res.json(w);
  } catch (e) {
    console.warn('[weather] live fetch failed, using estimate:', e.message);
    res.json(weather.estimateWeather());
  }
});

// ── Smoke cone: couples fire intensity/duration with real wind ───────────
// stabilityClassOverride: pass an explicit 1-5 to force it (e.g. ?stability=
// query param, for testing/comparison). Otherwise stability is COMPUTED per
// incident from real cloud-cover/wind/day-night data via
// weather.computeStabilityClass — it used to be hard-coded to "neutral"
// (class 3) for every single fire, which meant the model never actually
// reflected whether conditions were the calm-clear-night type that trap
// smoke near the ground vs. a windy, well-mixed afternoon.
async function buildSmokeCone(inc, stabilityClassOverride) {
  let w;
  try { w = await weather.fetchIncidentWeather(inc.lat, inc.lon, inc.created_at); }
  catch (e) { w = weather.estimateWeather(); }
  const durationHours = (Date.now() - new Date(inc.created_at).getTime()) / 3600000;
  const stabilityClass = Number.isFinite(stabilityClassOverride) ? stabilityClassOverride
    : weather.computeStabilityClass({
        windSpeedMs: w.surface?.wind_speed_ms, cloudCoverPct: w.surface?.cloud_cover_pct,
        isDay: w.surface?.is_day, shortwaveRadiation: w.surface?.shortwave_radiation,
      });
  const cone = smokeCone.computeSmokeCone({
    lat: inc.lat, lon: inc.lon, frp: inc.frp, durationHours,
    weather: w, stabilityClass,
  });
  return { cone, weather: w, durationHours, stabilityClass };
}

app.get('/api/incidents/:id/smoke-cone', async (req, res) => {
  const inc = await lookupIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  const stabilityOverride = parseInt(req.query.stability);
  const { cone, weather: w, durationHours, stabilityClass } = await buildSmokeCone(inc, stabilityOverride);
  res.json({ incidentId: inc.id, durationHours, stabilityClass, weather: w, ...cone });
});

// ── Real structures-at-risk (OSM Overpass) + v1 logistic risk scoring ────
// Shared by the JSON endpoint and the CSV export so both always agree.
async function computeStructuresAtRisk(inc, stabilityClassOverride) {
  const { cone, durationHours, weather: w, stabilityClass } = await buildSmokeCone(inc, stabilityClassOverride);
  const rawStructures = await structuresLib.fetchStructuresNear(inc.lat, inc.lon, cone.reach_m);
  const { version: modelVersion, coefficients } = await risk.loadCoefficients(db);
  const fireTypeIsWildfire = (inc.source || '').includes('wildfire');

  const results = [];
  for (const s of rawStructures) {
    const { distance_m, bearing_deg } = smokeCone.distanceBearing(inc.lat, inc.lon, s.lat, s.lon);
    const inCone = smokeCone.isWithinCone(bearing_deg, cone.travel_bearing_deg, cone.half_width_deg, distance_m, cone.reach_m);
    const scored = risk.computeStructureRisk({
      distanceM: distance_m, reachM: cone.reach_m, inCone,
      frpMw: inc.frp, durationHours, windSpeedMs: cone.speed_ms,
      stabilityClass, precipMm: w.surface?.precip_mm, humidityPct: w.surface?.humidity_pct,
      boundaryLayerHeightM: w.surface?.boundary_layer_height_m, fireTypeIsWildfire,
      buildingType: s.building_type, coefficients, modelVersion,
    });
    if (!inCone) continue; // only report structures actually inside the plume

    await db.upsertStructure(s);
    const incidentStructureId = await db.insertRiskAssessment({
      incident_id: inc.id, structure_id: s.id, distance_m, bearing_deg,
      wind_dir_deg: cone.dir_deg, wind_speed_ms: cone.speed_ms, stability_class: stabilityClass,
      smoke_cone_reach_m: cone.reach_m, in_cone: inCone, risk_score: scored.score,
      risk_tier: scored.tier, model_version: modelVersion, inputs: scored.inputs,
    });

    // incident_structure_id is what the future CRM feedback loop references
    // (POST /api/feedback) to report what an inspection actually found at
    // this specific structure/fire pairing — has to be surfaced here, not
    // just written to the DB, or there'd be no way to report back on it.
    results.push({
      ...s, distance_m, bearing_deg, risk_score: scored.score,
      probability_pct: scored.probability_pct, risk_tier: scored.tier,
      incident_structure_id: incidentStructureId,
    });
  }
  results.sort((a, b) => b.risk_score - a.risk_score);
  return { results, cone };
}

app.get('/api/incidents/:id/structures', async (req, res) => {
  const inc = await lookupIncident(req.params.id);
  if (!inc) return res.status(404).json({
    error: 'incident not found',
    reason: 'No location data available for this incident yet — the event carrying its address may not have been received, or geocoding failed.',
  });
  const stabilityOverride = parseInt(req.query.stability);

  try {
    const { results, cone } = await computeStructuresAtRisk(inc, stabilityOverride);
    res.json({ incidentId: inc.id, count: results.length, structures: results, cone });
  } catch (e) {
    console.error('[structures] failed:', e.message);
    res.status(502).json({ error: 'structure lookup failed', detail: e.message });
  }
});

// ── CSV export: addresses potentially affected by smoke for one incident ──
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// OSM doesn't tag every building with an address. Rather than leaving the
// cell blank (which reads as an error), label it clearly, and if we found a
// nearby addressed building to associate it with (see attachNearestAddress
// in lib/structures.js), include that so unaddressed structures visibly
// group under whichever known address they're actually next to.
function formatAffectedAddress(s) {
  if (s.address) return s.address;
  if (s.name) return s.name;
  if (s.near_address) return `Structure - no address (near ${s.near_address})`;
  return 'Structure - no address';
}

app.get('/api/incidents/:id/structures.csv', async (req, res) => {
  const inc = await lookupIncident(req.params.id);
  if (!inc) return res.status(404).send('incident not found — no location data available yet');
  const stabilityOverride = parseInt(req.query.stability);

  try {
    const { results, cone } = await computeStructuresAtRisk(inc, stabilityOverride);
    const incidentAddress = [inc.line1, inc.city, inc.state].filter(Boolean).join(', ') || `${inc.lat.toFixed(4)}, ${inc.lon.toFixed(4)}`;
    const header = [
      'incident_address', 'incident_type', 'incident_date',
      'affected_address', 'building_type', 'distance_m', 'bearing_deg', 'smoke_damage_pct', 'risk_tier', 'lat', 'lon',
      'incident_structure_id',
    ];
    const rows = results.map(s => [
      incidentAddress, inc.incident_type || '', inc.created_at || '',
      formatAffectedAddress(s), s.building_type || '', Math.round(s.distance_m),
      Math.round(s.bearing_deg), s.probability_pct, s.risk_tier, s.lat, s.lon,
      s.incident_structure_id ?? '',
    ]);
    const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="firewatch-${inc.id}-structures-at-risk.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[structures.csv] failed:', e.message);
    res.status(502).send('structure lookup failed: ' + e.message);
  }
});

// ── Full export: every structure ever found inside any smoke cone ────────
// The aggregate "houses that may be damaged" record across ALL incidents,
// not just one fire at a time. Reads straight from Supabase, so it needs
// persistence configured — it's a report on historical data, not a live
// computation.
app.get('/api/export/structures-at-risk.csv', async (req, res) => {
  const rows = await db.allRiskAssessments(parseInt(req.query.limit) || 5000);
  if (rows === null) return res.status(503).send('No database configured — set SUPABASE_URL/SUPABASE_KEY to enable this export.');

  const header = [
    'incident_address', 'incident_type', 'incident_date', 'incident_status',
    'affected_address', 'building_type', 'distance_m', 'bearing_deg', 'smoke_damage_pct', 'risk_tier',
    'lat', 'lon', 'computed_at', 'incident_structure_id',
  ];
  const csvRows = rows.map(r => {
    const s = r.structures || {};
    const i = r.incidents || {};
    const incidentAddress = [i.line1, i.city, i.state].filter(Boolean).join(', ');
    return [
      incidentAddress, i.incident_type || '', i.created_at || '', i.status || '',
      formatAffectedAddress(s), s.building_type || '',
      r.distance_m != null ? Math.round(r.distance_m) : '', r.bearing_deg != null ? Math.round(r.bearing_deg) : '',
      r.risk_score != null ? Math.round(r.risk_score * 1000) / 10 : '', r.risk_tier, s.lat ?? '', s.lon ?? '', r.computed_at,
      r.id ?? '',
    ];
  });
  const csv = [header, ...csvRows].map(row => row.map(csvEscape).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="firewatch-all-structures-at-risk.csv"`);
  res.send(csv);
});

// ── Feedback loop stub (manual today, Monday.com-fed later) ──────────────
// Record what actually happened at a structure so future model versions can
// be calibrated against ground truth instead of just the v0 heuristic.
app.post('/api/feedback', jsonBody, async (req, res) => {
  const { incident_structure_id, damage_observed, damage_severity, notes } = req.body || {};
  if (!incident_structure_id) return res.status(400).json({ error: 'incident_structure_id required' });
  const row = await db.insertFeedback({ incident_structure_id, damage_observed, damage_severity, notes, source: 'manual' });
  if (!row) return res.status(503).json({ error: 'no database configured — set DATABASE_URL to enable feedback storage' });
  res.json({ ok: true, id: row.id });
});

// ── Model status + recalibration (the "continually learn" loop) ─────────
// Shows what's currently live and how much ground-truth feedback exists to
// learn from — useful for a CRM view showing "model confidence" over time.
app.get('/api/model/status', async (req, res) => {
  if (!db.isEnabled()) return res.status(503).json({ error: 'no database configured' });
  const active = await db.getActiveModelVersion();
  const trainingRows = await db.getTrainingData(50000);
  const usable = trainingRows ? recalibrateLib.extractTrainingPairs(trainingRows).X.length : 0;
  res.json({
    active_version: active?.version || 'v1-logistic (default, not yet persisted)',
    description: active?.description || null,
    active_since: active?.created_at || null,
    feedback_rows_total: trainingRows ? trainingRows.length : 0,
    feedback_rows_usable_for_training: usable,
    min_samples_needed_to_recalibrate: recalibrateLib.MIN_SAMPLES,
    ready_to_recalibrate: usable >= recalibrateLib.MIN_SAMPLES,
  });
});

// Triggers a refit. Call this after a batch of CRM inspection results has
// been logged via /api/feedback — it's not automatic/scheduled by design,
// since you'll want to decide when there's enough new ground truth to be
// worth re-fitting on (the endpoint itself reports if there isn't enough
// yet, via the `skipped` field, rather than silently doing nothing).
app.post('/api/model/recalibrate', async (req, res) => {
  if (!db.isEnabled()) return res.status(503).json({ error: 'no database configured' });
  try {
    const result = await recalibrateLib.recalibrate(db);
    res.json(result);
  } catch (e) {
    console.error('[recalibrate] failed:', e.message);
    res.status(500).json({ error: 'recalibration failed', detail: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    incidents: incidents.size,
    secretConfigured: !!FN_SECRET,
    dbConnected: db.isEnabled(),
    uptime: Math.round(process.uptime()) + 's',
  });
});

app.use(express.static('public'));

// Render restarts this process on every deploy (and free-tier instances can
// restart after sleeping), which wipes the in-memory maps. Without this, a
// redeploy looks like every incident vanished even though they're safely in
// Postgres — /fn-incidents just wasn't reading from there. Rebuild both
// in-memory stores from Supabase on boot so a restart never loses history
// the app already has.
async function hydrateFromDb() {
  if (!db.isEnabled()) return;
  const rows = await db.recentIncidents(500);
  if (!rows) return;
  let fnCount = 0, syncedCount = 0;
  for (const row of rows) {
    if (row.source === 'fn_structural') {
      const payload = row.raw_payload || {};
      const data = payload.data || {};
      incidents.set(row.id, {
        ...data,
        _lat: row.lat, _lon: row.lon,
        _lastEventType: payload.eventType, _lastEventId: payload.id,
        _lastEventAt: payload.occurredAt, _webhookId: payload.webhookId, _businessId: payload.businessId,
      });
      fnCount++;
    } else {
      syncedCache.set(row.id, { ...(row.raw_payload || {}), id: row.id, lat: row.lat, lon: row.lon, frp: row.frp, _lat: row.lat, _lon: row.lon });
      syncedCount++;
    }
  }
  console.log(`[hydrate] restored ${fnCount} FN incidents + ${syncedCount} synced incidents from Supabase`);
}

async function start() {
  await db.init();
  await hydrateFromDb();
  app.listen(PORT, () => console.log(`FireWatch server running on port ${PORT} — secret: ${FN_SECRET?'SET':'NOT SET'} — db: ${db.isEnabled()?'CONNECTED':'not configured'}`));
}
start();
