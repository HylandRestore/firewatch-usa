// v1 logistic smoke-damage probability model.
//
// v0 (superseded) was a hand-built multiplicative heuristic. This version is
// a proper logistic regression: p(damage) = sigmoid(bias + sum(weight_i *
// feature_i)). The reason that matters — not just tidiness — is that logistic
// regression is exactly the model family that can be *re-fit* from real
// inspection outcomes via ordinary gradient descent (see lib/recalibrate.js).
// Every prediction stores its full named feature vector in
// incident_structures.inputs.features, in the same order as FEATURE_ORDER, so
// recalibration can reconstruct the training matrix X and target vector y
// (feedback_outcomes.damage_observed) and re-fit weights without ever
// touching this file. The output is a true 0-100% probability, not an
// arbitrary "score."
//
// Every factor below is chosen for a specific, citable physical reason —
// not just "seemed relevant" — because the model needs to be defensible to
// someone (an insurer, an inspector, a homeowner) asking "why did you say
// this house was at risk?"

const DEFAULT_COEFFICIENTS = {
  bias: -3.0,
  // Spatial: how close the structure is to the fire, relative to how far the
  // plume reaches (see lib/smokeCone.js reach model). This is the single
  // strongest predictor in any plume-dispersion model — concentration falls
  // off sharply with distance from source in the standard Gaussian plume
  // equation (Turner 1970; C ~ Q / (u * sigma_y * sigma_z), and sigma_y/z
  // grow with downwind distance).
  proximity_factor: 3.0,
  // Fire radiative power (FRP, from NASA FIRMS / MODIS-VIIRS) is a
  // well-established proxy for the rate of biomass/fuel consumption and
  // therefore for smoke-emission rate (Wooster et al. 2003; Kaufman et al.
  // 1998 — FRP-based fire emissions). Log-scaled because FRP is heavy-tailed:
  // the difference between a 50MW and 500MW fire matters far more than the
  // difference between a 1500MW and 1950MW fire.
  intensity_norm: 1.2,
  // Cumulative exposure time. A structure downwind of a fire burning for 10
  // hours accumulates more soot/ash deposition than one exposed for 30
  // minutes, but the marginal effect saturates (a fire's *plume* is governed
  // by current conditions, not indefinitely growing reach — modeled as a
  // saturating exponential, consistent with the duration term already used
  // in the smoke-cone reach calculation).
  duration_norm: 0.8,
  // Wind speed's SIGN is genuinely ambiguous a priori, which is why it's
  // both a plain feature and an interaction term below rather than a fixed
  // hand-picked direction:
  //   - Briggs (1965, 1969) plume-rise formulas: plume rise is inversely
  //     related to wind speed for a bent-over plume (Δh ∝ F^(1/3)/u). Higher
  //     wind speed means LESS buoyant lift, so a hot fire's smoke stays
  //     closer to the surface instead of lofting — literally "more smoke at
  //     surface," which is the effect you described.
  //   - But the standard Gaussian plume dispersion equation also has
  //     concentration inversely proportional to wind speed (faster wind =
  //     more horizontal dilution of a fixed emission rate).
  //   These pull in opposite directions and the net effect depends on
  //   distance from the fire, which is exactly what wind_prox_interaction
  //   is for for: it lets recalibration learn that wind's effect is
  //   different close to the fire (favors the "less lofting, more surface
  //   smoke" mechanism) vs. far downwind (favors the "more dilution"
  //   mechanism), instead of the old model hard-coding "wind = always less
  //   risk."
  wind_norm: 0.6,
  wind_prox_interaction: 0.8,
  // Atmospheric stability class (Pasquill-Gifford, via
  // weather.computeStabilityClass — see lib/weather.js). Stable conditions
  // (common on clear, calm nights) suppress vertical mixing, so smoke stays
  // concentrated near the ground instead of dispersing upward. This used to
  // be hard-coded to "neutral" (class 3) everywhere; it's now computed per
  // incident from real cloud-cover/wind/day-night data.
  stability_norm: 1.0,
  // Precipitation since/around the fire scrubs particulates out of the air
  // (wet deposition) — a standard term in EPA/NOAA air-quality dispersion
  // models. Negative weight: more rain, less smoke-damage risk.
  precip_norm: -2.0,
  // Boundary-layer (mixing) height: the depth of the surface layer smoke can
  // mix into. A shallow boundary layer — the same NOAA HRRR-Smoke / BlueSky
  // Framework key input used for real wildfire-smoke air-quality forecasts —
  // traps smoke near the ground, elevating surface concentration for the
  // same emission rate. pbl_trap_norm is defined so that SHALLOW layers
  // score HIGH (it's "how trapped," not "how tall"), hence a positive
  // weight here.
  pbl_trap_norm: 1.0,
  // Relative humidity: hygroscopic growth of smoke/soot particles (PM2.5)
  // in humid air increases their effective size and visible deposition on
  // surfaces. A secondary effect vs. precipitation, so a smaller weight.
  humidity_norm: 0.3,
  // Building-type vulnerability (openings, HVAC intake exposure, porous
  // materials like wood siding vs. sealed industrial metal cladding) —
  // carried over from v0's BUILDING_VULNERABILITY table, centered at 0 so it
  // shifts log-odds up/down rather than multiplying.
  vulnerability_centered: 1.5,
  // Wildfire smoke and structure-fire smoke are not the same hazard: wildland
  // fuel combustion (EPA AP-42 wildfire emission factors) tends to produce
  // more sustained, larger-footprint particulate plumes than a single
  // structure fire (NIST structure-fire research — typically shorter
  // duration and smaller source area unless it's a multi-structure
  // conflagration), so a wildfire source gets a small positive nudge that
  // recalibration can adjust once real outcomes exist for both fire types.
  fire_type_wildfire: 0.3,
};

