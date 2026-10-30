import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { emptyLedger, foldEvents } from '../lib/cost.js';
import { createSessionCache, encodeSnapshot, decodeSnapshot } from '../lib/session-cache.js';
const sample = (seq = 1) => ({ seq, time: 1793343783806, type: 'assistant/message', data: {
  turn: 1, message: { content: [{ text: 'PRIVATE PROMPT' }], source: { provider: 'openai', model: 'gpt-6.1-sol', replayState: 'PRIVATE KEY' } },
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0 },
} });
const ledger = () => foldEvents(emptyLedger(), [sample()]);
async function fixture(fn) {
  const home = await fs.mkdtemp(join(tmpdir(), 'dsh-cost-cache-'));
  try { await fn(home); } finally {
    assert.equal(resolve(home), home); assert.ok(home.startsWith(join(tmpdir(), 'dsh-cost-cache-')));
    await fs.rm(home, { recursive: true, force: true });
  }
}
test('allowlisted snapshots roundtrip counts without prompts, credentials or extra keys', () => {
  const l = ledger(); l.records[0].content = 'PRIVATE BODY'; l.route = { provider: 'openai', model: 'gpt-6.1-sol', key: 'SECRET' };
  const encoded = encodeSnapshot('session-cache', l, 0, 1000);
  assert.doesNotMatch(JSON.stringify(encoded), /PRIVATE|SECRET|content|replayState/);
  encoded.ledger.records[0].replayState = 'SECRET';
  const decoded = decodeSnapshot(encoded, 'session-cache');
  assert.deepEqual(decoded.ledger.missingUsageByTurn, new Map());
  assert.doesNotMatch(JSON.stringify(decoded), /SECRET|replayState/);
  assert.equal(decoded.ledger.records[0].inputTokens, 100);
  assert.equal(decodeSnapshot(encoded, 'session-other'), null);
});
test('corrupt schema, invalid counters, duplicate turns and malformed records fail closed', () => {
  const good = encodeSnapshot('session-cache', ledger(), 0, 1000);
  for (const mutate of [x => { x.version = 99; }, x => { x.ledger.lastSeq = -2; },
    x => { x.ledger.records[0].inputTokens = -1; }, x => { x.ledger.records[0].outputTokens = '10'; },
    x => { x.ledger.records[0].time = 'invalid'; }, x => { x.ledger.records[0].time = 8640000000000000; },
    x => { x.ledger.records[0].inputTokens = 1e308; }, x => { x.ledger.missingUsageByTurn = [[1, 1]]; },
    x => { x.ledger.missingUsageByTurn = [[1, 0], [1, 0]]; }, x => { x.inheritedEventCount = -1; }]) {
    const bad = structuredClone(good); mutate(bad); assert.equal(decodeSnapshot(bad, 'session-cache'), null);
  }
});
test('atomic local writes survive restart, use private permissions and isolate sessions', async () => fixture(async home => {
  const cache = createSessionCache(home);
  assert.equal(await cache.read('session-cache'), null);
  assert.equal(await cache.write('session-cache', ledger(), 0, 1000), true);
  await cache.drain();
  const restarted = createSessionCache(home), restored = await restarted.read('session-cache');
  assert.equal(restored.updatedAt, 1000); assert.equal(restored.ledger.records.length, 1);
  assert.equal((await fs.stat(cache.pathFor('session-cache'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(home, 'cache', 'dsh-conversation-cost', 'sessions'))).mode & 0o777, 0o700);
  assert.equal(await restarted.read('session-other'), null);
  assert.throws(() => cache.pathFor('../escape'));
  assert.throws(() => cache.pathFor(''));
  assert.throws(() => cache.pathFor('x'.repeat(201)));
}));
test('concurrent saves coalesce and the newest ledger wins, even during a delayed write', async () => fixture(async home => {
  let release, started;
  const firstWrite = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const cache = createSessionCache(home, { io: { ...fs, async writeFile(...args) {
    if (++calls === 1) { started(); await gate; } return fs.writeFile(...args);
  } } });
  const one = ledger(), save = cache.write('session-cache', one, 0, 1000);
  await firstWrite;
  foldEvents(one, [sample(2)]);
  const second = cache.write('session-cache', one, 0, 2000);
  release(); await Promise.all([save, second]); await cache.drain();
  const stored = await cache.read('session-cache');
  assert.equal(stored.ledger.records.length, 2); assert.equal(stored.updatedAt, 2000);
}));
test('independent writers serialize, reject stale writes and cannot resurrect deletion tombstones', async () => fixture(async home => {
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let blocked = false;
  const a = createSessionCache(home, { io: { ...fs, async rename(...args) {
    if (!blocked) { blocked = true; started(); await gate; } return fs.rename(...args);
  } } });
  const b = createSessionCache(home);
  const old = ledger(), newer = ledger(); foldEvents(newer, [sample(2)]);
  const oldWrite = a.write('session-cache', old, 0, 1000); await begun;
  const newWrite = b.write('session-cache', newer, 0, 2000);
  release(); await Promise.all([oldWrite, newWrite]);
  assert.equal((await b.read('session-cache')).ledger.records.length, 2);
  await a.write('session-cache', old, 0, 1000);
  assert.equal((await b.read('session-cache')).updatedAt, 2000);
  await b.remove('session-cache'); assert.equal(await b.read('session-cache'), null);
  await a.write('session-cache', old, 0, 1000); assert.equal(await b.read('session-cache'), null);
  const tombstone = JSON.parse(await fs.readFile(b.pathFor('session-cache'), 'utf8'));
  assert.equal(tombstone.deleted, true); assert.equal(tombstone.ledger, undefined);
}));
test('deletion waits for an in-flight writer and leaves no old usage behind', async () => fixture(async home => {
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const a = createSessionCache(home, { io: { ...fs, async rename(...args) { started(); await gate; return fs.rename(...args); } } });
  const b = createSessionCache(home);
  const writing = a.write('session-cache', ledger(), 0, 1000); await begun;
  const deletion = b.remove('session-cache'); release(); await Promise.all([writing, deletion]);
  assert.equal(await a.read('session-cache'), null);
  assert.doesNotMatch(await fs.readFile(a.pathFor('session-cache'), 'utf8'), /inputTokens|model|records/);
}));
test('invalid metadata cannot block canonical self-healing or impersonate a deletion', async () => fixture(async home => {
  const cache = createSessionCache(home);
  await cache.write('session-cache', ledger(), 0, 1000);
  await fs.writeFile(cache.pathFor('session-cache'), JSON.stringify({ version: 1, sessionId: 'session-cache', updatedAt: 1e100, ledger: { lastSeq: 9999 } }));
  assert.equal(await cache.read('session-cache'), null);
  await cache.write('session-cache', ledger(), 0, 2000);
  assert.equal((await cache.read('session-cache')).updatedAt, 2000);
  await fs.writeFile(cache.pathFor('session-cache'), JSON.stringify({ version: 1, sessionId: 'session-cache', deleted: true, deletedAt: 1e100 }));
  assert.equal(await cache.isDeleted('session-cache'), false);
  await cache.write('session-cache', ledger(), 0, 3000);
  assert.equal((await cache.read('session-cache')).updatedAt, 3000);
}));
test('an abandoned lock is not stolen and failure is bounded without corrupting the last snapshot', async () => fixture(async home => {
  const reports = [], cache = createSessionCache(home, { report: code => reports.push(code) });
  await cache.write('session-cache', ledger(), 0, 1000);
  const lock = cache.pathFor('session-cache') + '.lock';
  await fs.writeFile(lock, '{"pid":0}');
  await fs.utimes(lock, new Date(0), new Date(0));
  const started = performance.now();
  assert.equal(await cache.write('session-cache', ledger(), 0, 2000), false);
  assert.ok(performance.now() - started < 4000);
  assert.equal((await cache.read('session-cache')).updatedAt, 1000);
  assert.ok(reports.includes('cache-write-failed'));
  assert.equal(await fs.readFile(lock, 'utf8'), '{"pid":0}');
}));
test('preexisting permissive directories are tightened during writes', async () => fixture(async home => {
  const root = join(home, 'cache', 'dsh-conversation-cost', 'sessions');
  await fs.mkdir(root, { recursive: true }); await fs.chmod(root, 0o777);
  const cache = createSessionCache(home); await cache.write('session-cache', ledger(), 0, 1000);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
}));
test('corrupt/oversize cache is ignored, and write failure preserves the last valid snapshot', async () => fixture(async home => {
  const reports = [], cache = createSessionCache(home, { report: code => reports.push(code) });
  await cache.write('session-cache', ledger(), 0, 1000);
  const broken = createSessionCache(home, { io: { ...fs, writeFile: async () => { throw Error('PRIVATE ERROR'); } }, report: code => reports.push(code) });
  assert.equal(await broken.write('session-cache', ledger(), 0, 2000), false);
  assert.equal((await cache.read('session-cache')).updatedAt, 1000);
  assert.ok(reports.includes('cache-write-failed')); assert.doesNotMatch(reports.join(' '), /PRIVATE/);
  assert.deepEqual((await fs.readdir(join(home, 'cache', 'dsh-conversation-cost', 'sessions'))).filter(x => x.endsWith('.tmp')), []);
  await fs.writeFile(cache.pathFor('session-cache'), '{bad');
  assert.equal(await cache.read('session-cache'), null);
  const huge = createSessionCache(home, { io: { ...fs, stat: async () => ({ size: 17 * 1024 * 1024 }), readFile: async () => { assert.fail('must check size before reading'); } } });
  assert.equal(await huge.read('session-cache'), null);
}));
