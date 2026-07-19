const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const app     = express();

const FN_SECRET   = process.env.FN_SECRET   || '';
const PORT        = process.env.PORT         || 3001;
const TOLERANCE_S = 300;

const incidents = new Map();
const sseClients = new Set();

app.use('/fn-webhook', (req, res, next) => {
  let buf = Buffer.alloc(0);
  req.on('data', chunk => { buf = Buffer.concat([buf, chunk]); });
  req.on('end', () => {
    req.rawBody = buf.toString('utf8');
    try { req.body = JSON.parse(req.rawBody); } catch(e) { req.body = {}; }
    next();
  });
});

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(path.dirname(__filename)));

function verifySignature(req) {
  if (!FN_SECRET) return true;
  const sigHeader = req.headers['x-fn-signature'] || '';
  const timestamp  = req.headers['x-fn-timestamp']  || '';
  if (!sigHeader || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > TOLERANCE_S) return false;
  const signed   = `${timestamp}.${req.rawBody}`;
  const expected = 'v1=' + crypto.createHmac('sha256', FN_SECRET).update(signed, 'utf8').digest('hex');
  const sigBuf      = Buffer.from(sigHeader);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

app.post('/fn-webhook', (req, res) => {
  res.status(200).json({ received: true });
  if (!verifySignature(req)) { console.warn('FN webhook: invalid signature'); return; }
  const envelope = req.body;
  if (!envelope || !envelope.data) { console.warn('FN webhook: empty body'); return; }
  processEnvelope(envelope);
});

function processEnvelope(envelope) {
  const { id, eventType, occurredAt, webhookId, businessId, data } = envelope;
  if (!data) return;
  const incidentId = data.incidentId;
  console.log(`[${new Date().toISOString()}] ${eventType} — incident ${incidentId}`);
  const existing = incidents.get(incidentId) || {};
  const updated = { ...existing, ...data, _lastEventType:eventType, _lastEventId:id, _lastEventAt:occurredAt, _webhookId:webhookId, _businessId:businessId };
  incidents.set(incidentId, updated);
  const payload = JSON.stringify({ eventType, incidentId, envelope });
  for (const client of sseClients) { client.write(`data: ${payload}\n\n`); }
  const addr = data.address || {};
  switch (eventType) {
    case 'webhook:incident.created': console.log(`  NEW: ${data.incidentType} at ${addr.line1}, ${addr.city} ${addr.state}`); break;
    case 'webhook:incident.closed':  console.log(`  CLOSED at ${data.closedAt}`); break;
    case 'webhook:incident.paged':
    case 'webhook:incident.comment.paged': console.log(`  PAGED: alarm=${data.alarm}`); if(data.contact) console.log(`  CONTACT: ${data.contact}`); break;
  }
}

app.get('/fn-incidents', (req, res) => {
  const all = Array.from(incidents.values()).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,200);
  res.json({ incidents: all, count: all.length });
});

app.get('/fn-stream', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  for (const [incidentId, data] of incidents) {
    res.write(`data: ${JSON.stringify({ eventType:'snapshot', incidentId, envelope:{ data } })}\n\n`);
  }
  req.on('close', () => sseClients.delete(res));
});

app.post('/fn-test/:eventType', (req, res) => {
  const envelope = { id:'evt_test_'+Date.now(), eventType:req.params.eventType, occurredAt:new Date().toISOString(), webhookId:'test', businessId:'test', data:req.body };
  processEnvelope(envelope);
  res.json({ injected:true });
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', incidents:incidents.size, sseClients:sseClients.size, secretConfigured:!!FN_SECRET, uptime:Math.round(process.uptime())+'s' });
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
╠══════════════════════════════════════════════════════════╣
║  Signature verification: ${FN_SECRET ? 'ENABLED  ✓' : 'DISABLED'}             ║
╚══════════════════════════════════════════════════════════╝`);
});
