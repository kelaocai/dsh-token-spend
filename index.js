/**
 * Host half of Token Cost: a per-Session projection that prices every
 * provider-reported model call under DeepSeek's peak / off-peak tariffs.
 *
 * The browser half reads the projection through `useProjection('tokenCost')`
 * and renders it in the composer dock; neither side talks to the other
 * directly, and the whole-History fold survives reloads through the projection
 * checkpoint.
 *
 * No model-visible surface: this plugin registers no prompt section, tool, or
 * request field. It only reads committed `assistant/message`, `assistant/attempt`
 * and `model/selection` events.
 */

import {
  PROJECTION_KEY,
  STATE_VERSION,
  buildView,
  emptyState,
  fold,
  normalizeConfig,
  stateSchema,
  viewSchema,
} from './pricing.js'

/** Cordis plugin name. */
export const name = 'token-spend'

/** The projection registry is the only capability this plugin needs. */
export const inject = ['sessionProjections']

/**
 * Register the `tokenCost` projection on the mounting fiber.
 * @param {object} ctx - plugin context carrying `sessionProjections`.
 * @param {object} [config] - plugin config: prices, currency, time zone,
 *   peak windows, and holiday dates (see README).
 * @returns {Promise<void>} after registration settled; disposal is owned by
 *   the plugin fiber.
 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  // Price is applied in `view`, not in the fold: the checkpointed state stays
  // tariff-independent, so editing prices changes the estimate without a
  // stateVersion bump. A WeakMap keeps one state reference mapped to the same
  // view object, which is exactly the identity the registry compares to decide
  // whether a client-visible value changed.
  const views = new WeakMap()

  const definition = {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: () => emptyState(),
    apply: (state, event) => fold(state, event, cfg),
    wire: {
      // This projection grows with the conversation, and Session list rows
      // never draw it, so keep it out of Session summaries.
      summary: false,
      viewSchema,
      view(state) {
        let cached = views.get(state)
        if (cached === undefined) {
          cached = buildView(state, cfg)
          views.set(state, cached)
        }
        return cached
      },
    },
  }

  await ctx.sessionProjections.register(definition)
}
