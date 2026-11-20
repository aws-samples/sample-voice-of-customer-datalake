/**
 * @fileoverview Registry → a role's card → Model (7.58.00): the select with each option's harness (no Auto on the
 * native harness), what the choice runs on the harness this deployment runs the role on (on Kiro with no choice, its
 * card's model by Kiro's name), "Other model…" shown only when picked (on Kiro a model id typed and checked for its
 * shape; on the native harness a select of the other models this deployment enables), Save's body and the server's
 * refusal in its words, who changed it last; and a made card's role choice, read only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import { parseCardDetail } from '../../../api/engineeringRegistryApi'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RoleModelSetting } = await import('./RoleModelSetting')

const ENABLED = ['global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5']
/** Another model this deployment grants and prices (with -c engineeringModelPrices). */
const OPUS_5 = 'global.anthropic.claude-opus-5'
const BUILDER = {
  kind: 'role', id: 'builder', base_role: 'builder', title: 'builder', purpose: 'Builds a feature.', launchable: true,
  template: { version: 3, label: 'builder@template-3', digest: 'sha256:b' },
  skill: { source: 'template', label: 'builder@template-3', connection: null, version: null, provenance: 'template', template_version: 3 },
  model: 'global.anthropic.claude-sonnet-5-5', tools: ['read_file'], harness: 'converse', caps: {}, inputs: [], outputs: [],
}
const PATH = '/agents/engineering/registry/builder/model'
const NOT_ENABLED = "global.anthropic.claude-opus-5 isn't enabled in this deployment. An admin adds it with -c engineeringModelPrices (docs/deployment.md)."

function renderSetting(card: Record<string, unknown>, enabled: readonly string[] = ENABLED, price: number | null = null) {
  const detail = parseCardDetail({ card: { ...BUILDER, ...card }, versions: [], bedrock_enabled: enabled,
    ...(price === null ? {} : { kiro_credit_price_usd: price }) })
  return renderWithQueryClient(<RoleModelSetting card={detail.card} enabled={detail.bedrockEnabled} creditPrice={detail.kiroCreditPrice} />)
}

const select = () => screen.getByLabelText('The model this role runs on')
const save = () => screen.getByRole('button', { name: 'Save model' })
const modelId = () => screen.getByLabelText('Model ID')
const enabledModel = () => screen.getByLabelText('Enabled model')
const options = (element: HTMLElement) => [...element.querySelectorAll('option')].map((option) => option.textContent)

beforeEach(() => { resetFetchApi() })

