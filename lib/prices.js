import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCatalog, parseDeepseek } from './cost.js';

const SIX_HOURS = 6 * 3600000;
export async function createPriceStore(home, { fetcher = fetch, seed, now = Date.now } = {}) {
  seed ??= JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8'));
  let value = structuredClone(seed), inflight = null, disposed = false;
  const abort = new AbortController();
  const path = join(home, 'cache', 'dsh-conversation-cost', 'prices.json');
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    if (cached.version === 1 && cached.routes && cached.deepseek?.rates && cached.calendars &&
      Number.isFinite(cached.catalogAt) && Number.isFinite(cached.deepseekAt)) value = cached;
  } catch { /* First run or a damaged cache: use the shipped public snapshot. */ }
  let lastAttempt = 0;
  let errors = [], saving = Promise.resolve();
  async function save() {
    const snapshot = JSON.stringify(value);
    saving = saving.catch(() => {}).then(async () => {
      const temp = path + '.' + randomUUID() + '.tmp';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, path);
    });
    await saving;
  }
  async function text(url) {
    const response = await fetcher(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
      headers: { 'user-agent': 'dsh-conversation-cost/0.1.0' }, redirect: 'error' });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const body = await response.text();
    if (body.length > 30 * 1024 * 1024) throw Error('Price response too large');
    return body;
  }
  async function refresh() {
    if (disposed) return;
    if (inflight) return inflight;
    // One refresh request is shared by all open chats; failed sources retain their last success.
    lastAttempt = now();
    inflight = (async () => {
      const results = await Promise.allSettled([
        text('https://models.dev/api.json').then(body => parseCatalog(JSON.parse(body))),
        text('https://api-docs.deepseek.com/quick_start/pricing/').then(parseDeepseek),
      ]);
      if (disposed) return;
      const next = { ...value };
      errors = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          next[i === 0 ? 'routes' : 'deepseek'] = result.value;
          next[i === 0 ? 'catalogAt' : 'deepseekAt'] = now();
        } else errors.push(i === 0 ? 'models.dev' : 'DeepSeek');
      }
      value = next;
      try { await save(); } catch { errors.push('cache-write'); }
    })().finally(() => { inflight = null; });
    return inflight;
  }
  const yearAttempts = new Map(), yearInflight = new Map();
  async function ensureYear(year) {
    if (yearInflight.has(year)) return yearInflight.get(year);
    if (value.calendars[year] || disposed || now() - (yearAttempts.get(year) ?? 0) < SIX_HOURS) return;
    yearAttempts.set(year, now());
    const pending = (async () => {
      try {
        const calendar = JSON.parse(await text('https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/' + year + '.json'));
        if (String(calendar.year) !== year || !Array.isArray(calendar.days) || calendar.days.length === 0) throw Error('Invalid holiday calendar');
        const days = calendar.days.filter(day => day.isOffDay === true).map(day => day.date);
        if (days.length === 0 || days.some(day => typeof day !== 'string' || !day.startsWith(year + '-'))) throw Error('Invalid holiday dates');
        if (disposed) return;
        value = { ...value, calendars: { ...value.calendars, [year]: days } };
        await save();
      } catch { /* Unknown-year DeepSeek calls remain visibly unpriced. */ }
    })().finally(() => yearInflight.delete(year));
    yearInflight.set(year, pending);
    return pending;
  }
  return {
    get: () => value,
    status: () => ({ catalogAt: value.catalogAt, deepseekAt: value.deepseekAt, refreshing: !!inflight, errors: [...errors],
      stale: now() - value.catalogAt > SIX_HOURS || now() - value.deepseekAt > SIX_HOURS }),
    refresh,
    tick: () => now() - lastAttempt >= SIX_HOURS ? refresh() : Promise.resolve(),
    async ensureCalendars(records) {
      const years = new Set(records.filter(r => ['deepseek', 'deepseek-official', 'deepseek-account'].includes(r.provider))
        .map(r => Number.isFinite(new Date(r.time).getTime()) ? new Date(new Date(r.time).getTime() + 8 * 3600000).getUTCFullYear().toString() : null).filter(Boolean));
      await Promise.all([...years].map(ensureYear));
    },
    dispose() { disposed = true; abort.abort(); },
  };
}
