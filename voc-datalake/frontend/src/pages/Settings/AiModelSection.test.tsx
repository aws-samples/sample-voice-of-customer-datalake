/**
 * @fileoverview Tests for the per-surface AI model picker (issue #96).
 *
 * REVERT MAP for the Automatic-label precedence (issue #275, upstream PR #402) —
 * each assertion names the mutation it catches:
 *   - labelling from `surface.default_id` while a global pin is deployed →
 *     'names the deployment-wide pin in every Automatic option'.
 *   - labelling from `data.model_id` unconditionally (so a null/absent pin
 *     erases the tuned per-surface defaults) → 'shows each surface default
 *     inside its Automatic option' and 'ignores an empty-string pin'.
 *   - letting the pin drive the *selected* value, not just the Automatic label →
 *     'keeps an explicit per-surface selection selected under a global pin'.
 *   - dropping the id-string fallback → 'falls back to the pinned id'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import AiModelSection from './AiModelSection'

const mockGetModelSettings = vi.fn<(...args: unknown[]) => unknown>()
const mockSaveModelSettings = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getModelSettings: () => mockGetModelSettings(),
    saveModelSettings: (surface: string, modelId: string | null) =>
      mockSaveModelSettings(surface, modelId),
    testModel: () => Promise.reject(new Error('not under test here')),
    getModelCapacity: () => Promise.resolve([]),
  },
}))

const SONNET55 = 'global.anthropic.claude-sonnet-5-5'
const SONNET5 = 'global.anthropic.claude-sonnet-5'
const SONNET46 = 'global.anthropic.claude-sonnet-4-6'
const OPUS5 = 'global.anthropic.claude-opus-5'
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

const SURFACE_LABELS = ['AI Assistant', 'Document Generation', 'Prototype Builder', 'Feedback Enrichment', 'Utilities']

/** Text of the first (Automatic) option of the surface select labelled `label`. */
const automaticOptionOf = (label: string) =>
  within(screen.getByLabelText(label)).getAllByRole('option').at(0)?.textContent

const modelSettingsFixture = {
  available_models: [
    { key: 'sonnet55', id: SONNET55, label: 'Claude Sonnet 5.5', description: 'Newest Sonnet' },
    { key: 'sonnet5', id: SONNET5, label: 'Claude Sonnet 5', description: 'Latest Sonnet' },
    { key: 'sonnet46', id: SONNET46, label: 'Claude Sonnet 4.6', description: 'Previous Sonnet' },
    { key: 'opus5', id: OPUS5, label: 'Claude Opus 5', description: 'Deepest reasoning' },
    { key: 'haiku45', id: HAIKU45, label: 'Claude Haiku 4.5', description: 'Fastest' },
  ],
  surfaces: [
    { key: 'chat', default_id: SONNET55, selected: null },
    { key: 'documents', default_id: SONNET5, selected: null },
    { key: 'prototype', default_id: OPUS5, selected: null },
    { key: 'enrichment', default_id: HAIKU45, selected: null },
    { key: 'utility', default_id: SONNET5, selected: null },
  ],
  model_id: null,
}

/** Mount the section as an admin against a configured API. */
function renderAdminSection() {
  return renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />)
}

/** Mount as admin, wait for the surfaces to load, then pick `modelId` for the AI Assistant. */
async function renderAndPickAssistantModel(user: UserEvent, modelId: string) {
  renderAdminSection()
  await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toBeInTheDocument())
  await user.selectOptions(screen.getByLabelText('AI Assistant'), modelId)
}

/** Press the row's Save, then confirm saving the (untested) model. */
async function saveAndConfirm(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await user.click(await screen.findByRole('button', { name: 'Save anyway' }))
}

