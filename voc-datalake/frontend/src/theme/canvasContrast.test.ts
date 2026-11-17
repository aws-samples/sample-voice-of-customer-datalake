/**
 * The flow canvas's non-text contrast (7.52.00 C2; docs/ux part 5 §5.9, N9; WCAG 1.4.11): a shape language fails if
 * its outlines do not show. Every node's outline, the arrows and the handles' ring are `--control-border`, which must
 * reach 3:1 on the canvas (`--bg-accent`) and on a node's fill (`--card`) in every theme; each kind's tile glyph
 * reaches 3:1 on its tile (an `*-subtle` tint is composited on the card), and each run state's badge glyph on the
 * card. The ratios are computed from the theme blocks, so retuning a token below 3:1 fails here.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEMES, contrastRatio as contrast, mixHex, themeBlockBody, themeHex as token } from '@test/themeTokens'
import type { Theme } from '@test/themeTokens'

const MIN = 3
const canvasCss = readFileSync(resolve(__dirname, '../components/WorkflowEditor/workflowCanvas.css'), 'utf8')

/** A `--name: rgba(r, g, b, a)` (or a hex) token of a theme as the colour it paints over `back`. */
function painted(theme: Theme, name: string, back: string): string {
  const body = themeBlockBody(theme)
  const declared = new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? ''
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(declared)
  if (rgba === null) return token(theme, name)
  const [, r = '0', g = '0', b = '0', alpha = '1'] = rgba
  const hex = `#${[r, g, b].map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`
  return mixHex(hex, back, Number(alpha))
}

/** Each tile: its glyph's token and its fill (a tint over the card, or a surface). */
const TILES: ReadonlyArray<readonly [string, string, string]> = [
  ['agent (aim)', 'aim', 'aim-subtle'],
  ['decision (warn)', 'warn', 'warn-subtle'],
  ['gate (strong)', 'text-strong', 'bg-hover'],
]

/** Each run state's badge glyph, drawn on the card. */
const BADGES = ['accent-text', 'ok', 'danger', 'warn'] as const

describe.each(THEMES)('the flow canvas in %s', (theme) => {
  it('draws outlines, arrows and handles at 3:1 or more on the canvas and on a node', () => {
    const edge = token(theme, 'control-border')
    const ratios = ['bg-accent', 'card'].map((surface) => Number(contrast(edge, token(theme, surface)).toFixed(2)))
    expect(ratios.filter((ratio) => ratio < MIN), JSON.stringify(ratios)).toStrictEqual([])
  })

  it.each(TILES)('a %s tile shows its glyph at 3:1 or more', (_kind, glyph, fill) => {
    const card = token(theme, 'card')
    const back = fill.endsWith('-subtle') ? painted(theme, fill, card) : token(theme, fill)
    expect(contrast(token(theme, glyph), back)).toBeGreaterThanOrEqual(MIN)
  })

  it('shows each run state\'s badge glyph at 3:1 or more on the card', () => {
    const card = token(theme, 'card')
    expect(BADGES.filter((name) => contrast(token(theme, name), card) < MIN)).toStrictEqual([])
  })
})

describe('the shape recipes draw with the token', () => {
  it('outlines every node, edge and handle with --control-border, never the 1.3:1 --border', () => {
    expect(canvasCss).toMatch(/\.voc-node \{[^}]*var\(--node-edge, var\(--control-border\)\)/)
    expect(canvasCss).toContain('--xy-edge-stroke: var(--control-border);')
    expect(canvasCss).toContain('--xy-handle-border-color: var(--control-border);')
    expect(canvasCss).not.toContain('--xy-node-border: 1px solid var(--border);')
  })
})
