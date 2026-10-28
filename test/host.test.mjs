import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
const event = (seq, amount = 10) => ({ seq, time: Date.parse('2026-10-28T02:00:00Z'), type: 'assistant/message',
  data: { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: amount, outputTokens: 2 } } });
async function host(readSession) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-'));
  const routes = new Map(), listeners = new Map(), disposers = [];
  // These tests use no network or production home.
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('offline test'); };
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
    async get(id) { return routes.get('/api/conversation-cost').fetch(new Request('http://localhost/api/conversation-cost?sessionId=' + id)); },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
      // Allow an in-progress initialization/atomic cache write to settle before cleanup.
      await new Promise(resolve => setTimeout(resolve, 50));
      globalThis.fetch = original; await rm(home, { recursive: true, force: true });
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