// Fixed (non-learned) geometry constant — how sharply risk falls off with
// distance inside the cone. Kept separate from the learned linear weights
// above because it shapes proximity_factor itself (a nonlinear transform of
// distance/reach), not a simple linear feature; a future version could learn
// this too, but v1 keeps it fixed for a simpler, more stable first fit.
const DISTANCE_DECAY = 1.5;

const FEATURE_ORDER = [
  'bias', 'proximity_factor', 'intensity_norm', 'duration_norm',
  'wind_norm', 'wind_prox_interaction', 'stability_norm', 'precip_norm',
  'pbl_trap_norm', 'humidity_norm', 'vulnerability_centered', 'fire_type_wildfire',
];

const BUILDING_VULNERABILITY = {
  residential: 1.05,
  house: 1.05,
  school: 1.15,
  hospital: 1.1,
  retirement_home: 1.15,
  industrial: 0.85,
  warehouse: 0.85,
  commercial: 0.9,
  retail: 0.95,
  government: 0.95,
};

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Fetches whichever model version is currently marked active in Supabase
// (model_versions.is_active), so a recalibration (lib/recalibrate.js) takes
// effect immediately without a code deploy. Falls back to the hand-picked
// DEFAULT_COEFFICIENTS/'v1-logistic' if no DB, or no active row yet (e.g.
// schema migration not run).
async function loadCoefficients(db) {
  if (db && db.isEnabled && db.isEnabled()) {
    const active = await db.getActiveModelVersion?.();
    if (active && active.coefficients) {
      return { version: active.version, coefficients: { ...DEFAULT_COEFFICIENTS, ...active.coefficients } };
    }
  }
  return { version: 'v1-logistic', coefficients: DEFAULT_COEFFICIENTS };
}

function computeStructureRisk({
  distanceM, reachM, inCone, frpMw, durationHours, windSpeedMs, stabilityClass,
  precipMm, humidityPct, boundaryLayerHeightM, fireTypeIsWildfire,
  buildingType, coefficients, modelVersion,
}) {
  const c = coefficients || DEFAULT_COEFFICIENTS;

  if (!inCone || reachM <= 0) {
    return { score: 0, probability: 0, probability_pct: 0, tier: 'Low', proximity_factor: 0 };
  }

  const proximityFactor = clamp01(1 - Math.pow(distanceM / reachM, 1 / DISTANCE_DECAY));
  const intensityNorm = clamp01(Math.log1p(frpMw || 0) / Math.log1p(2000));
  const durationNorm = 1 - Math.exp(-(durationHours || 1) / 24);
  const windNorm = clamp01((windSpeedMs ?? 5) / 20);
  const windProxInteraction = windNorm * proximityFactor;
  const stabilityNorm = clamp01((stabilityClass || 3) / 5);
  const precipNorm = clamp01((precipMm ?? 0) / 5);
  const pblTrapNorm = clamp01(1 - (boundaryLayerHeightM ?? 900) / 2000);
  const humidityNorm = clamp01((humidityPct ?? 50) / 100);
  const vulnerability = BUILDING_VULNERABILITY[(buildingType || '').toLowerCase()] || 1.0;
  const vulnerabilityCentered = vulnerability - 1;
  const fireTypeWildfire = fireTypeIsWildfire ? 1 : 0;

  const features = {
    bias: 1,
    proximity_factor: proximityFactor,
    intensity_norm: intensityNorm,
    duration_norm: durationNorm,
    wind_norm: windNorm,
    wind_prox_interaction: windProxInteraction,
    stability_norm: stabilityNorm,
    precip_norm: precipNorm,
    pbl_trap_norm: pblTrapNorm,
    humidity_norm: humidityNorm,
    vulnerability_centered: vulnerabilityCentered,
    fire_type_wildfire: fireTypeWildfire,
  };

  let z = 0;
  for (const key of FEATURE_ORDER) z += (c[key] ?? 0) * features[key];

  const probability = sigmoid(z);
  const tier = probability >= 0.6 ? 'High' : probability >= 0.3 ? 'Moderate' : 'Low';

  return {
    score: probability, // kept for backward compatibility with existing callers/CSV columns
    probability,
    probability_pct: Math.round(probability * 1000) / 10,
    tier,
    proximity_factor: proximityFactor,
    inputs: {
      distance_m: distanceM, reach_m: reachM, frp_mw: frpMw, duration_hours: durationHours,
      wind_speed_ms: windSpeedMs, stability_class: stabilityClass, precip_mm: precipMm,
      humidity_pct: humidityPct, boundary_layer_height_m: boundaryLayerHeightM,
      fire_type_wildfire: fireTypeIsWildfire, building_type: buildingType,
      features, feature_order: FEATURE_ORDER,
      model_version: modelVersion || 'v1-logistic', coefficients: c,
    },
  };
}

module.exports = {
  computeStructureRisk, loadCoefficients, sigmoid, clamp01,
  DEFAULT_COEFFICIENTS, BUILDING_VULNERABILITY, FEATURE_ORDER, DISTANCE_DECAY,
};
