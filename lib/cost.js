// Harness usage has four disjoint buckets. Reasoning is already in output.
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const keys = ['input', 'output', 'cache_read', 'cache_write'];
const subscriptions = new Map([
  ['codex-subscription', 'openai'], ['openai-codex', 'openai'],
  ['opencode-go-subscription', 'opencode-go'], ['opencode-go', 'opencode-go'],
]);

export function emptyLedger() {
  return { lastSeq: -1, route: null, records: [], missingUsage: 0, turn: null, missingUsageByTurn: new Map() };
}

export function foldEvent(ledger, event) {
  if (!Number.isSafeInteger(event?.seq) || event.seq <= ledger.lastSeq) return;
  ledger.lastSeq = event.seq;
  const data = event.data;
  if (event.type === 'turn/start' && Number.isSafeInteger(data?.turn)) ledger.turn = data.turn;
  if (event.type === 'request/header' && data?.header?.config) {
    const { provider, model } = data.header.config;
    // A malformed request must not inherit a previous request's route.
    ledger.route = typeof provider === 'string' && typeof model === 'string' ? { provider, model } : null;
  }
  if (event.type !== 'assistant/message') return;
  const turn = Number.isSafeInteger(data?.turn) ? data.turn : ledger.turn;
  function missingUsage() {
    ledger.missingUsage += 1;
    if (turn !== null) ledger.missingUsageByTurn.set(turn, (ledger.missingUsageByTurn.get(turn) ?? 0) + 1);
  }
  const usage = data?.usage;
  if (!usage || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) { missingUsage(); return; }
  if (fields.some(key => usage[key] !== undefined && (!Number.isFinite(usage[key]) || usage[key] < 0))) {
    missingUsage(); return;
  }
  const source = data.message?.source;
  const route = typeof source?.provider === 'string' && typeof source?.model === 'string' ? source : ledger.route;
  const counts = Object.fromEntries(fields.map(key => [key, usage[key] ?? 0]));
  if (!fields.some(key => counts[key] > 0)) return;
  ledger.records.push({ ...counts, provider: route?.provider ?? '', model: route?.model ?? '', time: event.time, turn });
}

export function foldEvents(ledger, events) {
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) foldEvent(ledger, event);
  return ledger;
}

export function parseCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid model catalog');
  const routes = {};
  for (const [provider, entry] of Object.entries(raw)) {
    for (const [id, model] of Object.entries(entry?.models ?? {})) {
      const cost = model?.cost;
      if (!cost || !Number.isFinite(cost.input) || cost.input < 0 || !Number.isFinite(cost.output) || cost.output < 0) continue;
      const cleaned = Object.fromEntries(keys.filter(k => Number.isFinite(cost[k]) && cost[k] >= 0).map(k => [k, cost[k]]));
      if (Array.isArray(cost.tiers)) cleaned.tiers = cost.tiers;
      else if (cost.context_over_200k) cleaned.tiers = [{ ...cost.context_over_200k, tier: { type: 'context', size: 200000 } }];
      routes[provider + '/' + id] = cleaned;
    }
  }
  if (Object.keys(routes).length === 0) throw Error('Empty model price catalog');
  return routes;
}

const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export function parseDeepseek(html) {
  const table = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw Error('DeepSeek pricing table missing');
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => plain(cell[1])));
  const header = rows.find(row => row[0] === 'MODEL');
  const models = header?.slice(1).map(cell => cell.match(/^([\w.-]+)/)?.[1]);
  if (!models?.length || models.some(id => !id?.startsWith('deepseek-'))) throw Error('DeepSeek model columns changed');
  const rates = Object.fromEntries(models.map(id => [id, { offPeak: {}, peak: {} }]));
  let bucket = null;
  for (const row of rows) {
    const text = row.join(' ');
    if (/CACHE HIT/.test(text)) bucket = 'cache_read';
    else if (/CACHE MISS/.test(text)) bucket = 'input';
    else if (/1M OUTPUT TOKENS/.test(text)) bucket = 'output';
    const prices = row.filter(cell => /^\$\d+(?:\.\d+)?$/.test(cell)).map(cell => Number(cell.slice(1)));
    if (!prices.length || bucket === null) continue;
    const period = row.includes('OFF-PEAK') ? 'offPeak' : row.includes('PEAK') ? 'peak' : null;
    if (period === null || prices.length !== models.length) throw Error('DeepSeek price columns changed');
    models.forEach((id, i) => { rates[id][period][bucket] = prices[i]; });
  }
  for (const model of Object.values(rates)) for (const period of ['offPeak', 'peak']) {
    if (['input', 'output', 'cache_read'].some(k => !Number.isFinite(model[period][k]) || model[period][k] < 0)) throw Error('Incomplete DeepSeek prices');
    model[period].cache_write = model[period].input;
  }
  const text = plain(html);
  const schedule = text.match(/Peak hours are (\d\d):(\d\d)\s*[-–]\s*(\d\d):(\d\d) and (\d\d):(\d\d)\s*[-–]\s*(\d\d):(\d\d) UTC, Monday through Friday, excluding Chinese public holidays/i);
  if (!schedule) throw Error('DeepSeek peak schedule changed');
  const n = schedule.slice(1).map(Number);
  return { rates, peakWindows: [[n[0] * 60 + n[1], n[2] * 60 + n[3]], [n[4] * 60 + n[5], n[6] * 60 + n[7]]] };
}

