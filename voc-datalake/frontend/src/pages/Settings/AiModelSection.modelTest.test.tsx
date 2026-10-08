/**
 * @fileoverview Draft-then-save and the model test on the Settings AI models card
 * (POST /settings/model/test, GET /settings/model/capacity).
 *
 * The picker basics (labels, Automatic precedence, load/save errors) are in
 * AiModelSection.test.tsx; this file pins what the test feature changed:
 *   - a select edits a DRAFT; nothing is saved until Save, Discard restores;
 *   - Test sends exactly the model the draft resolves to (Automatic included);
 *   - each status renders its own pill, and No capacity says "wait" with no link;
 *   - saving an untested or failing model asks first, a passing one does not;
 *   - "Test all models" runs one model at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import AiModelSection from './AiModelSection'
import type { ModelTestResult, ModelTestStatus } from '../../api/modelTestSchema'

const getSettings = vi.fn<() => Promise<unknown>>()
const saveSettings = vi.fn<(surface: string, modelId: string | null) => Promise<unknown>>()
const testModel = vi.fn<(modelId: string) => Promise<ModelTestResult>>()
const getCapacity = vi.fn<() => Promise<unknown[]>>()

vi.mock('../../api/client', () => ({
  api: {
    getModelSettings: () => getSettings(),
    saveModelSettings: (surface: string, modelId: string | null) => saveSettings(surface, modelId),
    testModel: (modelId: string) => testModel(modelId),
    getModelCapacity: () => getCapacity(),
  },
}))

const OPUS55 = 'global.anthropic.claude-opus-5-5'
const SONNET55 = 'global.anthropic.claude-sonnet-5-5'
const HAIKU55 = 'global.anthropic.claude-haiku-5-5'

const settings = {
  available_models: [
    { key: 'opus55', id: OPUS55, label: 'Claude Opus 5.5', description: 'Deepest' },
    { key: 'sonnet55', id: SONNET55, label: 'Claude Sonnet 5.5', description: 'Flagship' },
    { key: 'haiku55', id: HAIKU55, label: 'Claude Haiku 5.5', description: 'Fastest' },
  ],
  surfaces: [
    { key: 'chat', default_id: SONNET55, selected: null },
    { key: 'prototype', default_id: OPUS55, selected: OPUS55 },
  ],
  model_id: null,
}

function result(modelId: string, status: ModelTestStatus, extra: Partial<ModelTestResult> = {}): ModelTestResult {
  return {
    model_id: modelId, invoked_id: modelId, status, latency_ms: null, message: '',
    quota: null, checked_at: '2026-10-08T00:00:00+00:00', ...extra,
  }
}

/** The surface row holding the select labelled `label`. */
function rowOf(label: string): HTMLElement {
  const row = screen.getByLabelText(label).closest<HTMLElement>('[data-surface]')
  if (!row) throw new Error(`no row for ${label}`)
  return row
}

type User = ReturnType<typeof userEvent.setup>

/** Click the button named `name` in the AI Assistant row. */
const clickAssistant = (user: User, name: string) =>
  user.click(within(rowOf('AI Assistant')).getByRole('button', { name }))

/** Draft Haiku 5.5 on the AI Assistant, test it, wait for `status`, then press Save. */
async function draftTestAndSave(user: User, statusLabel: string) {
  await user.selectOptions(screen.getByLabelText('AI Assistant'), HAIKU55)
  await clickAssistant(user, 'Test')
  await within(rowOf('AI Assistant')).findByText(statusLabel)
  await clickAssistant(user, 'Save')
}

async function renderLoaded() {
  renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />)
  await waitFor(() => expect(screen.getByLabelText('AI Assistant')).toBeInTheDocument())
}

