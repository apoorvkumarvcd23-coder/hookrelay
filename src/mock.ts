import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { verify } from './core.ts';
import { readFileSync } from 'node:fs';
// Same generated local signing secret; no real provider account.
const env = Object.fromEntries(readFileSync('.env','utf8').trim().split(/\r?\n/).map(line => line.split('=')));
const db = new DatabaseSync('mock-provider.db');
db.exec('CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
let failures = Number(process.env.MOCK_FAILURES || 0);
createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/events') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('Oversize'); }
    verify(env.HOOKRELAY_SIGNING_SECRET, String(req.headers['x-timestamp'] || ''), String(req.headers['x-signature'] || ''), raw);
    const event = JSON.parse(raw);
    if (req.headers['idempotency-key'] !== event.eventId) throw new Error('Bad key');
    if (failures-- > 0) { res.writeHead(503); res.end('Temporary fixture failure'); return; }
    const old = db.prepare('SELECT payload FROM inbox WHERE id=?').get(event.eventId);
    if (old && old.payload !== raw) { res.writeHead(409); res.end(); return; }
    db.prepare('INSERT INTO inbox VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(event.eventId, raw);
    res.writeHead(200); res.end('Accepted');
  } catch { res.writeHead(400); res.end('Rejected'); }
}).listen(8102, '127.0.0.1', () => console.log('Mock provider http://127.0.0.1:8102/events'));