function periodAt(time, prices) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return null;
  const beijing = new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const holidays = prices.calendars?.[beijing.slice(0, 4)];
  if (!Array.isArray(holidays)) return null;
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays.includes(beijing) &&
    prices.deepseek.peakWindows.some(([a, b]) => minute >= a && minute < b) ? 'peak' : 'offPeak';
}

export function priceRecord(record, prices) {
  const subscription = subscriptions.has(record.provider);
  let provider = subscriptions.get(record.provider) ?? record.provider;
  if (provider === 'deepseek-official' || provider === 'deepseek-account') provider = 'deepseek';
  let rate, source, period = null, catalogRoute = null, reference = false;
  if (provider === 'deepseek') {
    const id = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(record.model) ? 'deepseek-flash' : record.model;
    period = prices.deepseek ? periodAt(record.time, prices) : null;
    rate = period && prices.deepseek.rates[id]?.[period];
    source = 'https://api-docs.deepseek.com/quick_start/pricing/';
  } else {
    catalogRoute = provider + '/' + record.model;
    rate = prices.routes?.[catalogRoute];
    // Go drops retired model IDs from its catalog. For subscription equivalents
    // only, Zen's exact same ID is a usable API reference; never rename it to a
    // newer model or use another route's price for an actual API bill estimate.
    if (!rate && subscription && provider === 'opencode-go') {
      const zenRoute = 'opencode/' + record.model;
      if (prices.routes?.[zenRoute]) {
        rate = prices.routes[zenRoute]; catalogRoute = zenRoute; reference = true;
      }
    }
    source = 'https://models.dev';
  }
  if (!rate) return { subscription, amount: null, source, period, catalogRoute, reference };
  const context = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens;
  let selected = { ...rate };
  const tiers = [...(rate.tiers ?? [])];
  if (tiers.some(tier => tier.tier?.type !== 'context' || !Number.isFinite(tier.tier.size))) return { subscription, amount: null, source, period, catalogRoute, reference };
  for (const tier of tiers.sort((a, b) => a.tier.size - b.tier.size)) {
    if (context > tier.tier.size) selected = { ...selected, ...tier };
  }
  let amount = 0, unpricedTokens = 0;
  const breakdown = {};
  fields.forEach((field, i) => {
    const tokens = record[field];
    const unit = selected[keys[i]];
    if (tokens > 0 && (!Number.isFinite(unit) || unit < 0)) { unpricedTokens += tokens; return; }
    const value = tokens ? tokens * unit / 1e6 : 0;
    amount += value;
    breakdown[keys[i]] = value;
  });
  return { subscription, amount, unpricedTokens, breakdown, rates: Object.fromEntries(keys.map(key => [key, selected[key] ?? null])), source, period, catalogRoute, reference };
}

export function summarize(ledger, prices) {
  const result = { currency: 'USD', apiCost: 0, subscriptionEquivalent: 0, tokens: 0, calls: ledger.records.length,
    unpricedTokens: 0, unpricedCalls: 0, subscriptionCalls: 0, missingUsage: ledger.missingUsage, models: [] };
  const groups = new Map();
  for (const record of ledger.records) {
    const priced = priceRecord(record, prices);
    const tokens = fields.reduce((sum, key) => sum + record[key], 0);
    result.tokens += tokens;
    if (priced.subscription) result.subscriptionCalls += 1;
    const missing = priced.amount === null ? tokens : priced.unpricedTokens;
    result.unpricedTokens += missing;
    if (missing) result.unpricedCalls += 1;
    if (priced.amount !== null) result[priced.subscription ? 'subscriptionEquivalent' : 'apiCost'] += priced.amount;
    const key = [record.provider, record.model, priced.period, priced.catalogRoute, JSON.stringify(priced.rates)].join('|');
    if (!groups.has(key)) groups.set(key, { provider: record.provider || 'unknown', model: record.model || 'unknown',
      subscription: priced.subscription, amount: 0, tokens: 0, unpricedTokens: 0, calls: 0, source: priced.source,
      period: priced.period, rates: priced.rates ?? null, catalogRoute: priced.catalogRoute, reference: priced.reference,
      usage: Object.fromEntries(fields.map(key => [key, 0])) });
    const row = groups.get(key);
    row.amount += priced.amount ?? 0; row.tokens += tokens; row.unpricedTokens += missing; row.calls += 1;
    for (const field of fields) row.usage[field] += record[field];
  }
  result.models = [...groups.values()];
  return result;
}

// The native answer footer represents one completed turn, including all model
// steps used to produce that answer. Price each step before adding the costs.
export function summarizeTurns(ledger, prices) {
  const turns = new Map();
  function ensure(turn) {
    if (!turns.has(turn)) turns.set(turn, { records: [], missingUsage: 0 });
    return turns.get(turn);
  }
  for (const record of ledger.records) {
    if (Number.isSafeInteger(record.turn)) ensure(record.turn).records.push(record);
  }
  for (const [turn, count] of ledger.missingUsageByTurn ?? []) ensure(turn).missingUsage = count;
  return Object.fromEntries([...turns].map(([turn, value]) => [turn, summarize(value, prices)]));
}
