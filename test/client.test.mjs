import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

// Persistent hooks/effect cleanup exercise the real plugin in a VM without a
// browser or extra dependencies. Network and clocks are explicitly controlled.
function harness() {
  let plugin, current, hookIndex, now = 100000, timerId = 0;
  const components = {}, instances = [], calls = [], timers = new Map(), events = new Map();
  let invalidWrites = 0;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const React = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const instance = current, index = hookIndex++;
      const slot = instance.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, value => {
        if (!instance.mounted) { invalidWrites++; return; }
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; instance.dirty = true; }
      }];
    },
    useRef(value) { return current.hooks[hookIndex++] ??= { current: value }; },
    useEffect(effect, deps) {
      const instance = current, index = hookIndex++;
      const old = instance.hooks[index];
      if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
        instance.effects.push(() => {
          old?.cleanup?.();
          instance.hooks[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const document = { body: {}, hidden: false, activeElement: { focus() {} },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
  };
  const window = { __ModuleLoader__: { load: spec => { plugin = spec.factory(name => name === 'react' ? React : { createPortal: node => node }); } } };
  // Expose closure helpers only in the test VM, never as production exports.
  const instrumented = source.replace("    return {\n      inject: ['slots']", "    window.__costTest = { costSource, requestCost };\n    return {\n      inject: ['slots']");
  vm.runInNewContext(instrumented, { window, document, Date: Clock, AbortSignal: { timeout: () => undefined },
    fetch: (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, next: now + ms }); return id; },
    clearInterval: id => timers.delete(id),
  });
  plugin.apply({ effect() {}, slots: { inject: (name, fn) => fn(), register: (spec, fn) => { components[spec.id] = fn; } } });
  function flush() {
    for (let pass = 0; pass < 100; pass++) {
      const dirty = instances.filter(instance => instance.mounted && instance.dirty);
      if (!dirty.length) return;
      for (const instance of dirty) {
        instance.dirty = false; instance.effects = []; current = instance; hookIndex = 0;
        instance.tree = instance.component(instance.props); current = null;
        for (const effect of instance.effects) effect();
      }
    }
    throw Error('Hook harness did not settle');
  }
  function mount(kind = 'composer', overrides = {}) {
    const props = { sessionId: 'session-test', useProjection: () => ({ tokens: 100 }),
      useSession: select => select({ running: false }), messageId: 'message-1',
      useChat: select => select(snapshot()), ...overrides };
    const instance = { component: typeof kind === 'function' ? kind : components[kind === 'composer' ? 'conversation-cost' : 'turn-cost'],
      props, hooks: [], effects: [], dirty: true, mounted: true, tree: null };
    instances.push(instance); flush(); return instance;
  }
  function update(instance, props) { instance.props = { ...instance.props, ...props }; instance.dirty = true; flush(); }
  function unmount(instance) { instance.mounted = false; for (const slot of instance.hooks) slot?.cleanup?.(); }
  async function settle() { for (let i = 0; i < 16; i++) { await Promise.resolve(); flush(); } }
  function reply(call, result, status = 200) { call.resolve({ ok: status >= 200 && status < 300, json: async () => result }); }
  function advance(ms) {
    now += ms;
    for (const timer of timers.values()) if (timer.next <= now) { timer.next = now + timer.ms; timer.fn(); }
    flush();
  }
  function click(instance) { instance.tree.children[0].props.onClick(); flush(); }
  function dialog(instance) { return instance.tree?.children.find(child => child && typeof child.type === 'function') ?? null; }
  function dialogText(instance) { const element = dialog(instance); return element ? text(mount(element.type, element.props).tree) : null; }
  return { calls, timers, document, mount, update, unmount, settle, reply, advance, click, dialog, dialogText,
    get invalidWrites() { return invalidWrites; }, pill: instance => text(instance.tree?.children[0]).trim(),
    button: instance => instance.tree?.children[0], api: window.__costTest,
    regular: id => calls.filter(call => !call.url.includes('cached=1') && !call.url.includes('/prices/') && (!id || call.url.includes('sessionId=' + id))),
    cached: id => calls.filter(call => call.url.includes('cached=1') && (!id || call.url.includes('sessionId=' + id))),
    visibility: () => { for (const fn of events.get('visibilitychange') ?? []) fn(); flush(); },
  };
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(text).filter(Boolean).join(' ');
  return (node.children ?? []).map(text).filter(Boolean).join(' ');
}
function snapshot() {
  const turn = id => ({ data: new Map([['turn-tail', { turn: id, closing: { finalNode: { messageId: 'message-' + id } } }]]) });
  return { timeline: { turns: new Map([[1, turn(1)], [2, turn(2)]]) } };
}
const summary = (unpriced = false, amount = .007165816) => ({ calls: 4, subscriptionCalls: 4, tokens: 99237, apiCost: 0,
  subscriptionEquivalent: unpriced ? 0 : amount, missingUsage: 0,
  unpricedCalls: unpriced ? 4 : 0, unpricedTokens: unpriced ? 99237 : 0,
  models: [{ model: 'deepseek-v4-flash', provider: 'opencode-go', subscription: true, tokens: 99237,
    unpricedTokens: unpriced ? 99237 : 0, amount: unpriced ? 0 : amount, source: 'https://models.dev',
    calls: 4, reference: !unpriced, catalogRoute: 'opencode/deepseek-v4-flash',
    usage: { inputTokens: 26560, cacheReadTokens: 67072, cacheWriteTokens: 0, outputTokens: 5605 } }],
});
function data({ sessionId = 'session-test', unpriced = false, amount = .007165816, state = 'fresh', seq = 10, updatedAt = 100000, error } = {}) {
  return { sessionId, ...summary(unpriced, amount), turns: { 1: summary(unpriced, amount), 2: summary(unpriced, .1234) },
    prices: { catalogAt: 100000, deepseekAt: 100000, errors: [], stale: false },
    cache: { state, throughSeq: seq, updatedAt, ...(error ? { error } : {}) } };
}
async function loaded(h, instance, value = data()) {
  h.reply(h.cached()[0], { error: 'cache-miss' }, 404);
  h.reply(h.regular()[0], value);
  await h.settle();
  return instance;
}

test('all-unpriced costs show 未计价, not loading or a zero dollar total', async () => {
  const h = harness(), composer = h.mount();
  await loaded(h, composer, data({ unpriced: true })); h.click(composer); await h.settle();
  assert.equal(h.pill(composer), 'Cost 未计价');
  assert.match(h.dialogText(composer), /订阅等值 · 未计价/);
  assert.doesNotMatch(h.dialogText(composer), /\$0\.0000/);
});

test('priced subscription and mixed API totals retain existing money/reference format', async () => {
  const h = harness(), composer = h.mount();
  await loaded(h, composer); h.click(composer); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
  assert.match(h.dialogText(composer), /API 参考价：opencode\/deepseek-v4-flash/);
  const mixed = data(); mixed.apiCost = .1; mixed.calls += 1;
  mixed.models.push({ ...mixed.models[0], subscription: false, amount: .1 });
  const promise = h.api.requestCost('session-test', JSON.stringify({ tokens: 100 }), true);
  h.reply(h.regular()[1], mixed); await promise; await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.1072');
});

test('cold loading, failed reads, cache miss and genuinely free priced routes are distinct', async () => {
  const h = harness(), composer = h.mount();
  assert.equal(h.pill(composer), 'Cost 加载中');
  h.reply(h.cached()[0], { error: 'cache-miss' }, 404); await h.settle();
  assert.equal(h.pill(composer), 'Cost 加载中');
  h.regular()[0].reject(Error('offline')); await h.settle();
  assert.equal(h.pill(composer), 'Cost 暂不可用');
  assert.match(h.button(composer).props.title, /点击后可重试/);
  h.click(composer); assert.equal(h.pill(composer), 'Cost 加载中');
  h.reply(h.regular()[1], data({ amount: 0 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0000');
  assert.ok(h.dialog(composer), 'a cold successful retry opens the dialog automatically');
  assert.equal(h.cached().length, 1);
});

test('fast persisted snapshot displays immediately in composer and all footers before regular GET finishes', async () => {
  const h = harness(), composer = h.mount(), first = h.mount('footer'), second = h.mount('footer', { messageId: 'message-2' });
  assert.equal(h.calls.length, 2, 'one cache-only and one regular request shared by all components');
  assert.match(h.calls[0].url, /&cached=1$/);
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  h.reply(h.cached()[0], data({ state: 'cached', amount: .25 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.2500');
  assert.equal(h.pill(first), 'Cost ≈$0.2500');
  assert.equal(h.pill(second), 'Cost ≈$0.1234');
  assert.equal(h.button(composer).props.title, '查看模型价格与费用明细（美元 USD）');
  h.reply(h.regular()[0], data({ amount: .3, seq: 11, updatedAt: 100001 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.3000');
  assert.equal(h.pill(first), 'Cost ≈$0.3000');
  assert.equal(h.pill(second), 'Cost ≈$0.1234');
});

test('slow cached response cannot overwrite the accepted fresh regular response', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.reply(h.regular()[0], data({ amount: .8, seq: 15 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.8000');
  h.reply(h.cached()[0], data({ state: 'cached', amount: .1, seq: 20, updatedAt: 200000 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.8000');
  assert.equal(h.pill(footer), 'Cost ≈$0.8000');
});

test('older regular snapshot does not downgrade a newer disk snapshot', async () => {
  const h = harness(), composer = h.mount();
  h.reply(h.cached()[0], data({ state: 'cached', amount: .5, seq: 20 })); await h.settle();
  h.reply(h.regular()[0], data({ amount: .1, seq: 10 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.5000');
  assert.match(h.button(composer).props.title, /保留最近金额/);
  h.click(composer); h.reply(h.regular()[1], data({ amount: .6, seq: 21 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.6000');
});

test('newer canonical repair may lower sequence and calls, while old timestamps and sequence ties cannot regress it', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.reply(h.cached()[0], data({ state: 'cached', amount: .5, seq: 10, updatedAt: 1000 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.5000');
  const repaired = data({ state: 'fresh', amount: .4, seq: 8, updatedAt: 2000 });
  repaired.calls--; repaired.subscriptionCalls--; repaired.models[0].calls--;
  repaired.turns[1].calls--; repaired.turns[1].subscriptionCalls--; repaired.turns[1].models[0].calls--;
  h.reply(h.regular()[0], repaired); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.4000'); assert.equal(h.pill(footer), 'Cost ≈$0.4000');
  assert.equal(h.api.costSource('session-test').data.calls, 3);
  assert.equal(h.api.costSource('session-test').data.cache.throughSeq, 8);
  for (const options of [{ seq: 12, updatedAt: 1500 }, { seq: 7, updatedAt: 2000 }]) {
    const request = h.api.requestCost('session-test', JSON.stringify({ tokens: 100 }), true);
    h.reply(h.regular().at(-1), data({ amount: .9, ...options })); await request; await h.settle();
    assert.equal(h.pill(composer), 'Cost ≈$0.4000');
    assert.equal(h.api.costSource('session-test').data.calls, 3);
    assert.equal(h.api.costSource('session-test').data.cache.updatedAt, 2000);
    assert.equal(h.api.costSource('session-test').data.cache.throughSeq, 8);
  }
  const request = h.api.requestCost('session-test', JSON.stringify({ tokens: 100 }), true);
  h.reply(h.regular().at(-1), data({ amount: .45, seq: 9, updatedAt: 2000 })); await request; await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.4500'); assert.equal(h.pill(footer), 'Cost ≈$0.4500');
});

test('regular failure preserves cached amount, shared error and retry dialog without a pending notice', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.reply(h.cached()[0], data({ state: 'cached', amount: .42 })); await h.settle();
  h.regular()[0].reject(Error('session read failed')); await h.settle();
  for (const instance of [composer, footer]) {
    assert.equal(h.pill(instance), 'Cost ≈$0.4200');
    assert.match(h.button(instance).props.title, /点击后可重试/);
  }
  h.click(footer);
  assert.doesNotMatch(h.dialogText(footer), /待更新|最近快照|上次保存/);
  assert.match(h.dialogText(footer), /费用暂时无法读取/);
  h.reply(h.regular()[1], data({ amount: .43, seq: 11 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.4300');
  assert.equal(h.pill(footer), 'Cost ≈$0.4300');
  assert.ok(h.dialog(footer));
});

test('late disk snapshot remains useful after a cold regular error', async () => {
  const h = harness(), composer = h.mount();
  h.regular()[0].reject(Error('offline')); await h.settle();
  assert.equal(h.pill(composer), 'Cost 暂不可用');
  h.reply(h.cached()[0], data({ state: 'cached', amount: .17 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.1700');
});

test('disk/network cache-only failure falls back to ordinary GET without false cold errors', async () => {
  const h = harness(), composer = h.mount();
  h.cached()[0].reject(Error('disk unavailable')); await h.settle();
  assert.equal(h.pill(composer), 'Cost 加载中');
  h.reply(h.regular()[0], data()); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
});

test('cached/stale metadata and safe cache errors retain amounts and retry without visible pending notices', async () => {
  for (const options of [{ state: 'cached' }, { state: 'stale', error: 'session-read-failed' }, { state: 'fresh', error: 'cache-write-failed' }]) {
    const h = harness(), composer = h.mount(), footer = h.mount('footer');
    await loaded(h, composer, data(options));
    assert.equal(h.pill(composer), 'Cost ≈$0.0072');
    assert.equal(h.pill(footer), 'Cost ≈$0.0072');
    h.click(composer);
    assert.doesNotMatch(h.dialogText(composer), /待更新|最近快照|上次保存/);
    assert.equal(h.regular().length, 2, 'hidden cache state still forces a retry when clicked');
    assert.doesNotMatch(h.dialogText(composer), /session-read-failed|cache-write-failed/);
  }
});

test('background validation never adds pending text to composer/footer labels, tooltips or dialogs', async () => {
  for (const options of [{ state: 'cached' }, { state: 'stale' }, { state: 'fresh', error: 'cache-write-failed' }, { state: 'cached', unpriced: true }]) {
    const h = harness(), composer = h.mount(), footer = h.mount('footer');
    await loaded(h, composer, data(options));
    for (const instance of [composer, footer]) {
      assert.equal(h.pill(instance), options.unpriced ? 'Cost 未计价' : 'Cost ≈$0.0072');
      assert.doesNotMatch(h.button(instance).props.title, /待更新|最近快照|上次保存/);
      assert.equal(h.button(instance).children.length, 1, 'no status badge is appended to the amount');
      h.click(instance);
      assert.equal(h.dialog(instance).props.pending, undefined, 'dialog has no visual pending state');
      assert.doesNotMatch(h.dialogText(instance), /待更新|最近快照|上次保存/);
    }
  }
});

test('answer footer resolves completed message to its own turn and never polls', async () => {
  const h = harness(), footer = h.mount('footer', { messageId: 'message-2' });
  await loaded(h, footer); h.click(footer); await h.settle();
  assert.equal(h.pill(footer), 'Cost ≈$0.1234');
  assert.match(h.dialogText(footer), /本轮回答费用/);
  assert.match(h.dialogText(footer), /第 2 轮回答/);
  assert.equal(h.timers.size, 0);
  h.advance(120000); await h.settle();
  assert.equal(h.regular().length, 1);
  h.update(footer, { messageId: 'unsettled-message' });
  assert.equal(h.pill(footer), '');
  assert.equal(h.dialog(footer), null);
});

test('cold footer retry opens its dialog on successful response', async () => {
  const h = harness(), footer = h.mount('footer');
  h.reply(h.cached()[0], { error: 'cache-miss' }, 404); h.regular()[0].reject(Error('offline')); await h.settle();
  assert.equal(h.pill(footer), 'Cost 暂不可用');
  h.click(footer); h.reply(h.regular()[1], data()); await h.settle();
  assert.ok(h.dialog(footer));
  assert.equal(h.pill(footer), 'Cost ≈$0.0072');
});

test('memory snapshot is restored on first render without another disk read or redundant fresh GET', async () => {
  const h = harness(), first = h.mount(); await loaded(h, first); h.unmount(first);
  const second = h.mount(), footer = h.mount('footer');
  assert.equal(h.pill(second), 'Cost ≈$0.0072');
  assert.equal(h.pill(footer), 'Cost ≈$0.0072');
  assert.equal(h.cached().length, 1); assert.equal(h.regular().length, 1);
});

test('fresh same usage is not repeatedly fetched on idle renders/visibility, but revalidates at 30s', async () => {
  const h = harness(), composer = h.mount(); await loaded(h, composer);
  for (let i = 0; i < 8; i++) { h.update(composer, { useProjection: () => ({ tokens: 100 }) }); h.visibility(); }
  await h.settle(); assert.equal(h.regular().length, 1);
  h.advance(29999); h.visibility(); await h.settle(); assert.equal(h.regular().length, 1);
  h.advance(1); await h.settle(); assert.equal(h.regular().length, 2);
  h.reply(h.regular()[1], data({ updatedAt: 130000 })); await h.settle();
  h.update(composer, { useProjection: () => ({ tokens: 101 }) });
  assert.equal(h.regular().length, 3, 'changed usage immediately invalidates the fresh key');
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
});

test('only one composer timer feeds many footers and running keeps 5s retry/recovery', async () => {
  const h = harness(), composer = h.mount();
  for (let i = 0; i < 10; i++) h.mount('footer');
  await loaded(h, composer); assert.equal(h.timers.size, 1);
  h.update(composer, { useSession: select => select({ running: true }) });
  assert.equal([...h.timers.values()][0].ms, 5000);
  h.advance(5000); assert.equal(h.regular().length, 2);
  h.regular()[1].reject(Error('temporary')); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
  h.advance(5000); assert.equal(h.regular().length, 3);
  h.reply(h.regular()[2], data({ amount: .2, seq: 11, updatedAt: 110000 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.2000');
});

test('queued usage updates still load after the preceding request fails and are shared', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.update(composer, { useProjection: () => ({ tokens: 101 }) });
  h.update(footer, { useProjection: () => ({ tokens: 101 }) });
  h.reply(h.cached()[0], { error: 'cache-miss' }, 404); h.regular()[0].reject(Error('temporary')); await h.settle();
  assert.equal(h.regular().length, 2);
  h.reply(h.regular()[1], data()); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
  assert.equal(h.pill(footer), 'Cost ≈$0.0072');
});

test('session switch cannot show prior amounts, errors or retry dialog from late requests', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.click(composer); h.click(footer);
  h.update(composer, { sessionId: 'session-next' }); h.update(footer, { sessionId: 'session-next' });
  assert.equal(h.pill(composer), 'Cost 加载中'); assert.equal(h.pill(footer), 'Cost 加载中');
  h.reply(h.cached('session-test')[0], data({ state: 'cached', amount: .8 }));
  h.reply(h.regular('session-test')[0], data({ amount: .9 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost 加载中'); assert.equal(h.pill(footer), 'Cost 加载中');
  assert.equal(h.dialog(composer), null); assert.equal(h.dialog(footer), null);
  h.reply(h.cached('session-next')[0], { error: 'cache-miss' }, 404);
  h.reply(h.regular('session-next')[0], data({ sessionId: 'session-next', amount: .2 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.2000'); assert.equal(h.pill(footer), 'Cost ≈$0.2000');
  assert.equal(h.dialog(composer), null); assert.equal(h.dialog(footer), null);
  h.update(composer, { sessionId: 'session-test' });
  assert.equal(h.pill(composer), 'Cost ≈$0.9000', 'returning restores only that session memory');
  assert.equal(h.dialog(composer), null);
  assert.equal(h.cached().length, 2);
});

test('a mismatched session response never contaminates either composer or footer', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.reply(h.cached()[0], data({ sessionId: 'wrong-session', state: 'cached' }));
  h.reply(h.regular()[0], data({ sessionId: 'wrong-session' })); await h.settle();
  assert.equal(h.pill(composer), 'Cost 暂不可用'); assert.equal(h.pill(footer), 'Cost 暂不可用');
});

test('unmount and footer message switch suppress asynchronous click/dialog state writes', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.click(composer); h.click(footer);
  h.unmount(composer); h.update(footer, { messageId: 'message-2' });
  h.reply(h.cached()[0], { error: 'cache-miss' }, 404); h.reply(h.regular()[0], data()); await h.settle();
  assert.equal(h.invalidWrites, 0); assert.equal(h.dialog(footer), null);
  assert.equal(h.pill(footer), 'Cost ≈$0.1234');
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.costSource('session-test').listeners.size, 1);
});

test('subscriber exceptions do not break requests or delivery to other subscribers', async () => {
  const h = harness();
  h.api.costSource('session-test').listeners.add(() => { throw Error('bad subscriber'); });
  const composer = h.mount(), footer = h.mount('footer');
  await loaded(h, composer);
  assert.equal(h.pill(composer), 'Cost ≈$0.0072'); assert.equal(h.pill(footer), 'Cost ≈$0.0072');
  const request = h.api.requestCost('session-test', 'new-usage', true);
  h.reply(h.regular()[1], data({ amount: .12, seq: 11 }));
  assert.equal((await request).subscriptionEquivalent, .12); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.1200'); assert.equal(h.pill(footer), 'Cost ≈$0.1200');
});

test('stale and cold results back off mount/visibility bursts while clicks immediately retry', async () => {
  for (const stale of [true, false]) {
    const h = harness(), composer = h.mount();
    h.reply(h.cached()[0], { error: 'cache-miss' }, 404);
    if (stale) h.reply(h.regular()[0], data({ state: 'cached' }));
    else h.regular()[0].reject(Error('offline'));
    await h.settle();
    for (let i = 0; i < 12; i++) { h.mount('footer'); h.visibility(); }
    await h.settle();
    assert.equal(h.regular().length, 1);
    h.click(composer);
    assert.equal(h.regular().length, 2, 'an explicit retry bypasses the short backoff');
    h.reply(h.regular()[1], data()); await h.settle();
  }
});

test('closing a dialog cancels pending automatic-open intent in both slots', async () => {
  for (const kind of ['composer', 'footer']) {
    const h = harness(), instance = h.mount(kind);
    h.click(instance); // cold intent is waiting for the ordinary GET
    h.reply(h.cached()[0], data({ state: 'cached' })); await h.settle();
    h.click(instance); // now cached data can open immediately
    assert.ok(h.dialog(instance));
    h.dialog(instance).props.close(); await h.settle();
    assert.equal(h.dialog(instance), null);
    h.reply(h.regular()[0], data()); await h.settle();
    assert.equal(h.dialog(instance), null, 'late successful load must not undo user close');
  }
});

test('successful price refresh waits out an older GET then shares a new post-refresh GET', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer');
  h.reply(h.cached()[0], data({ state: 'cached' })); await h.settle();
  h.click(composer); h.click(footer);
  h.dialog(composer).props.refresh(); h.dialog(footer).props.refresh(); await h.settle();
  const posts = h.calls.filter(call => call.url.includes('/prices/refresh'));
  assert.equal(posts.length, 1); assert.equal(posts[0].options.method, 'POST');
  h.reply(posts[0], {}); await h.settle();
  assert.equal(h.regular().length, 1, 'the pre-refresh request is still outstanding');
  h.reply(h.regular()[0], data({ amount: .02, updatedAt: 100001 })); await h.settle();
  assert.equal(h.regular().length, 2, 'a second GET must start after the successful POST and old GET');
  assert.equal(h.dialog(composer).props.busy, true); assert.equal(h.dialog(footer).props.busy, true);
  h.reply(h.regular()[1], data({ amount: .03, updatedAt: 100002 })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0300'); assert.equal(h.pill(footer), 'Cost ≈$0.0300');
  assert.equal(h.dialog(composer).props.busy, false); assert.equal(h.dialog(footer).props.busy, false);
});

test('price refresh busy/error/data are shared and late completion cannot update switched/unmounted UI', async () => {
  const h = harness(), composer = h.mount(), footer = h.mount('footer'); await loaded(h, composer);
  h.click(footer); await h.settle();
  h.dialog(footer).props.refresh(); await h.settle();
  assert.equal(h.calls.filter(call => call.url.includes('/prices/refresh')).length, 1);
  assert.equal(h.dialog(footer).props.busy, true);
  h.click(composer); await h.settle();
  assert.equal(h.dialog(composer).props.busy, true);
  h.dialog(composer).props.refresh();
  assert.equal(h.calls.filter(call => call.url.includes('/prices/refresh')).length, 1);
  const post = h.calls.find(call => call.url.includes('/prices/refresh'));
  h.update(composer, { sessionId: 'session-next' }); h.unmount(footer);
  post.reject(Error('sync offline')); await h.settle();
  assert.equal(h.invalidWrites, 0); assert.equal(h.pill(composer), 'Cost 加载中');
  h.reply(h.cached('session-next')[0], { error: 'cache-miss' }, 404);
  h.reply(h.regular('session-next')[0], data({ sessionId: 'session-next' })); await h.settle();
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
  h.update(composer, { sessionId: 'session-test' });
  assert.equal(h.pill(composer), 'Cost ≈$0.0072');
  assert.match(h.button(composer).props.title, /同步未完成/);
});
