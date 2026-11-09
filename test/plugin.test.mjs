import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

const MONDAY_PEAK = Date.UTC(2026, 10, 9, 2, 0, 0)

async function register(config) {
  let definition
  const ctx = {
    sessionProjections: {
      async register(value) {
        definition = value
      },
    },
  }
  await apply(ctx, config)
  return definition
}

test('the plugin declares its registry dependency', () => {
  assert.equal(name, 'token-spend')
  assert.deepEqual(inject, ['sessionProjections'])
})

test('apply registers a versioned projection with a stable wire view', async () => {
  const definition = await register({})
  assert.equal(definition.key, 'tokenCost')
  assert.equal(definition.stateVersion, 1)
  assert.equal(definition.wire.summary, false)

  const state = definition.init()
  const first = definition.wire.view(state)
  const second = definition.wire.view(state)
  assert.equal(first, second, 'unchanged state must reuse the view object')

  const next = definition.apply(state, {
    type: 'assistant/message',
    time: MONDAY_PEAK,
    data: {
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    },
  })
  assert.notEqual(next, state)
  const after = definition.wire.view(next)
  assert.notEqual(after, first)
  assert.equal(after.cost.total, 2)
})

test('config prices reach the registered projection', async () => {
  const definition = await register({
    currency: '$',
    models: { 'deepseek-flash': { peak: { cacheMiss: 100, cacheHit: 0, output: 0 } } },
  })
  const state = definition.apply(definition.init(), {
    type: 'assistant/message',
    time: MONDAY_PEAK,
    data: {
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    },
  })
  assert.equal(definition.wire.view(state).currency, '$')
  assert.equal(definition.wire.view(state).cost.total, 100)
})
