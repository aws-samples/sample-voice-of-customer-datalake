/**
 * @fileoverview The wave-12 design-system wire: the `website` kind, the
 * reference statuses the API actually writes, `extracted_design` on a
 * reference, and the apply / reference-logo routes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const { fetchApi, resetFetchApi } = await import('@test/fetchApiRoutes')
const { designSystemApi, designSystemBody, normalizeAppliedDraft, normalizeDesignSystem, readDraftLogo, REFERENCE_KINDS } = await import('./designSystemApi')

const DESIGN = {
  colors: [{ name: 'primary', value: '#8e48ff' }, { name: '', value: '#000' }],
  typography: [{ role: 'mono', family: 'JetBrains Mono', weight: 400 }],
  spacing: [{ name: 'md', value: '16px' }],
  radius: 'not a list',
  guidelines_md: '- One accent',
  components: [{ name: 'Button', description: 'Primary and ghost' }, { description: 'nameless' }],
  logo: { source_url: 'https://kirocrew.dev/logo.png', content_type: 'image/png' },
  source: 'computed_styles',
}

beforeEach(() => resetFetchApi())

describe('reference kinds and statuses', () => {
  it('offers Live website first', () => {
    expect(REFERENCE_KINDS[0]).toBe('website')
  })

  it.each([['pending', 'pending'], ['processing', 'pending'], ['error', 'failed'], ['ready', 'ready'], ['???', 'pending']])(
    'reads status %s as %s', (wire, shown) => {
      const ds = normalizeDesignSystem({ references: [{ id: 'r', kind: 'website', title: 'Site', status: wire }] })
      expect(ds.references[0]?.status).toBe(shown)
    },
  )
})

describe('extracted_design on a reference', () => {
  it('keeps valid rows, drops malformed ones and reads the logo candidate', () => {
    const ds = normalizeDesignSystem({ references: [{ id: 'r', kind: 'website', title: 'Site', status: 'ready', extracted_design: DESIGN }] })
    const design = ds.references[0]?.extracted_design
    expect(design?.colors).toStrictEqual([{ name: 'primary', value: '#8e48ff' }])
    expect(design?.typography).toStrictEqual([{ role: 'mono', family: 'JetBrains Mono', weight: '400' }])
    expect([design?.radius, design?.components.map((c) => c.name)]).toStrictEqual([[], ['Button']])
    expect(design?.logo).toStrictEqual({ source_url: 'https://kirocrew.dev/logo.png', content_type: 'image/png' })
  })

  it.each([null, undefined, { source_url: 'not a url' }])('reads logo %j as no candidate', (logo) => {
    const ds = normalizeDesignSystem({ references: [{ id: 'r', kind: 'github', title: 'Repo', status: 'ready', extracted_design: { ...DESIGN, logo } }] })
    expect(ds.references[0]?.extracted_design?.logo).toBeNull()
  })

  it('leaves a reference without extracted_design as it was', () => {
    const ds = normalizeDesignSystem({ references: [{ id: 'r', kind: 'figma', title: 'F', status: 'ready' }] })
    expect(ds.references[0]).toStrictEqual({ id: 'r', kind: 'figma', title: 'F', status: 'ready' })
  })
})

describe('apply and reference logo', () => {
  it('POSTs apply and reads the draft', async () => {
    fetchApi.mockResolvedValue({ draft: { tokens: { colors: [{ name: 'primary', value: '#8e48ff' }] }, guidelines: 'G', logo_candidate: null } })
    const draft = await designSystemApi.applyReference('ref site')
    expect(fetchApi).toHaveBeenCalledWith('/settings/design-system/references/ref%20site/apply', { method: 'POST' })
    expect(draft).toStrictEqual({ tokens: { colors: [{ name: 'primary', value: '#8e48ff' }], typography: [], spacing: [], radius: [] }, guidelines: 'G', components: [], logo_candidate: null })
  })

  it('reads the draft components and a logo preview copy (wave 13)', async () => {
    const button = { name: 'Button', description: '', variants: [{ name: 'primary', styles: { background: 'var:primary' } }] }
    fetchApi.mockResolvedValue({ draft: { tokens: {}, guidelines: '', components: [button], logo_candidate: { source_url: 'https://x.example/l.png', preview_url: '/design/logo/preview.png' } } })
    const draft = await designSystemApi.applyReference('ref')
    expect(draft.components).toStrictEqual([{ ...button, variants: [{ ...button.variants[0], hover: {}, focus: {} }] }])
    expect(draft.logo_candidate?.preview_url).toBe('/design/logo/preview.png')
  })

  it.each(['javascript:alert(1)', '//evil.example/x.png', 'http://evil.example/x.png'])('drops an unsafe logo preview_url %s', (previewUrl) => {
    const draft = normalizeAppliedDraft({ draft: { tokens: {}, guidelines: '', logo_candidate: { source_url: 'https://x.example/l.png', preview_url: previewUrl } } })
    expect([draft.logo_candidate?.source_url, draft.logo_candidate?.preview_url]).toStrictEqual(['https://x.example/l.png', undefined])
  })

  it.each([
    [true, true],
    [false, false],
    ['yes', undefined],
  ])('reads a logo candidate rendered: %j as %j (5.39, the capture browser drew an SVG logo)', (rendered, expected) => {
    const logo = { source_url: 'https://x.example/l.svg', preview_url: '/design/logo/preview.png', rendered }
    const draft = normalizeAppliedDraft({ draft: { tokens: {}, guidelines: '', logo_candidate: logo } })
    expect([draft.logo_candidate?.source_url, draft.logo_candidate?.preview_url, draft.logo_candidate?.rendered]).toStrictEqual([logo.source_url, logo.preview_url, expected])
  })

  it('refuses an answer without a draft rather than loading an empty editor', () => {
    expect(() => normalizeAppliedDraft({ tokens: {} })).toThrow('no draft')
  })

  it('POSTs the logo route and reads the drafted logo (nothing saved)', async () => {
    fetchApi.mockResolvedValue({ logo_id: 'logo_0123456789ab.png', logo_url: 'https://cdn.example/logo.png' })
    await expect(designSystemApi.draftReferenceLogo('r1')).resolves.toStrictEqual({ id: 'logo_0123456789ab.png', url: 'https://cdn.example/logo.png' })
    expect(fetchApi).toHaveBeenCalledWith('/settings/design-system/references/r1/logo', { method: 'POST' })
  })

  it.each([{}, { logo_url: 'https://cdn.example/l.png' }, { logo_id: '../x.png', logo_url: 'https://cdn.example/l.png' }])('reads %j as no drafted logo', (raw) => {
    expect(readDraftLogo(raw)).toBeNull()
  })

  it('sends logo_id with the design system only when the draft carries a logo', () => {
    const value = { tokens: { colors: [], typography: [], spacing: [], radius: [] }, guidelines: '', components: [] }
    expect(designSystemBody(value)).not.toHaveProperty('logo_id')
    expect(designSystemBody({ ...value, logo: { id: 'logo_0123456789ab.png', url: 'u' } })).toHaveProperty('logo_id', 'logo_0123456789ab.png')
  })
})
