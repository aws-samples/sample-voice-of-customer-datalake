/**
 * The build wizard's "Design system" box (Also read (optional)).
 *
 * Ticked by default when the company has a design system, and the label says what will
 * be read. Unticking sends `use_design_system: false`. With none set up the box is
 * disabled, says why and links to where it is set up, and the request carries no field
 * (the API default). While the design system is not known the row is absent and the
 * request is the one this card always sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PRD, PRFAQ, prototypeProjectsApiModule, resetPrototypeMocks, sentBuildBody, confirmWizardBuild,
} from './prototype-fixtures'
// After the fixtures on purpose: this imports OverviewTab, whose module graph runs the
// `vi.mock` factory below, which needs the fixture module evaluated.
import { buildButton, overviewTab } from './prototype-render-fixtures'
import { normalizeDesignSystem } from '../../api/designSystemApi'
import { TestRouter } from '../../test/TestRouter'
import type { DesignSystem } from '../../api/designSystemApi'

vi.mock('../../api/projectsApi', () => prototypeProjectsApiModule())

const FULL: DesignSystem = normalizeDesignSystem({
  tokens: {
    colors: [{ name: 'primary', value: '#8e48ff' }],
    typography: [{ role: 'body', family: 'Inter' }],
    spacing: [{ name: 'md', value: '16px' }],
    radius: [],
  },
  guidelines: 'One primary action per screen.',
  references: [
    { id: 'ref_a', kind: 'figma', title: 'Checkout', status: 'ready', extracted_summary: 'Purple.' },
    // Not read by the prompt, so not counted: still processing, and ready without a summary.
    { id: 'ref_b', kind: 'screenshot', title: 'Home', status: 'processing' },
    { id: 'ref_c', kind: 'figma', title: 'Empty', status: 'ready' },
  ],
})
const COLOURS_ONLY: DesignSystem = normalizeDesignSystem({ tokens: { colors: [{ name: 'primary', value: '#000' }] } })
const COMPONENTS_ONLY: DesignSystem = normalizeDesignSystem({
  components: [{ name: 'Button', description: 'Main action', variants: [{ name: 'primary', styles: { background: '#000' } }] }],
})
const NONE: DesignSystem = normalizeDesignSystem({})

async function openWizard(designSystem?: DesignSystem) {
  const user = userEvent.setup()
  render(overviewTab({ documents: [PRD, PRFAQ], designSystem }), { wrapper: TestRouter })
  await user.click(buildButton())
  return { user, dialog: screen.getByRole('dialog') }
}

beforeEach(() => resetPrototypeMocks())

describe('Design system box in the build wizard', () => {
  it('is ticked by default and says what will be read', async () => {
    const { dialog } = await openWizard(FULL)
    const box = within(dialog).getByRole('checkbox', { name: 'Design system' })
    expect(box).toBeChecked()
    expect(box).toBeEnabled()
    expect(box).toHaveAccessibleDescription('Uses its colours, type, spacing, guidelines, and 1 reference design')
  })

  it('counts component styles as something to read, so a design system of only components is offered', async () => {
    const { dialog } = await openWizard(COMPONENTS_ONLY)
    const box = within(dialog).getByRole('checkbox', { name: 'Design system' })
    expect(box).toBeChecked()
    expect(box).toHaveAccessibleDescription('Uses its 1 component style')
  })

  it('sends use_design_system true by default', async () => {
    const { user } = await openWizard(COLOURS_ONLY)
    await confirmWizardBuild(user)
    expect(sentBuildBody().use_design_system).toBe(true)
  })

  it('sends use_design_system false once unticked', async () => {
    const { user, dialog } = await openWizard(COLOURS_ONLY)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Design system' }))
    await confirmWizardBuild(user)
    expect(sentBuildBody().use_design_system).toBe(false)
  })

  it('is disabled with the reason and a link to set it up when none exists', async () => {
    const { dialog } = await openWizard(NONE)
    const box = within(dialog).getByRole('checkbox', { name: 'Design system' })
    expect(box).toBeDisabled()
    expect(box).toHaveAccessibleDescription(/^none set up yet\. once an administrator adds your colours/i)
    expect(within(dialog).getByRole('link', { name: 'Open Design system' })).toHaveAttribute('href', '/company?tab=design')
  })

  it.each([
    ['none set up', NONE],
    ['not known yet', undefined],
  ])('omits the field when %s, so the API default applies', async (_label, designSystem) => {
    const { user } = await openWizard(designSystem)
    await confirmWizardBuild(user)
    expect(sentBuildBody()).not.toHaveProperty('use_design_system')
  })

  it('shows no row while the design system is not known', async () => {
    const { dialog } = await openWizard()
    expect(within(dialog).queryByTestId('prototype-design-system')).not.toBeInTheDocument()
  })
})
