/**
 * @fileoverview Tests for the AI model selection section (issue #96).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AiModelSection from './AiModelSection'

const mockGetModelSettings = vi.fn()
const mockSaveModelSettings = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getModelSettings: () => mockGetModelSettings(),
    saveModelSettings: (modelId: string | null) => mockSaveModelSettings(modelId),
  },
}))

const SONNET = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

const modelSettings = {
  model_id: null,
  available_models: [
    { key: 'sonnet', id: SONNET, label: 'Claude Sonnet 4.5', description: 'Highest quality' },
    { key: 'haiku', id: HAIKU, label: 'Claude Haiku 4.5', description: 'Faster and cheaper' },
  ],
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('AiModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetModelSettings.mockResolvedValue(modelSettings)
    mockSaveModelSettings.mockResolvedValue({ success: true, model_id: HAIKU })
  })

  it('selects Automatic when no override is configured', async () => {
    render(<AiModelSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

    expect(await screen.findByRole('radio', { name: /automatic/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /sonnet/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /haiku/i })).not.toBeChecked()
  })

  it('selects the configured model when an override is set', async () => {
    mockGetModelSettings.mockResolvedValue({ ...modelSettings, model_id: HAIKU })
    render(<AiModelSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

    expect(await screen.findByRole('radio', { name: /haiku/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /automatic/i })).not.toBeChecked()
  })

  it('saves the override when a model is chosen', async () => {
    render(<AiModelSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

    await userEvent.click(await screen.findByRole('radio', { name: /haiku/i }))

    await waitFor(() => {
      expect(mockSaveModelSettings).toHaveBeenCalledWith(HAIKU)
    })
  })

  it('clears the override when Automatic is chosen', async () => {
    mockGetModelSettings.mockResolvedValue({ ...modelSettings, model_id: HAIKU })
    render(<AiModelSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

    await userEvent.click(await screen.findByRole('radio', { name: /automatic/i }))

    await waitFor(() => {
      expect(mockSaveModelSettings).toHaveBeenCalledWith(null)
    })
  })

  it('renders nothing without an API endpoint', () => {
    const { container } = render(<AiModelSection apiEndpoint="" />, { wrapper: createWrapper() })

    expect(container).toBeEmptyDOMElement()
    expect(mockGetModelSettings).not.toHaveBeenCalled()
  })

  it('shows an error message when saving fails', async () => {
    mockSaveModelSettings.mockRejectedValue(new Error('403'))
    render(<AiModelSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

    await userEvent.click(await screen.findByRole('radio', { name: /haiku/i }))

    expect(await screen.findByText(/failed to save model selection/i)).toBeInTheDocument()
  })
})
