import * as fs from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const MAX_BYTES = 16 * 1024 * 1024;
const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
export const validSessionId = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && /^[\w-]+$/.test(id);
const count = n => Number.isSafeInteger(n) && n >= 0;
const turn = n => n === null || count(n);
const tombstone = (raw, id) => raw?.version === VERSION && raw.sessionId === id && raw.deleted === true && count(raw.deletedAt);
const route = r => r === null || r && typeof r.provider === 'string' && typeof r.model === 'string';

// Explicit allowlist: no original events, messages, prompts, credentials or replay state.
export function encodeSnapshot(sessionId, ledger, inheritedEventCount, updatedAt) {
  return {
    version: VERSION, sessionId, inheritedEventCount, updatedAt,
    ledger: {
      lastSeq: ledger.lastSeq, route: ledger.route ? { provider: ledger.route.provider, model: ledger.route.model } : null,
      turn: ledger.turn, missingUsage: ledger.missingUsage,
      missingUsageByTurn: [...ledger.missingUsageByTurn].map(([id, amount]) => [id, amount]),
      records: ledger.records.map(record => ({
        ...Object.fromEntries(buckets.map(key => [key, record[key]])),
        provider: record.provider, model: record.model, time: record.time, turn: record.turn,
      })),
    },
  };
}
export function decodeSnapshot(raw, sessionId) {
  const l = raw?.ledger;
  if (raw?.version !== VERSION || raw.sessionId !== sessionId || !count(raw.inheritedEventCount) ||
      !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0 || !l ||
      !Number.isSafeInteger(l.lastSeq) || l.lastSeq < -1 || !route(l.route) || !turn(l.turn) ||
      !count(l.missingUsage) || !Array.isArray(l.records) || !Array.isArray(l.missingUsageByTurn)) return null;
  if (l.records.some(r => !r || typeof r.provider !== 'string' || typeof r.model !== 'string' ||
      !Number.isSafeInteger(r.time) || r.time < 0 || r.time > 8640000000000000 - 8 * 3600000 ||
      !turn(r.turn) || buckets.some(key => !count(r[key])))) return null;
  const seen = new Set();
  let missing = 0;
  for (const pair of l.missingUsageByTurn) {
    if (!Array.isArray(pair) || pair.length !== 2 || !count(pair[0]) || !count(pair[1]) || seen.has(pair[0])) return null;
    seen.add(pair[0]); missing += pair[1];
  }
  if (missing > l.missingUsage) return null;
  const clean = encodeSnapshot(sessionId, { ...l, missingUsageByTurn: new Map(l.missingUsageByTurn) }, raw.inheritedEventCount, raw.updatedAt);
  return { ...clean, ledger: { ...clean.ledger, missingUsageByTurn: new Map(clean.ledger.missingUsageByTurn) } };
}

export function createSessionCache(home, { io = fs, report = () => {} } = {}) {
  const root = resolve(home, 'cache', 'dsh-conversation-cost', 'sessions');
  const writes = new Map();
  function pathFor(id) {
    if (!validSessionId(id)) throw Error('invalid-session');
    const path = resolve(root, id + '.json');
    if (dirname(path) !== root) throw Error('invalid-session');
    return path;
  }
  async function readRaw(id) {
    const path = pathFor(id);
    if ((await io.stat(path)).size > MAX_BYTES) throw Error('cache-too-large');
    return JSON.parse(await io.readFile(path, 'utf8'));
  }
  async function read(id) {
    try {
      const raw = await readRaw(id);
      if (tombstone(raw, id)) return null;
      const result = decodeSnapshot(raw, id);
      if (!result) report('cache-invalid', id);
      return result;
    } catch (error) {
      if (error?.code !== 'ENOENT') report('cache-read-failed', id);
      return null;
    }
  }
  async function withLock(id, fn) {
    // A per-session lock covers read/compare/rename AND deletion, including other hosts.
    // Failed locks are bounded; never steal a living owner's lock based only on its age.
    const path = pathFor(id), lock = path + '.lock';
    if (dirname(lock) !== root) throw Error('invalid-lock-path');
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    await io.chmod(root, 0o700);
    const deadline = performance.now() + 2000;
    let handle;
    while (!handle) {
      try {
        handle = await io.open(lock, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } catch (error) {
        if (handle) { await handle.close().catch(() => {}); await io.unlink(lock).catch(() => {}); throw error; }
        if (error?.code !== 'EEXIST') throw error;
        // Do not auto-reap stale locks: stat + unlink is not atomic across hosts and
        // can delete a new owner's lock. A crashed owner's lock needs explicit cleanup.
        if (performance.now() >= deadline) throw Error('cache-lock-timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await fn(); } finally {
      const owned = await handle.stat().catch(() => null);
      await handle.close().catch(() => {});
      try { if (owned && (await io.stat(lock)).ino === owned.ino) await io.unlink(lock); } catch { /* Already absent. */ }
    }
  }
  async function replace(id, snapshot) {
    const path = pathFor(id), temp = join(root, id + '.' + randomUUID() + '.tmp');
    if (dirname(temp) !== root) throw Error('invalid-temp-path');
    try {
      const body = JSON.stringify(snapshot);
      if (Buffer.byteLength(body) > MAX_BYTES) throw Error('cache-too-large');
      await io.writeFile(temp, body, { mode: 0o600, flag: 'wx' });
      await io.rename(temp, path);
    } finally {
      // Absolute temp path is anchored beneath the checked cache root.
      await io.unlink(temp).catch(() => {});
    }
  }
  function write(id, ledger, inheritedEventCount, updatedAt) {
    const snapshot = encodeSnapshot(id, ledger, inheritedEventCount, updatedAt);
    if (!decodeSnapshot(snapshot, id)) { report('cache-invalid', id); return Promise.resolve(false); }
    let task = writes.get(id);
    if (task) { task.latest = snapshot; return task.promise; }
    task = { latest: snapshot, promise: null };
    writes.set(id, task);
    task.promise = (async () => {
      let ok = true;
      while (task.latest) {
        const next = task.latest; task.latest = null;
        try {
          await withLock(id, async () => {
            let previous;
            try { previous = await readRaw(id); } catch { /* Missing or corrupt snapshot can be replaced. */ }
            if (tombstone(previous, id)) return;
            const validPrevious = decodeSnapshot(previous, id);
            // Compare only validated snapshots; corrupt metadata must not prevent self-healing.
            if (validPrevious && (validPrevious.updatedAt > next.updatedAt ||
                validPrevious.updatedAt === next.updatedAt && validPrevious.ledger.lastSeq > next.ledger.lastSeq)) return;
            await replace(id, next);
          });
          ok = true;
        } catch { ok = false; report('cache-write-failed', id); }
      }
      return ok;
    })().finally(() => { if (writes.get(id) === task) writes.delete(id); });
    return task.promise;
  }
  async function remove(id) {
    await writes.get(id)?.promise;
    try {
      // A minimal tombstone prevents an older queued writer in another process from reviving
      // the deleted usage. It contains only the session id and deletion time, not the ledger.
      await withLock(id, () => replace(id, { version: VERSION, sessionId: id, deleted: true, deletedAt: Date.now() }));
    } catch { report('cache-remove-failed', id); }
  }
  async function drain() { while (writes.size) await Promise.all([...writes.values()].map(task => task.promise)); }
  async function isDeleted(id) {
    try {
      const raw = await readRaw(id);
      return tombstone(raw, id);
    } catch { return false; }
  }
  return { read, write, remove, drain, pathFor, isDeleted };
}
