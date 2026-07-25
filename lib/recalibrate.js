// The feedback loop: turns real inspection outcomes (feedback_outcomes) into
// an updated, better-calibrated risk model (a new model_versions row),
// without ever needing a code change or redeploy.
//
// Every risk assessment already stores its exact named feature vector at
// prediction time (lib/risk.js's computeStructureRisk -> inputs.features, in
// FEATURE_ORDER order). Once a CRM-side inspection confirms whether smoke
// damage actually happened at that structure (POST /api/feedback), this
// module:
//   1. Pulls every (features, actual outcome) pair on record.
//   2. Re-fits the logistic regression weights via batch gradient descent —
//      warm-started from whatever coefficients are currently active, so
//      each recalibration is an incremental update on top of the last one
//      (and on top of the original physically-reasoned priors), not a
//      from-scratch refit that throws away prior knowledge every time.
//   3. Writes the new weights as a new, versioned model_versions row and
//      marks it active — so the very next risk computation anywhere in the
//      app uses the improved model, while every previous version stays in
//      the table for audit/rollback.
//
// This is plain hand-rolled gradient descent, not a call to an external ML
// library — deliberately, so it can run inside the same lightweight Node
// process on Render with zero new dependencies.

const risk = require('./risk');

const MIN_SAMPLES = 30; // below this, weights fit on noise more than signal
const DEFAULT_EPOCHS = 1500;
const DEFAULT_LR = 0.15;
const DEFAULT_L2 = 0.002; // small L2 on every weight except bias, keeps fit from overreacting to a handful of samples

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

function trainLogisticRegression(X, y, { lr = DEFAULT_LR, epochs = DEFAULT_EPOCHS, l2 = DEFAULT_L2, initWeights }) {
  const n = X.length, k = X[0].length;
  const w = initWeights ? initWeights.slice() : new Array(k).fill(0);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const p = sigmoid(dot(X[i], w));
      const err = p - y[i];
      for (let j = 0; j < k; j++) grad[j] += err * X[i][j];
    }
    for (let j = 0; j < k; j++) {
      let g = grad[j] / n;
      if (j !== 0) g += l2 * w[j]; // don't shrink the bias term
      w[j] -= lr * g;
    }
  }
  return w;
}

function evaluate(X, y, w) {
  let loss = 0, correct = 0;
  for (let i = 0; i < X.length; i++) {
    const p = sigmoid(dot(X[i], w));
    const pClamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
    loss += -(y[i] * Math.log(pClamped) + (1 - y[i]) * Math.log(1 - pClamped));
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
  }
  return { log_loss: loss / X.length, accuracy: correct / X.length };
}

// Pull (feature-vector, label) pairs out of the raw join. Only rows whose
// stored feature vector matches the current FEATURE_ORDER exactly are usable
// — older v0-heuristic assessments (before this feature set existed) are
// skipped rather than guessed at.
function extractTrainingPairs(rows) {
  const order = risk.FEATURE_ORDER;
  const X = [], y = [];
  for (const row of rows) {
    if (row.damage_observed === null || row.damage_observed === undefined) continue;
    const inc = row.incident_structures;
    const feats = inc && inc.inputs && inc.inputs.features;
    if (!feats) continue;
    if (!order.every(k => typeof feats[k] === 'number')) continue;
    X.push(order.map(k => feats[k]));
    y.push(row.damage_observed ? 1 : 0);
  }
  return { X, y };
}

async function recalibrate(db, opts = {}) {
  if (!db || !db.isEnabled || !db.isEnabled()) {
    return { skipped: true, reason: 'no database configured' };
  }

  const rawRows = await db.getTrainingData(opts.limit || 20000);
  if (!rawRows) return { skipped: true, reason: 'could not read feedback_outcomes (check schema migration ran)' };

  const { X, y } = extractTrainingPairs(rawRows);
  if (X.length < MIN_SAMPLES) {
    return {
      skipped: true,
      reason: `not enough usable feedback yet — have ${X.length}, need at least ${MIN_SAMPLES}`,
      n_samples: X.length,
    };
  }

  const active = await risk.loadCoefficients(db);
  const initWeights = risk.FEATURE_ORDER.map(k => active.coefficients[k] ?? 0);

  const w = trainLogisticRegression(X, y, { ...opts, initWeights });
  const { log_loss, accuracy } = evaluate(X, y, w);

  const coefficients = {};
  risk.FEATURE_ORDER.forEach((k, i) => { coefficients[k] = Math.round(w[i] * 10000) / 10000; });

  const version = `v1-learned-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const description = `Recalibrated from ${X.length} feedback samples (warm-started from ${active.version}). ` +
    `log_loss=${log_loss.toFixed(4)}, train_accuracy=${accuracy.toFixed(3)}.`;

  const saved = await db.insertModelVersion(version, description, coefficients, { activate: true });
  if (!saved) return { skipped: true, reason: 'failed to write new model_versions row' };

  return {
    skipped: false, version, n_samples: X.length, log_loss, accuracy,
    warm_started_from: active.version, coefficients,
  };
}

module.exports = { recalibrate, trainLogisticRegression, evaluate, extractTrainingPairs, MIN_SAMPLES };
