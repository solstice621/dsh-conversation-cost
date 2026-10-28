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
    function pillText(data) {
      if (!data || ((data.calls > 0 || data.missingUsage > 0) &&
        !data.models.some(row => row.unpricedTokens < row.tokens))) return 'Cost ≈—';
      return 'Cost ≈' + money(data.apiCost + data.subscriptionEquivalent);
    }
    // One cached request feeds the composer and every answer footer in a chat.
    // Footer subscriptions reuse the composer's polling instead of adding one
    // interval or network request per answer.
    const sessionCosts = new Map();
    function costSource(sessionId) {
      let entry = sessionCosts.get(sessionId);
      if (!entry) {
        if (sessionCosts.size >= 24) {
          const idle = [...sessionCosts].find(([, source]) => !source.promise && source.listeners.size === 0);
          if (idle) sessionCosts.delete(idle[0]);
        }
        entry = { data: null, key: null, at: 0, promise: null, listeners: new Set() };
        sessionCosts.set(sessionId, entry);
      }
      return entry;
    }
    function requestCost(sessionId, key, force = false) {
      const source = costSource(sessionId);
      if (source.promise) return source.key === key ? source.promise : source.promise.then(() => requestCost(sessionId, key, true));
      if (!force && source.data && source.key === key && Date.now() - source.at < 1000) return Promise.resolve(source.data);
      source.key = key;
      source.promise = (async () => {
        const response = await fetch('/api/conversation-cost?sessionId=' + encodeURIComponent(sessionId), {
          signal: AbortSignal.timeout(20000), credentials: 'same-origin',
        });
        if (!response.ok) throw Error('读取失败');
        const result = await response.json();
        if (result.sessionId !== sessionId) throw Error('会话不匹配');
        source.data = result; source.at = Date.now();
        for (const listener of source.listeners) listener(result);
        return result;
      })().finally(() => { source.promise = null; });
      return source.promise;
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
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const loadRef = React.useRef(null);
      const alive = React.useRef(false);
      const usageKey = React.useRef(null);
      usageKey.current = JSON.stringify(usage);
      React.useEffect(() => { setData(null); setError(null); setOpen(false); setBusy(false); }, [sessionId]);
      React.useEffect(() => {
        alive.current = true;
        if (!sessionId) return () => { alive.current = false; };
        let active = true, inflight = null;
        async function load(force = false) {
          if (!active || document.hidden) return;
          if (inflight) return inflight;
          inflight = (async () => {
            try {
              const result = await requestCost(sessionId, usageKey.current, force === true);
              if (active && result.sessionId === sessionId) { setData(result); setError(null); }
            } catch (e) { if (active && e.name !== 'AbortError') setError('费用暂时无法读取，点击后可重试。'); }
          })().finally(() => { inflight = null; });
          return inflight;
        }
        loadRef.current = load;
        void load();
        const timer = setInterval(load, running ? 5000 : 30000);
        document.addEventListener('visibilitychange', load);
        return () => { active = false; alive.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', load); if (loadRef.current === load) loadRef.current = null; };
      }, [sessionId, running]);
      React.useEffect(() => { void loadRef.current?.(); }, [usage]);
      async function refresh() {
        setBusy(true);
        try {
          const response = await fetch('/api/conversation-cost/prices/refresh', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(45000) });
          if (!response.ok) throw Error('sync failed');
          await loadRef.current?.(true);
        } catch { if (alive.current) setError('同步未完成，已保留当前价格。'); }
        finally { if (alive.current) setBusy(false); }
      }
      if (!sessionId) return null;
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dsh-cost-pill', 'data-composer-stat': 'cost',
          'aria-label': '查看本次对话费用', 'aria-haspopup': 'dialog', 'aria-expanded': open,
          title: error || '查看模型价格与费用明细（美元 USD）', onClick: () => { void loadRef.current?.(); if (data) setOpen(true); } },
          pillText(data)),
        open && data && h(CostDialog, { data, close: () => setOpen(false), refresh, busy, error }));
    }
    function TurnCost({ sessionId, messageId, useChat, useProjection }) {
      const turn = useChat(snapshot => completedTurn(snapshot, messageId));
      const usage = useProjection('tokenUsage');
      const key = JSON.stringify(usage);
      const [session, setSession] = React.useState(() => costSource(sessionId).data);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        let active = true;
        setOpen(false); setError(null);
        const source = costSource(sessionId);
        const accept = value => { if (active) { setSession(value); setError(null); } };
        source.listeners.add(accept);
        if (source.data) accept(source.data);
        if (turn !== null && !document.hidden) requestCost(sessionId, key).then(accept).catch(() => {
          if (active) setError('暂时无法读取本轮费用。');
        });
        return () => { active = false; source.listeners.delete(accept); };
      }, [sessionId, messageId, turn, key]);
      const data = session?.sessionId === sessionId && session.turns?.[turn] ? { ...session.turns[turn], prices: session.prices } : null;
      async function refresh() {
        setBusy(true);
        try {
          const response = await fetch('/api/conversation-cost/prices/refresh', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(45000) });
          if (!response.ok) throw Error('sync failed');
          await requestCost(sessionId, key, true);
        } catch { setError('同步未完成，已保留当前价格。'); }
        finally { setBusy(false); }
      }
      if (turn === null) return null;
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dsh-cost-pill dsh-turn-cost', 'data-turn-cost': turn,
          'aria-label': '查看本轮回答费用', 'aria-haspopup': 'dialog', 'aria-expanded': open,
          title: error || '本轮回答费用（美元 USD）', onClick: () => {
            if (data) setOpen(true);
            else requestCost(sessionId, key, true).then(setSession).catch(() => setError('暂时无法读取本轮费用。'));
          } }, pillText(data)),
        open && data && h(CostDialog, { data, turn, close: () => setOpen(false), refresh, busy, error }));
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
