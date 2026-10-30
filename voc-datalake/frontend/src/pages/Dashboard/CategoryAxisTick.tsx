/**
 * @fileoverview A category-axis tick that never clips: a label longer than the
 * axis has room for is cut with an ellipsis, and the full label is the tick's
 * SVG `<title>` (the hover tooltip, and what assistive tech reads).
 *
 * Recharts right-aligns a vertical chart's category labels against the plot, so
 * a label wider than the axis ran off the card's left edge ("oftware firmware").
 * @module pages/Dashboard/CategoryAxisTick
 */
import { AXIS_TICK } from './chartTheme'
import { charsThatFit, TICK_GAP_PX, truncateLabel } from './axisLabel'

interface TickProps {
  /** Set by Recharts when it clones the tick. */
  readonly x?: number
  readonly y?: number
  readonly payload?: { readonly value?: unknown }
  /** The axis width this tick must fit (the `<YAxis width>`). */
  readonly axisWidth: number
}

export function CategoryAxisTick({ x = 0, y = 0, payload, axisWidth }: TickProps) {
  const raw = payload?.value
  const label = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={-TICK_GAP_PX} y={0} dy={4} textAnchor="end" fontSize={AXIS_TICK.fontSize} fill={AXIS_TICK.fill}>
        <title>{label}</title>
        {truncateLabel(label, charsThatFit(axisWidth))}
      </text>
    </g>
  )
}
