import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyLedger, foldEvent, foldEvents, summarize, summarizeTurns } from './cost.js';
import { createPriceStore } from './prices.js';

export const name = 'dsh-conversation-cost';
export const inject = ['connection', 'sessionQuery'];

export function apply(ctx) {
  const missing = [
    ['get', ctx?.get], ['on', ctx?.on], ['effect', ctx?.effect],
    ['sessionQuery.readSession', ctx?.sessionQuery?.readSession],
    ['connection.fetch.register', ctx?.connection?.fetch?.register],
  ].filter(([, method]) => typeof method !== 'function').map(([api]) => api);
  if (missing.length) throw new Error(`dsh-conversation-cost: Harness is missing required APIs: ${missing.join(', ')}`);
  const sessions = new Map();
  let disposed = false;
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const storePromise = createPriceStore(home);
  // The cache keeps usage counts and identities only, never prompt or response text.
  function touch(id) {
    let entry = sessions.get(id);
    if (entry) { sessions.delete(id); sessions.set(id, entry); return entry; }
    while (sessions.size >= 24) {
      const candidate = [...sessions].find(([, value]) => !value.loading);
      if (!candidate) break;
      sessions.delete(candidate[0]);
    }
    entry = { ledger: emptyLedger(), loading: true, buffered: [], promise: null };
    sessions.set(id, entry);
    entry.promise = Promise.resolve().then(async () => {
      const loaded = await ctx.sessionQuery.readSession(id);
      if (disposed) throw Error('Plugin disposed');
      // Forks inherit historical messages for context; the original session owns their cost.
      const inherited = loaded.inheritedEventCount ?? 0;
      foldEvents(entry.ledger, [...loaded.events, ...entry.buffered].filter(event => event.seq >= inherited));
      entry.buffered = [];
      entry.loading = false;
      return entry;
    }).catch(error => { if (sessions.get(id) === entry) sessions.delete(id); throw error; });
    return entry;
  }
  ctx.on('session/event', (session, event) => {
    const id = session.header?.id ?? session.id;
    const entry = sessions.get(id);
    if (!entry) return;
    if (entry.loading) entry.buffered.push(event);
    else foldEvent(entry.ledger, event);
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/conversation-cost', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const id = new URL(request.url).searchParams.get('sessionId');
      if (!id || id.length > 200 || !/^[\w-]+$/.test(id)) return Response.json({ error: 'invalid-session' }, { status: 400 });
      try {
        const [entry, prices] = await Promise.all([touch(id).promise, storePromise]);
        await prices.ensureCalendars(entry.ledger.records);
        return Response.json({ sessionId: id, ...summarize(entry.ledger, prices.get()),
          turns: summarizeTurns(entry.ledger, prices.get()), prices: prices.status() }, { headers: { 'cache-control': 'no-store' } });
      } catch {
        return Response.json({ error: 'session-unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
      }
    },
  }));
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/conversation-cost/prices/refresh', methods: ['POST'], requestBody: 'buffered',
    async fetch() {
      const store = await storePromise;
      await store.refresh();
      return Response.json(store.status(), { headers: { 'cache-control': 'no-store' } });
    },
  }));
  storePromise.then(store => { if (!disposed) void store.refresh(); }).catch(error => console.error('[conversation-cost] init:', String(error)));
  const timer = setInterval(() => { storePromise.then(store => store.tick()).catch(() => {}); }, 60000);
  timer.unref?.();
  ctx.effect(() => () => {
    disposed = true; clearInterval(timer); sessions.clear();
    void storePromise.then(store => store.dispose());
  });
}
