/**
 * Pure token accounting and pricing for the token-cost plugin.
 *
 * The Host half folds provider-reported token usage into per-model,
 * per-tariff buckets for one Session; the browser half renders that fold as a
 * CNY estimate. This module deliberately has no Cordis or Node dependency so
 * the fold can be unit tested with plain `node --test`.
 *
 * Tariffs follow DeepSeek's published per-million-token prices, which differ
 * between peak and off-peak hours. Peak hours are Beijing time, Monday to
 * Friday, 09:00-12:00 and 14:00-18:00; every other moment (weekends included)
 * is off-peak. The official page also treats Chinese statutory holidays as
 * off-peak all day, but that calendar is not bundled here: list their dates in
 * `holidays` (YYYY-MM-DD) when the difference matters.
 *
 * Sources: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

/** Projection key registered with `ctx.sessionProjections`. */
export const PROJECTION_KEY = 'tokenCost'

/** Bump when the folded state or its semantics change. */
export const STATE_VERSION = 1

const PER_MILLION = 1_000_000

/** Per-million-token CNY prices for the shipped DeepSeek models. */
const FLASH_RATES = {
  peak: { cacheMiss: 2, cacheHit: 0.04, cacheWrite: 2, output: 8 },
  offPeak: { cacheMiss: 1, cacheHit: 0.02, cacheWrite: 1, output: 4 },
}

const PRO_RATES = {
  peak: { cacheMiss: 9, cacheHit: 0.3, cacheWrite: 9, output: 27 },
  offPeak: { cacheMiss: 4.5, cacheHit: 0.15, cacheWrite: 4.5, output: 13.5 },
}

/** Model ids the plugin knows out of the box, including documented aliases. */
export const DEFAULT_MODELS = {
  'deepseek-flash': FLASH_RATES,
  'deepseek-v4-flash': FLASH_RATES,
  'deepseek-v4-flash-vision-exp': FLASH_RATES,
  'deepseek-v4-pro': PRO_RATES,
}

const DEFAULT_CONFIG = {
  currency: '¥',
  timeZone: 'Asia/Shanghai',
  peakWeekdays: [1, 2, 3, 4, 5],
  peakWindows: [
    [9, 12],
    [14, 18],
  ],
  holidays: [],
  models: DEFAULT_MODELS,
  fallback: null,
}

/** Token fields a provider may report, each priced by one tariff field. */
const TOKEN_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output']
const TOKEN_FIELD_TARIFF = {
  input: 'cacheMiss',
  cacheRead: 'cacheHit',
  cacheWrite: 'cacheWrite',
  output: 'output',
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isCount = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const countOf = (value) => (isCount(value) ? value : 0)

const roundCost = (value) => Math.round(value * 1e6) / 1e6

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Accept either a numeric price or an already-normalized positive number. */
function priceOf(value) {
  return isCount(value) ? value : 0
}

/**
 * Normalize one tariff pair.
 * @param {unknown} raw - `{ peak: {...}, offPeak: {...} }` from config.
 * @returns {{peak: object, offPeak: object}|null} normalized rates or null.
 */
function normalizeRates(raw) {
  if (!isPlainObject(raw)) return null
  const peak = isPlainObject(raw.peak) ? raw.peak : raw.offPeak
  const offPeak = isPlainObject(raw.offPeak) ? raw.offPeak : raw.peak
  if (!isPlainObject(peak) && !isPlainObject(offPeak)) return null
  const read = (value) => ({
    cacheMiss: priceOf(value.cacheMiss),
    cacheHit: priceOf(value.cacheHit),
    cacheWrite: isCount(value.cacheWrite) ? value.cacheWrite : priceOf(value.cacheMiss),
    output: priceOf(value.output),
  })
  return {
    peak: read(isPlainObject(peak) ? peak : offPeak),
    offPeak: read(isPlainObject(offPeak) ? offPeak : peak),
  }
}

function normalizeWeekdays(raw) {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG.peakWeekdays
  const days = [...new Set(raw.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
  return days.length === 0 ? [] : days
}

function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG.peakWindows
  const windows = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [start, end] = entry
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (start < 0 || end > 24 || start >= end) continue
    windows.push([start, end])
  }
  return windows.length === 0 ? [] : windows
}

function normalizeHolidays(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.trim()))
    .map((day) => day.trim())
}

/** Build a formatter once; reject an unusable time zone instead of failing later. */
function formatterFor(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    return formatterFor('Asia/Shanghai')
  }
}

