import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyLedger, foldEvents, parseCatalog, parseDeepseek, priceRecord, summarize, summarizeTurns } from '../lib/cost.js';
const seed = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url)));
const record = (changes = {}) => ({ provider: 'openai', model: 'test', time: Date.parse('2026-10-28T02:00:00Z'),
  inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 1000000, ...changes });
const prices = { routes: { 'openai/test': { input: 2, output: 10, cache_read: .2, cache_write: 2.5 } } };
const near = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
test('four disjoint usage buckets and reasoning are never counted twice', () => {
  const ledger = emptyLedger();
  foldEvents(ledger, [{ seq: 0, type: 'request/header', data: { header: { config: { provider: 'openai', model: 'test' } } } },
    { seq: 1, type: 'assistant/message', time: record().time, data: { usage: { ...record(), reasoningTokens: 999999, totalTokens: 4000000 } } }]);
  const result = summarize(ledger, prices);
  near(result.apiCost, 14.7); assert.equal(result.tokens, 4000000); assert.equal(result.calls, 1);
});
test('deduplicates replay events, prices each actual route after model switches', () => {
  const ledger = emptyLedger();
  const events = [
    { seq: 1, type: 'request/header', data: { header: { config: { provider: 'openai', model: 'test' } } } },
    { seq: 2, type: 'assistant/message', time: record().time, data: { usage: record({ cacheReadTokens: 0, cacheWriteTokens: 0 }) } },
    { seq: 3, type: 'request/header', data: { header: { config: { provider: 'codex-subscription', model: 'test' } } } },
    { seq: 4, type: 'assistant/message', time: record().time, data: { usage: record({ cacheReadTokens: 0, cacheWriteTokens: 0 }) } },
  ];
  foldEvents(ledger, events); foldEvents(ledger, events);
  const result = summarize(ledger, prices);
  near(result.apiCost, 12); near(result.subscriptionEquivalent, 12); assert.equal(result.calls, 2); assert.equal(result.subscriptionCalls, 1);
});
test('answer costs aggregate all steps in that turn and never include another answer', () => {
  const ledger = emptyLedger();
  const rows = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'request/header', data: { header: { config: { provider: 'openai', model: 'test' } } } },
    { seq: 2, type: 'assistant/message', time: record().time, data: { turn: 1, usage: record({ cacheReadTokens: 0, cacheWriteTokens: 0 }) } },
    { seq: 3, type: 'assistant/message', time: record().time, data: { turn: 1, usage: record({ cacheReadTokens: 0, cacheWriteTokens: 0 }) } },
    { seq: 4, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, type: 'request/header', data: { header: { config: { provider: 'codex-subscription', model: 'test' } } } },
    { seq: 6, type: 'assistant/message', time: record().time, data: { turn: 2, usage: record({ cacheReadTokens: 0, cacheWriteTokens: 0 }) } },
    { seq: 7, type: 'assistant/message', data: { turn: 2 } },
  ];
  foldEvents(ledger, rows); foldEvents(ledger, rows);
  const turns = summarizeTurns(ledger, prices);
  near(turns[1].apiCost, 24); assert.equal(turns[1].calls, 2); assert.equal(turns[1].missingUsage, 0);
  near(turns[2].subscriptionEquivalent, 12); assert.equal(turns[2].calls, 1); assert.equal(turns[2].missingUsage, 1);
  const total = summarize(ledger, prices);
  near(turns[1].apiCost + turns[2].subscriptionEquivalent, total.apiCost + total.subscriptionEquivalent);
});
test('assistant source wins over a stale request header; unknown provider never guesses by model name', () => {
  const ledger = emptyLedger();
  foldEvents(ledger, [{ seq: 0, type: 'assistant/message', data: { usage: record(), message: { source: { provider: 'gateway', model: 'test' } } } }]);
  const result = summarize(ledger, prices);
  assert.equal(result.unpricedTokens, 4000000); assert.equal(result.unpricedCalls, 1); assert.equal(result.apiCost, 0);
});
test('missing cache prices retain partial coverage; an explicit zero is a real price', () => {
  const p = { routes: { 'openai/test': { input: 2, output: 10, cache_read: 0 } } };
  const result = priceRecord(record(), p);
  near(result.amount, 12); assert.equal(result.unpricedTokens, 1000000);
  const ledger = { ...emptyLedger(), records: [record()] };
  assert.equal(summarize(ledger, p).unpricedCalls, 1);
});
test('retired Go model uses the exact Zen ID as a disclosed subscription reference', () => {
  for (const provider of ['opencode-go', 'opencode-go-subscription']) {
    const r = record({ provider, model: 'deepseek-v4-flash', inputTokens: 26560,
      outputTokens: 5605, cacheReadTokens: 67072, cacheWriteTokens: 0 });
    const result = priceRecord(r, seed);
    near(result.amount, .007165816); assert.equal(result.unpricedTokens, 0);
    assert.equal(result.reference, true); assert.equal(result.catalogRoute, 'opencode/deepseek-v4-flash');
    const total = summarize({ ...emptyLedger(), records: [r] }, seed);
    assert.equal(total.tokens, 99237); assert.equal(total.unpricedTokens, 0); assert.equal(total.apiCost, 0);
    assert.equal(total.models[0].reference, true);
  }
});
test('Go exact prices including explicit zero beat Zen references', () => {
  const p = { routes: { 'opencode-go/test': { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    'opencode/test': { input: 2, output: 10, cache_read: .2, cache_write: 2.5 } } };
  const result = priceRecord(record({ provider: 'opencode-go' }), p);
  assert.equal(result.amount, 0); assert.equal(result.unpricedTokens, 0); assert.equal(result.reference, false);
});
test('no substitute model version or unrelated API provider is used to fill missing prices', () => {
  const p = { ...seed, routes: { 'opencode-go/deepseek-v4.1-flash': seed.routes['opencode-go/deepseek-v4.1-flash'],
    'opencode/deepseek-v4-flash': seed.routes['opencode/deepseek-v4-flash'] } };
  assert.equal(priceRecord(record({ provider: 'custom-api', model: 'deepseek-v4-flash' }), p).amount, null);
  delete p.routes['opencode/deepseek-v4-flash'];
  assert.equal(priceRecord(record({ provider: 'opencode-go', model: 'deepseek-v4-flash' }), p).amount, null);
});
test('context price tier uses full input including cache, and exact threshold', () => {
  const p = { routes: { 'openai/test': { input: 2, output: 10, cache_read: .2,
    tiers: [{ input: 4, output: 20, cache_read: .4, tier: { type: 'context', size: 200000 } }] } } };
  near(priceRecord(record({ inputTokens: 100000, cacheReadTokens: 100000, cacheWriteTokens: 0 }), p).amount, 10.22);
  near(priceRecord(record({ inputTokens: 100001, cacheReadTokens: 100000, cacheWriteTokens: 0 }), p).amount, 20.440004);
});
test('invalid and missing usage are marked incomplete', () => {
  const ledger = emptyLedger();
  foldEvents(ledger, [undefined, { seq: 0, type: 'assistant/message', data: {} },
    { seq: 1, type: 'assistant/message', data: { usage: { inputTokens: -1, outputTokens: 2 } } },
    { seq: 2, type: 'assistant/message', data: { usage: { outputTokens: 1 } } }]);
  assert.equal(ledger.missingUsage, 3); assert.equal(ledger.records.length, 0);
});
test('DeepSeek UTC peak windows, weekend and Chinese holidays use each call time', () => {
  const r = record({ provider: 'deepseek-official', model: 'deepseek-v4-flash', cacheReadTokens: 0, cacheWriteTokens: 0 });
  const a = priceRecord(r, seed); assert.equal(a.period, 'peak'); near(a.amount, 1.5);
  const b = priceRecord({ ...r, time: Date.parse('2026-10-28T04:00:00Z') }, seed); assert.equal(b.period, 'offPeak'); near(b.amount, .75);
  assert.equal(priceRecord({ ...r, time: Date.parse('2026-10-31T02:00:00Z') }, seed).period, 'offPeak');
  assert.equal(priceRecord({ ...r, time: Date.parse('2026-10-01T02:00:00Z') }, seed).period, 'offPeak');
  assert.equal(priceRecord({ ...r, time: Date.parse('2027-01-05T02:00:00Z') }, seed).amount, null);
});
test('catalog accepts explicit free rates, rejects missing rates, preserves context tiers', () => {
  const routes = parseCatalog({ p: { models: { free: { cost: { input: 0, output: 0 } }, missing: {}, bad: { cost: { input: -1, output: 2 } },
    long: { cost: { input: 1, output: 2, context_over_200k: { input: 2, output: 4 } } } } } });
  assert.equal(routes['p/free'].input, 0); assert.equal(routes['p/missing'], undefined); assert.equal(routes['p/bad'], undefined);
  assert.equal(routes['p/long'].tiers[0].tier.size, 200000);
  assert.throws(() => parseCatalog({}));
});
test('official parser validates complete columns and peak schedule, fails closed on format drift', async () => {
  const html = await readFile(new URL('./deepseek-pricing.html', import.meta.url), 'utf8');
  assert.deepEqual(parseDeepseek(html), seed.deepseek);
  assert.throws(() => parseDeepseek(html.replace('$0.003', 'unknown')));
  assert.throws(() => parseDeepseek(html.replace('01:00 - 04:00', 'changed')));
});
