/**
 * @fileoverview Guards the wizard against re-hardcoding English.
 *
 * Every other test in this folder runs under `en`, where a hardcoded literal and
 * its translation are the same string — so those tests pass whether or not the
 * component is wired to i18next. This one renders under `de` and asserts the
 * German catalogue values reach the DOM, which is the only assertion that fails
 * if someone puts a literal back.
 *
 * Expected strings are read from the shipped `de` catalogue rather than written
 * out here, so rewording a translation does not break the test — only unwiring
 * a component does.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import { Sparkles } from 'lucide-react'
import DataSourceWizard from './DataSourceWizard'
import { DataSourcesStep, FeedbackFiltersStep, ItemSelectionStep } from './DataSourceSteps'
import ContextSummary from './ContextSummary'
import { defaultContextConfig } from './types'
import deComponents from '../../../public/locales/de/components.json'
import deCommon from '../../../public/locales/de/common.json'
import type { ProjectPersona, ProjectDocument } from '../../api/client'

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

const de = deComponents.dataSourceWizard

const personas: ProjectPersona[] = [
  { persona_id: 'p1', name: 'Power User', tagline: 'Uses all features', created_at: '' },
  { persona_id: 'p2', name: 'Casual User', tagline: 'Basic usage', created_at: '' },
]

const documents: ProjectDocument[] = [
  { document_id: 'd1', title: 'Product PRD', document_type: 'prd', content: '', created_at: '' },
  { document_id: 'd2', title: 'Research Report', document_type: 'research', content: '', created_at: '' },
]

const colors = {
  bg: 'bg-purple-600',
  bgLight: 'bg-purple-100',
  border: 'border-purple-300',
  text: 'text-purple-700',
  hover: 'hover:bg-purple-700',
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('DataSourceWizard localization', () => {
  beforeAll(async () => {
    i18n.addResourceBundle('de', 'components', deComponents)
    i18n.addResourceBundle('de', 'common', deCommon)
    await i18n.changeLanguage('de')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  beforeEach(() => {
    mockGetSources.mockResolvedValue({ sources: {} })
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
  })

  it('translates the data sources step', () => {
    render(
      <DataSourcesStep
        contextConfig={defaultContextConfig}
        onContextChange={vi.fn()}
        showFeedback
        showPersonas
        showDocuments
        showResearch
        combineDocuments={false}
        personasCount={2}
        documentsCount={3}
        otherDocsCount={2}
        researchDocsCount={1}
      />,
    )

    expect(screen.getByText(de.dataSources)).toBeInTheDocument()
    expect(screen.getByText(de.dataSourcesDescription)).toBeInTheDocument()
    expect(screen.getByText(de.customerFeedback)).toBeInTheDocument()
    expect(screen.getByText(de.customerFeedbackDescription)).toBeInTheDocument()
    expect(screen.getByText(de.existingDocumentsDescription)).toBeInTheDocument()
    expect(screen.queryByText('Data Sources')).not.toBeInTheDocument()
    expect(screen.queryByText('Customer Feedback')).not.toBeInTheDocument()
  })

  it('translates the feedback filters step, including sentiment labels', () => {
    render(
      <FeedbackFiltersStep
        contextConfig={defaultContextConfig}
        onContextChange={vi.fn()}
        sources={[]}
        categories={[]}
        loadingCategories={false}
        colors={colors}
      />,
    )

    expect(screen.getByText(de.sources)).toBeInTheDocument()
    expect(screen.getByText(de.leaveEmptyForAllSources)).toBeInTheDocument()
    expect(screen.getByText(de.sentiments)).toBeInTheDocument()
    expect(screen.getByText(de.timeRange)).toBeInTheDocument()
    // Time-range options come from one interpolated key, not seven literals.
    expect(screen.getByText(de.lastDays.replace('{{days}}', '30'))).toBeInTheDocument()
    expect(screen.getByText(de.lastYear)).toBeInTheDocument()
    expect(screen.getByText(de.allTime)).toBeInTheDocument()
    // common:sentiment.*, previously hardcoded lowercase English.
    expect(screen.getByText(deCommon.sentiment.positive)).toBeInTheDocument()
    expect(screen.getByText(deCommon.sentiment.negative)).toBeInTheDocument()
    expect(screen.queryByText('positive')).not.toBeInTheDocument()
    expect(screen.queryByText('Last 30 days')).not.toBeInTheDocument()
  })

  it('translates the persona and document selection step', () => {
    render(
      <ItemSelectionStep
        contextConfig={{ ...defaultContextConfig, usePersonas: true, useResearch: true }}
        onContextChange={vi.fn()}
        personas={personas}
        documents={documents}
        otherDocs={documents.filter(d => d.document_type !== 'research')}
        researchDocs={documents.filter(d => d.document_type === 'research')}
        combineDocuments={false}
      />,
    )

    expect(screen.getByText(de.selectPersonas)).toBeInTheDocument()
    expect(screen.getByText(de.leaveEmptyForAllPersonas)).toBeInTheDocument()
    expect(screen.getByText(de.selectResearchDocuments)).toBeInTheDocument()
    expect(screen.getByText(de.leaveEmptyForAllResearch)).toBeInTheDocument()
    expect(screen.queryByText('Select Personas')).not.toBeInTheDocument()
  })

  it('translates the context summary, including its "all N" fallbacks', () => {
    render(
      <ContextSummary
        config={{ ...defaultContextConfig, useFeedback: true, usePersonas: true, useResearch: true }}
        personas={personas}
        documents={documents}
      />,
    )

    expect(screen.getByText(de.contextSummary)).toBeInTheDocument()
    expect(screen.getByText(`${de.sources}:`)).toBeInTheDocument()
    expect(screen.getByText(`${de.personas}:`)).toBeInTheDocument()
    expect(screen.getByText(de.allPersonas.replace('{{total}}', '2'))).toBeInTheDocument()
    expect(screen.getByText(de.allResearch.replace('{{total}}', '1'))).toBeInTheDocument()
    expect(screen.queryByText('Context Summary')).not.toBeInTheDocument()
    expect(screen.queryByText('All 2 personas')).not.toBeInTheDocument()
  })

  it('translates the wizard chrome', () => {
    render(
      <DataSourceWizard
        title="Test Wizard"
        accentColor="purple"
        icon={<Sparkles />}
        personas={personas}
        documents={documents}
        contextConfig={defaultContextConfig}
        onContextChange={vi.fn()}
        renderFinalStep={() => <div />}
        finalStepValid
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        isSubmitting={false}
        submitLabel="Generate"
      />,
      { wrapper: createWrapper() },
    )

    // Matched on the template's leading fragment so this does not also pin the
    // step count, which belongs to useWizardState's own tests.
    const stepPrefix = de.stepOf
      .slice(0, de.stepOf.indexOf('{{total}}'))
      .replace('{{step}}', '1')
    expect(screen.getByText(stepPrefix, { exact: false })).toBeInTheDocument()
    expect(screen.getByLabelText(de.closeWizard)).toBeInTheDocument()
    expect(screen.getByText(de.back)).toBeInTheDocument()
    expect(screen.getByText(de.next)).toBeInTheDocument()
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Close wizard')).not.toBeInTheDocument()
  })
})
