/**
 * @fileoverview /company → Design system, wave 12: the Live website kind (the
 * default), the preview of a read reference, "Use as design system" (a draft in
 * the editor + a change summary, nothing saved until Save), "Use this logo",
 * Reading… while pending, and the reasons when something fails.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag, fetchApi } from '@test/fetchApiRoutes'
import { registerDesignSectionHooks, renderDesignSection } from '@test/designSectionHarness'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const LOGO = { source_url: 'https://kirocrew.dev/logo.png', content_type: 'image/png' }
const SITE = {
  id: 'ref_site', kind: 'website', title: 'kirocrew.dev', url: 'https://kirocrew.dev', status: 'ready',
  extracted_design: {
    colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'surface', value: '#19161d' }],
    typography: [{ role: 'heading', family: 'Space Grotesk' }, { role: 'mono', family: 'JetBrains Mono' }],
    spacing: [], radius: [{ name: 'card', value: '12px' }],
    guidelines_md: '- One accent', components: [{ name: 'Button', description: '' }], logo: LOGO, source: 'computed_styles',
  },
}
const SAVED_TOKENS = { colors: [{ name: 'primary', value: '#000000' }], typography: [], spacing: [], radius: [] }
const DESIGN = { tokens: SAVED_TOKENS, guidelines: 'Be brief', references: [SITE], integrations: { figma: false, github: false } }
const DRAFT = {
  tokens: { ...SAVED_TOKENS, colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'surface', value: '#19161d' }] },
  guidelines: 'Be brief\n\n## From kirocrew.dev\n\n- One accent',
  logo_candidate: LOGO,
}

function renderSection(routes: Record<string, RouteHandler>) {
  renderDesignSection({ 'GET /settings/design-system': () => DESIGN, ...routes })
}

const calls = (key: string) => fetchApi.mock.calls.filter(([path, options]) => `${options?.method ?? 'GET'} ${path}` === key)

// jsdom has no scrollIntoView; the harness stubs it for the banner.
registerDesignSectionHooks()

describe('adding a reference', () => {
  it('defaults to Live website, explains it, and names the reference by its host when untitled', async () => {
    const create = vi.fn(() => ({ reference: { id: 'n', kind: 'website', title: 'acme.example', status: 'pending' } }))
    renderSection({ 'POST /settings/design-system/references': create })
    expect(await screen.findByRole('combobox', { name: 'Reference type' })).toHaveValue('website')
    expect(screen.getByText('We open the page in a secure browser and read its colors, fonts and logo.')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Link (https://…)' }), 'https://acme.example/brand')
    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ kind: 'website', title: 'acme.example', url: 'https://acme.example/brand' }))
  })

  it('returns the type to Live website after a reference is added', async () => {
    renderSection({ 'POST /settings/design-system/references': () => ({ reference: { id: 'g', kind: 'github', title: 'repo', status: 'pending' } }) })
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Reference type' }), 'github')
    await userEvent.type(screen.getByRole('textbox', { name: 'Link (https://…)' }), 'https://github.com/acme/ui')
    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Reference type' })).toHaveValue('website'))
  })

  it('tells GitHub users a public repository needs no token', async () => {
    renderSection({})
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Reference type' }), 'github')
    expect(screen.getByText(/Public repositories work without a token/)).toBeInTheDocument()
  })

  it('shows the server reason when the link is refused', async () => {
    renderSection({ 'POST /settings/design-system/references': () => { throw new ApiError(400, 'That address is not allowed') } })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Link (https://…)' }), 'https://10.0.0.1')
    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is not allowed')
  })
})

describe('reading status', () => {
  it('shows Reading… with a hint while pending and the reason when it failed', async () => {
    renderSection({ 'GET /settings/design-system': () => ({ ...DESIGN, references: [
      { id: 'p', kind: 'website', title: 'Pending site', url: 'https://p.example', status: 'processing' },
      { id: 'f', kind: 'website', title: 'Walled site', url: 'https://w.example', status: 'error', error: 'The site blocked the secure browser' },
    ] }) })
    expect(await screen.findByText('Reading…')).toBeInTheDocument()
    expect(screen.getByText(/Reading it now/)).toBeInTheDocument()
    expect(screen.getByText('The site blocked the secure browser')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use as design system' })).not.toBeInTheDocument()
  })
})

describe('the preview of a read reference', () => {
  it('shows swatches, fonts and counts', async () => {
    renderSection({})
    const preview = await screen.findByTestId('reference-design-preview')
    expect(within(preview).getByRole('img', { name: 'primary: #8e48ff' })).toHaveStyle({ backgroundColor: '#8e48ff' })
    expect(within(preview).getByText('Space Grotesk')).toBeInTheDocument()
    expect(within(preview).getByText('2 colors · 2 fonts · 1 corner radius · 1 component')).toBeInTheDocument()
  })

  it('shows only the first family of a font stack, with the whole stack as its tooltip', async () => {
    const stack = '"Space Grotesk", system-ui, sans-serif'
    const typography = [{ role: 'heading', family: stack }, { role: 'mono', family: "'JetBrains Mono', monospace" }]
    renderSection({ 'GET /settings/design-system': () => ({ ...DESIGN, references: [{ ...SITE, extracted_design: { ...SITE.extracted_design, typography } }] }) })
    const preview = await screen.findByTestId('reference-design-preview')
    expect(within(preview).getByText('Space Grotesk')).toHaveAttribute('title', stack)
    expect(within(preview).getByText('JetBrains Mono')).toHaveAttribute('title', "'JetBrains Mono', monospace")
  })

  it('shows the logo from the server copy (preview_url), never the remote original', async () => {
    const logo = { ...LOGO, preview_url: '/design/logo-preview/ref_site.png' }
    renderSection({ 'GET /settings/design-system': () => ({ ...DESIGN, references: [{ ...SITE, extracted_design: { ...SITE.extracted_design, logo } }] }) })
    const preview = await screen.findByTestId('reference-design-preview')
    await waitFor(() => expect(within(preview).getByRole('img', { name: 'Logo found on this reference' })).toHaveAttribute('src', logo.preview_url))
  })

  it('falls back to the icon when the logo has no preview copy', async () => {
    renderSection({})
    const preview = await screen.findByTestId('reference-design-preview')
    expect(within(preview).getByRole('img', { name: 'Logo found on this reference' }).tagName).toBe('svg')
    expect(within(preview).queryByRole('img', { name: 'Logo found on this reference' })).not.toHaveAttribute('src')
  })

  it('is view-only for non-admins', async () => {
    adminFlag.isAdmin = false
    renderSection({})
    expect(await screen.findByTestId('reference-design-preview')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use as design system' })).not.toBeInTheDocument()
  })
})

describe('Use as design system', () => {
  async function applied(routes: Record<string, RouteHandler> = {}) {
    renderSection({ 'POST /settings/design-system/references/ref_site/apply': () => ({ draft: DRAFT }), ...routes })
    await userEvent.click(await screen.findByRole('button', { name: 'Use as design system' }))
    return screen.findByRole('region', { name: /From kirocrew.dev/ })
  }

  it('summarises what the reference changes', async () => {
    const banner = await applied()
    expect(within(banner).getByText('Colors: 1 new, 1 updated')).toBeInTheDocument()
    expect(within(banner).queryByText(/0 (new|updated)/)).not.toBeInTheDocument()
    expect(within(banner).getByText('Guidelines added')).toBeInTheDocument()
  })

  it('puts the draft in the editor without saving it', async () => {
    await applied()
    expect(screen.getByLabelText('Guidelines')).toHaveValue(DRAFT.guidelines)
    expect(screen.getByRole('img', { name: 'Color swatch #19161d' })).toBeInTheDocument()
    expect(calls('PUT /settings/design-system')).toHaveLength(0)
  })

  it('Save stores the draft with the existing PUT', async () => {
    const save = vi.fn((body: unknown) => ({ ...DESIGN, ...(typeof body === 'object' ? body : {}) }))
    const banner = await applied({ 'PUT /settings/design-system': save })
    await userEvent.click(within(banner).getByRole('button', { name: 'Save design system' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ tokens: DRAFT.tokens, guidelines: DRAFT.guidelines, components: [] }))
    await waitFor(() => expect(screen.queryByRole('region', { name: /From kirocrew.dev/ })).not.toBeInTheDocument())
  })

  it('Discard restores the saved design system', async () => {
    const banner = await applied()
    await userEvent.click(within(banner).getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Guidelines')).toHaveValue('Be brief')
    expect(calls('PUT /settings/design-system')).toHaveLength(0)
  })

  it('asks before replacing unsaved edits', async () => {
    renderSection({ 'POST /settings/design-system/references/ref_site/apply': () => ({ draft: DRAFT }) })
    await userEvent.type(await screen.findByLabelText('Guidelines'), ' and kind')
    await userEvent.click(screen.getByRole('button', { name: 'Use as design system' }))
    expect(await screen.findByText('Replace your unsaved changes?')).toBeInTheDocument()
    expect(calls('POST /settings/design-system/references/ref_site/apply')).toHaveLength(0)
  })

  it('shows the reason when the reference cannot be applied', async () => {
    renderSection({ 'POST /settings/design-system/references/ref_site/apply': () => { throw new ApiError(409, 'Not read yet') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Use as design system' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not read yet')
  })
})

describe('Use this logo', () => {
  it('stores the candidate through the logo route and refreshes', async () => {
    const adopt = vi.fn(() => ({ logo_url: 'https://cdn.example/logo.png' }))
    renderSection({ 'POST /settings/design-system/references/ref_site/logo': adopt })
    await userEvent.click(await screen.findByRole('button', { name: 'Use this logo' }))
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(calls('GET /settings/design-system').length).toBeGreaterThan(1))
  })

  it('asks before replacing a logo that is already set, and shows a failure', async () => {
    renderSection({
      'GET /settings/design-system': () => ({ ...DESIGN, logo_url: 'https://cdn.example/old.png' }),
      'POST /settings/design-system/references/ref_site/logo': () => { throw new ApiError(400, 'The logo is larger than 2 MB') },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Use this logo' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use this logo' }))
    expect(await screen.findByText('The logo is larger than 2 MB')).toBeInTheDocument()
  })
})
