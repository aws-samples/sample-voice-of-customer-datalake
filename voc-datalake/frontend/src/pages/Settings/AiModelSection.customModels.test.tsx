/**
 * @fileoverview The deployment's own models in Administration → AI models (7.65.00, `custom_models`,
 * `-c customModels`): each is offered under "Your models" on the Claude-list surfaces it declares, and never on the
 * web search surface. While a row resolves to one (a draft or a stored pick), the row says it is "Your model", where
 * its inference runs and through what, its price, that the prompts are tuned for Claude, an imported model's cold
 * start, and offers its JSON check and, when it takes tools, its tools check, each with its own result. The basic
 * Test and the save confirmation are unchanged; "Test all models" stays on the Claude list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import AiModelSection from './AiModelSection'
import { modelApi, surfaceRowOf as rowOf } from './ai-model-section-fixtures'
import type { ModelTestProbe, ModelTestResult, ModelTestStatus } from '../../api/modelTestSchema'

const { getModelSettings: mockGetModelSettings, testModel: mockTestModel } = modelApi

vi.mock('../../api/client', () => import('./ai-model-section-fixtures').then((m) => m.modelClientModule()))

const SONNET55 = 'global.anthropic.claude-sonnet-5-5'
const HAIKU55 = 'global.anthropic.claude-haiku-5-5'
const LUNA = 'openai.gpt-5.6-luna'
const LLAMA = 'us.meta.llama3-3-70b-instruct-v1:0'
const IMPORTED = 'arn:aws:bedrock:eu-central-1:111111111111:imported-model/abcd1234efgh'
const NOVA = 'global.amazon.nova-2-lite-v1:0'

const capabilities = (tools: boolean) => ({ tools, documents: false, json: true, temperature: true })

const CUSTOM_MODELS = [
  {
    key: 'llama33', id: LLAMA, label: 'Llama 3.3 70B Instruct', description: '', kind: 'bedrock', source: 'profile',
    surfaces: ['documents', 'chat'], eu: false, regions: ['us-east-1', 'us-east-2', 'us-west-2'],
    capabilities: capabilities(true), price: { in: 0.72, out: 0.72 },
  },
  {
    key: 'examplechat', id: IMPORTED, label: 'Example imported model', description: '', kind: 'imported',
    source: 'imported', surfaces: ['enrichment'], eu: true, regions: ['eu-central-1'],
    capabilities: capabilities(false), price: { in: 0.5, out: 1.5 },
  },
  {
    key: 'nova2lite', id: NOVA, label: 'Amazon Nova 2 Lite', description: '', kind: 'bedrock', source: 'profile',
    surfaces: ['documents'], eu: false, regions: [], capabilities: capabilities(false), price: { in: 0.3, out: 2.5 },
  },
]

/** A surface row of GET /settings/model; only the web search surface picks from its own list. */
const surface = (key: string, defaultId: string, selected: string | null = null) =>
  ({ key, default_id: defaultId, selected, allowlist: key === 'web_reviews_search' ? 'web_search' : 'claude' })

const settings = (overrides: Record<string, unknown> = {}) => ({
  available_models: [
    { key: 'sonnet55', id: SONNET55, label: 'Claude Sonnet 5.5', description: 'Flagship' },
    { key: 'haiku55', id: HAIKU55, label: 'Claude Haiku 5.5', description: 'Fast' },
  ],
  web_search_models: [{ key: 'gpt56luna', id: LUNA, label: 'OpenAI GPT-5.6 Luna', description: 'Cheapest' }],
  custom_models: CUSTOM_MODELS,
  surfaces: [
    surface('chat', SONNET55), surface('documents', SONNET55), surface('enrichment', HAIKU55, IMPORTED),
    surface('utility', SONNET55), surface('web_reviews_search', LUNA),
  ],
  model_id: null,
  ...overrides,
})

function result(modelId: string, status: ModelTestStatus, probe: ModelTestProbe = 'basic'): ModelTestResult {
  return { model_id: modelId, invoked_id: modelId, status, probe, latency_ms: null, message: '', quota: null, checked_at: '' }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetModelSettings.mockResolvedValue(settings())
  mockTestModel.mockImplementation((modelId, probe) => Promise.resolve(result(modelId, 'available', probe)))
})

/** The check (button and result) of the row labelled `label` whose result is named `name`, once it shows. */
async function checkOf(label: string, name: string): Promise<HTMLElement> {
  const check = (await within(rowOf(label)).findByText(name)).closest<HTMLElement>('[data-probe]')
  if (!check) throw new Error(`no check ${name}`)
  return check
}

const CLAUDE_TUNED = "The prompts are tuned for Claude: check this model's answers on this surface before relying on it."

/** The badges, residency line and notes the row labelled `label` shows about its custom model (none: []). */
function detailLines(label: string): string[] {
  const details = rowOf(label).querySelector('[data-custom-model]')
  if (!details) return []
  return [...details.querySelectorAll(':scope > div:first-child > span, :scope > p')].map((node) => node.textContent)
}

const groupOptions = (label: string, group: string) => within(within(screen.getByLabelText(label)).getByRole('group', { name: group }))
  .getAllByRole('option').map((option) => option.textContent)

