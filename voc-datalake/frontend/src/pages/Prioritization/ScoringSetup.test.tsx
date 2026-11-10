/**
 * The Scoring setup: admins edit the workspace metrics (save with base_version, 409 →
 * reload), everyone else reads "How scoring works".
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import { DEFAULT_AXES } from '../../api/prioritizationAxes'
import type { AxisInput, PrioritizationConfig, SaveConfigResult } from '../../api/prioritizationConfigApi'

const auth = vi.hoisted(() => ({ isAdmin: true }))
const mockGetConfig = vi.fn<() => Promise<PrioritizationConfig>>()
const mockSaveConfig = vi.fn<(axes: readonly AxisInput[], base: number) => Promise<SaveConfigResult>>()

vi.mock('../../store/authStore', () => ({ useIsAdmin: () => auth.isAdmin }))
vi.mock('../../api/prioritizationConfigApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/prioritizationConfigApi')>(),
  prioritizationConfigApi: {
    getConfig: () => mockGetConfig(),
    saveConfig: (axes: readonly AxisInput[], base: number) => mockSaveConfig(axes, base),
  },
}))

import { ScoringSetupButton } from './ScoringSetupButton'

// The dialog and view are lazy-loaded: the FIRST open pays their cold module transform, which on a loaded runner
// under coverage took longer than a test's own wait (5.60.01). Load both here, under the hook timeout, so every
// test's `findBy*` measures the open itself.
beforeAll(async () => {
  await Promise.all([import('./ScoringSetupDialog'), import('./ScoringSetupView')])
})

const p = (key: string, options?: Record<string, unknown>) => i18n.t(`prioritization:${key}`, options)
/** A metric card's heading: its position and its name. */
const numbered = (n: number, name: string) => new RegExp(`^${String(n)}\\.\\s*${name}$`)
const STORED: PrioritizationConfig = { axes: DEFAULT_AXES, configVersion: 3, updatedAt: '2026-10-20T10:00:00Z', updatedBy: 'Ana' }

function renderButton(onSaved = vi.fn<() => void>()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ScoringSetupButton onSaved={onSaved} /></QueryClientProvider>)
  return onSaved
}

async function openEditor() {
  const user = userEvent.setup()
  const onSaved = renderButton()
  await user.click(screen.getByRole('button', { name: p('setup.open') }))
  // The dialog is lazy-loaded on first open, so allow for a cold import under a loaded runner.
  const dialog = await screen.findByRole('dialog', { name: p('setup.title') }, { timeout: 10000 })
  await within(dialog).findByText(p('setup.metricsTitle', { active: 4, max: 8 }), {}, { timeout: 10000 })
  return { user, dialog, onSaved }
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.isAdmin = true
  mockGetConfig.mockResolvedValue(STORED)
  mockSaveConfig.mockResolvedValue({ ok: true })
})

describe('the editor (admins)', () => {
  it('lists the configured metrics with their live share of the score', async () => {
    const { dialog } = await openEditor()

    expect(within(dialog).getAllByText(p('setup.share', { share: 40 })).length).toBeGreaterThan(0)
    expect(within(dialog).getByRole('heading', { name: numbered(4, p('scores.confidence')) })).toBeInTheDocument()
  })

  it('saves with the version it read, sending a built-in left at its translation as null', async () => {
    const { user, dialog, onSaved } = await openEditor()
    await user.click(within(dialog).getByRole('button', { name: p('setup.save') }))

    await waitFor(() => { expect(onSaved).toHaveBeenCalledWith() })
    const [axes, base] = mockSaveConfig.mock.calls.at(0) ?? [[], -1]
    expect([base, axes.map((axis) => [axis.id, axis.label, axis.weight])]).toStrictEqual([3, [
      ['impact', null, 40], ['time_to_market', null, 30], ['strategic_fit', null, 20], ['confidence', null, 10],
    ]])
  })

  it('applies a template only after a confirm that says what changes, then saves it', async () => {
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByRole('button', { name: new RegExp(p('setup.templates.rice')) }))
    const confirm = await screen.findByRole('dialog', { name: p('setup.templateConfirmTitle', { template: p('setup.templates.rice') }) })
    expect(confirm).toHaveTextContent(p('scores.strategicFit'))
    await user.click(within(confirm).getByRole('button', { name: p('setup.templateApply') }))
    await user.click(within(dialog).getByRole('button', { name: p('setup.save') }))

    await waitFor(() => { expect(mockSaveConfig).toHaveBeenCalledTimes(1) })
    const [axes] = mockSaveConfig.mock.calls.at(0) ?? [[]]
    expect(axes.map((axis) => [axis.id ?? 'new', axis.label, axis.weight, axis.direction, axis.archived])).toStrictEqual([
      ['new', p('setup.templateAxes.reach'), 30, 'higher_better', false],
      ['impact', null, 30, 'higher_better', false],
      ['confidence', null, 20, 'higher_better', false],
      ['new', p('setup.templateAxes.effort'), 20, 'lower_better', false],
      ['time_to_market', null, 30, 'higher_better', true],
      ['strategic_fit', null, 20, 'higher_better', true],
    ])
  })

  it('says someone else changed the setup on a 409 and reloads on request', async () => {
    mockSaveConfig.mockResolvedValue({ ok: false, kind: 'conflict' })
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByRole('button', { name: p('setup.save') }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(p('setup.conflict'))
    await user.click(within(dialog).getByRole('button', { name: p('setup.reload') }))
    await waitFor(() => { expect(mockGetConfig).toHaveBeenCalledTimes(2) })
  })

  it('blocks Save and says why when a new metric has no name', async () => {
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByRole('button', { name: p('setup.addMetric') }))

    expect(within(dialog).getByText(p('setup.problems.missingName'))).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: p('setup.save') })).toBeDisabled()
  })

  it('reorders with keyboard-reachable buttons', async () => {
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByRole('button', { name: p('setup.moveDown', { name: p('scores.impact') }) }))

    expect(within(dialog).getByRole('heading', { name: numbered(2, p('scores.impact')) })).toBeInTheDocument()
  })
})

describe('How scoring works (everyone else)', () => {
  it('shows the metrics, shares and directions read-only', async () => {
    auth.isAdmin = false
    const user = userEvent.setup()
    renderButton()
    await user.click(screen.getByRole('button', { name: p('setup.viewOpen') }))
    const dialog = await screen.findByRole('dialog', { name: p('setup.viewTitle') }, { timeout: 10000 })

    expect(await within(dialog).findByText(p('scores.timeToMarket'))).toBeInTheDocument()
    expect(within(dialog).getByText(p('setup.share', { share: 30 }))).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: p('setup.save') })).toBeNull()
  })
})
