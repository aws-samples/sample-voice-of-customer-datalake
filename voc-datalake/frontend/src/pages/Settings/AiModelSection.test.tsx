/**
 * @fileoverview Tests for the per-surface AI model picker (issue #96).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AiModelSection from './AiModelSection'

const mockGetModelSettings = vi.fn()
const mockSaveModelSettings = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getModelSettings: () => mockGetModelSettings(),
    saveModelSettings: (surface: string, modelId: string | null) =>
      mockSaveModelSettings(surface, modelId),
  },
}))

const SONNET5 = 'global.anthropic.claude-sonnet-5'
const OPUS48 = 'global.anthropic.claude-opus-4-8'
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

const modelSettingsFixture = {
  available_models: [
    { key: 'sonnet5', id: SONNET5, label: 'Claude Sonnet 5', description: 'Latest Sonnet' },
    { key: 'sonnet46', id: 'global.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Previous Sonnet' },
    { key: 'opus48', id: OPUS48, label: 'Claude Opus 4.8', description: 'Deepest reasoning' },
    { key: 'haiku45', id: HAIKU45, label: 'Claude Haiku 4.5', description: 'Fastest' },
  ],
  surfaces: [
    { key: 'chat', default_id: SONNET5, selected: null },
    { key: 'documents', default_id: SONNET5, selected: null },
    { key: 'prototype', default_id: OPUS48, selected: null },
    { key: 'enrichment', default_id: HAIKU45, selected: null },
    { key: 'utility', default_id: SONNET5, selected: null },
  ],
  model_id: null,
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('AiModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetModelSettings.mockResolvedValue(modelSettingsFixture)
    mockSaveModelSettings.mockResolvedValue({ success: true, surface: 'chat', model_id: HAIKU45 })
  })

  it('renders nothing without an API endpoint', () => {
    const { container } = render(<AiModelSection apiEndpoint="" isAdmin />, { wrapper: createWrapper() })

    expect(container).toBeEmptyDOMElement()
    expect(mockGetModelSettings).not.toHaveBeenCalled()
  })

  it('renders nothing (and never fetches) for non-admins', () => {
    const { container } = render(
      <AiModelSection apiEndpoint="https://api.example.com" isAdmin={false} />,
      { wrapper: createWrapper() },
    )

    expect(container).toBeEmptyDOMElement()
    expect(mockGetModelSettings).not.toHaveBeenCalled()
  })

  it('renders one selector per surface, all on Automatic by default', async () => {
    render(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByLabelText('AI Chat')).toBeInTheDocument())
    const surfaceLabels = ['AI Chat', 'Document Generation', 'Prototype Builder', 'Feedback Enrichment', 'Utilities']
    for (const label of surfaceLabels) {
      const select = screen.getByLabelText(label)
      expect(select).toHaveValue('')
    }
  })

  it('shows each surface default inside its Automatic option', async () => {
    render(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByLabelText('Prototype Builder')).toBeInTheDocument())
    const prototypeSelect = screen.getByLabelText('Prototype Builder')
    expect(within(prototypeSelect).getByText('Automatic — Claude Opus 4.8')).toBeInTheDocument()
    const enrichmentSelect = screen.getByLabelText('Feedback Enrichment')
    expect(within(enrichmentSelect).getByText('Automatic — Claude Haiku 4.5')).toBeInTheDocument()
  })

  it('saves a per-surface selection and shows the Saved badge', async () => {
    const user = userEvent.setup()
    render(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByLabelText('AI Chat')).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText('AI Chat'), HAIKU45)

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
    render(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByLabelText('AI Chat')).toHaveValue(HAIKU45))
    await user.selectOptions(screen.getByLabelText('AI Chat'), '')

    expect(mockSaveModelSettings).toHaveBeenCalledWith('chat', null)
  })

  it('shows an error state instead of an infinite spinner when the load fails', async () => {
    mockGetModelSettings.mockRejectedValue(new Error('boom'))
    render(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() =>
      expect(screen.getByText('Could not load model settings.')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Loading models...')).not.toBeInTheDocument()
  })

  it('shows a save error message when the mutation fails', async () => {
    mockSaveModelSettings.mockRejectedValue(new Error('403'))
    const user = userEvent.setup()
    render(<AiModelSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByLabelText('AI Chat')).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText('AI Chat'), HAIKU45)

    await waitFor(() =>
      expect(screen.getByText('Failed to save model selection. Try again.')).toBeInTheDocument(),
    )
  })
})
