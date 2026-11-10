/**
 * @fileoverview /company → Design system → Components (wave 13): add, edit and
 * remove components and variants, the "Use token…" picker writing `var:<name>`,
 * the live preview resolving tokens, invalid values blocking Save, the read-only
 * view, and example HTML staying out of the app document (sandboxed frame only).
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag } from '@test/fetchApiRoutes'
import { registerDesignSectionHooks, renderDesignSection } from '@test/designSectionHarness'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const TOKENS = { colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'surface', value: '#19161d' }], typography: [], spacing: [], radius: [] }
const BUTTON = {
  name: 'Button', description: 'Main action',
  variants: [{ name: 'primary', styles: { background: 'var:primary', color: '#ffffff', radius: '8px' }, hover: { background: '#9f63ff' } }],
}
const DESIGN = { tokens: TOKENS, guidelines: '', components: [BUTTON], references: [], integrations: { figma: false, github: false } }

function renderSection(routes: Record<string, RouteHandler> = {}) {
  renderDesignSection({ 'GET /settings/design-system': () => DESIGN, ...routes })
}

async function expand(name: string) {
  const section = await screen.findByTestId('design-components')
  await userEvent.click(within(section).getByRole('button', { name: new RegExp(`^${name}`) }))
  return section
}

const sample = (state: string) => {
  const figure = screen.getAllByTestId('variant-preview')[0]?.querySelector(`[data-state="${state}"]`)
  const element = figure?.firstElementChild
  if (!(element instanceof HTMLElement)) throw new Error(`no ${state} sample`)
  return element
}

/** The i-th element, or a failed test when there is none. */
function nth(elements: readonly HTMLElement[], index: number): HTMLElement {
  const element = elements[index]
  if (!element) throw new Error(`no element #${index}`)
  return element
}

registerDesignSectionHooks()

describe('the live preview', () => {
  it('paints a real button from the variant, resolving var:primary from the current tokens', async () => {
    renderSection()
    await expand('Button')
    expect(sample('default').tagName).toBe('BUTTON')
    expect(sample('default')).toHaveStyle({ backgroundColor: '#8e48ff', color: '#ffffff', borderRadius: '8px' })
    expect(sample('hover')).toHaveStyle({ backgroundColor: '#9f63ff' })
  })

  it('follows a token change made in the same draft', async () => {
    renderSection()
    const primary = nth(await screen.findAllByRole('textbox', { name: 'Value' }), 0)
    await userEvent.clear(primary)
    await userEvent.type(primary, '#123456')
    await expand('Button')
    expect(sample('default')).toHaveStyle({ backgroundColor: '#123456' })
  })
})

describe('editing', () => {
  it('adds a component and saves it in THE CONTRACT shape', async () => {
    const save = vi.fn((body: unknown) => ({ ...DESIGN, ...(typeof body === 'object' ? body : {}) }))
    renderSection({ 'PUT /settings/design-system': save })
    const section = await screen.findByTestId('design-components')
    await userEvent.click(within(section).getByRole('button', { name: 'Add component' }))
    await userEvent.type(within(section).getByRole('textbox', { name: 'Name' }), 'Card')
    await userEvent.type(nth(within(section).getAllByRole('textbox', { name: 'Corner radius' }), 0), '12px')
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      components: [BUTTON, { name: 'Card', description: '', variants: [{ name: 'default', styles: { radius: '12px' } }] }],
    })))
  })

  it('"Use token…" writes var:<token name> into the colour field', async () => {
    renderSection()
    const section = await expand('Button')
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: 'Use a color token for Text color' }), 'surface')
    expect(within(section).getByRole('textbox', { name: 'Text color' })).toHaveValue('var:surface')
    expect(sample('default')).toHaveStyle({ color: '#19161d' })
  })

  it('adds, renames and removes a variant', async () => {
    renderSection({ 'GET /settings/design-system': () => ({ ...DESIGN, components: [{ ...BUTTON, variants: [{ name: 'primary', styles: {} }] }] }) })
    const section = await expand('Button')
    await userEvent.click(within(section).getByRole('button', { name: 'Add variant' }))
    const second = nth(within(section).getAllByRole('textbox', { name: 'Variant name' }), 1)
    await userEvent.clear(second)
    second.focus()
    await userEvent.paste('subtle')
    await userEvent.click(within(section).getByRole('button', { name: 'Remove variant subtle' }))
    expect(within(section).getAllByTestId('variant-editor')).toHaveLength(1)
  })

  // Render-only (no typing): six full variant editors re-rendering on every keystroke ran past
  // the 10 s test limit under the parallel validate.
  it('stops adding variants at eight, the server cap', async () => {
    const eight = ['primary', 'outline', 'ghost', 'danger', 'link', 'subtle', 'inverse', 'neutral'].map((name) => ({ name, styles: {} }))
    renderSection({ 'GET /settings/design-system': () => ({ ...DESIGN, components: [{ ...BUTTON, variants: eight }] }) })
    const section = await expand('Button')
    expect(within(section).getByRole('button', { name: 'Add variant' })).toBeDisabled()
  })

  it('edits the focus ring border colour and glow beside the outline', async () => {
    renderSection()
    const section = await expand('Button')
    await userEvent.click(within(section).getByText('Hover and focus'))
    const glow = within(section).getByRole('textbox', { name: 'Shadow on focus' })
    await userEvent.type(glow, 'url(x)')
    expect(glow).toHaveAttribute('aria-invalid', 'true')
    expect(within(section).getByRole('textbox', { name: 'Border color on focus' })).toBeInTheDocument()
    expect(within(section).getByRole('textbox', { name: 'Width' })).toBeInTheDocument()
  })

  it('flags an invalid value and keeps Save disabled until it is fixed', async () => {
    renderSection()
    const section = await expand('Button')
    const radius = within(section).getByRole('textbox', { name: 'Corner radius' })
    await userEvent.clear(radius)
    await userEvent.type(radius, 'big')
    expect(radius).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('asks before removing a component', async () => {
    renderSection()
    const section = await screen.findByTestId('design-components')
    await userEvent.click(within(section).getByRole('button', { name: 'Remove Button' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(section).queryByRole('button', { name: /^Button/ })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()
  })
})

describe('example HTML', () => {
  const HOSTILE = '<img src="x" onerror="window.__pwned = 1"><b id="evil-example">Go</b><script>window.__pwned = 2</script>'

  it('is shown only inside a sandboxed frame, never in the app document', async () => {
    renderSection({ 'GET /settings/design-system': () => ({ ...DESIGN, components: [{ ...BUTTON, example_html: HOSTILE }] }) })
    const section = await expand('Button')
    await userEvent.click(within(section).getByText('Advanced: example HTML'))
    const frame = within(section).getByTestId('example-frame')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame.getAttribute('srcdoc')).toContain('evil-example')
    expect(document.getElementById('evil-example')).toBeNull()
    expect(Reflect.get(window, '__pwned')).toBeUndefined()
  })
})

describe('view-only', () => {
  it('shows the components and their previews without any field', async () => {
    adminFlag.isAdmin = false
    renderSection()
    const section = await expand('Button')
    expect(within(section).getByTestId('variant-view')).toHaveTextContent('background=var:primary')
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: 'Add component' })).not.toBeInTheDocument()
  })
})
