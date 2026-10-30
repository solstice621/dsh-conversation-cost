import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createSessionCache } from '../lib/session-cache.js';
import { emptyLedger, foldEvents } from '../lib/cost.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
const event = (seq, amount = 10) => ({ seq, time: Date.parse('2026-10-28T02:00:00Z'), type: 'assistant/message',
  data: { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: amount, outputTokens: 2 } } });
test('missing host APIs fail before price initialization or route registration', () => {
  for (const api of ['sessionQuery.readSession', 'connection.fetch.register']) {
    const ctx = {
      get() { throw Error('Host state must not be read before capability checks'); },
      on() {}, effect() {},
      sessionQuery: { readSession() {} },
      connection: { fetch: { register() { throw Error('No route may be registered'); } } },
    };
    if (api === 'sessionQuery.readSession') ctx.sessionQuery.readSession = undefined;
    else ctx.connection.fetch.register = 'unavailable';
    assert.throws(() => apply(ctx), error => error.message.includes('dsh-conversation-cost') && error.message.includes(api));
  }
});
async function host(readSession, options = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-cost-host-'));
  const routes = new Map(), listeners = new Map(), disposers = [];
  // These tests use no network or production home.
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { if (options.fetcher) return options.fetcher(...args); throw Error('offline test'); };
  const ctx = {
    get: name => name === 'profileContext' ? { home } : undefined,
    sessionQuery: { readSession },
    connection: { fetch: { register(route) {
      assert.equal(route.requestBody, 'buffered', 'Harness requires an explicit request body mode, including for GET');
      routes.set(route.path, route); return () => routes.delete(route.path);
    } } },
    on(name, fn) { listeners.set(name, fn); },
    effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); },
  };
  apply(ctx);
  return {
    emit(id, value) { listeners.get('session/event')({ header: { id } }, value); },
    lifecycle(name, id) { return listeners.get(name)?.({ header: { id } }); },
    emitLive(id, value, events, inheritedEventCount = 0) { return listeners.get('session/event')({ header: { id }, inheritedEventCount, snapshotEvents: () => events }, value); },
    home,
    setFetcher(fetcher) { options.fetcher = fetcher; },
    async get(id, query = '') { return routes.get('/api/conversation-cost').fetch(new Request('http://localhost/api/conversation-cost?sessionId=' + encodeURIComponent(id) + query)); },
    async refresh() { return routes.get('/api/conversation-cost/prices/refresh').fetch(new Request('http://localhost/api/conversation-cost/prices/refresh', { method: 'POST' })); },
    async waitFor(id, predicate, cachedOnly = false) {
      const deadline = performance.now() + 2000;
      while (true) {
        const data = await (await this.get(id, cachedOnly ? '&cached=1' : '')).json();
        if (predicate(data)) return data;
        assert.ok(performance.now() < deadline, 'Timed out waiting for background validation');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
      // Allow an in-progress initialization/atomic cache write to settle before cleanup.
      await new Promise(resolve => setTimeout(resolve, 50));
      globalThis.fetch = original;
      if (!options.home) await rm(home, { recursive: true, force: true });
    },
  };
}
test('cold-load/live-event race deduplicates and cached reads avoid replaying the log', async () => {
  let resolve, reads = 0;
  const loaded = new Promise(r => { resolve = r; });
  const h = await host(async () => { reads++; return loaded; });
  try {
    const pending = h.get('session-test');
    h.emit('session-test', event(2));
    resolve({ inheritedEventCount: 0, events: [event(1), event(2)] });
    assert.equal((await (await pending).json()).calls, 2);
    h.emit('session-test', event(2)); h.emit('session-test', event(3));
    assert.equal((await (await h.get('session-test')).json()).calls, 3);
    assert.equal(reads, 1);
  } finally { await h.dispose(); }
});
test('fork inheritance is excluded and session errors retry without publishing a partial total', async () => {
  let reads = 0;
  const h = await host(async () => {
    reads++; if (reads === 1) throw Error('temporary read error');
    return { inheritedEventCount: 2, events: [event(0), event(1), event(2)] };
  });
  try {
    assert.equal((await h.get('session-fork')).status, 503);
    const response = await h.get('session-fork');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.calls, 1); assert.equal(data.tokens, 12);
    assert.equal((await h.get('../invalid')).status, 400);
  } finally { await h.dispose(); }
});
test('restart returns a local snapshot immediately while full session validation is delayed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-'));
  let first, second;
  let resolveLoad, reads = 0;
  const loading = new Promise(resolve => { resolveLoad = resolve; });
  try {
    const e = event(1); e.data.turn = 1;
    first = await host(async () => ({ inheritedEventCount: 0, events: [e] }), { home });
    assert.equal((await (await first.get('session-restart')).json()).cache.state, 'fresh');
    await first.dispose(); first = null;
    const path = join(home, 'cache', 'dsh-conversation-cost', 'sessions', 'session-restart.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.ledger.records.length, 1); assert.equal(saved.ledger.missingUsageByTurn.length, 0);
    second = await host(async () => { reads++; return loading; }, { home });
    const cached = await (await second.get('session-restart', '&cached=1')).json();
    assert.equal(cached.calls, 1); assert.equal(cached.cache.state, 'cached'); assert.equal(reads, 0);
    const immediate = await (await second.get('session-restart')).json();
    assert.equal(immediate.calls, 1); assert.equal(immediate.cache.state, 'cached'); assert.equal(reads, 1);
    const extra = event(2, 30); extra.data.turn = 2;
    second.emit('session-restart', extra);
    resolveLoad({ inheritedEventCount: 0, events: [e, extra] });
    await new Promise(resolve => setImmediate(resolve));
    const fresh = await second.waitFor('session-restart', data => data.cache?.state === 'fresh');
    assert.equal(fresh.cache.state, 'fresh'); assert.equal(fresh.calls, 2);
    assert.equal(fresh.turns[1].tokens, 12); assert.equal(fresh.turns[2].tokens, 32);
    assert.equal(reads, 1);
  } finally {
    if (first) await first.dispose(); if (second) await second.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
test('failed background validation preserves a stale amount and retries without double counting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-'));
  let h, reads = 0;
  try {
    await createSessionCache(home).write('session-stale', foldEvents(emptyLedger(), [event(1)]), 0, 1000);
    h = await host(async () => { if (++reads === 1) throw Error('PRIVATE upstream failure'); return { inheritedEventCount: 0, events: [event(1), event(2)] }; }, { home });
    const first = await (await h.get('session-stale')).json(); assert.equal(first.calls, 1);
    await new Promise(resolve => setImmediate(resolve));
    const stale = await (await h.get('session-stale', '&cached=1')).json();
    assert.equal(stale.cache.state, 'stale'); assert.equal(stale.cache.error, 'session-read-failed');
    assert.equal(stale.calls, 1); assert.ok(stale.apiCost > 0);
    assert.doesNotMatch(JSON.stringify(stale), /PRIVATE/);
    await h.get('session-stale'); await new Promise(resolve => setImmediate(resolve));
    const fresh = await h.waitFor('session-stale', data => data.cache?.state === 'fresh');
    assert.equal(fresh.cache.state, 'fresh'); assert.equal(fresh.calls, 2); assert.equal(reads, 2);
  } finally { if (h) await h.dispose(); await rm(home, { recursive: true, force: true }); }
});
test('cache-only miss never reads the session; corrupt cache falls back to a clean replay', async () => {
  let reads = 0;
  const h = await host(async () => { reads++; return { inheritedEventCount: 0, events: [event(1)] }; });
  try {
    assert.equal((await h.get('session-cold', '&cached=1')).status, 404); assert.equal(reads, 0);
    const path = join(h.home, 'cache', 'dsh-conversation-cost', 'sessions');
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'session-corrupt.json'), '{bad');
    assert.equal((await h.get('session-corrupt', '&cached=1')).status, 404); assert.equal(reads, 0);
    assert.equal((await (await h.get('session-corrupt')).json()).calls, 1); assert.equal(reads, 1);
  } finally { await h.dispose(); }
});
test('revalidation corrects fork ownership and truncated histories instead of trusting a cached total', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-'));
  let h;
  try {
    await createSessionCache(home).write('session-repaired', foldEvents(emptyLedger(), [event(0), event(1), event(2), event(3)]), 0, 1000);
    h = await host(async () => ({ inheritedEventCount: 2, events: [event(0), event(1), event(2)] }), { home });
    await h.get('session-repaired'); await new Promise(resolve => setImmediate(resolve));
    let fresh = await h.waitFor('session-repaired', data => data.cache?.state === 'fresh');
    assert.equal(fresh.calls, 1); assert.equal(fresh.cache.throughSeq, 2);
    h.emit('session-repaired', event(0));
    fresh = await (await h.get('session-repaired')).json(); assert.equal(fresh.calls, 1);
  } finally { if (h) await h.dispose(); await rm(home, { recursive: true, force: true }); }
});
test('LRU eviction flushes usage and a later lookup restores it without blocking on session replay', async () => {
  let reads = 0;
  const h = await host(async () => { reads++; return { inheritedEventCount: 0, events: [event(0)] }; });
  try {
    for (let i = 0; i < 25; i++) await h.get('session-' + i);
    assert.equal(reads, 25);
    const cache = createSessionCache(h.home);
    // Eviction schedules a detached atomic write; allow filesystem work, not fixed sleeps.
    for (let i = 0; i < 100 && !(await cache.read('session-0')); i++) await new Promise(resolve => setImmediate(resolve));
    const restored = await (await h.get('session-0', '&cached=1')).json();
    assert.equal(restored.calls, 1); assert.equal(restored.cache.state, 'cached'); assert.equal(reads, 25);
  } finally { await h.dispose(); }
});
test('deleted sessions discard stale snapshots rather than permanently showing old amounts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-')); let h;
  try {
    await createSessionCache(home).write('session-deleted', foldEvents(emptyLedger(), [event(1)]), 0, 1000);
    h = await host(async () => { throw Object.assign(Error('deleted'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); }, { home });
    await h.get('session-deleted');
    // Wait for the known cache file to be removed by the terminal-not-found path.
    for (let i = 0; i < 100 && await createSessionCache(home).read('session-deleted'); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await createSessionCache(home).read('session-deleted'), null);
    assert.equal((await h.get('session-deleted', '&cached=1')).status, 404);
  } finally { if (h) await h.dispose(); await rm(home, { recursive: true, force: true }); }
});
test('prices refresh revalues stored usage rather than freezing the original dollar estimate', async () => {
  const e = event(0); e.data.message.source = { provider: 'openai', model: 'gpt-6.1-sol' };
  const h = await host(async () => ({ inheritedEventCount: 0, events: [e] }));
  try {
    await h.get('session-reprice'); await h.refresh();
    const before = await (await h.get('session-reprice')).json();
    h.setFetcher(async url => new Response(url.includes('models.dev') ? JSON.stringify({ openai: { models: { 'gpt-6.1-sol': { cost: { input: 100, output: 200, cache_read: 1, cache_write: 1 } } } } }) : 'invalid'));
    await h.refresh();
    const after = await (await h.get('session-reprice')).json();
    assert.equal(after.calls, before.calls); assert.equal(after.tokens, before.tokens);
    assert.equal(after.apiCost, .0014); assert.ok(after.apiCost > before.apiCost);
  } finally { await h.dispose(); }
});
test('live usage without a prior GET is persisted and missed-event gaps trigger one clean replay', async () => {
  let reads = 0;
  const h = await host(async () => { reads++; return { inheritedEventCount: 0, events: [event(0), event(1), ...(reads > 1 ? [event(2), event(3)] : [])] }; });
  try {
    h.emit('session-live', event(1));
    await new Promise(resolve => setImmediate(resolve));
    let first = await (await h.get('session-live')).json(); assert.equal(first.calls, 2);
    h.emit('session-live', event(3)); await new Promise(resolve => setImmediate(resolve));
    const final = await h.waitFor('session-live', data => data.cache?.state === 'fresh' && data.calls === 4); assert.equal(final.calls, 4); assert.equal(reads, 2);
  } finally { await h.dispose(); }
});
test('a lagging replay plus out-of-order live events never publishes or persists a gapped total', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-')); let h, resolveLoad, reads = 0;
  const loading = new Promise(resolve => { resolveLoad = resolve; });
  try {
    await createSessionCache(home).write('session-gap', foldEvents(emptyLedger(), [event(0), event(1)]), 0, 1000);
    h = await host(async () => { reads++; return reads === 1 ? loading : { inheritedEventCount: 0, events: [event(0), event(1), event(2), event(3)] }; }, { home });
    await h.get('session-gap'); h.emit('session-gap', event(3));
    resolveLoad({ inheritedEventCount: 0, events: [event(0), event(1)] });
    await new Promise(resolve => setImmediate(resolve));
    const stale = await h.waitFor('session-gap', data => data.cache?.state === 'stale', true);
    assert.equal(stale.cache.state, 'stale'); assert.equal(stale.calls, 2); assert.equal(stale.cache.throughSeq, 1);
    h.emit('session-gap', event(2)); await h.get('session-gap'); await new Promise(resolve => setImmediate(resolve));
    const fresh = await h.waitFor('session-gap', data => data.cache?.state === 'fresh');
    assert.equal(fresh.calls, 4); assert.equal(fresh.cache.state, 'fresh');
  } finally { if (h) await h.dispose(); await rm(home, { recursive: true, force: true }); }
});
test('warm closure invalidates observations, flushes durably, and detects deletion on the next lookup', async () => {
  let deleted = false, reads = 0;
  const h = await host(async () => { reads++; if (deleted) throw Object.assign(Error('deleted'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); return { inheritedEventCount: 0, events: [event(0)] }; });
  try {
    await h.get('session-warm'); await h.lifecycle('session/flush', 'session-warm');
    assert.equal((await createSessionCache(h.home).read('session-warm')).ledger.records.length, 1);
    h.lifecycle('session/disposed', 'session-warm'); deleted = true;
    await h.get('session-warm');
    for (let i = 0; i < 100 && await createSessionCache(h.home).read('session-warm'); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.get('session-warm', '&cached=1')).status, 404); assert.equal(reads, 2);
  } finally { await h.dispose(); }
});
test('quiet warm sessions are periodically revalidated without blocking cached display', async () => {
  let deleted = false, reads = 0;
  const h = await host(async () => { reads++; if (deleted) throw Object.assign(Error('deleted'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); return { inheritedEventCount: 0, events: [event(0)] }; });
  const originalNow = Date.now;
  try {
    await h.get('session-ttl'); const firstTime = Date.now();
    await h.get('session-ttl'); assert.equal(reads, 1);
    Date.now = () => firstTime + 5 * 60 * 1000 + 1; deleted = true;
    await h.get('session-ttl');
    for (let i = 0; i < 100 && await createSessionCache(h.home).read('session-ttl'); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.get('session-ttl', '&cached=1')).status, 404); assert.equal(reads, 2);
  } finally { Date.now = originalNow; await h.dispose(); }
});
test('live snapshot bootstrap and admitted cold load flush during graceful disposal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-')); let h;
  try {
    h = await host(async () => { assert.fail('live snapshot must not query the disk'); }, { home });
    h.emitLive('session-bootstrap', event(2), [event(0), event(1), event(2)], 2);
    await h.dispose(); h = null;
    const bootstrap = await createSessionCache(home).read('session-bootstrap');
    assert.equal(bootstrap.ledger.records.length, 1); assert.equal(bootstrap.inheritedEventCount, 2);
    let resolveLoad, started;
    const begun = new Promise(resolve => { started = resolve; });
    const loading = new Promise(resolve => { resolveLoad = resolve; });
    h = await host(async () => { started(); return loading; }, { home });
    h.emit('session-cold-close', event(0)); await begun;
    const disposing = h.dispose(); resolveLoad({ inheritedEventCount: 0, events: [event(0)] });
    await disposing; h = null;
    assert.equal((await createSessionCache(home).read('session-cold-close')).ledger.records.length, 1);
  } finally { if (h) await h.dispose(); await rm(home, { recursive: true, force: true }); }
});
test('a session closed while validation is in flight cannot publish the old observation as fresh', async () => {
  let resolveLoad, reads = 0;
  const loading = new Promise(resolve => { resolveLoad = resolve; });
  const h = await host(async () => { reads++; return loading; });
  try {
    const pending = h.get('session-close-race');
    while (!reads) await new Promise(resolve => setImmediate(resolve));
    h.lifecycle('session/disposed', 'session-close-race');
    resolveLoad({ inheritedEventCount: 0, events: [event(0)] });
    assert.equal((await pending).status, 503);
    assert.equal((await h.get('session-close-race', '&cached=1')).status, 404);
  } finally { await h.dispose(); }
});
test('a deleted generation cannot be revived by a read that completes after its tombstone', async () => {
  let started, resolveLoad;
  const begun = new Promise(resolve => { started = resolve; });
  const loading = new Promise(resolve => { resolveLoad = resolve; });
  const h = await host(async () => { started(); return loading; });
  try {
    const pending = h.get('session-delete-generation'); await begun;
    await createSessionCache(h.home).remove('session-delete-generation');
    resolveLoad({ inheritedEventCount: 0, events: [event(0)] });
    assert.equal((await pending).status, 503);
    await h.lifecycle('session/flush', 'session-delete-generation');
    const cache = createSessionCache(h.home);
    assert.equal(await cache.read('session-delete-generation'), null); assert.equal(await cache.isDeleted('session-delete-generation'), true);
    // Even an old observer with a late completion timestamp cannot replace the deleted generation.
    await cache.write('session-delete-generation', foldEvents(emptyLedger(), [event(0)]), 0, Date.now() + 1000);
    assert.equal(await cache.read('session-delete-generation'), null);
  } finally { await h.dispose(); }
});
test('a hung GET-first query upgrades to the live in-memory snapshot and flushes on shutdown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-')); let h, started, resolveOld;
  const begun = new Promise(resolve => { started = resolve; });
  const old = new Promise(resolve => { resolveOld = resolve; });
  try {
    h = await host(async () => { started(); return old; }, { home });
    const pending = h.get('session-upgrade'); await begun;
    h.emitLive('session-upgrade', event(1), [event(0), event(1)]);
    const fresh = await (await pending).json(); assert.equal(fresh.calls, 2); assert.equal(fresh.cache.state, 'fresh');
    await h.dispose(); h = null;
    assert.equal((await createSessionCache(home).read('session-upgrade')).ledger.records.length, 2);
    resolveOld({ inheritedEventCount: 0, events: [event(0)] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await createSessionCache(home).read('session-upgrade')).ledger.records.length, 2);
  } finally { resolveOld?.({ inheritedEventCount: 0, events: [] }); if (h) await h.dispose(); await rm(home, { recursive: true, force: true }); }
});
test('the API returns separate answer totals and updates only the active turn', async () => {
  const first = event(1); first.data.turn = 1;
  const second = event(2, 20); second.data.turn = 2;
  const h = await host(async () => ({ inheritedEventCount: 0, events: [first, second] }));
  try {
    let data = await (await h.get('session-turns')).json();
    assert.equal(data.turns[1].tokens, 12); assert.equal(data.turns[2].tokens, 22);
    const extra = event(3, 30); extra.data.turn = 2; h.emit('session-turns', extra);
    data = await (await h.get('session-turns')).json();
    assert.equal(data.turns[1].tokens, 12); assert.equal(data.turns[2].tokens, 54);
    assert.equal(data.tokens, 66);
  } finally { await h.dispose(); }
});
