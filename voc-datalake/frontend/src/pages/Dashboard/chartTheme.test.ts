/**
 * Dashboard chart styling stays on the design system: axis labels at the 12px
 * content minimum (they were 10px, design audit D-READ) and token colours only.
 */
import { describe, expect, it } from 'vitest'
import { AXIS_LINE, AXIS_TICK, GRID_STROKE, TOOLTIP_PROPS } from './chartTheme'

describe('chartTheme', () => {
  it('draws axis labels at the 12px content minimum', () => {
    expect(AXIS_TICK.fontSize).toBeGreaterThanOrEqual(12)
  })

  it('paints only with CSS variables (theme tokens)', () => {
    const colours = [AXIS_TICK.fill, AXIS_LINE.stroke, GRID_STROKE, TOOLTIP_PROPS.contentStyle.background, TOOLTIP_PROPS.contentStyle.color]
    for (const colour of colours) expect(colour).toMatch(/^var\(--[a-z0-9-]+\)$/)
  })
})
