/**
 * FireNotification Webhook Receiver — fn-webhook-server.js
 * Compliant with Fire Notification Webhook Data Reference v1.02
 *
 * Setup:
 *   npm install express
 *   FN_SECRET=your_webhook_secret node fn-webhook-server.js
 *
 * Register your public URL (e.g. https://your-domain.com/fn-webhook)
 * in the FireNotification dashboard under Webhooks.
 *
 * The server verifies HMAC-SHA256 signatures per spec §7, stores
 * incidents in memory, and exposes them to the FireWatch HTML app
 * via a simple REST endpoint + SSE stream.
 */

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const app     = express();

const FN_SECRET   = process.env.FN_SECRET   || '';
const PORT        = process.env.PORT         || 3001;
const TOLERANCE_S = 300; // 5-minute timestamp tolerance per spec §7

// Store incidents in memory (replace with DB for production)
const incidents = new Map();
const sseClients = new Set();

// Raw body needed for HMAC verification — must come before express.json()
app.use((req, res, next) => {
  if (req.path === '/fn-webhook') {
    let buf = '';
    if (req.path === '/fn-webhook') {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { buf += chunk; });
    req.on('end', () => { req.rawBody = buf; req.body = JSON.parse(buf || '{}'); next(); });
  } else {
    next();
  }req.on('data', chunk => { buf += chunk; });
    req.on('end', () => { req.rawBody = buf; next(); });
  } else {
    next();
  }
});

app.use(express.json());

// CORS for FireWatch HTML running locally
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── Serve FireWatch HTML ────────────────────────────────────────────────────
app.use(express.static(path.dirname(__filename)));

// ── HMAC-SHA256 signature verification per spec §7.2 ───────────────────────
function verifySignature(req) {
  if (!FN_SECRET) return true; // skip if no secret configured

  const sigHeader   = req.headers['x-fn-signature'] || '';
  const timestamp   = req.headers['x-fn-timestamp']  || '';
  const rawBody     = req.rawBody || '';

  if (!sigHeader || !timestamp) return false;

  // Reject requests outside 5-minute window (replay attack mitigation)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > TOLERANCE_S) {
    console.warn('FN webhook rejected: timestamp out of tolerance');
    return false;
  }

  // Construct signed string: {timestamp}.{raw_body}
  const signed = `${timestamp}.${rawBody}`;

  // HMAC-SHA256 with webhook secret as key
  const expected = 'v1=' + crypto
    .createHmac('sha256', FN_SECRET)
    .update(signed, 'utf8')
    .digest('hex');

  // Constant-time comparison per spec security recommendations
  const sigBuf      = Buffer.from(sigHeader);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// ── FireNotification Webhook Endpoint ───────────────────────────────────────
app.post('/fn-webhook', (req, res) => {
  res.status(200).json({ received: true });

  if (!verifySignature(req)) {
    console.warn('FN webhook: invalid signature — ignored');
    return;
  }

  let envelope;
  try {
    envelope = typeof req.rawBody === 'string' ? JSON.parse(req.rawBody) : req.body;
    if (!envelope || typeof envelope !== 'object') {
      console.warn('FN webhook: empty or invalid body');
      return;
    }
  } catch (e) {
    console.warn('FN webhook: JSON parse error', e.message);
    return;
  }

  processEnvelope(envelope);
});

