import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { InputError, Queue, parseEvent, runOnce, sign, verify } from './core.ts';

const secret = process.env.HOOKRELAY_SIGNING_SECRET;
const key = process.env.HOOKRELAY_API_KEY;
if (!secret || !key || secret === key) throw new Error('Run npm run keys first; distinct API/signing secrets required.');
const queue = new Queue(process.env.HOOKRELAY_DB || 'hookrelay.db');
const port = Number(process.env.PORT || 8100);
const target = process.env.HOOKRELAY_TARGET || 'http://127.0.0.1:8102/events';
const page = readFileSync(new URL('../index.html', import.meta.url));
function authorized(value: string) {
  if (!value.startsWith('Bearer ')) return false;
  const candidate = value.replace(/^Bearer /, '');
  return Buffer.byteLength(candidate) === Buffer.byteLength(key!) && timingSafeEqual(Buffer.from(candidate), Buffer.from(key!));
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
    if (req.method === 'GET' && path === '/health') { send(200, { status: 'ok' }); return; }
    if (path !== '/webhooks/demo' && !authorized(String(req.headers.authorization || ''))) throw new InputError(401, 'Invalid credentials');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new InputError(413, 'Body too large'); chunks.push(chunk); }
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'POST' && path === '/webhooks/demo') {
      verify(secret!, String(req.headers['x-timestamp'] || ''), String(req.headers['x-signature'] || ''), body);
      const event = parseEvent(body, String(req.headers['content-type'] || ''));
      const created = queue.accept(event); send(created ? 201 : 200, { accepted: true, duplicate: !created, eventId: event.eventId });
    } else if (req.method === 'GET' && path === '/jobs') send(200, queue.list());
    else if (req.method === 'POST' && path === '/worker') send(200, await runOnce(queue, target, secret!));
    else if (req.method === 'POST' && path.startsWith('/replay/')) { queue.replay(decodeURIComponent(path.slice(8))); send(200, { queued: true }); }
    else if (req.method === 'POST' && path === '/fixtures') {
      let config: any; try { config = JSON.parse(body); } catch { throw new InputError(400, 'Invalid JSON'); }
      const eventId = 'demo-' + randomUUID().slice(0, 8);
      const xml = config.format === 'xml';
      const raw = xml ? `<event><eventId>${eventId}</eventId><ticketId>TKT-42</ticketId><status>resolved</status></event>` : JSON.stringify({ eventId, ticketId: 'TKT-42', status: 'resolved' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/demo`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: {
        'Content-Type': xml ? 'application/xml' : 'application/json', 'X-Timestamp': timestamp, 'X-Signature': sign(secret!, timestamp, raw) }, body: raw });
      send(response.status, await response.json());
    } else throw new InputError(404, 'Unknown endpoint');
  } catch (e) { send(e instanceof InputError ? e.status : 500, { error: e instanceof InputError ? e.message : 'Internal error' }); }
});
server.requestTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.log(`HookRelay http://127.0.0.1:${port} (local-only)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { queue.close(); process.exit(0); }));
