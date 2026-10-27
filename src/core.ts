import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type Event = { eventId: string; ticketId: string; status: string };
export class InputError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}
export function verify(secret: string, timestamp: string, signature: string, body: string, now = Date.now()): void {
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) throw new InputError(401, 'Invalid or expired signature');
  if (!timingSafeEqual(Buffer.from(sign(secret, timestamp, body), 'hex'), Buffer.from(signature, 'hex'))) throw new InputError(401, 'Invalid signature');
}
export function parseEvent(body: string, contentType: string): Event {
  let value: any;
  if (contentType.split(';')[0] === 'application/json') {
    try { value = JSON.parse(body); } catch { throw new InputError(400, 'Invalid JSON'); }
  } else if (contentType.split(';')[0] === 'application/xml') {
    // Deliberately small, flat XML contract: no attributes, DTDs, entities or nesting.
    const root = /^\s*<event>([\s\S]*)<\/event>\s*$/.exec(body);
    if (!root || /<!|<\?|&/.test(body)) throw new InputError(400, 'Unsupported XML syntax');
    value = {};
    let rest = root[1];
    for (const match of root[1].matchAll(/<(eventId|ticketId|status)>([^<>]*)<\/\1>/g)) {
      if (Object.hasOwn(value, match[1])) throw new InputError(400, 'Duplicate XML field');
      value[match[1]] = match[2]; rest = rest.replace(match[0], '');
    }
    if (rest.trim()) throw new InputError(400, 'Unknown XML field');
  } else throw new InputError(415, 'Use application/json or application/xml');
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join() !== 'eventId,status,ticketId') throw new InputError(400, 'Expected eventId, ticketId and status');
  for (const key of ['eventId', 'ticketId']) if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value[key])) throw new InputError(400, 'Invalid event identifier');
  if (!['open', 'in_progress', 'resolved'].includes(value.status)) throw new InputError(400, 'Invalid status');
  return { eventId: value.eventId, ticketId: value.ticketId, status: value.status };
}

export class Queue {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_at REAL NOT NULL, lease TEXT, lease_until REAL, last_error TEXT);`);
  }
  accept(event: Event, now = Date.now()): boolean {
    const payload = JSON.stringify(event);
    const digest = createHash('sha256').update(payload).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT digest FROM events WHERE id=?').get(event.eventId);
      if (old && old.digest !== digest) throw new InputError(409, 'Event ID already has different content');
      if (!old) {
        this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(event.eventId, digest, payload);
        this.db.prepare('INSERT INTO jobs(id,state,next_at) VALUES (?, ?, ?)').run(event.eventId, 'queued', now);
      }
      this.db.exec('COMMIT'); return !old;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  list() { return this.db.prepare('SELECT id,state,attempts,next_at,last_error FROM jobs ORDER BY next_at DESC LIMIT 100').all(); }
  replay(id: string) {
    const row = this.db.prepare('UPDATE jobs SET state=\'queued\',attempts=0,next_at=?,last_error=NULL WHERE id=? AND state=\'dead\' RETURNING id').get(Date.now(), id);
    if (!row) throw new InputError(409, 'Only dead-letter jobs can be replayed');
  }
  claim(now = Date.now()) {
    const lease = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`UPDATE jobs SET state='running',attempts=attempts+1,lease=?,lease_until=?
        WHERE id=(SELECT id FROM jobs WHERE (state='queued' AND next_at<=?) OR (state='running' AND lease_until<=?) ORDER BY next_at LIMIT 1)
        RETURNING *`).get(lease, now + 10000, now, now);
      this.db.exec('COMMIT');
      return row ? { ...row, payload: this.db.prepare('SELECT payload FROM events WHERE id=?').get(row.id)?.payload } : null;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(id: string, lease: string, state: string, next: number, error: string | null): boolean {
    return this.db.prepare('UPDATE jobs SET state=?,next_at=?,last_error=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND state=\'running\'').run(state, next, error, id, lease).changes === 1;
  }
  close() { this.db.close(); }
}

export async function runOnce(queue: Queue, target: string, secret: string, transport: typeof fetch = fetch, now = Date.now()) {
  const job = queue.claim(now);
  if (!job) return { worked: false };
  const timestamp = String(Math.floor(now / 1000));
  let status = 0, delay = Math.min(60000, 1000 * 2 ** (Number(job.attempts) - 1));
  try {
    const response = await transport(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { 'Content-Type': 'application/json', 'X-Timestamp': timestamp,
        'X-Signature': sign(secret, timestamp, String(job.payload)), 'Idempotency-Key': String(job.id) }, body: String(job.payload) });
    status = response.status;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^\d+$/.test(retryAfter)) delay = Math.max(delay, Math.min(60000, Number(retryAfter) * 1000));
    await response.body?.cancel();
  } catch { /* A bounded network failure is retryable; response bodies/secrets are not logged. */ }
  const success = status >= 200 && status < 300;
  const retry = !success && (status === 0 || status === 429 || status >= 500) && Number(job.attempts) < 4;
  const state = success ? 'delivered' : retry ? 'queued' : 'dead';
  const committed = queue.finish(String(job.id), String(job.lease), state, now + delay, success ? null : status ? 'HTTP ' + status : 'Network error or timeout');
  return { worked: true, id: job.id, state, committed };
}
