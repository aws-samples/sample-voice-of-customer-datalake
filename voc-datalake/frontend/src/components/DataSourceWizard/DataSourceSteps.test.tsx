/**
 * @fileoverview Tests for DataSourceSteps components.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DataSourcesStep, FeedbackFiltersStep } from './DataSourceSteps'
import { ItemSelectionStep } from './ItemSelectionStep'
import { SENTIMENTS } from '../../constants/filters'
import { defaultContextConfig } from './types'
import { accentColors, contextConfig, splitDocuments } from './dataSourceWizard-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import { at } from '@test/defined'

const mockPersonas: ProjectPersona[] = [
  {
    persona_id: 'p1',
    name: 'Power User',
    tagline: 'Uses all features daily',
    identity: { age_range: '25-34' },
    pain_points: { current_challenges: ['Slow loading'] },
    goals_motivations: { secondary_goals: ['Efficiency'] },
    behaviors: { current_solutions: ['Daily usage'] },
    created_at: '2025-01-01T00:00:00Z',
  },
  {
    persona_id: 'p2',
    name: 'Casual User',
    tagline: 'Occasional usage',
    identity: { age_range: '35-44' },
    pain_points: { current_challenges: ['Complex UI'] },
    goals_motivations: { secondary_goals: ['Simplicity'] },
    behaviors: { current_solutions: ['Weekly usage'] },
    created_at: '2025-01-01T00:00:00Z',
  },
]

const mockDocuments: ProjectDocument[] = [
  {
    document_id: 'd1',
    title: 'Product PRD',
    document_type: 'prd',
    content: '# PRD Content',
    created_at: '2025-01-01T00:00:00Z',
  },
  {
    document_id: 'd2',
    title: 'Research Report',
    document_type: 'research',
    content: '# Research Content',
    created_at: '2025-01-02T00:00:00Z',
  },
  {
    document_id: 'd3',
    title: 'PR/FAQ Document',
    document_type: 'prfaq',
    content: '# PR/FAQ Content',
    created_at: '2025-01-03T00:00:00Z',
  },
]

/** Assert that each of `texts` is on screen. */
function expectAllVisible(...texts: string[]) {
  for (const text of texts) {
    expect(screen.getByText(text)).toBeInTheDocument()
  }
}

