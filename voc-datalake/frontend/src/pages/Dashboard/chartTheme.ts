/**
 * @fileoverview Recharts styling shared by every Dashboard chart — theme tokens
 * only (src/index.css), so charts flip with light/dark.
 * @module pages/Dashboard/chartTheme
 */
import type { ComponentProps } from 'react'
import type { ResponsiveContainer } from 'recharts'

export const GRID_STROKE = 'var(--chart-grid)'
/**
 * Axis labels are content (dates, category names), so they take the 12px
 * minimum (docs/kiro-design-system.md rule 8 and its chart example); they were
 * 10px — below the floor on every Dashboard chart (design audit D-READ).
 */
export const AXIS_TICK = { fontSize: 12, fill: 'var(--muted)' }
export const AXIS_LINE = { stroke: 'var(--border)' }

/** Shared Recharts tooltip styling (spread onto each `<Tooltip>`). */
export const TOOLTIP_PROPS = {
  contentStyle: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text)',
  },
  labelStyle: { color: 'var(--text-strong)' },
  itemStyle: { color: 'var(--text)' },
}
export const BAR_CURSOR = { fill: 'var(--bg-hover)' }
export const LINE_CURSOR = { stroke: 'var(--border-strong)' }
/**
 * First-paint size for every ResponsiveContainer. Recharts defaults to -1×-1
 * until its ResizeObserver fires and warns about it on every mount; a positive
 * placeholder silences that without fixing the chart to a size.
 */
export const CHART_CONTAINER_PROPS: Omit<ComponentProps<typeof ResponsiveContainer>, 'children'> = {
  width: '100%',
  height: '100%',
  minWidth: 0,
  initialDimension: { width: 480, height: 250 },
}
