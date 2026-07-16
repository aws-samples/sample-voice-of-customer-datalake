/**
 * @fileoverview Tests for ResearchWizard (Wizards.tsx) — the web-search data
 * source card placement (#207): web search is selected on the Data Sources
 * step (step 1) as a peer card of Customer Feedback, not buried on the final
 * step, and only when the deployment has the AgentCore gateway.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWizard } from './Wizards'
import { defaultContextConfig } from '../../components/DataSourceWizard/exports'
import type { ResearchToolConfig } from './types'

const mockSuggestResearchQuestions = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestResearchQuestions: (...args: unknown[]) => mockSuggestResearchQuestions(...args),
  },
}))

const mockGetSources = vi.fn()
const mockGetCategoriesConfig = vi.fn()
vi.mock('../../api/client', () => ({
  api: {
    getSources: (days: number) => mockGetSources(days),
    getCategoriesConfig: () => mockGetCategoriesConfig(),
  },
}))
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

const mockIsWebSearchAvailable = vi.fn()
vi.mock('../../runtimeConfig', () => ({
  isWebSearchAvailable: () => mockIsWebSearchAvailable(),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const baseResearchConfig: ResearchToolConfig = {
  question: '',
  title: '',
  useWebSearch: false,
}

function makeProps(researchConfig: Partial<ResearchToolConfig> = {}) {
  return {
    projectId: 'proj-1',
    personas: [],
    documents: [],
    contextConfig: defaultContextConfig,
    researchConfig: { ...baseResearchConfig, ...researchConfig },
    generating: null,
    onContextChange: vi.fn(),
    onResearchConfigChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }
}

/** Click Next until the final (research question) step is visible. */
async function goToFinalStep(user: ReturnType<typeof userEvent.setup>) {
  while (!screen.queryByText(/research question/i)) {
    await user.click(screen.getByRole('button', { name: /next/i }))
  }
}

describe('ResearchWizard web-search data source (#207)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSources.mockResolvedValue({ sources: {} })
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
    mockIsWebSearchAvailable.mockReturnValue(true)
  })

  it('offers web search on the Data Sources step (step 1)', () => {
    render(<ResearchWizard {...makeProps()} />, { wrapper: createWrapper() })

    // Step 1 is the Data Sources step; the card is there without navigating.
    expect(screen.getByText('Data Sources')).toBeInTheDocument()
    expect(screen.getByText('Public Web Search')).toBeInTheDocument()
    expect(screen.getByText(/plans and runs multiple web searches/i)).toBeInTheDocument()
  })

  it('formats the web-search card exactly like the built-in source cards', () => {
    render(<ResearchWizard {...makeProps()} />, { wrapper: createWrapper() })

    const builtInCard = screen.getByText('Customer Feedback').closest('label')
    const webSearchCard = screen.getByText('Public Web Search').closest('label')
    expect(webSearchCard).not.toBeNull()
    expect(webSearchCard?.className).toBe(builtInCard?.className)
  })

  it('toggling the card updates useWebSearch in the research config', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    render(<ResearchWizard {...props} />, { wrapper: createWrapper() })

    await user.click(screen.getByRole('checkbox', { name: /public web search/i }))

    expect(props.onResearchConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ useWebSearch: true }),
    )
  })

  it('reflects an already-enabled web search', () => {
    render(<ResearchWizard {...makeProps({ useWebSearch: true })} />, { wrapper: createWrapper() })

    expect(screen.getByRole('checkbox', { name: /public web search/i })).toBeChecked()
  })

  it('hides the card when the deployment has no web-search gateway', () => {
    mockIsWebSearchAvailable.mockReturnValue(false)
    render(<ResearchWizard {...makeProps()} />, { wrapper: createWrapper() })

    expect(screen.getByText('Data Sources')).toBeInTheDocument()
    expect(screen.queryByText('Public Web Search')).not.toBeInTheDocument()
  })

  it('no longer renders a web-search checkbox on the final step', async () => {
    const user = userEvent.setup()
    render(<ResearchWizard {...makeProps()} />, { wrapper: createWrapper() })

    await goToFinalStep(user)

    expect(screen.getByText(/research title/i)).toBeInTheDocument()
    expect(screen.queryByText('Public Web Search')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /web search/i })).not.toBeInTheDocument()
  })
})
