/**
 * @fileoverview Tests for ContextSummary component
 * @module components/DataSourceWizard/ContextSummary.test
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ContextSummary from './ContextSummary'
import type { ContextConfig } from './types'
import type { ProjectPersona, ProjectDocument } from '../../api/client'

const createConfig = (overrides: Partial<ContextConfig> = {}): ContextConfig => ({
  useFeedback: false,
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
  ...overrides,
})

const mockPersonas: ProjectPersona[] = [
  { persona_id: 'p1', name: 'Power User', tagline: 'Expert', created_at: '' },
  { persona_id: 'p2', name: 'Casual User', tagline: 'Beginner', created_at: '' },
]

const mockDocuments: ProjectDocument[] = [
  { document_id: 'd1', document_type: 'prd', title: 'Product Spec', content: '', created_at: '' },
  { document_id: 'd2', document_type: 'prfaq', title: 'PR/FAQ Doc', content: '', created_at: '' },
  { document_id: 'r1', document_type: 'research', title: 'User Research', content: '', created_at: '' },
  { document_id: 'r2', document_type: 'research', title: 'Market Analysis', content: '', created_at: '' },
]

describe('ContextSummary', () => {
  describe('Header', () => {
    it('renders context summary title', () => {
      render(<ContextSummary config={createConfig()} personas={[]} documents={[]} />)
      expect(screen.getByText('Context Summary')).toBeInTheDocument()
    })
  })

  describe('No Sources Selected', () => {
    it('shows no data sources message when nothing selected', () => {
      render(<ContextSummary config={createConfig()} personas={[]} documents={[]} />)
      expect(screen.getByText('No data sources selected')).toBeInTheDocument()
    })
  })

  describe('Feedback Section', () => {
    it('shows feedback filters when useFeedback is true', () => {
      const config = createConfig({ useFeedback: true, days: 7 })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.getByText('Sources:')).toBeInTheDocument()
      expect(screen.getByText('Categories:')).toBeInTheDocument()
      expect(screen.getByText('Sentiments:')).toBeInTheDocument()
      expect(screen.getByText('Time Range:')).toBeInTheDocument()
      expect(screen.getByText('Last 7 days')).toBeInTheDocument()
    })

    it('shows All when no specific sources selected', () => {
      const config = createConfig({ useFeedback: true })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.getAllByText('All')).toHaveLength(3) // sources, categories, sentiments
    })

    it('shows selected sources', () => {
      const config = createConfig({ useFeedback: true, sources: ['twitter', 'trustpilot'] })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.getByText('twitter, trustpilot')).toBeInTheDocument()
    })

    it('shows selected categories', () => {
      const config = createConfig({ useFeedback: true, categories: ['delivery', 'pricing'] })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.getByText('delivery, pricing')).toBeInTheDocument()
    })

    it('shows selected sentiments', () => {
      const config = createConfig({ useFeedback: true, sentiments: ['positive', 'negative'] })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.getByText('positive, negative')).toBeInTheDocument()
    })

    it('does not show feedback section when useFeedback is false', () => {
      const config = createConfig({ useFeedback: false })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.queryByText('Sources:')).not.toBeInTheDocument()
    })
  })

  describe('Personas Section', () => {
    it('shows all personas when none specifically selected', () => {
      const config = createConfig({ usePersonas: true })
      render(<ContextSummary config={config} personas={mockPersonas} documents={[]} />)

      expect(screen.getByText('Personas:')).toBeInTheDocument()
      expect(screen.getByText('All 2 personas')).toBeInTheDocument()
    })

    it('shows selected persona names', () => {
      const config = createConfig({ usePersonas: true, selectedPersonaIds: ['p1'] })
      render(<ContextSummary config={config} personas={mockPersonas} documents={[]} />)

      expect(screen.getByText('Power User')).toBeInTheDocument()
    })

    it('shows multiple selected personas', () => {
      const config = createConfig({ usePersonas: true, selectedPersonaIds: ['p1', 'p2'] })
      render(<ContextSummary config={config} personas={mockPersonas} documents={[]} />)

      expect(screen.getByText('Power User, Casual User')).toBeInTheDocument()
    })

    it('does not show personas section when usePersonas is false', () => {
      const config = createConfig({ usePersonas: false })
      render(<ContextSummary config={config} personas={mockPersonas} documents={[]} />)

      expect(screen.queryByText('Personas:')).not.toBeInTheDocument()
    })
  })

  describe('Documents Section', () => {
    it('shows all documents when none specifically selected', () => {
      const config = createConfig({ useDocuments: true })
      render(<ContextSummary config={config} personas={[]} documents={mockDocuments} />)

      expect(screen.getByText('Documents:')).toBeInTheDocument()
      expect(screen.getByText('All 2 documents')).toBeInTheDocument() // excludes research docs
    })

    it('shows selected document titles', () => {
      const config = createConfig({ useDocuments: true, selectedDocumentIds: ['d1'] })
      render(<ContextSummary config={config} personas={[]} documents={mockDocuments} />)

      expect(screen.getByText('Product Spec')).toBeInTheDocument()
    })

    it('does not show documents section when useDocuments is false', () => {
      const config = createConfig({ useDocuments: false })
      render(<ContextSummary config={config} personas={[]} documents={mockDocuments} />)

      expect(screen.queryByText('Documents:')).not.toBeInTheDocument()
    })
  })

  describe('Research Section', () => {
    it('shows all research docs when none specifically selected', () => {
      const config = createConfig({ useResearch: true })
      render(<ContextSummary config={config} personas={[]} documents={mockDocuments} />)

      expect(screen.getByText('Research:')).toBeInTheDocument()
      expect(screen.getByText('All 2 research docs')).toBeInTheDocument()
    })

    it('shows selected research titles', () => {
      const config = createConfig({ useResearch: true, selectedResearchIds: ['r1'] })
      render(<ContextSummary config={config} personas={[]} documents={mockDocuments} />)

      expect(screen.getByText('User Research')).toBeInTheDocument()
    })

    it('does not show research section when useResearch is false', () => {
      const config = createConfig({ useResearch: false })
      render(<ContextSummary config={config} personas={[]} documents={mockDocuments} />)

      expect(screen.queryByText('Research:')).not.toBeInTheDocument()
    })
  })

  describe('Multiple Sources', () => {
    it('shows all enabled sources together', () => {
      const config = createConfig({
        useFeedback: true,
        usePersonas: true,
        useDocuments: true,
        useResearch: true,
        days: 14,
      })
      render(<ContextSummary config={config} personas={mockPersonas} documents={mockDocuments} />)

      expect(screen.getByText('Sources:')).toBeInTheDocument()
      expect(screen.getByText('Personas:')).toBeInTheDocument()
      expect(screen.getByText('Documents:')).toBeInTheDocument()
      expect(screen.getByText('Research:')).toBeInTheDocument()
      expect(screen.getByText('Last 14 days')).toBeInTheDocument()
      expect(screen.queryByText('No data sources selected')).not.toBeInTheDocument()
    })
  })
})
