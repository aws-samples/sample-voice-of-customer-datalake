/**
 * @fileoverview A reference's components (wave 13): the preview counts them and
 * their variants and paints up to six mini previews from their styles; "Use as
 * design system" loads the merged components into the editor, the banner says
 * how many are new / updated, and Save sends them.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { registerDesignSectionHooks, renderDesignSection } from '@test/designSectionHarness'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const v = (name: string, styles: Record<string, string> = {}) => ({ name, styles })
const REFERENCE_COMPONENTS = [
  { name: 'Button', description: 'Actions', variants: [v('primary', { background: 'var:accent', color: '#ffffff' }), v('outline', { border_color: 'var:accent' }), v('ghost')] },
  { name: 'Card', description: '', variants: [v('default', { radius: '12px' })] },
  { name: 'Input', description: '', variants: [v('default')] },
  { name: 'Badge', description: '', variants: [v('default'), v('muted')] },
  { name: 'Tabs', description: '', variants: [v('default')] },
  { name: 'Dialog', description: '', variants: [v('default')] },
]
const SITE = {
  id: 'ref_site', kind: 'website', title: 'kirocrew.dev', url: 'https://kirocrew.dev', status: 'ready',
  extracted_design: {
    colors: [{ name: 'accent', value: '#8e48ff' }], typography: [], spacing: [], radius: [],
    guidelines_md: '', components: REFERENCE_COMPONENTS, logo: null,
  },
}
const SAVED_BUTTON = { name: 'button', description: 'Old', variants: [v('primary', { background: '#000000' })] }
const DESIGN = {
  tokens: { colors: [], typography: [], spacing: [], radius: [] }, guidelines: '', components: [SAVED_BUTTON],
  references: [SITE], integrations: { figma: false, github: false },
}
const MERGED = [REFERENCE_COMPONENTS[0], REFERENCE_COMPONENTS[1]]
const DRAFT = { tokens: DESIGN.tokens, guidelines: '', components: MERGED, logo_candidate: null }

function renderSection(routes: Record<string, RouteHandler> = {}) {
  renderDesignSection({ 'GET /settings/design-system': () => DESIGN, 'POST /settings/design-system/references/ref_site/apply': () => ({ draft: DRAFT }), ...routes })
}

registerDesignSectionHooks()

describe('the reference preview', () => {
  it('counts components and variants', async () => {
    renderSection()
    const preview = await screen.findByTestId('reference-design-preview')
    expect(within(preview).getByText('1 color · 6 components · 9 variants')).toBeInTheDocument()
  })

  it('paints at most six mini previews, first variants first, from the reference colours', async () => {
    renderSection()
    const row = await screen.findByTestId('reference-component-previews')
    const samples = within(row).getAllByTestId('mini-preview')
    expect(samples).toHaveLength(6)
    expect(within(row).getByText('Button · primary')).toBeInTheDocument()
    expect(samples[0]?.firstElementChild).toHaveStyle({ backgroundColor: '#8e48ff' })
  })
})

describe('Use as design system with components', () => {
  it('names the component changes in the banner', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Use as design system' }))
    const banner = await screen.findByRole('region', { name: /From kirocrew.dev/ })
    expect(within(banner).getByText('Components: 1 new · 1 updated')).toBeInTheDocument()
  })

  it('loads the merged components into the editor and Save sends them', async () => {
    const save = vi.fn(() => DESIGN)
    renderSection({ 'PUT /settings/design-system': save })
    await userEvent.click(await screen.findByRole('button', { name: 'Use as design system' }))
    const editor = screen.getByTestId('design-components')
    expect(within(editor).getByRole('button', { name: /^Card/ })).toBeInTheDocument()
    await userEvent.click(within(await screen.findByRole('region', { name: /From kirocrew.dev/ })).getByRole('button', { name: 'Save design system' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ components: MERGED })))
  })
})
