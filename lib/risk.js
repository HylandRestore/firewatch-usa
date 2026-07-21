// v0 heuristic structure damage-risk model.
//
// This is intentionally rudimentary: a transparent, hand-built formula (not
// a trained model) that combines proximity, fire intensity, duration, wind,
// and atmospheric stability into a 0-1 probability of smoke/ash damage.
//
// The point of writing it this way — rather than reaching for an ML model
// day one — is that every prediction stores its full input vector and
// coefficient version in incident_structures.inputs. Once feedback_outcomes
// has enough real inspection results (from the future Monday.com loop), a
// second version of this model (v1-calibrated, v2-learned, ...) can be
// fit against that data and swapped in without losing the audit trail of
// what v0 predicted and why.

const DEFAULT_COEFFICIENTS = {
  distance_decay: 1.5,
  intensity_weight: 0.35,
  duration_weight: 0.15,
  wind_speed_weight: 0.25, // interpreted as a mild dilution effect (higher wind -> lower local concentration)
  stability_weight: 0.25,
};

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

async function loadCoefficients(db) {
  if (db && db.isEnabled && db.isEnabled()) {
    const coeffs = await db.getModelCoefficients('v0-heuristic');
    if (coeffs) return { ...DEFAULT_COEFFICIENTS, ...coeffs };
  }
  return DEFAULT_COEFFICIENTS;
}

function computeStructureRisk({
  distanceM, reachM, inCone, frpMw, durationHours, windSpeedMs, stabilityClass,
  buildingType, coefficients,
}) {
  const c = coefficients || DEFAULT_COEFFICIENTS;

  if (!inCone || reachM <= 0) {
    return { score: 0, tier: 'Low', proximity_factor: 0 };
  }

  const proximityFactor = clamp01(1 - Math.pow(distanceM / reachM, 1 / c.distance_decay));

  const intensityNorm = clamp01((frpMw || 0) / 2000);
  const durationNorm = 1 - Math.exp(-(durationHours || 1) / 24);
  const stabilityNorm = clamp01((stabilityClass || 3) / 5); // more stable atmosphere -> smoke stays low -> more risk
  const windDilution = clamp01((windSpeedMs || 5) / 15); // faster wind -> more dilution -> less risk

  let factorSum =
    c.intensity_weight * intensityNorm +
    c.duration_weight * durationNorm +
    c.stability_weight * stabilityNorm -
    c.wind_speed_weight * windDilution * 0.5;

  factorSum = clamp01(factorSum);

  const vulnerability = BUILDING_VULNERABILITY[(buildingType || '').toLowerCase()] || 1.0;

  const score = clamp01(proximityFactor * factorSum * vulnerability);
  const tier = score >= 0.6 ? 'High' : score >= 0.3 ? 'Moderate' : 'Low';

  return {
    score,
    tier,
    proximity_factor: proximityFactor,
    inputs: {
      distance_m: distanceM, reach_m: reachM, frp_mw: frpMw, duration_hours: durationHours,
      wind_speed_ms: windSpeedMs, stability_class: stabilityClass, building_type: buildingType,
      intensity_norm: intensityNorm, duration_norm: durationNorm, stability_norm: stabilityNorm,
      wind_dilution: windDilution, vulnerability, coefficients: c,
    },
  };
}

module.exports = { computeStructureRisk, loadCoefficients, DEFAULT_COEFFICIENTS, BUILDING_VULNERABILITY };