/**
 * Merge plugin config over the shipped defaults.
 *
 * The merge is tolerant on purpose: a malformed price entry is skipped rather
 * than preventing the plugin from loading, because pricing is advisory and a
 * broken config must not take the Host down.
 * @param {unknown} input - raw plugin config (undefined is valid).
 * @returns {object} configuration consumed by {@link isPeak} and
 *   {@link buildView}.
 */
export function normalizeConfig(input) {
  const raw = isPlainObject(input) ? input : {}
  const currency =
    typeof raw.currency === 'string' && raw.currency.trim() !== ''
      ? raw.currency.trim()
      : DEFAULT_CONFIG.currency
  const timeZone =
    typeof raw.timeZone === 'string' && raw.timeZone.trim() !== ''
      ? raw.timeZone.trim()
      : DEFAULT_CONFIG.timeZone

  const models = new Map()
  for (const [id, rates] of Object.entries(DEFAULT_MODELS)) {
    const normalized = normalizeRates(rates)
    if (normalized !== null) models.set(id, normalized)
  }
  if (isPlainObject(raw.models)) {
    for (const [id, rates] of Object.entries(raw.models)) {
      if (typeof id !== 'string' || id.trim() === '') continue
      const normalized = normalizeRates(rates)
      if (normalized !== null) models.set(id.trim(), normalized)
    }
  }

  return {
    currency,
    timeZone,
    formatter: formatterFor(timeZone),
    peakWeekdays: new Set(normalizeWeekdays(raw.peakWeekdays)),
    peakWindows: normalizeWindows(raw.peakWindows),
    holidays: new Set(normalizeHolidays(raw.holidays)),
    models,
    fallback: normalizeRates(raw.fallback),
  }
}

// ---------------------------------------------------------------------------
// Tariff period
// ---------------------------------------------------------------------------

/**
 * Read one instant in the configured time zone.
 * @param {object} cfg - normalized config.
 * @param {number} timeMs - epoch milliseconds; the current time when invalid.
 * @returns {{date: string, weekday: number, hour: number}}
 */
function dateParts(cfg, timeMs) {
  const date = new Date(Number.isFinite(timeMs) ? timeMs : Date.now())
  const parts = cfg.formatter.formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[get('weekday')]
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: Number.isInteger(weekday) ? weekday : -1,
    hour: Number(get('hour')) % 24,
  }
}

/**
 * Whether one instant falls in a peak tariff window.
 * @param {number} timeMs - epoch milliseconds.
 * @param {object} cfg - normalized config.
 * @returns {boolean} true for peak pricing.
 */
export function isPeak(timeMs, cfg) {
  const parts = dateParts(cfg, timeMs)
  if (cfg.holidays.has(parts.date)) return false
  if (!cfg.peakWeekdays.has(parts.weekday)) return false
  return cfg.peakWindows.some(
    ([start, end]) => parts.hour >= start && parts.hour < end,
  )
}

// ---------------------------------------------------------------------------
// Usage extraction and folding
// ---------------------------------------------------------------------------

/** The last usage chunk of a durable assistant stream, if it reported one. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const item = stream[index]
    if (item === null || typeof item !== 'object') continue
    const chunk = isPlainObject(item.chunk) ? item.chunk : item
    if (chunk.type === 'usage' && isPlainObject(chunk.usage)) return chunk.usage
  }
  return undefined
}

/**
 * Provider-reported usage one durable event settled, mirroring the token
 * meter's fold: a final `assistant/message` sample wins, while a failed or
 * retried `assistant/attempt` contributes the usage end of its stream.
 * @param {object} event - committed Session event.
 * @returns {object|undefined} usage record when the event billed tokens.
 */
export function usageOf(event) {
  if (!isPlainObject(event)) return undefined
  if (event.type === 'assistant/message' && isPlainObject(event.data?.usage)) {
    return event.data.usage
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
    return undefined
  }
  return streamUsage(event.data?.stream)
}

function readRoute(value) {
  if (!isPlainObject(value)) return null
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider === '') return null
  if (typeof model !== 'string' || model === '') return null
  return { provider, model }
}

/** The exact route an assistant message names; a bare attempt names none. */
function messageRoute(event) {
  return readRoute(event.data?.message?.source)
}

function selectionRoute(event) {
  return readRoute(event.data)
}

const emptyPeriod = () => ({ peak: 0, offPeak: 0 })

const emptyEntry = (provider, model) => ({
  provider,
  model,
  input: emptyPeriod(),
  cacheRead: emptyPeriod(),
  cacheWrite: emptyPeriod(),
  output: emptyPeriod(),
})

/** Initial projection state: no route seen, no tokens billed. */
export function emptyState() {
  return { route: null, models: {} }
}