describe('AiModelSection — draft, test, save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSettings.mockResolvedValue(settings)
    saveSettings.mockResolvedValue({ success: true })
    getCapacity.mockResolvedValue([])
    testModel.mockImplementation((modelId) => Promise.resolve(result(modelId, 'available', { latency_ms: 420 })))
  })

  it('changing a select only edits the draft: no save, Save and Discard appear', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.selectOptions(screen.getByLabelText('AI Assistant'), HAIKU55)

    expect(saveSettings).not.toHaveBeenCalled()
    expect(within(rowOf('AI Assistant')).getByText('Unsaved change')).toBeInTheDocument()
    expect(within(rowOf('AI Assistant')).getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(within(rowOf('Prototype Builder')).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('Discard restores the stored choice without saving', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.selectOptions(screen.getByLabelText('Prototype Builder'), HAIKU55)
    await user.click(within(rowOf('Prototype Builder')).getByRole('button', { name: 'Discard' }))

    expect(screen.getByLabelText('Prototype Builder')).toHaveValue(OPUS55)
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('Test on Automatic tests the model Automatic resolves to, then the draft model', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await clickAssistant(user, 'Test')
    await user.selectOptions(screen.getByLabelText('AI Assistant'), HAIKU55)
    await clickAssistant(user, 'Test')

    expect(testModel.mock.calls).toStrictEqual([[SONNET55], [HAIKU55]])
  })

  it('shows Available with latency and tokens/min', async () => {
    testModel.mockResolvedValue(result(SONNET55, 'available', {
      latency_ms: 1234, quota: { name: 'q', tokens_per_minute: 6_000_000 },
    }))
    const user = userEvent.setup()
    await renderLoaded()

    await clickAssistant(user, 'Test')

    const pill = await within(rowOf('AI Assistant')).findByText('Available')
    expect(pill).toHaveTextContent('Available1,234 ms · 6,000,000 tokens/min')
  })

  it.each([
    ['no_access', 'No access', 'This account has no access to the model'],
    ['not_in_region', 'Not in this region', 'not offered in this region'],
    ['no_capacity', 'No capacity', 'Quota is 0 for this model in this account; nothing to do but wait.'],
    ['throttled', 'Throttled', 'retry in a moment'],
    ['not_ready', 'Not ready', 'retry in a few minutes'],
    ['unavailable', 'Unavailable', 'temporarily unavailable'],
    ['error', 'Error', 'The test request failed.'],
  ] satisfies Array<[ModelTestStatus, string, string]>)('renders %s as "%s" with its explanation', async (status, label, detail) => {
    testModel.mockResolvedValue(result(SONNET55, status))
    const user = userEvent.setup()
    await renderLoaded()

    await clickAssistant(user, 'Test')

    const row = rowOf('AI Assistant')
    expect(await within(row).findByText(label)).toBeInTheDocument()
    expect(within(row).getByText(detail, { exact: false })).toBeInTheDocument()
    // Nothing to request: never a link (e.g. to a quota increase) from a test result.
    expect(within(row).queryByRole('link')).not.toBeInTheDocument()
  })

  it('a failed request records Error instead of spinning', async () => {
    testModel.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()
    await renderLoaded()

    await clickAssistant(user, 'Test')

    expect(await within(rowOf('AI Assistant')).findByText('Error')).toBeInTheDocument()
  })

  it('saving a model that tested Available saves at once', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await draftTestAndSave(user, 'Available')

    expect(saveSettings).toHaveBeenCalledWith('chat', HAIKU55)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('saving a model whose last test failed names the status and can be cancelled', async () => {
    testModel.mockResolvedValue(result(HAIKU55, 'no_capacity'))
    const user = userEvent.setup()
    await renderLoaded()

    await draftTestAndSave(user, 'No capacity')

    expect(await screen.findByText('The last test of Claude Haiku 5.5 returned "No capacity". Save it for AI Assistant anyway?'))
      .toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('saving an untested model asks first, then saves on confirm', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.selectOptions(screen.getByLabelText('AI Assistant'), HAIKU55)
    await clickAssistant(user, 'Save')

    expect(await screen.findByText('Claude Haiku 5.5 has not been tested yet. Save it for AI Assistant anyway?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save anyway' }))
    expect(saveSettings).toHaveBeenCalledWith('chat', HAIKU55)
  })
})

describe('AiModelSection — Test all models', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSettings.mockResolvedValue(settings)
    getCapacity.mockResolvedValue([
      { model_id: OPUS55, label: 'Claude Opus 5.5', quota: { name: 'q', tokens_per_minute: 0 } },
    ])
  })

  it('fills tokens/min from the capacity overview before any test', async () => {
    await renderLoaded()

    const opusRow = await screen.findByRole('row', { name: /Claude Opus 5\.5/ })
    await waitFor(() => expect(opusRow).toHaveTextContent('0 tokens/min'))
    expect(within(opusRow).getByText('Not tested')).toBeInTheDocument()
  })

  it('tests every model one at a time, never in parallel', async () => {
    const pending: Array<() => void> = []
    const load = { inFlight: 0, max: 0 }
    testModel.mockImplementation((modelId) => new Promise((resolve) => {
      load.inFlight += 1
      load.max = Math.max(load.max, load.inFlight)
      pending.push(() => {
        load.inFlight -= 1
        resolve(result(modelId, 'available', { latency_ms: 10 }))
      })
    }))
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: 'Test all models' }))
    for (const step of [0, 1, 2]) {
      await waitFor(() => expect(pending).toHaveLength(step + 1))
      pending[step]?.()
    }

    await waitFor(() => expect(screen.getByRole('button', { name: 'Test all models' })).toBeEnabled())
    expect(testModel.mock.calls).toStrictEqual([[OPUS55], [SONNET55], [HAIKU55]])
    expect(load.max).toBe(1)
  })

  it('shows each result in the table', async () => {
    testModel.mockImplementation((modelId) => Promise.resolve(
      modelId === OPUS55 ? result(modelId, 'no_capacity') : result(modelId, 'available', { latency_ms: 77 }),
    ))
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: 'Test all models' }))

    const opusRow = screen.getByRole('row', { name: /Claude Opus 5\.5/ })
    expect(await within(opusRow).findByText('No capacity')).toBeInTheDocument()
    expect(await within(screen.getByRole('row', { name: /Claude Haiku 5\.5/ })).findByText('77 ms')).toBeInTheDocument()
  })
})