describe('Registry: a role\'s model', () => {
  it('offers the role\'s default first, each option with where it runs, and nothing to save until it changes', () => {
    renderSetting({ runs_on: 'kiro' })
    expect([...select().querySelectorAll('option')].map((option) => option.textContent)).toStrictEqual([
      "Role's default (Sonnet 5.5)", 'Auto (Kiro only)', 'Opus 5.5 (Kiro and native)', 'Sonnet 5.5 (Kiro and native)',
      'Haiku 5.5 (Kiro and native)', 'Other model…'])
    expect(screen.getByText('This deployment runs the role on Kiro: it runs on Sonnet 5.5 (claude-sonnet-5.5).')).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('says a role on Kiro is billed in Kiro credits at the deployment\'s price, which the cost cap counts (7.58.00)', () => {
    renderSetting({ runs_on: 'kiro' }, ENABLED, 0.04)
    expect(screen.getByText('Billed in Kiro credits at $0.04 a credit, which the cost cap counts.')).toBeInTheDocument()
  })

  it('says nothing of Kiro credits for a native role, nor without a price', () => {
    renderSetting({ runs_on: 'native' }, ENABLED, 0.04)
    expect(screen.queryByText(/Billed in Kiro credits/)).toBeNull()
    cleanup()
    renderSetting({ runs_on: 'kiro' })
    expect(screen.queryByText(/Billed in Kiro credits/)).toBeNull()
  })

  it('says what a choice runs on Kiro (its Kiro id, or Kiro\'s pick for Auto), and that one Kiro cannot use stops the step', async () => {
    const user = userEvent.setup()
    renderSetting({ runs_on: 'kiro' })
    await user.selectOptions(select(), 'opus')
    expect(screen.getByText('This deployment runs the role on Kiro: it runs on Opus 5.5 (claude-opus-5.5).')).toBeInTheDocument()
    expect(screen.getByText(/If Kiro cannot use that model on this account, the step stops for a person/)).toBeInTheDocument()
    await user.selectOptions(select(), 'auto')
    expect(screen.getByText('This deployment runs the role on Kiro: Kiro chooses its model per task.')).toBeInTheDocument()
  })

  it('offers no Auto on the native harness (Kiro\'s alone), and runs the role\'s default with none', () => {
    renderSetting({ runs_on: 'native' })
    expect(options(select())).toStrictEqual(["Role's default (Sonnet 5.5)", 'Opus 5.5 (Kiro and native)',
      'Sonnet 5.5 (Kiro and native)', 'Haiku 5.5 (Kiro and native)', 'Other model…'])
    expect(screen.getByText(/native harness \(Amazon Bedrock\): it runs on Sonnet 5\.5 \(global\.anthropic\.claude-sonnet-5-5\)/))
      .toBeInTheDocument()
  })

  it('shows an Auto saved while the role ran on Kiro as it is, on the role\'s default, and drops it once changed', async () => {
    const user = userEvent.setup()
    renderSetting({ runs_on: 'native', model_choice: 'auto' })
    expect(select()).toHaveValue('auto')
    expect(screen.getByText(/native harness \(Amazon Bedrock\): it runs on Sonnet 5\.5/)).toBeInTheDocument()
    await user.selectOptions(select(), 'opus')
    expect(options(select())).not.toContain('Auto (Kiro only)')
  })

  it('makes a native role\'s Other model… a list of the other models this deployment enables, never an id typed', async () => {
    const user = userEvent.setup()
    renderSetting({ runs_on: 'native' }, [...ENABLED, OPUS_5])
    await user.selectOptions(select(), 'other')
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
    expect(options(enabledModel())).toStrictEqual(['Choose a model…', OPUS_5])   // (the three named ones are above)
    expect(screen.getByText(/The Bedrock models this deployment grants and prices besides the three above/)).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('saves the enabled model picked from the list', async () => {
    const user = userEvent.setup()
    routeFetchApi({ [`PUT ${PATH}`]: () => ({ role: 'builder', model_choice: OPUS_5, updated_at: '2026-11-20T09:00:00Z', updated_by: 'admin' }) })
    renderSetting({ runs_on: 'native' }, [...ENABLED, OPUS_5])
    await user.selectOptions(select(), 'other')
    await user.selectOptions(enabledModel(), OPUS_5)
    expect(screen.getByText(/native harness \(Amazon Bedrock\): it runs on .* \(global\.anthropic\.claude-opus-5\)/)).toBeInTheDocument()
    await user.click(save())
    await waitFor(() => { expect(sentFetchApiBody(PATH, 'PUT')).toStrictEqual({ model: OPUS_5 }) })
  })

  it('shows a saved model no longer enabled as it is, says so, and will not save it again', () => {
    renderSetting({ runs_on: 'native', model_choice: 'other-model' }, [...ENABLED, OPUS_5])
    const chosen = [...enabledModel().querySelectorAll('option')].find((option) => option.selected)?.textContent
    expect([options(enabledModel()), chosen]).toStrictEqual([['Choose a model…', 'other-model', OPUS_5], 'other-model'])
    expect(screen.getByText("other-model isn't enabled in this deployment. An admin adds it with -c engineeringModelPrices (docs/deployment.md)."))
      .toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('says a saved model the deployment no longer prices is not enabled', () => {
    renderSetting({ runs_on: 'native', model_choice: OPUS_5 }, ENABLED)
    expect(screen.getByText(NOT_ENABLED)).toBeInTheDocument()
  })

  it('says no other model is enabled when the deployment enables only the three named ones', async () => {
    const user = userEvent.setup()
    renderSetting({ runs_on: 'native' })
    await user.selectOptions(select(), 'other')
    expect(screen.getByText(/No other model is enabled in this deployment/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Enabled model')).not.toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('takes any Kiro id of its shape for a role on Kiro (its hint says where to find them), and saves it', async () => {
    const user = userEvent.setup()
    routeFetchApi({ [`PUT ${PATH}`]: () => ({ role: 'builder', model_choice: 'claude-sonnet-5.5', updated_at: '2026-11-19T09:00:00Z', updated_by: 'admin' }) })
    renderSetting({ runs_on: 'kiro' })
    await user.selectOptions(select(), 'other')
    expect(screen.getByText(/A Kiro model ID, as `kiro-cli chat --list-models` lists them/)).toBeInTheDocument()
    await user.type(modelId(), 'two words')
    expect(screen.getByText(/A model ID starts with a letter or a digit/)).toBeInTheDocument()
    await user.clear(modelId())
    await user.type(modelId(), 'claude-sonnet-5.5')
    await user.click(save())
    await waitFor(() => { expect(sentFetchApiBody(PATH, 'PUT')).toStrictEqual({ model: 'claude-sonnet-5.5' }) })
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  it('sends null to go back to the role\'s default, and says who changed it last and when', async () => {
    const user = userEvent.setup()
    routeFetchApi({ [`PUT ${PATH}`]: () => ({ role: 'builder', model_choice: null, updated_at: null, updated_by: null }) })
    renderSetting({ model_choice: 'haiku', model_choice_updated_by: 'admin-demo', model_choice_updated_at: '2026-11-18T10:00:00Z' })
    expect(select()).toHaveValue('haiku')
    expect(screen.getByText(/Changed by admin-demo/)).toBeInTheDocument()
    await user.selectOptions(select(), '')
    await user.click(save())
    await waitFor(() => { expect(sentFetchApiBody(PATH, 'PUT')).toStrictEqual({ model: null }) })
  })

  it('says the server\'s refusal in its words', async () => {
    const user = userEvent.setup()
    routeFetchApi({ [`PUT ${PATH}`]: () => { throw new ApiError(400, 'model is not a model id') } })
    renderSetting({})
    await user.selectOptions(select(), 'opus')
    await user.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: model is not a model id')
  })

  it('says a made card runs its role\'s choice, read only; and nothing on a card never launched', () => {
    const { unmount } = renderSetting({ kind: 'card', id: 'builder-fast', version: 1, model_choice: 'opus' })
    expect(screen.getByText("Runs its role's model: Opus 5.5.")).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    unmount()
    renderSetting({ id: 'coach', base_role: 'coach', launchable: false })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
