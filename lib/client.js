window.__ModuleLoader__.load({
  id: 'dsh-conversation-cost',
  factory: require => {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const css = `
.dsh-cost-pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;border:0;border-radius:7px;padding:3px 7px;background:transparent;color:var(--dsw-alias-label-secondary,#737373);font:inherit;font-size:12px;line-height:20px;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-cost-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary)}
.dsh-turn-cost{order:1;flex:none;color:var(--dsw-alias-label-tertiary,#858585);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));padding:0 6px}
[data-clock="end"]:has(.dsh-turn-cost)>span:last-child{display:contents}
[data-clock="end"]:has(.dsh-turn-cost)>span:last-child>:first-child{margin-inline-start:8px}
[data-clock="end"]:has(.dsh-turn-cost)>span:last-child>span:last-child:not(:has(button)){order:2}
.dsh-cost-pill:focus-visible,.dsh-cost-dialog button:focus-visible,.dsh-cost-dialog a:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}
.dsh-cost-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:20px}
.dsh-cost-dialog{box-sizing:border-box;max-width:680px;width:100%;max-height:85vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#262626);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:16px;box-shadow:0 16px 60px #0003;padding:24px;font-size:13px;line-height:1.6}
.dsh-cost-dialog h2{font-size:18px;margin:0;font-weight:600}.dsh-cost-dialog p{margin:10px 0}.dsh-cost-dialog .cost-muted{color:var(--dsw-alias-label-secondary,#737373)}
.dsh-cost-dialog .cost-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.dsh-cost-dialog .cost-total{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:10px}
.dsh-cost-dialog button{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;padding:5px 10px;background:transparent;color:inherit;font:inherit;cursor:pointer}.dsh-cost-dialog button:disabled{opacity:.5;cursor:wait}
.dsh-cost-dialog a{color:#4d6bfe}.dsh-cost-model{padding-top:14px;margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));overflow-wrap:anywhere}.dsh-cost-model strong{font-weight:600}.dsh-cost-model .cost-row{align-items:flex-start}
.dsh-cost-dialog .cost-notice{background:rgba(77,107,254,.07);border-radius:8px;padding:10px 12px;margin-top:12px}.dsh-cost-dialog dl{display:grid;grid-template-columns:1fr auto;gap:4px 16px;margin:10px 0 0}.dsh-cost-dialog dt{color:var(--dsw-alias-label-secondary,#737373)}.dsh-cost-dialog dd{margin:0;font-variant-numeric:tabular-nums;text-align:right}.dsh-cost-dialog .cost-small{font-size:12px}
@media(max-width:560px){.dsh-cost-backdrop{padding:12px}.dsh-cost-dialog{padding:18px}.dsh-cost-pill{font-size:11px;padding-inline:4px}.dsh-cost-dialog .cost-total{font-size:23px}}
`;
    function money(n) { return n > 0 && n < .0001 ? '<$0.0001' : '$' + n.toFixed(4); }
    function count(n) { return n.toLocaleString(); }
    function stamp(time) { return new Date(time).toLocaleString(); }
    const partial = data => data.unpricedCalls > 0 || data.missingUsage > 0;
    function knownAmount(data, subscription) {
      const rows = data.models.filter(row => row.subscription === subscription);
      const known = rows.some(row => row.unpricedTokens < row.tokens);
      if (!known && (rows.length > 0 || data.missingUsage > 0)) return null;
      return money(subscription ? data.subscriptionEquivalent : data.apiCost);
    }
    function pillText(data, error, loading) {
      if (!data) return error && !loading ? 'Cost 暂不可用' : 'Cost 加载中';
      if ((data.calls > 0 || data.missingUsage > 0) &&
        !data.models.some(row => row.unpricedTokens < row.tokens)) return 'Cost 未计价';
      return 'Cost ≈' + money(data.apiCost + data.subscriptionEquivalent);
    }
    // Session-scoped memory fronts the server's persisted snapshots. Only the
    // composer polls; all footers share requests, data and failure state.
    const sessionCosts = new Map();
    function costSource(sessionId) {
      let entry = sessionCosts.get(sessionId);
      if (!entry) {
        if (sessionCosts.size >= 24) {
          const idle = [...sessionCosts].find(([, source]) => !source.promise && !source.cachePromise && !source.refreshPromise && source.listeners.size === 0);
          if (idle) sessionCosts.delete(idle[0]);
        }
        entry = { sessionId, data: null, key: null, dataKey: null, at: 0, attemptedAt: null, revision: 0,
          promise: null, cachePromise: null, cacheRead: false, refreshPromise: null,
          loading: false, refreshing: false, error: null, listeners: new Set() };
        sessionCosts.set(sessionId, entry);
      }
      return entry;
    }
    // Background freshness still governs retries, but is not displayed as a UI notice.
    function costView(source) {
      return { sessionId: source.sessionId, data: source.data, error: source.error,
        loading: source.loading, busy: source.refreshing,
        pending: !!source.data && (!!source.error || source.dataKey !== source.key ||
          !!source.data.cache?.error || (source.data.cache && source.data.cache.state !== 'fresh')) };
    }
    function publish(source) {
      const view = costView(source);
      for (const listener of source.listeners) {
        // A broken/unmounted subscriber must never turn a successful fetch into
        // an error or prevent other subscribers from receiving the snapshot.
        try { listener(view); } catch { /* isolate subscriber failures */ }
      }
    }
    async function fetchCost(sessionId, cached = false) {
      const response = await fetch('/api/conversation-cost?sessionId=' + encodeURIComponent(sessionId) + (cached ? '&cached=1' : ''), {
        signal: AbortSignal.timeout(20000), credentials: 'same-origin',
      });
      if (!response.ok) throw Error('读取失败');
      const result = await response.json();
      if (result.sessionId !== sessionId) throw Error('会话不匹配');
      return result;
    }
    function olderSnapshot(result, previous) {
      if (!result.cache || !previous?.cache) return false;
      // Canonical rebuilds may legitimately truncate/repair the ledger, so a
      // newer authoritative snapshot can have a lower sequence and fewer calls.
      // Sequence only breaks ties between snapshots rebuilt at the same time.
      if (result.cache.updatedAt !== previous.cache.updatedAt) return result.cache.updatedAt < previous.cache.updatedAt;
      return result.cache.throughSeq < previous.cache.throughSeq;
    }
    function readCachedCost(source) {
      if (source.cacheRead || source.data) return;
      source.cacheRead = true;
      const revision = source.revision;
      source.cachePromise = fetchCost(source.sessionId, true).then(result => {
        // Even a late cache with a newer timestamp must not replace an accepted
        // regular response. A cache arriving after a regular failure is useful.
        if (source.revision !== revision || source.data) return;
        source.data = result;
        publish(source);
      }).catch(() => { /* Cache miss/disk failure: the regular GET is authoritative. */ })
        .finally(() => { source.cachePromise = null; });
    }
    function requestCost(sessionId, key, force = false) {
      const source = costSource(sessionId);
      if (source.promise) {
        if (source.key === key) return source.promise;
        const next = () => requestCost(sessionId, key, force);
        return source.promise.then(next, next);
      }
      if (!force && source.data && !costView(source).pending && source.dataKey === key && Date.now() - source.at < 30000) return Promise.resolve(source.data);
      // Mounting another footer or repeated visibility events must not create a
      // burst of stale/cold retries. Explicit clicks and the running timer bypass
      // this short backoff; changed usage always gets its own update.
      if (!force && source.key === key && source.attemptedAt !== null && Date.now() - source.attemptedAt < 5000) return Promise.resolve(source.data);
      source.key = key; source.loading = true; source.attemptedAt = Date.now();
      readCachedCost(source);
      source.promise = fetchCost(sessionId).then(result => {
        source.revision++;
        if (olderSnapshot(result, source.data)) {
          source.error = '返回了较旧的费用数据，已保留最近金额。';
        } else {
          source.data = result; source.dataKey = key; source.at = Date.now(); source.error = null;
        }
        return source.data;
      }).catch(error => {
        source.error = '费用暂时无法读取，点击后可重试。';
        throw error;
      }).finally(() => { source.promise = null; source.loading = false; publish(source); });
      publish(source);
      return source.promise;
    }
    function refreshCost(sessionId, key) {
      const source = costSource(sessionId);
      if (source.refreshPromise) return source.refreshPromise;
      source.refreshing = true;
      source.refreshPromise = (async () => {
        const response = await fetch('/api/conversation-cost/prices/refresh', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw Error('sync failed');
        // A GET already in flight may predate the completed price refresh.
        if (source.promise) await source.promise.catch(() => {});
        await requestCost(sessionId, key, true);
      })().catch(error => {
        source.error = '同步未完成，已保留当前价格。';
        throw error;
      }).finally(() => { source.refreshPromise = null; source.refreshing = false; publish(source); });
      publish(source);
      return source.refreshPromise;
    }
    function useCostState(sessionId, identity = sessionId) {
      const source = costSource(sessionId);
      const [state, setState] = React.useState(() => costView(source));
      const scope = React.useRef({ identity, active: true });
      // Invalidate outstanding click continuations during render, not only when
      // effects clean up: a session/message switch must never open the old dialog.
      if (scope.current.identity !== identity) scope.current = { identity, active: true };
      React.useEffect(() => {
        const token = scope.current; token.active = true;
        const accept = view => { if (token.active && scope.current === token) setState(view); };
        source.listeners.add(accept); accept(costView(source));
        return () => { token.active = false; source.listeners.delete(accept); };
      }, [sessionId, identity]);
      return { view: state.sessionId === sessionId ? state : costView(source), scope };
    }
    function completedTurn(snapshot, messageId) {
      for (const turn of snapshot.timeline.turns.values()) {
        const tail = turn.data.get('turn-tail');
        if (tail?.closing?.finalNode.messageId === messageId) return tail.turn;
      }
      return null;
    }
    function CostDialog({ data, close, refresh, busy, error, turn = null }) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        const previous = document.activeElement;
        const root = ref.current;
        root?.querySelector('button')?.focus();
        const onKey = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
          if (event.key === 'Tab') {
            const targets = [...root.querySelectorAll('button:not(:disabled),a[href]')];
            const first = targets[0], last = targets[targets.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => { document.removeEventListener('keydown', onKey, true); previous?.focus?.(); };
      }, []);
      const apiCalls = data.calls - data.subscriptionCalls;
      const api = knownAmount(data, false), equivalent = knownAmount(data, true);
      return createPortal(h('div', { className: 'dsh-cost-backdrop', onClick: event => { if (event.target === event.currentTarget) close(); } },
        h('div', { ref, className: 'dsh-cost-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dsh-cost-title' },
          h('div', { className: 'cost-row' }, h('h2', { id: 'dsh-cost-title' }, turn === null ? '本次对话费用' : '本轮回答费用'), h('button', { onClick: close, 'aria-label': '关闭费用明细' }, '关闭')),
          apiCalls > 0 || !data.calls ? h('div', null, h('div', { className: 'cost-total' }, api === null ? '未计价' : '≈' + api), h('div', { className: 'cost-muted' }, 'API 费用估算 · 美元 USD' + (partial(data) ? ' · 仅已计价部分' : ''))) : null,
          data.subscriptionCalls > 0 && h('div', { className: 'cost-notice' },
            h('strong', null, equivalent === null ? '订阅等值 · 未计价' : '订阅等值 ≈' + equivalent),
            h('div', null, 'Codex / OpenCode Go 使用订阅额度；此处按目录 API 价格折算参考价值，实际扣款金额无法按 Token 推算。')),
          h('p', { className: 'cost-muted cost-small' }, `${count(data.tokens)} Token · ${data.calls} 次用量记录。` +
            (turn === null ? '按当前价格估算本会话，不含子会话和 fork 继承的历史用量。' : `按当前价格估算第 ${turn} 轮回答，包含该轮的各次模型调用。`)),
          partial(data) && h('p', { className: 'cost-notice', role: 'status' }, `${data.unpricedCalls} 次调用的 ${count(data.unpricedTokens)} Token 尚未完整计价` + (data.missingUsage ? `；另有 ${data.missingUsage} 条回复未回报有效用量` : '') + '。未计价部分不会按免费处理。'),
          data.models.map((row, i) => h('div', { className: 'dsh-cost-model', key: i },
            h('div', { className: 'cost-row' }, h('strong', null, row.model), h('strong', null, row.unpricedTokens === row.tokens ? '未计价' : '≈' + money(row.amount))),
            h('div', { className: 'cost-muted cost-small' }, row.provider + (row.subscription ? ' · 订阅等值' : ' · API') + (row.period ? row.period === 'peak' ? ' · 峰时' : ' · 谷时' : '') + ' · ' + row.calls + ' 次'),
            h('dl', null, ...[
              ['普通输入', 'inputTokens', 'input'], ['缓存读取', 'cacheReadTokens', 'cache_read'],
              ['缓存写入', 'cacheWriteTokens', 'cache_write'], ['输出（含推理）', 'outputTokens', 'output'],
            ].flatMap(([label, field, key]) => [h('dt', { key: key + 'label' }, label), h('dd', { key }, count(row.usage[field]) + ' Token' + (row.rates?.[key] != null ? ` × $${row.rates[key]} / 百万` : row.usage[field] > 0 ? ' · 缺少价格' : ''))])),
            h('div', { className: 'cost-muted cost-small', style: { marginTop: 8 } }, row.unpricedTokens > 0 ? count(row.unpricedTokens) + ' Token 未计价 · ' : '',
              h('a', { href: row.source, target: '_blank', rel: 'noopener noreferrer' }, row.source.includes('deepseek.com') ? 'DeepSeek 官方定价' : 'models.dev 价格目录')),
            row.reference && h('div', { className: 'cost-muted cost-small' }, 'API 参考价：' + row.catalogRoute + '（Go 目录缺少此模型价格）'))),
          h('p', { className: 'cost-muted cost-small' }, '仅统计模型回报的 Token 用量，工具及其他按次收费不在此估算内。历史用量使用当前价格重估，金额不等同于账单。'),
          h('div', { className: 'dsh-cost-model cost-small cost-muted' },
            h('div', null, '模型目录更新：' + stamp(data.prices.catalogAt)),
            h('div', null, 'DeepSeek 定价更新：' + stamp(data.prices.deepseekAt)),
            h('div', { className: 'cost-row', style: { marginTop: 10 } }, h('span', null, '每 6 小时自动同步' + (data.prices.stale ? ' · 当前使用缓存' : '')), h('button', { onClick: refresh, disabled: busy }, busy ? '同步中…' : '立即同步价格')),
            (data.prices.errors.length > 0 || error) && h('p', { role: 'status' }, error || '部分来源同步失败，已保留最近成功的价格。')))), document.body);
    }
    function CostPill({ sessionId, useProjection, useSession }) {
      const usage = useProjection('tokenUsage');
      const running = useSession(snapshot => snapshot.running);
      const { view, scope } = useCostState(sessionId);
      const { data, error, busy, pending, loading } = view;
      const [openSession, setOpenSession] = React.useState(null);
      const openIntent = React.useRef(0);
      const open = openSession === sessionId;
      const key = JSON.stringify(usage);
      const usageKey = React.useRef(key); usageKey.current = key;
      React.useEffect(() => { setOpenSession(null); }, [sessionId]);
      React.useEffect(() => {
        if (!sessionId) return;
        let active = true;
        const load = (force = false) => {
          if (active && !document.hidden) return requestCost(sessionId, usageKey.current, force).catch(() => {});
        };
        void load();
        const timer = setInterval(() => { void load(running); }, running ? 5000 : 30000);
        const visible = () => { void load(); };
        document.addEventListener('visibilitychange', visible);
        return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
      }, [sessionId, running]);
      React.useEffect(() => {
        if (sessionId && !document.hidden) void requestCost(sessionId, key).catch(() => {});
      }, [sessionId, key]);
      function click() {
        const token = scope.current, intent = ++openIntent.current;
        if (data) setOpenSession(sessionId);
        void requestCost(sessionId, key, !!error || pending || !data).then(result => {
          if (!data && token.active && scope.current === token && openIntent.current === intent && result?.sessionId === sessionId) setOpenSession(sessionId);
        }).catch(() => {});
      }
      if (!sessionId) return null;
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dsh-cost-pill', 'data-composer-stat': 'cost',
          'aria-label': '查看本次对话费用', 'aria-haspopup': 'dialog', 'aria-expanded': open,
          title: error || '查看模型价格与费用明细（美元 USD）', onClick: click },
          pillText(data, error, loading)),
        open && data && h(CostDialog, { data, close: () => { openIntent.current++; setOpenSession(null); },
          refresh: () => { void refreshCost(sessionId, usageKey.current).catch(() => {}); }, busy, error }));
    }
    function TurnCost({ sessionId, messageId, useChat, useProjection }) {
      const turn = useChat(snapshot => completedTurn(snapshot, messageId));
      const usage = useProjection('tokenUsage');
      const key = JSON.stringify(usage);
      const identity = JSON.stringify([sessionId, messageId, turn]);
      const { view, scope } = useCostState(sessionId, identity);
      const { data: session, error, busy, pending, loading } = view;
      const [openIdentity, setOpenIdentity] = React.useState(null);
      const openIntent = React.useRef(0);
      const open = openIdentity === identity;
      React.useEffect(() => { setOpenIdentity(null); }, [identity]);
      React.useEffect(() => {
        if (sessionId && turn !== null && !document.hidden) void requestCost(sessionId, key).catch(() => {});
      }, [sessionId, turn, key]);
      const data = session?.sessionId === sessionId && session.turns?.[turn] ? { ...session.turns[turn], prices: session.prices, cache: session.cache } : null;
      function click() {
        const token = scope.current, intent = ++openIntent.current;
        if (data) setOpenIdentity(identity);
        void requestCost(sessionId, key, !!error || pending || !data).then(result => {
          if (!data && token.active && scope.current === token && openIntent.current === intent && result?.sessionId === sessionId && result.turns?.[turn]) setOpenIdentity(identity);
        }).catch(() => {});
      }
      if (!sessionId || turn === null) return null;
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dsh-cost-pill dsh-turn-cost', 'data-turn-cost': turn,
          'aria-label': '查看本轮回答费用', 'aria-haspopup': 'dialog', 'aria-expanded': open,
          title: error || '本轮回答费用（美元 USD）', onClick: click },
          pillText(data, error, loading)),
        open && data && h(CostDialog, { data, turn, close: () => { openIntent.current++; setOpenIdentity(null); },
          refresh: () => { void refreshCost(sessionId, key).catch(() => {}); }, busy, error }));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style'); style.dataset.plugin = 'dsh-conversation-cost';
          style.textContent = css; document.head.appendChild(style); return () => style.remove();
        });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'conversation-cost', order: 2,
        }, CostPill));
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: 'turn-cost', order: 30,
        }, TurnCost));
      },
    };
  },
});