// ── Process FN Envelope per spec §2-§6 ─────────────────────────────────────
function processEnvelope(envelope) {
  const { id, eventType, occurredAt, webhookId, businessId, data } = envelope;

  if (!id || !eventType || !data) {
    console.warn('FN webhook: malformed envelope', id);
    return;
  }

  console.log(`[${new Date().toISOString()}] ${eventType} — incident ${data.incidentId}`);

  const incidentId = data.incidentId;

  // Merge with existing incident record (events may update the same incident)
  const existing = incidents.get(incidentId) || {};
  const updated = {
    ...existing,
    ...data,
    _lastEventType: eventType,
    _lastEventId:   id,
    _lastEventAt:   occurredAt,
    _webhookId:     webhookId,
    _businessId:    businessId,
  };
  incidents.set(incidentId, updated);

  // Broadcast to all connected SSE clients (FireWatch map updates in real time)
  const payload = JSON.stringify({ eventType, incidentId, envelope });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }

  // Log notable events
  switch (eventType) {
    case 'webhook:incident.created':
      console.log(`  NEW: ${data.incidentType} at ${data.address?.line1}, ${data.address?.city} ${data.address?.state}`);
      break;
    case 'webhook:incident.paged':
    case 'webhook:incident.comment.paged':
      console.log(`  PAGED: alarm=${data.alarm} paged=${data.paged}`);
      if (data.contact) console.log(`  CONTACT: ${data.contact}`);
      break;
    case 'webhook:incident.priority.upgraded':
      console.log(`  ESCALATED: alarm level ${data.alarm}`);
      break;
    case 'webhook:incident.closed':
      console.log(`  CLOSED at ${data.closedAt}`);
      break;
    case 'webhook:incident.title.paged':
      const t = (data.titles || [])[0];
      if (t) {
        console.log(`  TITLE: owner=${t.ownerInfo?.name} value=$${t.assessedValues?.marketValue}`);
      }
      break;
  }
}

// ── REST: Get all incidents (for FireWatch HTML initial load) ────────────────
app.get('/fn-incidents', (req, res) => {
  const all = Array.from(incidents.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 200);
  res.json({ incidents: all, count: all.length });
});

// ── REST: Get single incident ────────────────────────────────────────────────
app.get('/fn-incidents/:id', (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Not found' });
  res.json(inc);
});

// ── SSE: Real-time stream to FireWatch HTML ──────────────────────────────────
app.get('/fn-stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`SSE client connected (${sseClients.size} total)`);

  // Send current incidents on connect
  for (const [incidentId, data] of incidents) {
    res.write(`data: ${JSON.stringify({ eventType:'snapshot', incidentId, envelope:{ data } })}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`SSE client disconnected (${sseClients.size} remaining)`);
  });
});

// ── Inject test payloads (for development) ───────────────────────────────────
app.post('/fn-test/:eventType', (req, res) => {
  const validTypes = [
    'webhook:incident.created', 'webhook:incident.updated',
    'webhook:incident.closed',  'webhook:incident.paged',
    'webhook:incident.priority.upgraded', 'webhook:incident.comment.paged',
    'webhook:incident.title.paged',       'webhook:incident.contact.paged',
    'webhook:incident.callType.changed',  'webhook:incident.note_added',
  ];
  const eventType = req.params.eventType.replace('_', ':').replace('_', '.');
  if (!validTypes.some(t => t.includes(req.params.eventType))) {
    return res.status(400).json({ error: 'Unknown event type' });
  }
  const envelope = {
    id: 'evt_test_' + Date.now(),
    eventType,
    occurredAt: new Date().toISOString(),
    webhookId: 'test-webhook-id',
    businessId: 'test-business',
    data: req.body,
  };
  processEnvelope(envelope);
  res.json({ injected: true, eventType });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    incidents: incidents.size,
    sseClients: sseClients.size,
    secretConfigured: !!FN_SECRET,
    uptime: Math.round(process.uptime()) + 's',
  });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         FireNotification Webhook Server v1.02            ║
╠══════════════════════════════════════════════════════════╣
║  Webhook endpoint:  POST http://localhost:${PORT}/fn-webhook   ║
║  Incident REST:     GET  http://localhost:${PORT}/fn-incidents  ║
║  Live SSE stream:   GET  http://localhost:${PORT}/fn-stream     ║
║  Health check:      GET  http://localhost:${PORT}/health        ║
║  Test inject:       POST http://localhost:${PORT}/fn-test/:type ║
╠══════════════════════════════════════════════════════════╣
║  Signature verification: ${FN_SECRET ? 'ENABLED  ✓' : 'DISABLED (set FN_SECRET)'}             ║
╚══════════════════════════════════════════════════════════╝

Register this public URL in your FireNotification dashboard:
  https://your-domain.com/fn-webhook

To expose locally for testing (using ngrok):
  ngrok http ${PORT}
  → copy the https URL into FireNotification dashboard
  `);
});
