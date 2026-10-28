import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPriceStore } from '../lib/prices.js';
const snapshot = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url)));
const html = await readFile(new URL('./deepseek-pricing.html', import.meta.url), 'utf8');
test('refresh shares a single request and offline restarts retain the last successful public cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-test-'));
  let calls = 0;
  const fetcher = async url => { calls++; await new Promise(resolve => setImmediate(resolve)); return new Response(url.includes('models.dev') ? JSON.stringify({ p: { models: { m: { cost: { input: 3, output: 4 } } } } }) : html); };
  try {
    const store = await createPriceStore(home, { seed: snapshot, fetcher });
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    assert.equal(calls, 2); assert.deepEqual(store.status().errors, []); assert.equal(store.get().routes['p/m'].input, 3);
    store.dispose();
    const offline = await createPriceStore(home, { seed: snapshot, fetcher: async () => { throw Error('offline'); } });
    await offline.refresh(); assert.equal(offline.get().routes['p/m'].input, 3); assert.equal(offline.status().errors.length, 2);
    assert.deepEqual(offline.get().deepseek, snapshot.deepseek); offline.dispose();
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('a malformed refresh cannot erase cached prices and disposal cancels requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-test-'));
  try {
    const store = await createPriceStore(home, { seed: snapshot, fetcher: async () => new Response('{}') });
    await store.refresh(); assert.equal(store.status().errors.length, 2); assert.deepEqual(store.get().routes, snapshot.routes); store.dispose();
    let signals = [];
    const pending = await createPriceStore(home, { seed: snapshot, fetcher: (url, options) => new Promise((resolve, reject) => {
      signals.push(options.signal); options.signal.addEventListener('abort', () => reject(Error('aborted')));
    }) });
    const run = pending.refresh(); pending.dispose(); await run;
    assert(signals.every(signal => signal.aborted));
  } finally { await rm(home, { recursive: true, force: true }); }
});