/** Add one token count to one tariff period without mutating the input. */
function addTo(period, tariff, tokens) {
  if (tokens <= 0) return period
  return tariff === 'peak'
    ? { peak: period.peak + tokens, offPeak: period.offPeak }
    : { peak: period.peak, offPeak: period.offPeak + tokens }
}

/**
 * Fold one committed Session event into the projection state.
 *
 * Returns the same state reference for events that bill nothing, which is how
 * the projection registry suppresses downstream work.
 * @param {object} state - current projection state.
 * @param {object} event - committed Session event.
 * @param {object} cfg - normalized config.
 * @returns {object} the new or unchanged state.
 */
export function fold(state, event, cfg) {
  if (!isPlainObject(state) || !isPlainObject(event)) return state

  if (event.type === 'model/selection') {
    const route = selectionRoute(event)
    if (route === null) return state
    if (
      state.route !== null &&
      state.route.provider === route.provider &&
      state.route.model === route.model
    ) {
      return state
    }
    return { ...state, route }
  }

  const usage = usageOf(event)
  if (usage === undefined) return state

  const route = messageRoute(event) ?? state.route
  const provider = route?.provider ?? null
  const model = route?.model ?? null
  const key = route === null ? 'unknown' : `${provider}/${model}`
  const tariff = isPeak(event.time, cfg) ? 'peak' : 'offPeak'

  const entry = state.models[key] ?? emptyEntry(provider, model)
  const next = {
    provider: entry.provider,
    model: entry.model,
    input: addTo(entry.input, tariff, countOf(usage.inputTokens)),
    cacheRead: addTo(entry.cacheRead, tariff, countOf(usage.cacheReadTokens)),
    cacheWrite: addTo(entry.cacheWrite, tariff, countOf(usage.cacheWriteTokens)),
    output: addTo(entry.output, tariff, countOf(usage.outputTokens)),
  }
  return { ...state, models: { ...state.models, [key]: next } }
}

// ---------------------------------------------------------------------------
// Client view
// ---------------------------------------------------------------------------

/**
 * Resolve the tariffs for one route.
 * @param {object} cfg - normalized config.
 * @param {string|null} provider - route provider.
 * @param {string|null} model - route model id.
 * @returns {{rates: object, id: string}|null} tariffs, or null when unpriced.
 */
export function ratesFor(cfg, provider, model) {
  if (typeof model !== 'string' || model === '') return null
  const exact = typeof provider === 'string' && provider !== '' ? `${provider}/${model}` : null
  if (exact !== null && cfg.models.has(exact)) {
    return { rates: cfg.models.get(exact), id: exact }
  }
  if (cfg.models.has(model)) return { rates: cfg.models.get(model), id: model }
  if (cfg.fallback !== null) return { rates: cfg.fallback, id: 'fallback' }
  return null
}

/**
 * Project the folded state into the client-visible value.
 *
 * Prices are applied here rather than during the fold, so editing the plugin
 * config changes the estimate without invalidating checkpointed state.
 * @param {object} state - projection state.
 * @param {object} cfg - normalized config.
 * @returns {object} wire view consumed by the composer pill.
 */
export function buildView(state, cfg) {
  const buckets = {
    input: { tokens: 0, cost: 0 },
    cacheRead: { tokens: 0, cost: 0 },
    cacheWrite: { tokens: 0, cost: 0 },
    output: { tokens: 0, cost: 0 },
  }
  const cost = { total: 0, peak: 0, offPeak: 0, unpricedTokens: 0 }
  const models = []
  let totalTokens = 0

  for (const entry of Object.values(state.models)) {
    const lookup = ratesFor(cfg, entry.provider, entry.model)
    const rates = lookup?.rates ?? null
    const rowTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
    let rowCost = rates === null ? null : 0

    for (const field of TOKEN_FIELDS) {
      const period = entry[field]
      const tokens = countOf(period.peak) + countOf(period.offPeak)
      rowTokens[field] = tokens
      buckets[field].tokens += tokens
      if (rates !== null) {
        const tariff = TOKEN_FIELD_TARIFF[field]
        const peakCost = (countOf(period.peak) * rates.peak[tariff]) / PER_MILLION
        const offPeakCost = (countOf(period.offPeak) * rates.offPeak[tariff]) / PER_MILLION
        rowCost = (rowCost ?? 0) + peakCost + offPeakCost
        buckets[field].cost += peakCost + offPeakCost
        cost.peak += peakCost
        cost.offPeak += offPeakCost
      }
    }

    rowTokens.total =
      rowTokens.input + rowTokens.cacheRead + rowTokens.cacheWrite + rowTokens.output
    totalTokens += rowTokens.total
    if (rowCost === null) {
      cost.unpricedTokens += rowTokens.total
    } else {
      cost.total += rowCost
    }

    models.push({
      key: `${entry.provider ?? 'unknown'}/${entry.model ?? 'unknown'}`,
      provider: entry.provider,
      model: entry.model,
      tokens: rowTokens,
      // Unpriced models keep their tokens visible but never invent a price.
      cost: rowCost === null ? null : roundCost(rowCost),
      priced: rowCost !== null,
    })
  }

  models.sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1))
  for (const field of TOKEN_FIELDS) {
    buckets[field].cost = roundCost(buckets[field].cost)
  }

  const promptTokens = buckets.input.tokens + buckets.cacheRead.tokens + buckets.cacheWrite.tokens
  const cacheHitRate = promptTokens > 0 ? buckets.cacheRead.tokens / promptTokens : null

  return {
    currency: cfg.currency,
    tokens: {
      total: totalTokens,
      input: buckets.input.tokens,
      cacheRead: buckets.cacheRead.tokens,
      cacheWrite: buckets.cacheWrite.tokens,
      output: buckets.output.tokens,
    },
    buckets,
    cost: {
      total: roundCost(cost.total),
      peak: roundCost(cost.peak),
      offPeak: roundCost(cost.offPeak),
      unpricedTokens: cost.unpricedTokens,
    },
    cacheHitRate,
    models,
  }
}

