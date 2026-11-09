/**
 * Browser half of Token Cost.
 *
 * Registers one `conversation.composer.dock` entry, next to the shipped
 * `activity` and `usage` statistics pills. The entry renders that Session's
 * `tokenCost` projection: provider-reported tokens plus a CNY estimate priced
 * under DeepSeek's peak / off-peak tariffs. The fold, the tariff table, and the
 * history replay all live on the Host; this half only formats the numbers.
 *
 * No import of a Harness Client package is needed: `useProjection` and
 * `sessionId` arrive as standard Session-scope props, and React/ReactDOM come
 * from the shared module table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-spend',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React

    const NS = 'token-spend'
    const DOCK = 'conversation.composer.dock'
    const STAT_ID = 'token-spend'
    const PANEL_WIDTH = 352

    const ZH = {
      'panel.title': 'Token 花费',
      'panel.reading': 'Token 花费',
      'row.input': '输入（缓存未命中）',
      'row.cacheRead': '输入（缓存命中）',
      'row.cacheWrite': '缓存写入',
      'row.output': '输出',
      'row.cacheHit': '缓存命中率',
      'row.peak': '高峰时段',
      'row.offPeak': '空闲时段',
      'row.total': '合计',
      'note.unpriced': '有 {tokens} tokens 来自未配置价格的模型，未计入金额。',
      'note.pricing':
        '按 DeepSeek 官方价格估算：高峰为北京时间工作日 9:00–12:00、14:00–18:00，其余时段按空闲价；法定节假日暂按工作日规则计算。',
      'note.scope': '仅统计本会话的模型调用，不含子代理会话与联网搜索/抓取费用。',
      'unit.tokens': 'tokens',
      'state.unpriced': '未定价',
    }

    const EN = {
      'panel.title': 'Token cost',
      'panel.reading': 'Token cost',
      'row.input': 'Input (cache miss)',
      'row.cacheRead': 'Input (cache hit)',
      'row.cacheWrite': 'Cache write',
      'row.output': 'Output',
      'row.cacheHit': 'Cache hit rate',
      'row.peak': 'Peak hours',
      'row.offPeak': 'Off-peak hours',
      'row.total': 'Total',
      'note.unpriced':
        '{tokens} tokens came from a model without configured prices and are excluded from the estimate.',
      'note.pricing':
        'Estimated from DeepSeek list prices: peak hours are Beijing weekdays 09:00–12:00 and 14:00–18:00; everything else is off-peak. Statutory holidays are not applied.',
      'note.scope': 'Counts this Session’s model calls only (no subagent Sessions, web search, or fetch fees).',
      'unit.tokens': 'tokens',
      'state.unpriced': 'Unpriced',
    }

    const CSS = `
.tc-root{position:relative;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.tc-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
.tc-pill svg{flex:none;width:14px;height:14px}
.tc-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.tc-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.tc-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.tc-panel{z-index:1100;box-sizing:border-box;position:fixed;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;padding:16px;font-size:12px;line-height:18px;overflow:hidden auto}
.tc-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}
.tc-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
.tc-title-label svg{flex:none;width:14px;height:14px}
.tc-title-value{font-variant-numeric:tabular-nums;white-space:nowrap}
.tc-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.tc-rows{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(88px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
.tc-rows dt,.tc-rows dd{min-width:0;margin:0}
.tc-rows dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.tc-rows .tc-sub{color:var(--dsw-alias-label-tertiary)}
.tc-models{margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:4px}
.tc-model{display:flex;align-items:baseline;gap:12px}
.tc-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.tc-model-provider{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:6px}
.tc-model-value{margin-left:auto;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.tc-warn{margin-top:10px;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-secondary)}
.tc-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
`

    let styleInstalled = false
    function ensureStyle() {
      if (styleInstalled) return
      if (typeof document === 'undefined') return
      const tagId = 'dsh-token-spend/dock.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-token-spend'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      styleInstalled = true
    }

    /** 1.23K / 12.3M, three significant digits at most. */
    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      if (value < 1000) return String(Math.round(value))
      const trim = (text) => text.replace(/\.?0+$/, '')
      if (value < 1e6) {
        const scaled = value / 1e3
        return `${trim(scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0))}K`
      }
      const scaled = value / 1e6
      return `${trim(scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0))}M`
    }

    /** 0.0042 / 0.42 / 14.42, never inventing precision it does not have. */
    function formatAmount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const absolute = Math.abs(value)
      if (absolute === 0) return '0'
      const digits = absolute >= 1 ? 2 : absolute >= 0.01 ? 3 : 4
      return value.toFixed(digits)
    }

    /** The currency-prefixed reading used by tooltips and dialog cells. */
    function formatMoney(value, currency) {
      const unit = typeof currency === 'string' && currency !== '' ? currency : '¥'
      return `${unit}${formatAmount(value)}`
    }

    function formatPercent(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
      const percent = ratio * 100
      return `${percent >= 99.95 ? '100' : percent.toFixed(percent < 10 ? 1 : 0)}%`
    }

    function billedTotal(usage) {
      if (usage === null || typeof usage !== 'object') return null
      const input = typeof usage.uncachedInputTokens === 'number' ? usage.uncachedInputTokens : 0
      const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
      const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
      const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
      const total = input + read + write + output
      return total > 0 ? total : null
    }

    function CoinIcon({ currency }) {
      const unit = typeof currency === 'string' && currency !== '' ? currency : '¥'
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h(
          'text',
          {
            x: 8,
            y: 11.1,
            textAnchor: 'middle',
            fontSize: unit.length > 1 ? 5 : 8.4,
            fontWeight: 600,
            fill: 'currentColor',
            fontFamily: 'inherit',
          },
          unit,
        ),
      )
    }

    /** One dialog row: token count on the left, money on the right. */
    function metricRow(t, key, tokens, cost, currency) {
      const parts = []
      if (tokens !== null) parts.push(formatCount(tokens))
      if (cost !== null) parts.push(formatMoney(cost, currency))
      return h(
        React.Fragment,
        { key },
        h('dt', null, t(key)),
        h('dd', null, parts.length === 0 ? '—' : parts.join(' · ')),
      )
    }

    /**
     * Position the panel above the pill, clamped to the viewport. The composer
     * is a compositor layer (fixed descendants portal elsewhere), so the panel
     * is portaled to the document body and placed from the pill's rect.
     */
    function measurePosition(anchor) {
      const rect = anchor.getBoundingClientRect()
      const width = Math.max(280, Math.min(PANEL_WIDTH, window.innerWidth - 24))
      const centered = rect.left + rect.width / 2 - width / 2
      const left = Math.max(12, Math.min(centered, window.innerWidth - width - 12))
      const bottom = Math.max(12, window.innerHeight - rect.top + 8)
      const maxHeight = Math.max(160, rect.top - 24)
      return { left, bottom, width, maxHeight }
    }

    /** Fixed-position style for one measured placement (the panel portals to body). */
    function fixedStyle(position) {
      return {
        position: 'fixed',
        left: `${position.left}px`,
        bottom: `${position.bottom}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
      }
    }

    function CostPanel({ data, t, panelRef, style }) {
      const currency = data.currency
      const total = data.cost.total
      const unpriced = data.cost.unpricedTokens
      const rows = []

      rows.push(metricRow(t, 'row.input', data.buckets.input.tokens, data.buckets.input.cost, currency))
      rows.push(metricRow(t, 'row.cacheRead', data.buckets.cacheRead.tokens, data.buckets.cacheRead.cost, currency))
      if (data.buckets.cacheWrite.tokens > 0) {
        rows.push(metricRow(t, 'row.cacheWrite', data.buckets.cacheWrite.tokens, data.buckets.cacheWrite.cost, currency))
      }
      rows.push(metricRow(t, 'row.output', data.buckets.output.tokens, data.buckets.output.cost, currency))
      if (data.cacheHitRate !== null) {
        rows.push(
          h(React.Fragment, { key: 'row.cacheHit' }, h('dt', null, t('row.cacheHit')), h('dd', null, formatPercent(data.cacheHitRate))),
        )
      }
      if (data.cost.peak > 0 && data.cost.offPeak > 0) {
        rows.push(metricRow(t, 'row.peak', null, data.cost.peak, currency))
        rows.push(metricRow(t, 'row.offPeak', null, data.cost.offPeak, currency))
      }

      const children = [
        h(
          'div',
          { className: 'tc-title', key: 'title' },
          h('span', { className: 'tc-title-label' }, h(CoinIcon, { currency }), t('panel.title')),
          h('span', { className: 'tc-title-value' }, unpriced > 0 && total === 0 ? '—' : formatMoney(total, currency)),
        ),
        h('div', { className: 'tc-rule', key: 'rule', 'aria-hidden': true }),
        h('dl', { className: 'tc-rows', key: 'rows' }, rows),
      ]

      if (unpriced > 0) {
        children.push(
          h('div', { className: 'tc-warn', key: 'warn' }, t('note.unpriced', { tokens: formatCount(unpriced) })),
        )
      }

      if (Array.isArray(data.models) && data.models.length > 1) {
        const modelRows = data.models.map((row) =>
          h(
            'div',
            { className: 'tc-model', key: row.key, title: `${row.provider ?? 'unknown'}/${row.model ?? 'unknown'}` },
            h('span', { className: 'tc-model-name' }, row.model ?? t('state.unpriced')),
            h('span', { className: 'tc-model-value' }, row.priced ? formatMoney(row.cost, currency) : t('state.unpriced')),
          ),
        )
        children.push(h('div', { className: 'tc-models', key: 'models' }, modelRows))
      }

      children.push(h('p', { className: 'tc-note', key: 'pricing' }, t('note.pricing')))
      children.push(h('p', { className: 'tc-note', key: 'scope' }, t('note.scope')))

      return h(
        'div',
        {
          ref: panelRef,
          className: 'tc-panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
          'data-token-cost-panel': true,
          style,
        },
        children,
      )
    }

    /**
     * The dock control. `useProjection` is the Session-scope standard keyed
     * hook; `tokenUsage` is the fallback that still renders a token reading if
     * this plugin's Host half is not mounted.
     */
    function CostPill({ useProjection, t }) {
      const data = useProjection('tokenCost')
      const usage = useProjection('tokenUsage')

      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const [position, setPosition] = useState(null)

      const place = useCallback(() => {
        if (rootRef.current === null) return
        setPosition(measurePosition(rootRef.current))
      }, [])

      useLayoutEffect(() => {
        if (open) place()
      }, [open, place])

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (rootRef.current?.contains(target) === true) return
          if (panelRef.current?.contains(target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, place])

      const hasCost = data !== undefined && data !== null && typeof data.cost?.total === 'number'
      const totalTokens =
        data !== undefined && data !== null
          ? data.tokens?.total ?? null
          : billedTotal(usage)

      if (totalTokens === null || (totalTokens === 0 && !hasCost)) return null

      const currency = data?.currency
      const unpriced = hasCost && data.cost.unpricedTokens > 0 && data.cost.total === 0
      const amount = hasCost && !unpriced ? formatAmount(data.cost.total) : null
      // The coin icon already draws the currency symbol; the label stays short.
      const label = `${amount ?? '—'} · ${formatCount(totalTokens)}`
      const reading = hasCost && !unpriced
        ? `${t('panel.reading')}: ${formatMoney(data.cost.total, currency)} · ${formatCount(totalTokens)}`
        : `${t('panel.reading')}: ${label}`

      return h(
        'span',
        { ref: rootRef, className: 'tc-root', 'data-composer-stat': STAT_ID },
        h(
          'button',
          {
            type: 'button',
            className: 'tc-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': reading,
            title: reading,
            onClick: () => {
              setOpen((value) => !value)
            },
          },
          h(CoinIcon, { currency }),
          h('span', { className: 'tc-label' }, label),
        ),
        open && position !== null
          ? ReactDOM.createPortal(
              hasCost
                ? h(CostPanel, { data, t, panelRef, style: fixedStyle(position) })
                : h(
                    'div',
                    {
                      ref: panelRef,
                      className: 'tc-panel',
                      role: 'dialog',
                      'aria-label': t('panel.title'),
                      style: fixedStyle(position),
                    },
                    h('div', { className: 'tc-title' }, h('span', { className: 'tc-title-label' }, h(CoinIcon, { currency }), t('panel.title'))),
                    h('div', { className: 'tc-rule', 'aria-hidden': true }),
                    h('p', { className: 'tc-note', style: { marginTop: 0 } }, t('note.pricing')),
                  ),
              document.body,
            )
          : null,
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ensureStyle()

      ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'token-spend: zh dictionary')
      ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'token-spend: en dictionary')

      ctx.slots.inject(DOCK, () =>
        ctx.slots.register(
          {
            name: DOCK,
            id: STAT_ID,
            // After the shipped activity (0) and usage (1) pills.
            order: 2,
            locale: NS,
          },
          CostPill,
        ),
      )
    }

    return { inject, apply }
  },
})