describe('AiModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetModelSettings.mockResolvedValue(modelSettingsFixture)
    mockSaveModelSettings.mockResolvedValue({ success: true, surface: 'chat', model_id: HAIKU45 })
  })

  it('renders nothing without an API endpoint', () => {
    const { container } = renderWithQueryClient(<AiModelSection apiEndpoint="" isAdmin />)

    expect(container).toBeEmptyDOMElement()
    expect(mockGetModelSettings).not.toHaveBeenCalled()
  })

  it('renders nothing (and never fetches) for non-admins', () => {
    const { container } = renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin={false} />)

    expect(container).toBeEmptyDOMElement()
    expect(mockGetModelSettings).not.toHaveBeenCalled()
  })

  it('renders one selector per surface, all on Automatic by default', async () => {
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toBeInTheDocument())
    for (const label of SURFACE_LABELS) {
      const select = screen.getByLabelText(label)
      expect(select).toHaveValue('')
    }
  })

  it('shows each surface default inside its Automatic option', async () => {
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('Prototype Builder')).toBeInTheDocument())
    expect({
      prototype: automaticOptionOf('Prototype Builder'),
      assistant: automaticOptionOf('AI Assistant'),
      enrichment: automaticOptionOf('Feedback Enrichment'),
    }).toStrictEqual({
      prototype: 'Automatic — Claude Opus 5',
      assistant: 'Automatic — Claude Sonnet 5.5',
      enrichment: 'Automatic — Claude Haiku 4.5',
    })
    expect(screen.getByText('Floating page-aware assistant and the full-screen chat page')).toBeInTheDocument()
  })

  it('keeps each surface default in its Automatic option when the pin field is absent', async () => {
    // Positive control for the null case above: `model_id` missing from the
    // payload (not merely null) must not be read as a pin either.
    const withoutPinField = Object.fromEntries(
      Object.entries(modelSettingsFixture).filter(([key]) => key !== 'model_id'),
    )
    mockGetModelSettings.mockResolvedValue(withoutPinField)
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('Prototype Builder')).toBeInTheDocument())
    expect(automaticOptionOf('Prototype Builder')).toBe('Automatic — Claude Opus 5')
    expect(automaticOptionOf('AI Assistant')).toBe('Automatic — Claude Sonnet 5.5')
  })

  it('names the deployment-wide pin in every Automatic option', async () => {
    // The resolver ranks settings.model_id above SURFACE_DEFAULTS, so a pinned
    // deployment runs Sonnet 4.6 everywhere — the label has to say so (#275).
    mockGetModelSettings.mockResolvedValue({ ...modelSettingsFixture, model_id: SONNET46 })
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toBeInTheDocument())
    for (const label of SURFACE_LABELS) {
      expect(automaticOptionOf(label)).toBe('Automatic — Claude Sonnet 4.6')
      expect(screen.getByLabelText(label)).toHaveValue('')
    }
    // No surface keeps advertising its built-in default under a pin.
    expect(screen.queryByText('Automatic — Claude Opus 5')).not.toBeInTheDocument()
  })

  it('keeps an explicit per-surface selection selected under a global pin', async () => {
    // The pin only re-labels Automatic; a stored per-surface choice still wins
    // in the resolver and must stay the selected option.
    mockGetModelSettings.mockResolvedValue({
      ...modelSettingsFixture,
      model_id: SONNET46,
      surfaces: modelSettingsFixture.surfaces.map((s) =>
        s.key === 'chat' ? { ...s, selected: OPUS5 } : s,
      ),
    })
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toHaveValue(OPUS5))
    expect(automaticOptionOf('AI Assistant')).toBe('Automatic — Claude Sonnet 4.6')
  })

  it('falls back to the pinned id when no friendly label is available', async () => {
    mockGetModelSettings.mockResolvedValue({ ...modelSettingsFixture, model_id: 'global.anthropic.claude-unknown-9' })
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toBeInTheDocument())
    expect(automaticOptionOf('AI Assistant')).toBe('Automatic — global.anthropic.claude-unknown-9')
  })

  it('ignores an empty-string pin and keeps the surface default', async () => {
    // '' is not an allowlisted id; treating it as a pin would label Automatic
    // with the empty string and lose the default entirely.
    mockGetModelSettings.mockResolvedValue({ ...modelSettingsFixture, model_id: '' })
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('Prototype Builder')).toBeInTheDocument())
    expect(automaticOptionOf('Prototype Builder')).toBe('Automatic — Claude Opus 5')
  })

  it('saves a per-surface selection after confirming the untested model, then shows Saved', async () => {
    const user = userEvent.setup()
    await renderAndPickAssistantModel(user, HAIKU45)
    await saveAndConfirm(user)

    expect(mockSaveModelSettings).toHaveBeenCalledWith('chat', HAIKU45)
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
  })

  it('clears a selection back to Automatic (null)', async () => {
    mockGetModelSettings.mockResolvedValue({
      ...modelSettingsFixture,
      surfaces: modelSettingsFixture.surfaces.map((s) =>
        s.key === 'chat' ? { ...s, selected: HAIKU45 } : s,
      ),
    })
    mockSaveModelSettings.mockResolvedValue({ success: true, surface: 'chat', model_id: null })
    const user = userEvent.setup()
    renderAdminSection()

    await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toHaveValue(HAIKU45))
    await user.selectOptions(screen.getByLabelText('AI Assistant'), '')
    await saveAndConfirm(user)

    expect(mockSaveModelSettings).toHaveBeenCalledWith('chat', null)
  })

  it('shows an error state instead of an infinite spinner when the load fails', async () => {
    mockGetModelSettings.mockRejectedValue(new Error('boom'))
    renderAdminSection()

    await waitFor(() =>
      expect(screen.getByText('Could not load model settings.')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Loading models...')).not.toBeInTheDocument()
  })

  it('shows a save error message when the mutation fails', async () => {
    mockSaveModelSettings.mockRejectedValue(new Error('403'))
    const user = userEvent.setup()
    await renderAndPickAssistantModel(user, HAIKU45)
    await saveAndConfirm(user)

    await waitFor(() =>
      expect(screen.getByText('Failed to save model selection. Try again.')).toBeInTheDocument(),
    )
  })
})