// ---------------------------------------------------------------------------
// Projection schemas
// ---------------------------------------------------------------------------

/*
 * The projection registry only calls `parse()` on these schemas (checkpoint
 * restore and wire publication). External plugins cannot rely on the Host's
 * private zod copy, so these are hand-written validators with the same
 * contract: validate, then return the input unchanged so a wire value keeps
 * its reference identity between reads.
 */

function invalid(message) {
  throw new Error(`tokenCost: ${message}`)
}

function parsePeriod(value, path) {
  if (!isPlainObject(value)) invalid(`${path} must be an object`)
  if (!isCount(value.peak) || !isCount(value.offPeak)) {
    invalid(`${path} must carry non-negative peak and offPeak counts`)
  }
  return value
}

function parseEntry(value, path) {
  if (!isPlainObject(value)) invalid(`${path} must be an object`)
  for (const field of TOKEN_FIELDS) parsePeriod(value[field], `${path}.${field}`)
  return value
}

/** State schema: a route hint plus the per-model token buckets. */
export const stateSchema = {
  parse(value) {
    if (!isPlainObject(value)) invalid('state must be an object')
    if (value.route !== null) readRoute(value.route) ?? invalid('state.route is malformed')
    if (!isPlainObject(value.models)) invalid('state.models must be an object')
    for (const [key, entry] of Object.entries(value.models)) {
      parseEntry(entry, `state.models.${key}`)
    }
    return value
  },
}

/** Wire schema: the exact number set the composer pill reads. */
export const viewSchema = {
  parse(value) {
    if (!isPlainObject(value)) invalid('view must be an object')
    if (typeof value.currency !== 'string') invalid('view.currency must be a string')
    if (!isPlainObject(value.tokens)) invalid('view.tokens must be an object')
    if (!isCount(value.tokens.total)) invalid('view.tokens.total must be a count')
    for (const field of TOKEN_FIELDS) {
      if (!isCount(value.tokens[field])) invalid(`view.tokens.${field} must be a count`)
      if (!isPlainObject(value.buckets?.[field])) invalid(`view.buckets.${field} must be an object`)
      if (!isCount(value.buckets[field].tokens)) {
        invalid(`view.buckets.${field}.tokens must be a count`)
      }
      if (!isCount(value.buckets[field].cost)) {
        invalid(`view.buckets.${field}.cost must be a count`)
      }
    }
    if (!isPlainObject(value.cost)) invalid('view.cost must be an object')
    for (const field of ['total', 'peak', 'offPeak', 'unpricedTokens']) {
      if (!isCount(value.cost[field])) invalid(`view.cost.${field} must be a count`)
    }
    if (value.cacheHitRate !== null && !isCount(value.cacheHitRate)) {
      invalid('view.cacheHitRate must be a ratio or null')
    }
    if (!Array.isArray(value.models)) invalid('view.models must be an array')
    for (const row of value.models) {
      if (!isPlainObject(row)) invalid('view.models[] must be objects')
      if (!isPlainObject(row.tokens)) invalid('view.models[].tokens must be an object')
      if (!isCount(row.tokens.total)) invalid('view.models[].tokens.total must be a count')
      if (row.cost !== null && !isCount(row.cost)) invalid('view.models[].cost must be a count or null')
      if (typeof row.priced !== 'boolean') invalid('view.models[].priced must be a boolean')
    }
    return value
  },
}
