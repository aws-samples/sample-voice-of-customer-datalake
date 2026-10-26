/**
 * @fileoverview The change summary "Use as design system" shows, and the
 * counts a reference preview shows.
 */
import { describe, expect, it } from 'vitest'
import { designCounts, firstFamily, fontFamilies, hasDesign, summarizeDraft, urlHost } from './designDraftSummary'
import type { ExtractedDesign } from '../../api/designSystemApi'
import type { DesignComponent } from '../../api/designComponents'

const PRIMARY = { name: 'primary', styles: { background: 'var:primary' }, hover: {}, focus: {} }
const BUTTON: DesignComponent = { name: 'Button', description: 'Main action', variants: [PRIMARY] }

const SAVED = {
  tokens: {
    colors: [{ name: 'primary', value: '#000000' }, { name: 'text', value: '#ffffff' }],
    typography: [{ role: 'body', family: 'Inter' }],
    spacing: [],
    radius: [{ name: 'card', value: '12px' }],
  },
  guidelines: 'Be brief',
  components: [BUTTON],
}

const NO_COMPONENT_CHANGE = { added: 0, replaced: 0 }

const EMPTY_DESIGN: ExtractedDesign = { colors: [], typography: [], spacing: [], radius: [], guidelines_md: '', components: [], logo: null }

describe('summarizeDraft', () => {
  it('counts new and replaced tokens per group and notices the guidelines', () => {
    const draft = {
      tokens: {
        colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'text', value: '#ffffff' }, { name: 'surface', value: '#19161d' }],
        typography: [{ role: 'body', family: 'Space Grotesk' }, { role: 'mono', family: 'JetBrains Mono' }],
        spacing: [],
        radius: [{ name: 'card', value: '12px' }],
      },
      guidelines: 'Be brief\n\n## From kirocrew.dev\n\n- One accent',
      components: [BUTTON],
    }
    expect(summarizeDraft(SAVED, draft)).toStrictEqual({
      groups: [{ group: 'colors', added: 1, replaced: 1 }, { group: 'typography', added: 1, replaced: 1 }],
      components: NO_COMPONENT_CHANGE,
      guidelinesChanged: true,
      changed: true,
    })
  })

  it('reports nothing to review when the draft equals the saved design system', () => {
    expect(summarizeDraft(SAVED, { ...SAVED, guidelines: 'Be brief  ' }))
      .toStrictEqual({ groups: [], components: NO_COMPONENT_CHANGE, guidelinesChanged: false, changed: false })
  })

  it('counts components new and replaced by name, case-insensitively', () => {
    const outline = { name: 'outline', styles: { border_color: '#8e48ff' }, hover: {}, focus: {} }
    const draft = { ...SAVED, components: [{ ...BUTTON, name: 'button', variants: [...BUTTON.variants, outline] }, { ...BUTTON, name: 'Card' }] }
    const summary = summarizeDraft(SAVED, draft)
    expect(summary.components).toStrictEqual({ added: 1, replaced: 1 })
    expect(summary.changed).toBe(true)
  })

  it('does not count an empty hover or a trailing space as a component change', () => {
    const draft = { ...SAVED, components: [{ ...BUTTON, description: 'Main action ', variants: [{ ...PRIMARY, hover: { color: ' ' } }] }] }
    expect(summarizeDraft(SAVED, draft).changed).toBe(false)
  })
})

describe('preview counts', () => {
  it('lists each font family once and counts every group', () => {
    const design = { ...EMPTY_DESIGN, typography: [{ role: 'heading', family: 'Space Grotesk' }, { role: 'body', family: 'Space Grotesk ' }, { role: 'mono', family: 'JetBrains Mono' }], colors: [{ name: 'a', value: '#000' }], components: [BUTTON, { ...BUTTON, name: 'Card', variants: [] }] }
    expect(fontFamilies(design).map((font) => font.name)).toStrictEqual(['Space Grotesk', 'JetBrains Mono'])
    expect(designCounts(design)).toStrictEqual({ colors: 1, fonts: 2, spacing: 0, radii: 0, components: 2, variants: 1 })
  })

  it('names a font by the first family of its stack and keeps the stack', () => {
    const design = { ...EMPTY_DESIGN, typography: [{ role: 'body', family: '"Space Grotesk", system-ui, sans-serif' }, { role: 'h', family: "'Space Grotesk', sans-serif" }] }
    expect(fontFamilies(design)).toStrictEqual([{ name: 'Space Grotesk', stack: '"Space Grotesk", system-ui, sans-serif' }])
    expect([firstFamily("'JetBrains Mono', ui-monospace"), firstFamily('')]).toStrictEqual(['JetBrains Mono', ''])
  })

  it('treats a reference with nothing in it as having no design', () => {
    expect(hasDesign(undefined)).toBe(false)
    expect(hasDesign(EMPTY_DESIGN)).toBe(false)
    expect(hasDesign({ ...EMPTY_DESIGN, guidelines_md: 'Rules' })).toBe(true)
    expect(hasDesign({ ...EMPTY_DESIGN, logo: { source_url: 'https://x.example/l.png' } })).toBe(true)
  })

  it('names a link by its host', () => {
    expect([urlHost('https://kirocrew.dev/about'), urlHost('nope')]).toStrictEqual(['kirocrew.dev', ''])
  })
})