describe('DataSourcesStep', () => {
  const defaultProps = {
    contextConfig: defaultContextConfig,
    onContextChange: vi.fn(),
    showFeedback: true,
    showPersonas: true,
    showDocuments: true,
    showResearch: true,
    combineDocuments: false,
    personasCount: 2,
    documentsCount: 3,
    otherDocsCount: 2,
    researchDocsCount: 1,
  }

  type StepProps = Partial<Parameters<typeof DataSourcesStep>[0]>

  /** Mount the step, click the checkbox named `name`, and return the change spy. */
  async function toggle(name: RegExp, overrides: StepProps = {}) {
    const user = userEvent.setup()
    const onContextChange = vi.fn()
    render(<DataSourcesStep {...defaultProps} {...overrides} onContextChange={onContextChange} />)

    await user.click(screen.getByRole('checkbox', { name }))

    return onContextChange
  }

  it('renders data sources heading', () => {
    render(<DataSourcesStep {...defaultProps} />)
    expect(screen.getByText('Data Sources')).toBeInTheDocument()
  })

  it('renders description text', () => {
    render(<DataSourcesStep {...defaultProps} />)
    expect(screen.getByText(/select what data to use/i)).toBeInTheDocument()
  })

  describe('built-in options', () => {
    it.each([
      ['Customer Feedback', 'Customer Feedback'],
      ['Personas with count', /Personas \(2\)/],
      ['Existing Documents', /Existing Documents \(2\)/],
      ['Research Documents', /Research Documents \(1\)/],
    ])('displays %s when shown', (_label, text) => {
      render(<DataSourcesStep {...defaultProps} />)
      expect(screen.getByText(text)).toBeInTheDocument()
    })

    it.each([
      ['Customer Feedback', { showFeedback: false }, 'Customer Feedback'],
      ['Personas', { showPersonas: false }, /Personas/],
      ['documents', { showDocuments: false }, /Existing Documents/],
      ['research', { showResearch: false }, /Research Documents/],
    ] as const)('hides %s when its show flag is false', (_label, overrides, text) => {
      render(<DataSourcesStep {...defaultProps} {...overrides} />)
      expect(screen.queryByText(text)).not.toBeInTheDocument()
    })

    it('displays combined Documents option when combineDocuments is true', () => {
      render(<DataSourcesStep {...defaultProps} combineDocuments={true} />)
      expect(screen.getByText(/Documents \(3\)/)).toBeInTheDocument()
    })
  })

  describe('toggles', () => {
    it('calls onContextChange when feedback checkbox is toggled', async () => {
      const onContextChange = await toggle(/customer feedback/i)

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ useFeedback: false }))
    })

    it('calls onContextChange when personas checkbox is toggled', async () => {
      const onContextChange = await toggle(/personas/i)

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ usePersonas: true }))
    })

    it('clears selectedPersonaIds when personas is disabled', async () => {
      const onContextChange = await toggle(/personas/i, {
        contextConfig: contextConfig({ usePersonas: true, selectedPersonaIds: ['p1'] }),
      })

      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ usePersonas: false, selectedPersonaIds: [] })
      )
    })

    it('toggles both useDocuments and useResearch when combined', async () => {
      const onContextChange = await toggle(/documents/i, { combineDocuments: true })

      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ useDocuments: true, useResearch: true })
      )
    })
  })

  describe('extraDataSources (#207 — e.g. the research wizard\u2019s web search)', () => {
    const webSearchSource = {
      key: 'webSearch',
      checked: false,
      title: 'Public Web Search',
      description: 'AI plans and runs multiple web searches',
      onChange: vi.fn(),
    }

    it('renders nothing extra when the prop is omitted', () => {
      render(<DataSourcesStep {...defaultProps} />)
      expect(screen.queryByText('Public Web Search')).not.toBeInTheDocument()
    })

    it('renders extra sources as peer cards after the built-ins', () => {
      render(<DataSourcesStep {...defaultProps} extraDataSources={[webSearchSource]} />)
      expectAllVisible('Public Web Search', 'AI plans and runs multiple web searches')
    })

    it('uses the exact same card markup as the built-in sources', () => {
      render(<DataSourcesStep {...defaultProps} extraDataSources={[webSearchSource]} />)
      const builtInCard = screen.getByText('Customer Feedback').closest('label')
      const extraCard = screen.getByText('Public Web Search').closest('label')
      expect(extraCard).not.toBeNull()
      expect(extraCard?.className).toBe(builtInCard?.className)
    })

    it('forwards toggles to the extra source\u2019s onChange', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(<DataSourcesStep {...defaultProps} extraDataSources={[{ ...webSearchSource, onChange }]} />)

      await user.click(screen.getByRole('checkbox', { name: /public web search/i }))

      expect(onChange).toHaveBeenCalledWith(true)
    })

    it('reflects the checked state', () => {
      render(<DataSourcesStep {...defaultProps} extraDataSources={[{ ...webSearchSource, checked: true }]} />)
      expect(screen.getByRole('checkbox', { name: /public web search/i })).toBeChecked()
    })
  })
})

