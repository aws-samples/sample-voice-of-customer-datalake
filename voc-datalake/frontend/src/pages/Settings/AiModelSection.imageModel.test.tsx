/**
 * The read-only "Image generation (persona avatars)" row of Administration → AI models:
 * model, region, access status with its fix hint, requests-per-minute quota, and a Test that
 * "Test all models" leaves out (an image test costs a few cents).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import AiModelSection from './AiModelSection'
import type { ImageAccessStatus, ImageModelCapacity, ImageModelInfo } from '../../api/imageModelSchema'
import type { ModelTestResult } from '../../api/modelTestSchema'

const getSettings = vi.fn<() => Promise<unknown>>()
const getCapacity = vi.fn<() => Promise<unknown>>()
const testModel = vi.fn<(modelId: string) => Promise<ModelTestResult>>()

vi.mock('../../api/client', () => ({
  api: {
    getModelSettings: () => getSettings(),
    saveModelSettings: () => Promise.resolve({ success: true }),
    testModel: (modelId: string) => testModel(modelId),
    getModelCapacity: () => getCapacity(),
  },
}))

const SONNET55 = 'global.anthropic.claude-sonnet-5-5'
const IMAGE_ID = 'stability.stable-image-core-v1:1'

const IMAGE_INFO: ImageModelInfo = { id: IMAGE_ID, label: 'Stable Image Core', region: 'us-west-2', avatars_enabled: true }

function settingsWith(imageModel: ImageModelInfo | null) {
  return {
    available_models: [{ key: 'sonnet55', id: SONNET55, label: 'Claude Sonnet 5.5', description: 'Flagship' }],
    surfaces: [{ key: 'chat', default_id: SONNET55, selected: null }],
    model_id: null,
    image_model: imageModel,
  }
}

function imageCapacity(status: ImageAccessStatus, extra: Partial<ImageModelCapacity> = {}): ImageModelCapacity {
  return {
    ...IMAGE_INFO,
    access: { status, agreement: '', authorization: '', entitlement: '', region_availability: '' },
    quota: { name: 'On-demand model inference requests per minute for Stability.ai Stable Image Core', value: 1500, unit: 'requests_per_minute' },
    quota_state: 'fresh',
    ...extra,
  }
}

function result(modelId: string, status: ModelTestResult['status']): ModelTestResult {
  return { model_id: modelId, invoked_id: modelId, status, latency_ms: 900, message: '', quota: null, checked_at: '2026-10-28T00:00:00+00:00' }
}

async function imageRow(): Promise<HTMLElement> {
  renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />)
  const heading = await screen.findByRole('heading', { name: 'Image generation (persona avatars)' })
  const row = heading.closest<HTMLElement>('section')
  if (!row) throw new Error('no image row')
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  getSettings.mockResolvedValue(settingsWith(IMAGE_INFO))
  getCapacity.mockResolvedValue({ models: [], image: imageCapacity('available') })
  testModel.mockImplementation((modelId) => Promise.resolve(result(modelId, 'available')))
})

describe('the image model row', () => {
  it('shows the model, its region, access and requests-per-minute quota', async () => {
    const row = await imageRow()

    expect(row).toHaveTextContent('Stable Image Core')
    expect(row).toHaveTextContent('us-west-2')
    await waitFor(() => expect(row).toHaveTextContent('1,500 requests/min'))
    expect(within(row).getByText('Available')).toBeInTheDocument()
  })

  it.each([
    ['not_subscribed', 'Not subscribed', /agreement or Marketplace subscription is missing/],
    ['no_access', 'No access', /Check the organization's policies/],
    ['not_in_region', 'Not in this region', /not offered in this region/],
    ['unknown', 'Unknown', /Use Test to check the model directly/],
  ] as const)('shows %s with how to fix it', async (status, label, hint) => {
    getCapacity.mockResolvedValue({ models: [], image: imageCapacity(status) })
    const row = await imageRow()

    expect(await within(row).findByText(label)).toBeInTheDocument()
    expect(row).toHaveTextContent(hint)
  })

  it('reads the access as unknown while the capacity overview has no image block', async () => {
    getCapacity.mockResolvedValue({ models: [], image: null })
    const row = await imageRow()

    expect(await within(row).findByText('Unknown')).toBeInTheDocument()
  })

  it('says the quota is being read while Service Quotas has not answered yet', async () => {
    getCapacity.mockResolvedValue({ models: [], image: imageCapacity('available', { quota: null, quota_state: 'pending' }) })
    const row = await imageRow()

    await waitFor(() => expect(row).toHaveTextContent('Reading from Service Quotas, check again in a minute'))
  })

  it('warns that avatars are off when the deployment does not use the model', async () => {
    getSettings.mockResolvedValue(settingsWith({ ...IMAGE_INFO, avatars_enabled: false }))
    const row = await imageRow()

    expect(row).toHaveTextContent('Avatars are switched off in this deployment')
  })

  it('is absent when the API names no image model', async () => {
    getSettings.mockResolvedValue(settingsWith(null))
    renderWithQueryClient(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />)

    await screen.findByLabelText('AI Assistant')
    expect(screen.queryByRole('heading', { name: 'Image generation (persona avatars)' })).not.toBeInTheDocument()
  })
})

describe('testing the image model', () => {
  it('tests only the image model, telling the cost in the button title', async () => {
    const user = userEvent.setup()
    const row = await imageRow()
    const button = within(row).getByRole('button', { name: 'Test' })

    expect(button).toHaveAttribute('title', expect.stringContaining('costs a few US cents'))
    await user.click(button)

    expect(testModel.mock.calls).toStrictEqual([[IMAGE_ID]])
    expect(await within(row).findAllByText('Available')).toHaveLength(2)
  })

  it('is left out of "Test all models"', async () => {
    const user = userEvent.setup()
    await imageRow()

    await user.click(screen.getByRole('button', { name: /Test all/ }))

    await waitFor(() => expect(testModel).toHaveBeenCalledWith(SONNET55))
    expect(testModel).not.toHaveBeenCalledWith(IMAGE_ID)
  })
})
