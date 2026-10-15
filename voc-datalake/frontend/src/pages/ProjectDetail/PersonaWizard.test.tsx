/**
 * @fileoverview Tests for PersonaWizard (Wizards.tsx) — U8's N1: the wizard used
 * to offer data sources the persona generator cannot read.
 *
 * `generatePersonas` sends feedback filters, a persona count and custom
 * instructions. Nothing else. But the shared wizard was rendered with `personas`
 * and `documents`, so it showed Personas / Documents / Research toggles and item
 * pickers, and the context summary reported the selection back — inputs the
 * mutation then dropped on the floor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PersonaWizard, ResearchWizard } from './Wizards'
import { defaultContextConfig } from '../../components/DataSourceWizard/exports'
import type { ProjectDocument, ProjectPersona } from '../../api/types'

const mockGetSources = vi.fn()
const mockGetCategoriesConfig = vi.fn()
vi.mock('../../api/client', () => ({
  api: {
    getSources: (days: number) => mockGetSources(days),
    getCategoriesConfig: () => mockGetCategoriesConfig(),
  },
}))
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestResearchQuestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  },
}))
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const personas: ProjectPersona[] = [
  { persona_id: 'p1', name: 'Power User', tagline: 'Uses all features', created_at: '' },
  { persona_id: 'p2', name: 'Casual User', tagline: 'Basic usage', created_at: '' },
]

const documents: ProjectDocument[] = [
  { document_id: 'd1', document_type: 'prd', title: 'A PRD', content: '', created_at: '' },
  { document_id: 'd2', document_type: 'research', title: 'Some research', content: '', created_at: '' },
]

function personaProps() {
  return {
    personas,
    documents,
    contextConfig: defaultContextConfig,
    personaConfig: { personaCount: 3, customInstructions: '' },
    generating: null,
    onContextChange: vi.fn(),
    onPersonaConfigChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }
}

describe('PersonaWizard data sources', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSources.mockResolvedValue({ sources: {} })
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
  })

  it('offers customer feedback', async () => {
    render(<PersonaWizard {...personaProps()} />, { wrapper: createWrapper() })

    expect(await screen.findByText('Customer Feedback')).toBeInTheDocument()
  })

  it('does not offer personas, documents or research, which the generator discards', async () => {
    // The project passed in HAS two personas, a PRD and a research doc, so all
    // three cards would render if they were not hidden — that is what makes the
    // assertion meaningful rather than a restatement of an empty fixture.
    render(<PersonaWizard {...personaProps()} />, { wrapper: createWrapper() })

    await screen.findByText('Customer Feedback')
    expect(screen.queryByText('Personas (2)')).not.toBeInTheDocument()
    expect(screen.queryByText('Existing Documents (1)')).not.toBeInTheDocument()
    expect(screen.queryByText('Research Documents (1)')).not.toBeInTheDocument()
  })

  it('still offers personas in the research wizard, which can read them', async () => {
    // Guards against fixing N1 by hiding the sources for every wizard: research is
    // the step personas exist to ground.
    render(
      <ResearchWizard
        projectId="proj-1"
        personas={personas}
        documents={documents}
        contextConfig={defaultContextConfig}
        researchConfig={{ question: '', title: '', useWebSearch: false }}
        generating={null}
        onContextChange={vi.fn()}
        onResearchConfigChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(screen.getByText('Personas (2)')).toBeInTheDocument()
    })
  })
})