describe('FeedbackFiltersStep', () => {
  const defaultProps = {
    contextConfig: defaultContextConfig,
    onContextChange: vi.fn(),
    sources: ['webscraper', 'manual_import', 's3_import'],
    categories: [
      { id: 'delivery', name: 'Delivery' },
      { id: 'quality', name: 'Quality' },
      { id: 'support', name: 'Support' },
    ],
    loadingCategories: false,
    colors: accentColors,
  }

  type StepProps = Partial<Parameters<typeof FeedbackFiltersStep>[0]>

  /** Mount the step, click the filter button labelled `label`, and return the change spy. */
  async function clickFilter(label: string, overrides: StepProps = {}) {
    const user = userEvent.setup()
    const onContextChange = vi.fn()
    render(<FeedbackFiltersStep {...defaultProps} {...overrides} onContextChange={onContextChange} />)

    await user.click(screen.getByText(label))

    return onContextChange
  }

  it.each(['Sources', 'Categories', 'Sentiments', 'Time Range'])('renders the %s section', (heading) => {
    render(<FeedbackFiltersStep {...defaultProps} />)
    expect(screen.getByText(heading)).toBeInTheDocument()
  })

  describe('Sources', () => {
    it('displays all source buttons', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expectAllVisible('Webscraper', 'Manual Import', 'S3 Import')
    })

    it('formats source names correctly', () => {
      render(<FeedbackFiltersStep {...defaultProps} sources={['webscraper', 'manual_import']} />)
      expectAllVisible('Webscraper', 'Manual Import')
    })

    it('toggles source selection when clicked', async () => {
      const onContextChange = await clickFilter('Webscraper')

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ sources: ['webscraper'] }))
    })

    it('removes source when already selected', async () => {
      const onContextChange = await clickFilter('Webscraper', {
        contextConfig: contextConfig({ sources: ['webscraper'] }),
      })

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ sources: [] }))
    })
  })

  describe('Categories', () => {
    it('displays all category buttons', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expectAllVisible('Delivery', 'Quality', 'Support')
    })

    it('shows loading state when loadingCategories is true', () => {
      render(<FeedbackFiltersStep {...defaultProps} loadingCategories={true} />)
      expect(screen.getByText(/loading categories/i)).toBeInTheDocument()
    })

    it('toggles category selection when clicked', async () => {
      const onContextChange = await clickFilter('Delivery')

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ categories: ['delivery'] }))
    })
  })

  describe('Sentiments', () => {
    // Labels come from common:sentiment.*, so they are capitalised by the
    // catalogue rather than by a CSS `capitalize` class. The value written back
    // into contextConfig stays lowercase.
    it('displays sentiment buttons', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expectAllVisible('Positive', 'Negative', 'Neutral')
    })

    it('toggles sentiment selection when clicked', async () => {
      const onContextChange = await clickFilter('Positive')

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ sentiments: ['positive'] }))
    })

    it.each([
      ['positive', 'Positive', 'bg-ok-subtle'],
      ['negative', 'Negative', 'bg-danger-subtle'],
    ])('applies correct styling for %s sentiment when selected', (sentiment, label, className) => {
      render(<FeedbackFiltersStep {...defaultProps} contextConfig={contextConfig({ sentiments: [sentiment] })} />)

      expect(screen.getByText(label)).toHaveClass(className)
    })

    // A render assertion cannot tell "translated" from "i18next echoed the key",
    // so check the key PATH against the real catalogue. Coverage of the map
    // itself is a typecheck concern now: it is keyed by the Sentiment literal
    // union, so a new sentiment without a label will not compile.
    it('has a common:sentiment entry for every SENTIMENTS value', async () => {
      const en = (await import('../../../public/locales/en/common.json')).default
      for (const sentiment of SENTIMENTS) {
        // Indexed with no cast on purpose: because `sentiment` is the Sentiment
        // literal union, a key MISSING from the catalogue is a tsc error here,
        // and the assertion below covers a key present but empty. Widening to
        // Record<string, string> would discard the compile-time half.
        expect(
          en.sentiment[sentiment],
          `common:sentiment.${sentiment} missing from the en catalogue`,
        ).toBeTruthy()
      }
    })
  })

  describe('Time Range', () => {
    it('displays time range select with the default value', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      const select = screen.getByRole('combobox')
      expect(select).toBeInTheDocument()
      expect(select).toHaveValue('30')
    })

    it('updates days when selection changes', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<FeedbackFiltersStep {...defaultProps} onContextChange={onContextChange} />)

      await user.selectOptions(screen.getByRole('combobox'), '7')

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }))
    })

    it('displays all time range options', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expectAllVisible(
        'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 60 days', 'Last 90 days', 'Last year', 'All time',
      )
    })
  })
})

