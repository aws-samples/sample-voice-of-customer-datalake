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
    // The i18next singleton is shared. Vitest isolates per file today, so the
    // beforeAll switch holds — but assert it rather than assume, since a switch
    // to a shared pool would otherwise make every case below silently vacuous
    // (under `en` the German assertions would fail, but the negative
    // "no English literal" ones would pass for the wrong reason).
    expect(i18n.language).toBe('de')
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

  it('translates the feedback filters step, including sentiment labels shared with the summary', () => {
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
    // Separator is translated too, so this also pins that the ASCII colon is no
    // longer concatenated in code.
    expect(screen.getByText(`${de.sources}${de.labelSeparator}`)).toBeInTheDocument()
    expect(screen.getByText(`${de.personas}${de.labelSeparator}`)).toBeInTheDocument()
    expect(
      screen.getByText(de.allPersonas_other.replace('{{count}}', '2')),
    ).toBeInTheDocument()
    // One research doc in the fixture ⇒ the singular variant.
    expect(
      screen.getByText(de.allResearch_one.replace('{{count}}', '1')),
    ).toBeInTheDocument()
    expect(screen.queryByText('Context Summary')).not.toBeInTheDocument()
    expect(screen.queryByText('All 2 personas')).not.toBeInTheDocument()
  })

  it('translates the wizard chrome', async () => {
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

    // Settle the mocked getSources/getCategoriesConfig queries before asserting,
    // so their resolution can't land outside act().
    expect(await screen.findByText(de.customerFeedback)).toBeInTheDocument()

    // Asserted per literal fragment between the placeholders, so it neither
    // pins the step count (useWizardState's concern) nor assumes the locale
    // orders {{step}} before {{total}}.
    for (const fragment of de.stepOf.split(/\{\{\w+\}\}/).filter(f => f.trim())) {
      expect(screen.getByText(fragment, { exact: false })).toBeInTheDocument()
    }
    expect(screen.getByLabelText(de.closeWizard)).toBeInTheDocument()
    expect(screen.getByText(de.back)).toBeInTheDocument()
    expect(screen.getByText(de.next)).toBeInTheDocument()
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Close wizard')).not.toBeInTheDocument()
  })
})