async function renderLoaded() {
  renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />)
  await screen.findByLabelText('AI Assistant')
}

describe('the "Your models" group', () => {
  it('lists, last, the custom models that declare the surface, and none on the other rows', async () => {
    await renderLoaded()

    expect(groupOptions('Document Generation', 'Your models')).toStrictEqual(['Llama 3.3 70B Instruct', 'Amazon Nova 2 Lite'])
    expect(groupOptions('AI Assistant', 'Your models')).toStrictEqual(['Llama 3.3 70B Instruct'])
    expect(within(screen.getByLabelText('Document Generation')).getAllByRole('option').map((option) => option.textContent))
      .toStrictEqual(['Automatic — Claude Sonnet 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5', 'Llama 3.3 70B Instruct', 'Amazon Nova 2 Lite'])
    expect(['Utilities', 'Review pages: Bedrock web search']
      .filter((label) => within(screen.getByLabelText(label)).queryByRole('group', { name: 'Your models' }) !== null))
      .toStrictEqual([])
  })

  it('has no group, and the rows no details, when the deployment declares no model of its own', async () => {
    mockGetModelSettings.mockResolvedValue(settings({ custom_models: [], surfaces: [surface('chat', SONNET55)] }))
    await renderLoaded()

    expect(within(screen.getByLabelText('AI Assistant')).queryByRole('group', { name: 'Your models' })).not.toBeInTheDocument()
    expect(screen.queryByText('Your model')).not.toBeInTheDocument()
  })
})

describe('a row resolving to a custom model', () => {
  it('says it is your model, where it runs, its price and that the prompts are tuned for Claude', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    expect(detailLines('Document Generation')).toStrictEqual([])

    await user.selectOptions(screen.getByLabelText('Document Generation'), LLAMA)

    expect(detailLines('Document Generation')).toStrictEqual([
      'Your model', 'Runs in us-east-1, us-east-2, us-west-2 · inference profile',
      '0.72 / 0.72 USD per million tokens (input / output)', CLAUDE_TUNED,
    ])
  })

  it('shows a stored pick: an imported model with its EU residency and its cold start', async () => {
    await renderLoaded()

    expect(detailLines('Feedback Enrichment')).toStrictEqual([
      'Your model', 'EU residency', 'Runs in eu-central-1 · imported model',
      '0.5 / 1.5 USD per million tokens (input / output)', CLAUDE_TUNED,
      'An imported model scales to zero: after a pause, its first request can take tens of seconds or minutes.',
    ])
  })

  it('says a global. profile may run in any commercial Region', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.selectOptions(screen.getByLabelText('Document Generation'), NOVA)

    expect(within(rowOf('Document Generation')).getByText('Runs in any commercial AWS Region · inference profile')).toBeInTheDocument()
  })
})

describe('the checks of a custom model', () => {
  it('offers the tools check only to a model that takes tools', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    expect(within(rowOf('Feedback Enrichment')).getByRole('button', { name: 'Check JSON' })).toBeInTheDocument()
    expect(within(rowOf('Feedback Enrichment')).queryByRole('button', { name: 'Check tools' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('AI Assistant'), LLAMA)
    expect(within(rowOf('AI Assistant')).getByRole('button', { name: 'Check tools' })).toBeInTheDocument()
  })

  it('runs each check on exactly the model, with its probe, and shows each result under its name', async () => {
    mockTestModel.mockImplementation((modelId, probe) =>
      Promise.resolve(result(modelId, probe === 'tools' ? 'probe_failed' : 'available', probe)))
    const user = userEvent.setup()
    await renderLoaded()
    await user.selectOptions(screen.getByLabelText('AI Assistant'), LLAMA)
    const row = within(rowOf('AI Assistant'))

    await user.click(row.getByRole('button', { name: 'Check JSON' }))
    await user.click(row.getByRole('button', { name: 'Check tools' }))

    expect(mockTestModel.mock.calls).toStrictEqual([[LLAMA, 'json'], [LLAMA, 'tools']])
    expect(await within(await checkOf('AI Assistant', 'JSON check')).findByText('Available')).toBeInTheDocument()
    const tools = await checkOf('AI Assistant', 'Tools check')
    expect(await within(tools).findByText('Check failed')).toBeInTheDocument()
    expect(within(tools).getByText(/not as the check asked/)).toBeInTheDocument()
  })

  it('keeps the basic Test apart: a check alone still leaves the save unconfirmed', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.selectOptions(screen.getByLabelText('Document Generation'), LLAMA)
    const row = within(rowOf('Document Generation'))

    await user.click(row.getByRole('button', { name: 'Check JSON' }))
    await row.findByText('JSON check')
    await user.click(row.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Llama 3.3 70B Instruct has not been tested yet. Save it for Document Generation anyway?'))
      .toBeInTheDocument()
    await user.click(row.getByRole('button', { name: 'Test' }))
    expect(mockTestModel).toHaveBeenLastCalledWith(LLAMA)
  })

  it('leaves the custom models out of "Test all models"', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: 'Test all models' }))

    await waitFor(() => expect(mockTestModel).toHaveBeenCalledTimes(2))
    expect(mockTestModel.mock.calls).toStrictEqual([[SONNET55], [HAIKU55]])
  })
})