describe('ItemSelectionStep', () => {
  const defaultProps = {
    contextConfig: defaultContextConfig,
    onContextChange: vi.fn(),
    personas: mockPersonas,
    documents: mockDocuments,
    ...splitDocuments(mockDocuments),
    combineDocuments: false,
  }

  type StepProps = Partial<Parameters<typeof ItemSelectionStep>[0]>

  /** Mount the step with the given context toggles on. */
  function renderWith(toggles: Partial<typeof defaultContextConfig>, overrides: StepProps = {}) {
    render(<ItemSelectionStep {...defaultProps} contextConfig={contextConfig(toggles)} {...overrides} />)
  }

  /** Mount the step, click the checkbox at `index`, and return the change spy. */
  async function toggleCheckbox(toggles: Partial<typeof defaultContextConfig>, index: number) {
    const user = userEvent.setup()
    const onContextChange = vi.fn()
    renderWith(toggles, { onContextChange })

    await user.click(at(screen.getAllByRole('checkbox'), index))

    return onContextChange
  }

  describe('sections follow the context toggles', () => {
    it.each([
      ['personas', 'Select Personas', { usePersonas: true }],
      ['documents', 'Select Documents', { useDocuments: true }],
      ['research', 'Select Research Documents', { useResearch: true }],
    ])('shows the %s section only when its toggle is on', (_name, heading, toggles) => {
      const { unmount } = render(<ItemSelectionStep {...defaultProps} />)
      expect(screen.queryByText(heading)).not.toBeInTheDocument()
      unmount()

      renderWith(toggles)
      expect(screen.getByText(heading)).toBeInTheDocument()
    })

    it.each([
      ['personas', 'Select Personas', { usePersonas: true }, { personas: [] }],
      ['documents', 'Select Documents', { useDocuments: true }, { otherDocs: [] }],
      ['research', 'Select Research Documents', { useResearch: true }, { researchDocs: [] }],
    ] as const)('does not show the %s section when its items are empty', (_name, heading, toggles, overrides) => {
      renderWith(toggles, overrides)
      expect(screen.queryByText(heading)).not.toBeInTheDocument()
    })
  })

  describe('Persona Selection', () => {
    it('displays all personas with their taglines', () => {
      renderWith({ usePersonas: true })
      expectAllVisible('Power User', 'Casual User', 'Uses all features daily', 'Occasional usage')
    })

    it('toggles persona selection when clicked', async () => {
      const onContextChange = await toggleCheckbox({ usePersonas: true }, 0)

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ selectedPersonaIds: ['p1'] }))
    })

    it('removes persona when already selected', async () => {
      const onContextChange = await toggleCheckbox({ usePersonas: true, selectedPersonaIds: ['p1'] }, 0)

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ selectedPersonaIds: [] }))
    })

    it('shows persona initial in avatar', () => {
      renderWith({ usePersonas: true })
      expectAllVisible('P', 'C') // Power User, Casual User initials
    })
  })

  describe('Document Selection (separate mode)', () => {
    it('displays non-research documents with their type labels', () => {
      renderWith({ useDocuments: true })
      expectAllVisible('Product PRD', 'PR/FAQ Document', 'PRD', 'PRFAQ')
    })
  })

  describe('Research Document Selection', () => {
    it('displays research documents', () => {
      renderWith({ useResearch: true })
      expect(screen.getByText('Research Report')).toBeInTheDocument()
    })

    it('toggles research document selection', async () => {
      const onContextChange = await toggleCheckbox({ useResearch: true }, 0)

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ selectedResearchIds: ['d2'] }))
    })
  })

  describe('Document Selection (combined mode)', () => {
    it('shows all documents when combineDocuments is true', () => {
      renderWith({ useDocuments: true, useResearch: true }, { combineDocuments: true })
      expectAllVisible('Select Documents', 'Product PRD', 'Research Report', 'PR/FAQ Document')
    })

    it('shows description for merge mode', () => {
      renderWith({ useDocuments: true, useResearch: true }, { combineDocuments: true })
      expect(screen.getByText('Select documents to merge')).toBeInTheDocument()
    })
  })
})
