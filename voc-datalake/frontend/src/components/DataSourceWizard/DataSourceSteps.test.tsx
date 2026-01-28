/**
 * @fileoverview Tests for DataSourceSteps components.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DataSourcesStep, FeedbackFiltersStep, ItemSelectionStep } from './DataSourceSteps'
import type { ContextConfig } from './types'
import type { ProjectPersona, ProjectDocument } from '../../api/client'

const defaultColors = {
  bg: 'bg-purple-600',
  bgLight: 'bg-purple-100',
  border: 'border-purple-300',
  text: 'text-purple-700',
  hover: 'hover:bg-purple-700',
}

const defaultContextConfig: ContextConfig = {
  useFeedback: true,
  usePersonas: false,
  useDocuments: false,
  useResearch: false,
  sources: [],
  categories: [],
  sentiments: [],
  days: 30,
  selectedPersonaIds: [],
  selectedDocumentIds: [],
  selectedResearchIds: [],
}

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

  it('renders data sources heading', () => {
    render(<DataSourcesStep {...defaultProps} />)
    expect(screen.getByText('Data Sources')).toBeInTheDocument()
  })

  it('renders description text', () => {
    render(<DataSourcesStep {...defaultProps} />)
    expect(screen.getByText(/select what data to use/i)).toBeInTheDocument()
  })

  describe('Customer Feedback option', () => {
    it('displays Customer Feedback when showFeedback is true', () => {
      render(<DataSourcesStep {...defaultProps} />)
      expect(screen.getByText('Customer Feedback')).toBeInTheDocument()
    })

    it('hides Customer Feedback when showFeedback is false', () => {
      render(<DataSourcesStep {...defaultProps} showFeedback={false} />)
      expect(screen.queryByText('Customer Feedback')).not.toBeInTheDocument()
    })

    it('calls onContextChange when feedback checkbox is toggled', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<DataSourcesStep {...defaultProps} onContextChange={onContextChange} />)
      
      const checkbox = screen.getByRole('checkbox', { name: /customer feedback/i })
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ useFeedback: false })
      )
    })
  })

  describe('Personas option', () => {
    it('displays Personas with count when showPersonas is true', () => {
      render(<DataSourcesStep {...defaultProps} />)
      expect(screen.getByText(/Personas \(2\)/)).toBeInTheDocument()
    })

    it('hides Personas when showPersonas is false', () => {
      render(<DataSourcesStep {...defaultProps} showPersonas={false} />)
      expect(screen.queryByText(/Personas/)).not.toBeInTheDocument()
    })

    it('calls onContextChange when personas checkbox is toggled', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<DataSourcesStep {...defaultProps} onContextChange={onContextChange} />)
      
      const checkbox = screen.getByRole('checkbox', { name: /personas/i })
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ usePersonas: true })
      )
    })

    it('clears selectedPersonaIds when personas is disabled', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      const config = { ...defaultContextConfig, usePersonas: true, selectedPersonaIds: ['p1'] }
      render(<DataSourcesStep {...defaultProps} contextConfig={config} onContextChange={onContextChange} />)
      
      const checkbox = screen.getByRole('checkbox', { name: /personas/i })
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ usePersonas: false, selectedPersonaIds: [] })
      )
    })
  })

  describe('Documents option (combined mode)', () => {
    it('displays combined Documents option when combineDocuments is true', () => {
      render(<DataSourcesStep {...defaultProps} combineDocuments={true} />)
      expect(screen.getByText(/Documents \(3\)/)).toBeInTheDocument()
    })

    it('toggles both useDocuments and useResearch when combined', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<DataSourcesStep {...defaultProps} combineDocuments={true} onContextChange={onContextChange} />)
      
      const checkbox = screen.getByRole('checkbox', { name: /documents/i })
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ useDocuments: true, useResearch: true })
      )
    })
  })

  describe('Documents option (separate mode)', () => {
    it('displays Existing Documents when combineDocuments is false', () => {
      render(<DataSourcesStep {...defaultProps} combineDocuments={false} />)
      expect(screen.getByText(/Existing Documents \(2\)/)).toBeInTheDocument()
    })

    it('displays Research Documents when combineDocuments is false', () => {
      render(<DataSourcesStep {...defaultProps} combineDocuments={false} />)
      expect(screen.getByText(/Research Documents \(1\)/)).toBeInTheDocument()
    })

    it('hides documents when showDocuments is false', () => {
      render(<DataSourcesStep {...defaultProps} showDocuments={false} />)
      expect(screen.queryByText(/Existing Documents/)).not.toBeInTheDocument()
    })

    it('hides research when showResearch is false', () => {
      render(<DataSourcesStep {...defaultProps} showResearch={false} />)
      expect(screen.queryByText(/Research Documents/)).not.toBeInTheDocument()
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
    colors: defaultColors,
  }

  it('renders Sources section', () => {
    render(<FeedbackFiltersStep {...defaultProps} />)
    expect(screen.getByText('Sources')).toBeInTheDocument()
  })

  it('renders Categories section', () => {
    render(<FeedbackFiltersStep {...defaultProps} />)
    expect(screen.getByText('Categories')).toBeInTheDocument()
  })

  it('renders Sentiments section', () => {
    render(<FeedbackFiltersStep {...defaultProps} />)
    expect(screen.getByText('Sentiments')).toBeInTheDocument()
  })

  it('renders Time Range section', () => {
    render(<FeedbackFiltersStep {...defaultProps} />)
    expect(screen.getByText('Time Range')).toBeInTheDocument()
  })

  describe('Sources', () => {
    it('displays all source buttons', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expect(screen.getByText('Webscraper')).toBeInTheDocument()
      expect(screen.getByText('Manual Import')).toBeInTheDocument()
      expect(screen.getByText('S3 Import')).toBeInTheDocument()
    })

    it('formats source names correctly', () => {
      const props = { ...defaultProps, sources: ['webscraper', 'manual_import'] }
      render(<FeedbackFiltersStep {...props} />)
      expect(screen.getByText('Webscraper')).toBeInTheDocument()
      expect(screen.getByText('Manual Import')).toBeInTheDocument()
    })

    it('toggles source selection when clicked', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<FeedbackFiltersStep {...defaultProps} onContextChange={onContextChange} />)
      
      await user.click(screen.getByText('Webscraper'))
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ sources: ['webscraper'] })
      )
    })

    it('removes source when already selected', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      const config = { ...defaultContextConfig, sources: ['webscraper'] }
      render(<FeedbackFiltersStep {...defaultProps} contextConfig={config} onContextChange={onContextChange} />)
      
      await user.click(screen.getByText('Webscraper'))
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ sources: [] })
      )
    })
  })

  describe('Categories', () => {
    it('displays all category buttons', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expect(screen.getByText('Delivery')).toBeInTheDocument()
      expect(screen.getByText('Quality')).toBeInTheDocument()
      expect(screen.getByText('Support')).toBeInTheDocument()
    })

    it('shows loading state when loadingCategories is true', () => {
      render(<FeedbackFiltersStep {...defaultProps} loadingCategories={true} />)
      expect(screen.getByText(/loading categories/i)).toBeInTheDocument()
    })

    it('toggles category selection when clicked', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<FeedbackFiltersStep {...defaultProps} onContextChange={onContextChange} />)
      
      await user.click(screen.getByText('Delivery'))
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ categories: ['delivery'] })
      )
    })
  })

  describe('Sentiments', () => {
    it('displays sentiment buttons', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expect(screen.getByText('positive')).toBeInTheDocument()
      expect(screen.getByText('negative')).toBeInTheDocument()
      expect(screen.getByText('neutral')).toBeInTheDocument()
    })

    it('toggles sentiment selection when clicked', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<FeedbackFiltersStep {...defaultProps} onContextChange={onContextChange} />)
      
      await user.click(screen.getByText('positive'))
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ sentiments: ['positive'] })
      )
    })

    it('applies correct styling for positive sentiment when selected', async () => {
      const config = { ...defaultContextConfig, sentiments: ['positive'] }
      render(<FeedbackFiltersStep {...defaultProps} contextConfig={config} />)
      
      const positiveButton = screen.getByText('positive')
      expect(positiveButton).toHaveClass('bg-green-100')
    })

    it('applies correct styling for negative sentiment when selected', async () => {
      const config = { ...defaultContextConfig, sentiments: ['negative'] }
      render(<FeedbackFiltersStep {...defaultProps} contextConfig={config} />)
      
      const negativeButton = screen.getByText('negative')
      expect(negativeButton).toHaveClass('bg-red-100')
    })
  })

  describe('Time Range', () => {
    it('displays time range select', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expect(screen.getByRole('combobox')).toBeInTheDocument()
    })

    it('has correct default value', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      const select = screen.getByRole('combobox')
      expect(select).toHaveValue('30')
    })

    it('updates days when selection changes', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      render(<FeedbackFiltersStep {...defaultProps} onContextChange={onContextChange} />)
      
      await user.selectOptions(screen.getByRole('combobox'), '7')
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      )
    })

    it('displays all time range options', () => {
      render(<FeedbackFiltersStep {...defaultProps} />)
      expect(screen.getByText('Last 7 days')).toBeInTheDocument()
      expect(screen.getByText('Last 14 days')).toBeInTheDocument()
      expect(screen.getByText('Last 30 days')).toBeInTheDocument()
      expect(screen.getByText('Last 60 days')).toBeInTheDocument()
      expect(screen.getByText('Last 90 days')).toBeInTheDocument()
      expect(screen.getByText('Last year')).toBeInTheDocument()
      expect(screen.getByText('All time')).toBeInTheDocument()
    })
  })
})

describe('ItemSelectionStep', () => {
  const otherDocs = mockDocuments.filter(d => d.document_type !== 'research')
  const researchDocs = mockDocuments.filter(d => d.document_type === 'research')

  const defaultProps = {
    contextConfig: defaultContextConfig,
    onContextChange: vi.fn(),
    personas: mockPersonas,
    documents: mockDocuments,
    otherDocs,
    researchDocs,
    combineDocuments: false,
  }

  describe('Persona Selection', () => {
    it('does not show personas when usePersonas is false', () => {
      render(<ItemSelectionStep {...defaultProps} />)
      expect(screen.queryByText('Select Personas')).not.toBeInTheDocument()
    })

    it('shows personas when usePersonas is true', () => {
      const config = { ...defaultContextConfig, usePersonas: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Select Personas')).toBeInTheDocument()
    })

    it('displays all personas', () => {
      const config = { ...defaultContextConfig, usePersonas: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Power User')).toBeInTheDocument()
      expect(screen.getByText('Casual User')).toBeInTheDocument()
    })

    it('displays persona taglines', () => {
      const config = { ...defaultContextConfig, usePersonas: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Uses all features daily')).toBeInTheDocument()
      expect(screen.getByText('Occasional usage')).toBeInTheDocument()
    })

    it('toggles persona selection when clicked', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      const config = { ...defaultContextConfig, usePersonas: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} onContextChange={onContextChange} />)
      
      const checkbox = screen.getAllByRole('checkbox')[0]
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ selectedPersonaIds: ['p1'] })
      )
    })

    it('removes persona when already selected', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      const config = { ...defaultContextConfig, usePersonas: true, selectedPersonaIds: ['p1'] }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} onContextChange={onContextChange} />)
      
      const checkbox = screen.getAllByRole('checkbox')[0]
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ selectedPersonaIds: [] })
      )
    })

    it('shows persona initial in avatar', () => {
      const config = { ...defaultContextConfig, usePersonas: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('P')).toBeInTheDocument() // Power User initial
      expect(screen.getByText('C')).toBeInTheDocument() // Casual User initial
    })
  })

  describe('Document Selection (separate mode)', () => {
    it('does not show documents when useDocuments is false', () => {
      render(<ItemSelectionStep {...defaultProps} />)
      expect(screen.queryByText('Select Documents')).not.toBeInTheDocument()
    })

    it('shows documents when useDocuments is true', () => {
      const config = { ...defaultContextConfig, useDocuments: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Select Documents')).toBeInTheDocument()
    })

    it('displays non-research documents', () => {
      const config = { ...defaultContextConfig, useDocuments: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Product PRD')).toBeInTheDocument()
      expect(screen.getByText('PR/FAQ Document')).toBeInTheDocument()
    })

    it('shows document type labels', () => {
      const config = { ...defaultContextConfig, useDocuments: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('PRD')).toBeInTheDocument()
      expect(screen.getByText('PRFAQ')).toBeInTheDocument()
    })
  })

  describe('Research Document Selection', () => {
    it('does not show research when useResearch is false', () => {
      render(<ItemSelectionStep {...defaultProps} />)
      expect(screen.queryByText('Select Research Documents')).not.toBeInTheDocument()
    })

    it('shows research when useResearch is true', () => {
      const config = { ...defaultContextConfig, useResearch: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Select Research Documents')).toBeInTheDocument()
    })

    it('displays research documents', () => {
      const config = { ...defaultContextConfig, useResearch: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} />)
      expect(screen.getByText('Research Report')).toBeInTheDocument()
    })

    it('toggles research document selection', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      const config = { ...defaultContextConfig, useResearch: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} onContextChange={onContextChange} />)
      
      const checkbox = screen.getByRole('checkbox')
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ selectedResearchIds: ['d2'] })
      )
    })
  })

  describe('Document Selection (combined mode)', () => {
    it('shows all documents when combineDocuments is true', () => {
      const config = { ...defaultContextConfig, useDocuments: true, useResearch: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} combineDocuments={true} />)
      expect(screen.getByText('Select Documents')).toBeInTheDocument()
      expect(screen.getByText('Product PRD')).toBeInTheDocument()
      expect(screen.getByText('Research Report')).toBeInTheDocument()
      expect(screen.getByText('PR/FAQ Document')).toBeInTheDocument()
    })

    it('shows description for merge mode', () => {
      const config = { ...defaultContextConfig, useDocuments: true, useResearch: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} combineDocuments={true} />)
      expect(screen.getByText('Select documents to merge')).toBeInTheDocument()
    })
  })

  describe('Empty states', () => {
    it('does not show personas section when personas array is empty', () => {
      const config = { ...defaultContextConfig, usePersonas: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} personas={[]} />)
      expect(screen.queryByText('Select Personas')).not.toBeInTheDocument()
    })

    it('does not show documents section when documents array is empty', () => {
      const config = { ...defaultContextConfig, useDocuments: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} otherDocs={[]} />)
      expect(screen.queryByText('Select Documents')).not.toBeInTheDocument()
    })

    it('does not show research section when research array is empty', () => {
      const config = { ...defaultContextConfig, useResearch: true }
      render(<ItemSelectionStep {...defaultProps} contextConfig={config} researchDocs={[]} />)
      expect(screen.queryByText('Select Research Documents')).not.toBeInTheDocument()
    })
  })
})
