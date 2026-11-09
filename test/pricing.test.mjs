import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROJECTION_KEY,
  STATE_VERSION,
  buildView,
  emptyState,
  fold,
  isPeak,
  normalizeConfig,
  ratesFor,
  stateSchema,
  usageOf,
  viewSchema,
} from '../pricing.js'

// 2026-11-09 is a Monday. Beijing is UTC+8, so 02:00Z is 10:00 Beijing (peak),
// 05:00Z is 13:00 Beijing (off-peak lunch), and 2026-11-07 is a Saturday.
const MONDAY_PEAK = Date.UTC(2026, 10, 9, 2, 0, 0)
const MONDAY_LUNCH = Date.UTC(2026, 10, 9, 5, 0, 0)
const SATURDAY = Date.UTC(2026, 10, 7, 2, 0, 0)

const message = (time, provider, model, usage) => ({
  type: 'assistant/message',
  time,
  data: {
    message: { role: 'assistant', source: { kind: 'model', provider, model } },
    usage,
  },
})

const config = (overrides = {}) => normalizeConfig(overrides)

test('peak windows use Beijing weekday hours', () => {
  const cfg = config()
  assert.equal(isPeak(MONDAY_PEAK, cfg), true)
  assert.equal(isPeak(MONDAY_LUNCH, cfg), false)
  assert.equal(isPeak(SATURDAY, cfg), false)
  // 18:00 Beijing is the first off-peak minute.
  assert.equal(isPeak(Date.UTC(2026, 10, 9, 10, 0, 0), cfg), false)
  // 20:00Z Sunday is Monday 04:00 Beijing, off-peak.
  assert.equal(isPeak(Date.UTC(2026, 10, 8, 20, 0, 0), cfg), false)
})

test('configured holidays are off-peak all day', () => {
  const cfg = config({ holidays: ['2026-11-09'] })
  assert.equal(isPeak(MONDAY_PEAK, cfg), false)
})

test('fold ignores events that bill nothing and keeps the state reference', () => {
  const cfg = config()
  const state = emptyState()
  assert.equal(fold(state, { type: 'step/start', time: MONDAY_PEAK }, cfg), state)
  assert.equal(fold(state, { type: 'tool/result', time: MONDAY_PEAK }, cfg), state)
})

test('full DeepSeek Flash pricing: cache-miss input, cache hit, output', () => {
  const cfg = config()
  const usage = {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
    totalTokens: 3_000_000,
  }
  const state = fold(
    emptyState(),
    message(MONDAY_PEAK, 'deepseek-account', 'deepseek-flash', usage),
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.tokens.total, 3_000_000)
  assert.equal(view.buckets.input.cost, 2) // 1M * ¥2/M peak cache miss
  assert.equal(view.buckets.cacheRead.cost, 0.04) // 1M * ¥0.04/M peak cache hit
  assert.equal(view.buckets.output.cost, 8) // 1M * ¥8/M peak output
  assert.equal(view.cost.total, 10.04)
  assert.equal(view.cost.peak, 10.04)
  assert.equal(view.cost.offPeak, 0)
  assert.equal(view.cacheHitRate, 0.5)
  assert.equal(view.models.length, 1)
  assert.equal(view.models[0].priced, true)
  assert.equal(view.currency, '¥')
})

