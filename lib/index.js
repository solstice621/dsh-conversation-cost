import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyLedger, foldEvent, foldEvents, summarize, summarizeTurns } from './cost.js';
import { createPriceStore } from './prices.js';
import { createSessionCache, validSessionId } from './session-cache.js';

export const name = 'dsh-conversation-cost';
export const inject = ['connection', 'sessionQuery'];
const REVALIDATE_MS = 5 * 60 * 1000;

export function apply(ctx) {
  const missing = [
    ['get', ctx?.get], ['on', ctx?.on], ['effect', ctx?.effect],
    ['sessionQuery.readSession', ctx?.sessionQuery?.readSession],
    ['connection.fetch.register', ctx?.connection?.fetch?.register],
  ].filter(([, method]) => typeof method !== 'function').map(([api]) => api);
  if (missing.length) throw new Error(`dsh-conversation-cost: Harness is missing required APIs: ${missing.join(', ')}`);
  const sessions = new Map();
  let disposed = false, closing = false;
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  function report(code, id = '') {
    // Only fixed diagnostics and an already validated session id; never stringify upstream errors.
    try { console.warn('[conversation-cost]', code, validSessionId(id) ? id : ''); } catch { /* Logging must not break accounting. */ }
  }
  const disk = createSessionCache(home, { report });
  const storePromise = createPriceStore(home);
  storePromise.catch(() => report('prices-init-failed'));

  function persist(id, entry) {
    if (!entry.authoritative || !entry.ledger) return Promise.resolve();
    return disk.write(id, entry.ledger, entry.inheritedEventCount, entry.updatedAt).then(ok => {
      entry.writeError = ok ? null : 'cache-write-failed';
    });
  }
  function scheduleSave(id, entry) {
    if (disposed || closing || entry.saveTimer) return;
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null;
      void persist(id, entry);
    }, 500);
    entry.saveTimer.unref?.();
  }
  function touch(id) {
    let entry = sessions.get(id);
    if (entry) { sessions.delete(id); sessions.set(id, entry); return entry; }
    while (sessions.size >= 24) {
      const candidate = [...sessions].find(([, value]) => !value.loading && !value.restoring);
      if (!candidate) break;
      const [oldId, old] = candidate;
      clearTimeout(old.saveTimer); old.saveTimer = null;
      void persist(oldId, old);
      sessions.delete(oldId);
    }
    entry = { ledger: null, authoritative: false, inheritedEventCount: 0, updatedAt: 0,
      loading: false, restoring: true, buffered: [], promise: null, restore: null,
      saveTimer: null, error: null, writeError: null, validatedAt: 0, disposeEpoch: 0,
      liveSession: null, liveReady: null, resolveLive: null, summary: null, summaryLedger: null, summaryPrices: null };
    sessions.set(id, entry);
    entry.restore = disk.read(id).then(cached => {
      if (disposed) return;
      if (cached) {
        entry.ledger = cached.ledger;
        entry.inheritedEventCount = cached.inheritedEventCount;
        entry.updatedAt = cached.updatedAt;
      }
    }).finally(() => { entry.restoring = false; });
    return entry;
  }
  function validate(id, entry, liveSession) {
    if (entry.loading) return entry.promise;
    if (entry.authoritative && Date.now() - entry.validatedAt < REVALIDATE_MS) return Promise.resolve(entry);
    entry.authoritative = false;
    entry.loading = true;
    const disposeEpoch = entry.disposeEpoch;
    entry.liveSession ??= typeof liveSession?.snapshotEvents === 'function' ? liveSession : null;
    entry.liveReady = new Promise(resolve => { entry.resolveLive = resolve; });
    if (entry.liveSession) entry.resolveLive(entry.liveSession);
    entry.promise = (async () => {
      await entry.restore;
      if (disposed) throw Error('disposed');
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('session-read-timeout')), 15000);
          timer.unref?.();
        });
        const readLive = session => ({ inheritedEventCount: session.inheritedEventCount ?? 0, events: session.snapshotEvents() });
        const loaded = await Promise.race([
          Promise.resolve().then(() => entry.liveSession ? readLive(entry.liveSession) : ctx.sessionQuery.readSession(id)),
          entry.liveReady.then(readLive), timeout,
        ]);
        if (disposed || entry.disposeEpoch !== disposeEpoch) throw Error('disposed-session-observation');
        // A different host may have deleted this generation while its read was in flight.
        if (await disk.isDeleted(id)) throw Object.assign(Error('deleted-session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
        if (disposed || entry.disposeEpoch !== disposeEpoch) throw Error('disposed-session-observation');
        const current = entry.liveSession ? readLive(entry.liveSession) : loaded;
        const inherited = current.inheritedEventCount ?? 0;
        if (!Number.isSafeInteger(inherited) || inherited < 0 || !Array.isArray(current.events)) throw Error('invalid-session-log');
        // Replay once in the background after restart/eviction. Rebuild rather than blindly
        // append to a snapshot: fork ownership, repaired/truncated logs and old totals are verified.
        const combined = [...current.events, ...entry.buffered].filter(event => event.seq >= inherited);
        const seqs = [...new Set(combined.map(event => event.seq))].sort((a, b) => a - b);
        if (seqs.some((seq, i) => !Number.isSafeInteger(seq) || (i > 0 && seq !== seqs[i - 1] + 1))) throw Error('session-event-gap');
        const ledger = foldEvents(emptyLedger(), combined);
        ledger.lastSeq = Math.max(ledger.lastSeq, inherited - 1);
        entry.ledger = ledger; entry.inheritedEventCount = inherited;
        entry.buffered = []; entry.authoritative = true; entry.error = null;
        entry.updatedAt = Date.now(); entry.validatedAt = entry.updatedAt; entry.summary = null;
        scheduleSave(id, entry);
        return entry;
      } finally { clearTimeout(timer); }
    })().catch(async error => {
      if (!disposed) {
        const unavailable = error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND';
        if (entry.error !== 'session-read-failed') report('session-read-failed', id);
        entry.error = 'session-read-failed';
        if (unavailable) {
          entry.ledger = null; entry.summary = null; entry.buffered = [];
          await disk.remove(id);
        }
      }
      throw error;
    }).finally(() => {
      entry.loading = false; entry.promise = null;
      entry.liveSession = null; entry.liveReady = null; entry.resolveLive = null;
    });
    // Background revalidation may not have a foreground waiter.
    entry.promise.catch(() => {});
    return entry.promise;
  }
  function response(id, entry, prices, cachedOnly = false) {
    const ledger = entry.ledger, values = prices.get();
    // No repeatedly scanning even the reduced usage ledger when only UI polling occurs.
    if (!entry.summary || entry.summaryLedger !== ledger || entry.summaryCalls !== ledger.records.length ||
        entry.summaryMissing !== ledger.missingUsage || entry.summaryPrices !== values) {
      entry.summary = { ...summarize(ledger, values), turns: summarizeTurns(ledger, values) };
      entry.summaryLedger = ledger; entry.summaryCalls = ledger.records.length;
      entry.summaryMissing = ledger.missingUsage; entry.summaryPrices = values;
    }
    return Response.json({ sessionId: id, ...entry.summary, prices: prices.status(),
      cache: { state: entry.error ? 'stale' : entry.authoritative && !cachedOnly ? 'fresh' : 'cached',
        throughSeq: ledger.lastSeq, updatedAt: entry.updatedAt,
        ...(entry.error || entry.writeError ? { error: entry.error || entry.writeError } : {}) } },
      { headers: { 'cache-control': 'no-store' } });
  }
  ctx.on('session/event', (session, event) => {
    const id = session.header?.id ?? session.id;
    if (disposed || closing || !validSessionId(id)) return;
    let entry = sessions.get(id);
    // Capture completed usage even if the cost panel has not yet been opened.
    if (!entry && event.type === 'assistant/message') { entry = touch(id); void validate(id, entry, session); }
    if (!entry) return;
    if (!entry.authoritative) {
      if (typeof session.snapshotEvents === 'function') {
        entry.liveSession = session; entry.resolveLive?.(session);
      }
      entry.buffered.push(event); return;
    }
    if (event.seq < entry.inheritedEventCount || event.seq <= entry.ledger.lastSeq) return;
    if (event.seq > entry.ledger.lastSeq + 1) {
      // A missed notification must not make a partial incremental total appear authoritative.
      entry.authoritative = false; entry.buffered.push(event);
      void validate(id, entry, session); return;
    }
    foldEvent(entry.ledger, event);
    entry.updatedAt = Date.now(); scheduleSave(id, entry);
  });
  ctx.on('session/flush', session => {
    const id = session.header?.id ?? session.id, entry = sessions.get(id);
    if (disposed || !entry) return;
    clearTimeout(entry.saveTimer); entry.saveTimer = null;
    return persist(id, entry);
  });
  ctx.on('session/disposed', session => {
    const id = session.header?.id ?? session.id, entry = sessions.get(id);
    if (disposed || !entry) return;
    clearTimeout(entry.saveTimer); entry.saveTimer = null;
    void persist(id, entry);
    entry.disposeEpoch++;
    entry.authoritative = false; // Closure may precede deletion or repair; verify on next lookup.
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/conversation-cost', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url), id = url.searchParams.get('sessionId');
      if (!validSessionId(id)) return Response.json({ error: 'invalid-session' }, { status: 400 });
      if (closing || disposed) return Response.json({ error: 'session-unavailable' }, { status: 503 });
      const cachedOnly = url.searchParams.get('cached') === '1';
      const entry = touch(id);
      try {
        const [, prices] = await Promise.all([entry.restore, storePromise]);
        if (disposed) throw Error('disposed');
        if (cachedOnly) return entry.ledger ? response(id, entry, prices, true) :
          Response.json({ error: 'cache-miss' }, { status: 404, headers: { 'cache-control': 'no-store' } });
        const pending = validate(id, entry);
        // A persisted result is immediately useful. No full-session I/O or network calendar
        // fetch lies on its display path; freshness is explicit until validation finishes.
        if (!entry.ledger) await pending;
        if (!entry.ledger) throw Error('session-unavailable');
        // Keep pricing/calendar enrichment off the response's critical path.
        void prices.ensureCalendars(entry.ledger.records).catch(() => report('calendar-read-failed', id));
        return response(id, entry, prices);
      } catch {
        if (!disposed && entry.ledger) {
          try { return response(id, entry, await storePromise); } catch { /* Unavailable initial price seed. */ }
        }
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
  storePromise.then(store => { if (!disposed && !closing) void store.refresh(); }).catch(() => {});
  const timer = setInterval(() => { storePromise.then(store => store.tick()).catch(() => report('prices-tick-failed')); }, 60000);
  timer.unref?.();
  ctx.effect(() => async () => {
    closing = true; clearInterval(timer);
    // Give an already admitted first-load/live observation a bounded checkpoint window.
    // Never persist provisional fork totals if a hung canonical read cannot finish.
    let graceTimer;
    await Promise.race([
      Promise.allSettled([...sessions.values()].map(entry => entry.promise ?? entry.restore)),
      new Promise(resolve => { graceTimer = setTimeout(resolve, 2000); }),
    ]);
    clearTimeout(graceTimer); disposed = true;
    const saves = [];
    for (const [id, entry] of sessions) {
      clearTimeout(entry.saveTimer); entry.saveTimer = null;
      saves.push(persist(id, entry));
    }
    await Promise.all(saves); await disk.drain(); sessions.clear();
    await storePromise.then(store => store.dispose()).catch(() => {});
  });
}
