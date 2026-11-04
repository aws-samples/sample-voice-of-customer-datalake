/**
 * The Quick component look (styles/theme-palettes.css → Quick component look,
 * docs/kiro-design-system.md → Themes): Inter, pill buttons with the `--ink`
 * primary, the `--focus` ring, `--link` links, flat surfaces, scoped by
 * `[data-color-theme="quick"]` so every other theme keeps the Kiro recipes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexCss, paletteCss, ruleBody, withoutComments } from '@test/themeTokens'

const css = withoutComments(paletteCss)
const pkg: unknown = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'))

/** The declarations of the theme-palettes.css rule whose selector list is exactly `selector`. */
const rule = (selector: string): string => ruleBody(css, selector)

function dependencies(manifest: unknown): Record<string, unknown> {
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)) return {}
  const deps = manifest.dependencies
  return typeof deps === 'object' && deps !== null ? Object.fromEntries(Object.entries(deps)) : {}
}

const Q = '[data-color-theme="quick"]'

describe('Quick type and shape tokens', () => {
  it('sets Inter as the body face, with system fallbacks only', () => {
    const tokens = rule(`:root${Q}`)
    expect(tokens).toMatch(/--font-body:\s*'Inter Variable', -apple-system/)
    expect(tokens).toContain('--radius-sm: 4px')
  })

  it('bundles Inter, pinned exactly like the other @fontsource faces', () => {
    const deps = dependencies(pkg)
    expect(deps['@fontsource-variable/inter']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(deps['@fontsource-variable/inter']).toBe(deps['@fontsource/space-grotesk'])
    expect(indexCss).toContain('@import "@fontsource-variable/inter";')
  })

  it('every other theme keeps Space Grotesk (only Quick overrides --font-body)', () => {
    expect(indexCss).toMatch(/:root \{\s*--font-body: 'Space Grotesk'/)
    expect(css.match(/--font-body:/g)).toHaveLength(1)
  })
})

describe('Quick recipes', () => {
  it('the primary button is an --ink pill with --on-ink text and no light sweep', () => {
    expect(rule(`${Q} .btn`)).toContain('border-radius: 9999px')
    expect(rule(`${Q} .btn-primary`)).toMatch(/background: var\(--ink\); border-color: var\(--ink\); color: var\(--on-ink\)/)
    expect(rule(`${Q} .btn-primary::after`)).toContain('content: none')
  })

  it('a hovered primary button turns --ink-hover, with no accent glow', () => {
    const hover = rule(`${Q} .btn-primary:not(:disabled):hover`)
    expect(hover).toContain('background: var(--ink-hover)')
    expect(hover).toContain('box-shadow: none')
  })

  it('the secondary button carries an --ink edge and text', () => {
    expect(rule(`${Q} .btn-secondary`)).toMatch(/border-color: var\(--ink\); color: var\(--ink\)/)
  })

  it('focus outlines take --focus (themeContrast.test.ts pins --ring = --focus)', () => {
    expect(rule(`${Q} :focus-visible`)).toContain('outline-color: var(--focus)')
  })

  it('links and rendered-markdown links take --link and stay underlined', () => {
    expect(rule(`${Q} .link`)).toContain('color: var(--link)')
    expect(rule(`${Q} .link`)).not.toMatch(/text-decoration(?:-line)?:\s*none/)
    expect(rule(`${Q} .md-content a`)).toContain('color: var(--link)')
  })

  it('every override is scoped to Quick', () => {
    const look = css.slice(css.indexOf(`:root${Q}`))
    const selectors = look.split('}')
      .filter((chunk) => chunk.includes('{'))
      .map((chunk) => chunk.slice(0, chunk.lastIndexOf('{')).split(/[;{]/).at(-1)?.trim() ?? '')
    expect(selectors.length).toBeGreaterThan(10)
    const unscoped = selectors.filter((selector) => !topLevelParts(selector).every((part) => part.includes(Q)))
    expect(unscoped).toStrictEqual([])
  })
})

/** A selector list split on its top-level commas (not the ones inside `:is(…)`; our selectors nest one level). */
function topLevelParts(selector: string): string[] {
  return selector.replace(/\([^()]*\)/g, '()').split(',')
}
