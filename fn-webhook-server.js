const express = require('express');
const crypto  = require('crypto');
const app     = express();

const FN_SECRET   = process.env.FN_SECRET || '';
const PORT        = process.env.PORT || 3001;
const TOLERANCE_S = 300;
const incidents   = new Map();
const sseClients  = new Set();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
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
  processEnvelope(envelope);
});

function processEnvelope(envelope) {
  const { id, eventType, occurredAt, webhookId, businessId, data } = envelope;
  if (!data) return;
  const incidentId = data.incidentId || 'unknown';
  console.log(`[${new Date().toISOString()}] ${eventType} — incident ${incidentId}`);
  const existing = incidents.get(incidentId) || {};
  incidents.set(incidentId, { ...existing, ...data, _lastEventType:eventType, _lastEventId:id, _lastEventAt:occurredAt, _webhookId:webhookId, _businessId:businessId });
  const payload = JSON.stringify({ eventType, incidentId, envelope });
  for (const c of sseClients) c.write(`data: ${payload}\n\n`);
  const a = data.address || {};
  if (eventType === 'webhook:incident.created') console.log(`  NEW: ${data.incidentType} at ${a.line1}, ${a.city} ${a.state}`);
  if (eventType === 'webhook:incident.closed')  console.log(`  CLOSED at ${data.closedAt}`);
  if (data.contact) console.log(`  CONTACT: ${data.contact}`);
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
  processEnvelope({ id:'test_'+Date.now(), eventType:req.params.type, occurredAt:new Date().toISOString(), data:body });
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', incidents:incidents.size, secretConfigured:!!FN_SECRET, uptime:Math.round(process.uptime())+'s' });
});

app.listen(PORT, () => console.log(`FireWatch server running on port ${PORT} — secret: ${FN_SECRET?'SET':'NOT SET'}`));
