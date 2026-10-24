/**
 * Every Recharts `ResponsiveContainer` gets a positive first-paint size.
 *
 * Without one, Recharts renders at -1 x -1 until its ResizeObserver fires and logs
 * "The width(-1) and height(…) of chart should be greater than 0" on every mount
 * (found live on /categories in sweep 16: the sentiment gauge was the one container
 * without it). A container either spreads `CHART_CONTAINER_PROPS` (Dashboard/chartTheme.ts)
 * or passes `initialDimension` itself.
 */
import { describe, expect, it } from 'vitest'
import { appTsxFiles } from '../test/appSources'

/** Each `<ResponsiveContainer …>` opening tag in `source`, up to its first `>` (no container passes an arrow function). */
function containerTags(source: string): string[] {
  return source.split('<ResponsiveContainer').slice(1).map((rest) => rest.slice(0, rest.indexOf('>') + 1))
}

describe('chart containers', () => {
  const tags = appTsxFiles().flatMap(({ at, source }) => containerTags(source).map((tag) => ({ file: at, tag })))

  it('finds the charts (the scan is not empty)', () => {
    expect(tags.length).toBeGreaterThanOrEqual(6)
  })

  it('every ResponsiveContainer has a positive first-paint size', () => {
    const unsized = tags.filter(({ tag }) => !tag.includes('CHART_CONTAINER_PROPS') && !tag.includes('initialDimension'))
    expect(unsized.map(({ file }) => file)).toStrictEqual([])
  })
})