test('off-peak rates are half the peak rates for Flash', () => {
  const cfg = config()
  const state = fold(
    emptyState(),
    message(MONDAY_LUNCH, 'deepseek-account', 'deepseek-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.cost.total, 5) // ¥1/M input + ¥4/M output
  assert.equal(view.cost.offPeak, 5)
  assert.equal(view.cost.peak, 0)
})

test('DeepSeek V4 Pro prices differ from Flash', () => {
  const cfg = config()
  const state = fold(
    emptyState(),
    message(MONDAY_PEAK, 'deepseek-account', 'deepseek-v4-pro', {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.cost.total, 9 + 0.3 + 27)
})

test('model/selection attributes later attempts that carry no route', () => {
  const cfg = config()
  let state = fold(
    emptyState(),
    { type: 'model/selection', time: MONDAY_PEAK, data: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    cfg,
  )
  // A failed attempt reports usage only inside its durable stream.
  state = fold(
    state,
    {
      type: 'assistant/attempt',
      time: MONDAY_PEAK,
      data: {
        stream: [
          { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
          { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } } },
        ],
      },
    },
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.tokens.input, 1000)
  assert.equal(view.tokens.output, 500)
  assert.equal(view.models[0].model, 'deepseek-flash')
})

test('usageOf prefers the settled assistant usage over stream frames', () => {
  const event = message(MONDAY_PEAK, 'p', 'm', { inputTokens: 1, outputTokens: 2 })
  event.data.stream = [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 9 } } }]
  assert.deepEqual(usageOf(event), { inputTokens: 1, outputTokens: 2 })
})

test('unpriced models keep tokens but never invent a price', () => {
  const cfg = config()
  const state = fold(
    emptyState(),
    message(MONDAY_PEAK, 'somewhere', 'mystery-model', { inputTokens: 100, outputTokens: 50 }),
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.tokens.total, 150)
  assert.equal(view.cost.total, 0)
  assert.equal(view.cost.unpricedTokens, 150)
  assert.equal(view.models[0].cost, null)
  assert.equal(view.models[0].priced, false)
})

test('configured fallback prices otherwise unknown models', () => {
  const cfg = config({ fallback: { peak: { cacheMiss: 1, cacheHit: 0.01, output: 2 } } })
  const state = fold(
    emptyState(),
    message(MONDAY_PEAK, 'somewhere', 'mystery-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.cost.total, 3)
  assert.equal(view.cost.unpricedTokens, 0)
})

test('provider-qualified model ids override bare ids', () => {
  const cfg = config({
    models: { 'custom/deepseek-flash': { peak: { cacheMiss: 100, cacheHit: 1, output: 100 } } },
  })
  assert.equal(ratesFor(cfg, 'custom', 'deepseek-flash').id, 'custom/deepseek-flash')
  assert.equal(ratesFor(cfg, 'deepseek-account', 'deepseek-flash').id, 'deepseek-flash')
})

test('multiple models accumulate into one view and sort by cost', () => {
  const cfg = config()
  let state = fold(
    emptyState(),
    message(MONDAY_PEAK, 'deepseek-account', 'deepseek-flash', { inputTokens: 1000, outputTokens: 1000 }),
    cfg,
  )
  state = fold(
    state,
    message(MONDAY_PEAK, 'deepseek-account', 'deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 0 }),
    cfg,
  )
  const view = buildView(state, cfg)
  assert.equal(view.models.length, 2)
  assert.equal(view.models[0].model, 'deepseek-v4-pro')
  assert.equal(view.tokens.total, 1_002_000)
})

test('schemas accept the folded state and its view', () => {
  const cfg = config()
  const state = fold(
    emptyState(),
    message(MONDAY_PEAK, 'deepseek-account', 'deepseek-flash', { inputTokens: 10, outputTokens: 20 }),
    cfg,
  )
  assert.equal(stateSchema.parse(state), state)
  const view = buildView(state, cfg)
  assert.equal(viewSchema.parse(view), view)
  assert.throws(() => stateSchema.parse({ route: null, models: { bad: {} } }))
  assert.throws(() => viewSchema.parse({ currency: '¥' }))
})

test('empty state produces a zeroed view', () => {
  const cfg = config()
  const view = buildView(emptyState(), cfg)
  assert.equal(view.tokens.total, 0)
  assert.equal(view.cost.total, 0)
  assert.equal(view.cost.unpricedTokens, 0)
  assert.equal(view.cacheHitRate, null)
  assert.deepEqual(view.models, [])
})

test('projection identity is stable and versioned', () => {
  assert.equal(PROJECTION_KEY, 'tokenCost')
  assert.equal(STATE_VERSION, 1)
})
