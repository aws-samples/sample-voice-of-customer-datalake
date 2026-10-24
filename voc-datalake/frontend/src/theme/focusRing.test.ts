/**
 * Focus indicators (design audit qa/design D-FOCUS, WCAG 2.4.7 / 1.4.11).
 *
 * The audit measured the focus state of every Tab stop on production: the
 * recipes that drew focus only as `box-shadow: 0 0 0 3px var(--accent-subtle)`
 * (`.focus-ring` on buttons, `.link`, `.switch`, `.tab`, `.range`) painted a
 * 16%-alpha tint that is 1.28:1 against the card — invisible — and
 * `.menu-item` changed only its background (1.1:1). `.tab-active` also reset
 * the active tab's border and shadow, so a focused active tab showed nothing.
 *
 * Every recipe now draws the base `:focus-visible` treatment: a 2px solid
 * `--ring` outline (outline is never reset by a variant class), and `--ring`
 * clears 3:1 on every surface a control sits on, in both themes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio as contrast, indexCss as css, themeHexTokens as tokens, withoutComments as stripComments } from '@test/themeTokens'

const canvasCss = readFileSync(resolve(__dirname, '../components/WorkflowEditor/workflowCanvas.css'), 'utf8')

/** Every rule as [selector list, declarations] (flat: nested @layer/@media blocks are unwrapped). */
function rules(source: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const chunk of stripComments(source).split('}')) {
    const open = chunk.lastIndexOf('{')
    if (open === -1) continue
    const selector = chunk.slice(0, open).split(/[;{]/).at(-1)?.trim() ?? ''
    out.push([selector, chunk.slice(open + 1)])
  }
  return out
}

/** Declarations of the rule whose selector list contains `selector` exactly. */
function ruleBody(source: string, selector: string): string {
  const found = rules(source).find(([list]) => list.split(',').map((s) => s.trim()).includes(selector))
  if (found === undefined) throw new Error(`no rule for ${selector}`)
  return found[1]
}

const RING_OUTLINE = /outline:\s*2px solid var\(--ring\)/

describe('focus ring token', () => {
  it.each(['kiro-dark', 'kiro-light'] as const)('clears 3:1 on every surface in %s', (theme) => {
    const t = tokens(theme)
    for (const surface of ['bg', 'bg-accent', 'card', 'bg-elevated', 'bg-hover', 'panel']) {
      const ratio = contrast(t['ring'] ?? '', t[surface] ?? '')
      expect(ratio, `--ring on --${surface}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('focus recipes draw the ring outline', () => {
  it.each([
    '.focus-ring:focus-visible',
    '.link:focus-visible',
    '.tab:focus-visible',
    '.switch:focus-visible',
    '.menu-item:focus-visible',
  ])('%s', (selector) => {
    expect(ruleBody(css, selector)).toMatch(RING_OUTLINE)
  })

  it('the range slider rings its thumb', () => {
    expect(ruleBody(css, '.range:focus-visible::-webkit-slider-thumb')).toMatch(/outline:\s*2px solid var\(--ring\)/)
  })

  it.each(['.input:focus', '.select:focus-visible', '.input:focus-within'])('%s repeats the ring as an outline a border utility cannot erase', (selector) => {
    expect(ruleBody(css, selector)).toMatch(/outline:\s*1px solid var\(--ring\)/)
  })

  it('workflow canvas nodes (tabindex=0 in React Flow) show the ring', () => {
    expect(ruleBody(canvasCss, '.voc-workflow .react-flow__node:focus-visible')).toMatch(RING_OUTLINE)
  })

  it('workflow edge labels are at the 12px content minimum (every rule for them)', () => {
    const edgeRules = rules(canvasCss).filter(([selector]) => selector === '.voc-workflow .react-flow__edge-text')
    expect(edgeRules.length).toBeGreaterThan(0)
    for (const [, body] of edgeRules) expect(body).not.toMatch(/font-size:\s*(?:\d|1[01])px/)
    expect(edgeRules.some(([, body]) => /font-size:\s*12px/.test(body))).toBe(true)
  })

  it('no focus rule relies on the accent-subtle tint alone', () => {
    const focusRules = rules(css).filter(([selector]) => selector.includes(':focus'))
    expect(focusRules.length).toBeGreaterThan(5)
    for (const [selector, body] of focusRules) {
      if (!body.includes('--accent-subtle')) continue
      const drawsRing = /outline:\s*2px solid var\(--ring\)|border-color:\s*var\(--ring\)/.test(body)
      expect(drawsRing, `${selector} draws only the tint`).toBe(true)
    }
  })
})
