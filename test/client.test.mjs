import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
function render(data, open = false, footer = null) {
  let plugin, Component, stateIndex = 0;
  const states = footer ? [data, open, false, null] : [data, null, open, false];
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: value => ({ current: value }), useEffect() {},
    useState: initial => [states[stateIndex++] ?? initial, () => {}],
  };
  const require = name => name === 'react' ? React : { createPortal: node => node };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: spec => { plugin = spec.factory(require); } } }, document: { body: {} } });
  plugin.apply({ effect() {}, slots: { inject: (name, fn) => fn(), register: (spec, fn) => {
    if (spec.name === (footer ? 'conversation.chat.assistant-actions' : 'conversation.composer.dock')) Component = fn;
  } } });
  const tree = Component({ sessionId: 'session-test', useProjection: () => undefined, useSession: fn => fn({ running: false }),
    messageId: footer?.messageId, useChat: select => select(footer?.snapshot) });
  if (!tree) return { pill: '', dialog: null };
  const dialogElement = tree.children.find(child => child && typeof child.type === 'function');
  return { pill: text(tree.children[0]), dialog: dialogElement ? text(dialogElement.type(dialogElement.props)) : null };
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(text).join(' ');
  return (node.children ?? []).map(text).join(' ');
}
const data = (unpriced = true) => ({ calls: 4, subscriptionCalls: 4, tokens: 99237, apiCost: 0,
  subscriptionEquivalent: unpriced ? 0 : .007165816, missingUsage: 0,
  unpricedCalls: unpriced ? 4 : 0, unpricedTokens: unpriced ? 99237 : 0,
  models: [{ model: 'deepseek-v4-flash', provider: 'opencode-go', subscription: true, tokens: 99237,
    unpricedTokens: unpriced ? 99237 : 0, amount: unpriced ? 0 : .007165816, source: 'https://models.dev',
    calls: 4, reference: !unpriced, catalogRoute: 'opencode/deepseek-v4-flash',
    usage: { inputTokens: 26560, cacheReadTokens: 67072, cacheWriteTokens: 0, outputTokens: 5605 } }],
  prices: { catalogAt: Date.now(), deepseekAt: Date.now(), errors: [], stale: false },
});
test('all-unpriced subscription costs never render a zero dollar total', () => {
  const result = render(data(), true);
  assert.equal(result.pill, 'Cost ≈—');
  assert.match(result.dialog, /订阅等值 · 未计价/);
  assert.doesNotMatch(result.dialog, /\$0\.0000/);
});
test('priced subscription pill uses Cost and the dialog discloses the reference route', () => {
  const result = render(data(false), true);
  assert.equal(result.pill, 'Cost ≈$0.0072');
  assert.match(result.dialog, /API 参考价：opencode\/deepseek-v4-flash/);
  const mixed = data(false); mixed.apiCost = .1; mixed.calls += 1;
  mixed.models.push({ ...mixed.models[0], subscription: false, amount: .1 });
  assert.equal(render(mixed).pill, 'Cost ≈$0.1072');
});
test('Cost labels distinguish loading and a genuinely free priced route', () => {
  assert.equal(render(null).pill, 'Cost ≈—');
  const free = data(false); free.subscriptionEquivalent = 0; free.models[0].amount = 0;
  assert.equal(render(free).pill, 'Cost ≈$0.0000');
});
test('answer footer resolves the completed message to its own turn cost', () => {
  const turn = id => ({ data: new Map([['turn-tail', { turn: id, closing: { finalNode: { messageId: 'message-' + id } } }]]) });
  const snapshot = { timeline: { turns: new Map([[1, turn(1)], [2, turn(2)]]) } };
  const session = { ...data(false), sessionId: 'session-test', turns: { 1: data(false), 2: { ...data(false), subscriptionEquivalent: .1234 } } };
  const footer = { messageId: 'message-2', snapshot };
  const result = render(session, true, footer);
  assert.equal(result.pill, 'Cost ≈$0.1234');
  assert.match(result.dialog, /本轮回答费用/);
  assert.match(result.dialog, /第 2 轮回答/);
  assert.equal(render(session, false, { ...footer, messageId: 'unsettled-message' }).pill, '');
});
