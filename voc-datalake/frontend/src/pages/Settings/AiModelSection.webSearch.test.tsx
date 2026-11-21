/**
 * @fileoverview The web search surface of Administration → AI models (7.42.00): "Review pages: Bedrock web
 * search" (`web_reviews_search`) picks from its own OpenAI GPT models, like every surface with its Test and its
 * Save, and the two lists never mix.
 *
 *   - the row lists the GPT models only, Luna recommended, and its Automatic names Luna even while a Claude
 *     model is pinned for the deployment (a pin never reaches it);
 *   - every other row lists Claude models only;
 *   - Test sends exactly the GPT model the draft resolves to, and Save stores it for that surface;
 *   - "Test all models" stays on the Claude list (a GPT model is tested from its row).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import AiModelSection from './AiModelSection'
import { modelApi } from './ai-model-section-fixtures'

const { getModelSettings: mockGetModelSettings, saveModelSettings: mockSaveModelSettings, testModel: mockTestModel } = modelApi

vi.mock('../../api/client', () => import('./ai-model-section-fixtures').then((m) => m.modelClientModule()))

const SONNET55 = 'global.anthropic.claude-sonnet-5-5'
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
const LUNA = 'openai.gpt-5.6-luna'
const SOL = 'openai.gpt-5.6-sol'
const ROW = 'Review pages: Bedrock web search'

const settings = (overrides: Record<string, unknown> = {}) => ({
  available_models: [
    { key: 'sonnet55', id: SONNET55, label: 'Claude Sonnet 5.5', description: 'Flagship' },
    { key: 'haiku45', id: HAIKU45, label: 'Claude Haiku 4.5', description: 'Fast' },
  ],
  web_search_models: [
    { key: 'gpt56luna', id: LUNA, label: 'OpenAI GPT-5.6 Luna', description: 'Cheapest' },
    { key: 'gpt56sol', id: SOL, label: 'OpenAI GPT-5.6 Sol', description: 'Largest' },
  ],
  custom_models: [],
  surfaces: [
    { key: 'chat', default_id: SONNET55, selected: null, allowlist: 'claude' },
    { key: 'web_reviews_search', default_id: LUNA, selected: null, allowlist: 'web_search' },
  ],
  model_id: null,
  ...overrides,
})

const optionsOf = (label: string) =>
  within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  mockGetModelSettings.mockResolvedValue(settings())
  mockSaveModelSettings.mockResolvedValue({ success: true, surface: 'web_reviews_search', model_id: SOL })
  mockTestModel.mockImplementation((modelId) => Promise.resolve({
    model_id: modelId, invoked_id: modelId, status: 'available', probe: 'basic', latency_ms: 900, message: '', quota: null, checked_at: '',
  }))
})

/** The surface row holding `select`. */
function rowOf(select: HTMLElement): HTMLElement {
  const row = select.closest<HTMLElement>('[data-surface]')
  if (!row) throw new Error('no surface row')
  return row
}

function renderSection() {
  return renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />)
}

describe('the web search surface', () => {
  it('lists its GPT models only, Luna recommended, and every other row lists Claude only', async () => {
    renderSection()

    await screen.findByLabelText(ROW)
    expect(optionsOf(ROW)).toStrictEqual(['Automatic — OpenAI GPT-5.6 Luna', 'OpenAI GPT-5.6 Luna', 'OpenAI GPT-5.6 Sol'])
    const recommended = within(screen.getByLabelText(ROW)).getByRole('group', { name: 'Recommended' })
    expect(within(recommended).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['OpenAI GPT-5.6 Luna'])
    expect(optionsOf('AI Assistant')).toStrictEqual(['Automatic — Claude Sonnet 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 4.5'])
  })

  it('keeps Luna as its Automatic while a Claude model is pinned for every other surface', async () => {
    mockGetModelSettings.mockResolvedValue(settings({ model_id: HAIKU45, deployment_default: SONNET55 }))
    renderSection()

    await screen.findByLabelText(ROW)
    expect(optionsOf(ROW)[0]).toBe('Automatic — OpenAI GPT-5.6 Luna')
    expect(optionsOf('AI Assistant')[0]).toBe('Automatic — Claude Haiku 4.5')
  })

  it('tests exactly the GPT model the draft resolves to, then saves it for that surface', async () => {
    const user = userEvent.setup()
    renderSection()
    const select = await screen.findByLabelText(ROW)
    const row = rowOf(select)

    await user.click(within(row).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(mockTestModel).toHaveBeenCalledWith(LUNA))

    await user.selectOptions(select, SOL)
    await user.click(within(row).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(mockTestModel).toHaveBeenCalledWith(SOL))
    await user.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockSaveModelSettings).toHaveBeenCalledWith('web_reviews_search', SOL))
  })

  it('stays out of "Test all models"', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByLabelText(ROW)

    await user.click(screen.getByRole('button', { name: /Test all/ }))

    await waitFor(() => expect(mockTestModel).toHaveBeenCalledTimes(2))
    expect(mockTestModel.mock.calls).toStrictEqual([[SONNET55], [HAIKU45]])
  })
})
