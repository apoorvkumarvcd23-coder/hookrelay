import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError, Queue, parseEvent, runOnce, sign, verify } from '../src/core.ts';

const event = { eventId: 'e1', ticketId: 'TKT-42', status: 'resolved' };
const secret = 'test-only-signing-fixture';
const now = 1793090000000;
function fixture() { return new Queue(':memory:'); }

test('signature authenticates raw bytes, rejects mutation and stale delivery', () => {
  const raw = JSON.stringify(event), stamp = String(now / 1000);
  verify(secret, stamp, sign(secret, stamp, raw), raw, now);
  assert.throws(() => verify(secret, stamp, sign(secret, stamp, raw), raw + ' ', now), InputError);
  assert.throws(() => verify(secret, stamp, sign(secret, stamp, raw), raw, now + 301000), InputError);
  assert.throws(() => verify(secret, stamp, 'bad', raw, now), InputError);
});
test('JSON and flat XML map to the same internal contract', () => {
  assert.deepEqual(parseEvent(JSON.stringify(event), 'application/json'), event);
  assert.deepEqual(parseEvent('<event><eventId>e1</eventId><ticketId>TKT-42</ticketId><status>resolved</status></event>', 'application/xml'), event);
  for (const xml of ['<!DOCTYPE event><event/>', '<event><status>resolved</status></event>', '<event><eventId>a</eventId><eventId>b</eventId></event>']) assert.throws(() => parseEvent(xml, 'application/xml'));
  assert.throws(() => parseEvent(JSON.stringify({ ...event, secret: 'x' }), 'application/json'));
  assert.throws(() => parseEvent(JSON.stringify({ ...event, status: 'unknown' }), 'application/json'));
});
test('accepted duplicates are atomic; conflicting reuse cannot replace payload', () => {
  const q = fixture(); assert.equal(q.accept(event, now), true); assert.equal(q.accept(event, now), false);
  assert.throws(() => q.accept({ ...event, status: 'open' }, now), InputError);
  assert.equal(q.list().length, 1); q.close();
});
test('failed delivery retries later, then succeeds with stable idempotency key', async () => {
  const q = fixture(); q.accept(event, now);
  const failure: typeof fetch = async () => new Response('', { status: 503 });
  assert.equal((await runOnce(q, 'http://fixture', secret, failure, now)).state, 'queued');
  assert.equal((await runOnce(q, 'http://fixture', secret, failure, now + 10)).worked, false);
  const ok: typeof fetch = async (_url, options) => {
    assert.equal((options!.headers as Record<string,string>)['Idempotency-Key'], 'e1');
    return new Response('ok');
  };
  assert.equal((await runOnce(q, 'http://fixture', secret, ok, now + 1000)).state, 'delivered');
  assert.equal(q.list()[0].attempts, 2); q.close();
});
test('401 dead letters immediately; replay preserves event identity', async () => {
  const q = fixture(); q.accept(event, now);
  assert.equal((await runOnce(q, 'http://fixture', secret, async () => new Response('', { status: 401 }), now)).state, 'dead');
  q.replay('e1'); assert.equal(q.list()[0].state, 'queued'); assert.throws(() => q.replay('e1')); q.close();
});
test('retry-after is honored and retries stop after four attempts', async () => {
  const q = fixture(); q.accept(event, now);
  const throttle: typeof fetch = async () => new Response('', { status: 429, headers: { 'Retry-After': '10' } });
  await runOnce(q, 'http://fixture', secret, throttle, now);
  assert.equal(q.list()[0].next_at, now + 10000);
  for (let i = 1; i < 4; i++) await runOnce(q, 'http://fixture', secret, throttle, now + i * 10000);
  assert.equal(q.list()[0].state, 'dead'); assert.equal(q.list()[0].attempts, 4); q.close();
});
test('crashed workers are reclaimed and stale owners cannot overwrite results', () => {
  const q = fixture(); q.accept(event, now);
  const old = q.claim(now)!; assert.equal(q.claim(now + 1), null);
  const reclaimed = q.claim(now + 10000)!;
  assert.notEqual(reclaimed.lease, old.lease);
  assert.equal(q.finish('e1', String(old.lease), 'delivered', now, null), false);
  assert.equal(q.finish('e1', String(reclaimed.lease), 'delivered', now, null), true); q.close();
});
test('network exceptions retry and never persist exception bodies', async () => {
  const q = fixture(); q.accept(event, now);
  await runOnce(q, 'http://fixture', secret, async () => { throw Error('secret-password'); }, now);
  assert.equal(q.list()[0].state, 'queued'); assert.ok(!JSON.stringify(q.list()).includes('secret-password')); q.close();
});
test('queued jobs survive database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookrelay-'));
  try { const path = join(dir, 'queue.db'); const a = new Queue(path); a.accept(event, now); a.close();
    const b = new Queue(path); assert.equal(b.claim(now)?.id, 'e1'); b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
