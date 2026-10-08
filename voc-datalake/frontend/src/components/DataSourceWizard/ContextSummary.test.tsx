/**
 * @fileoverview Tests for ContextSummary component
 * @module components/DataSourceWizard/ContextSummary.test
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ContextSummary from './ContextSummary'
import { textsMissingFromScreen } from '../component-spec-fixtures'
import { contextConfig } from './dataSourceWizard-fixtures'
import type { ContextConfig } from './types'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import { at } from '@test/defined'

/** The wizard defaults with every source off, then `overrides`. */
const createConfig = (overrides: Partial<ContextConfig> = {}): ContextConfig =>
  contextConfig({ useFeedback: false, ...overrides })

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

interface SummaryData {
  personas?: ProjectPersona[]
  documents?: ProjectDocument[]
}

/** Mount the summary for `overrides` on top of the all-off config, with the given data. */
function renderSummary(overrides: Partial<ContextConfig> = {}, { personas = [], documents = [] }: SummaryData = {}) {
  render(<ContextSummary config={createConfig(overrides)} personas={personas} documents={documents} />)
}

describe('ContextSummary', () => {
  describe('Header', () => {
    it('renders context summary title', () => {
      renderSummary()
      expect(screen.getByText('Context Summary')).toBeInTheDocument()
    })
  })

  describe('No Sources Selected', () => {
    it('shows no data sources message when nothing selected', () => {
      renderSummary()
      expect(screen.getByText('No data sources selected')).toBeInTheDocument()
    })
  })

  describe('Feedback Section', () => {
    it('shows feedback filters when useFeedback is true', () => {
      renderSummary({ useFeedback: true, days: 7 })

      expect(textsMissingFromScreen([
        'Sources:', 'Categories:', 'Sentiments:', 'Time Range:', 'Last 7 days',
      ])).toStrictEqual([])
    })

    it('labels a 0-day window as All time rather than "Last 0 days"', () => {
      const config = createConfig({ useFeedback: true, days: 0 })
      render(<ContextSummary config={config} personas={[]} documents={[]} />)

      expect(screen.getByText('All time')).toBeInTheDocument()
      expect(screen.queryByText('Last 0 days')).not.toBeInTheDocument()
    })

    it('shows All when no specific sources selected', () => {
      renderSummary({ useFeedback: true })

      expect(screen.getAllByText('All')).toHaveLength(3) // sources, categories, sentiments
    })

    it.each([
      ['sources', { sources: ['webscraper', 'manual_import'] }, 'webscraper, manual_import'],
      ['categories', { categories: ['delivery', 'pricing'] }, 'delivery, pricing'],
      // Sentiments are translated via common:sentiment.*, the same lookup the
      // filter buttons use — they previously disagreed, buttons showing "Positiv"
      // while this line printed the raw slug "positive".
      ['sentiments as labels, not stored slugs', { sentiments: ['positive', 'negative'] }, 'Positive, Negative'],
      ['a sentiment slug that has no label, passed through', { sentiments: ['unheard-of'] }, 'unheard-of'],
    ])('shows selected %s', (_what, filters, rendered) => {
      renderSummary({ useFeedback: true, ...filters })

      expect(screen.getByText(rendered)).toBeInTheDocument()
    })

    it('does not render stored sentiment slugs', () => {
      renderSummary({ useFeedback: true, sentiments: ['positive', 'negative'] })

      expect(screen.queryByText('positive, negative')).not.toBeInTheDocument()
    })

    it('does not show feedback section when useFeedback is false', () => {
      renderSummary({ useFeedback: false })

      expect(screen.queryByText('Sources:')).not.toBeInTheDocument()
    })
  })

  describe('Personas Section', () => {
    it('shows all personas when none specifically selected', () => {
      renderSummary({ usePersonas: true }, { personas: mockPersonas })

      expect(screen.getByText('Personas:')).toBeInTheDocument()
      expect(screen.getByText('All 2 personas')).toBeInTheDocument()
    })

    // A one-item project is a common early state, and the first cut of these keys
    // interpolated {{total}} with no plural family, rendering "All 1 personas".
    // The singular also drops the quantifier — "All 1 persona" is awkward in
    // English and outright ungrammatical once the article is plural-marked
    // ("Todos los 1 documento"). These assertions fail if _one is dropped or
    // reverts to carrying the quantifier.
    it('uses the singular form, without the plural quantifier, for exactly one item', () => {
      const onePersona = [at(mockPersonas, 0)]
      const oneDoc = [at(mockDocuments, 0), at(mockDocuments, 2)] // 1 other + 1 research
      renderSummary(
        { usePersonas: true, useDocuments: true, useResearch: true },
        { personas: onePersona, documents: oneDoc },
      )

      expect(screen.getByText('1 persona')).toBeInTheDocument()
      expect(screen.getByText('1 document')).toBeInTheDocument()
      expect(screen.getByText('1 research doc')).toBeInTheDocument()
      expect(screen.queryByText('All 1 persona')).not.toBeInTheDocument()
    })

    it.each([
      ['selected persona names', ['p1'], 'Power User'],
      ['multiple selected personas', ['p1', 'p2'], 'Power User, Casual User'],
    ])('shows %s', (_what, selectedPersonaIds, rendered) => {
      renderSummary({ usePersonas: true, selectedPersonaIds }, { personas: mockPersonas })

      expect(screen.getByText(rendered)).toBeInTheDocument()
    })

    it('does not show personas section when usePersonas is false', () => {
      renderSummary({ usePersonas: false }, { personas: mockPersonas })

      expect(screen.queryByText('Personas:')).not.toBeInTheDocument()
    })
  })

  describe('Documents and Research Sections', () => {
    it.each([
      ['documents', { useDocuments: true }, 'Documents:', 'All 2 documents'], // excludes research docs
      ['research docs', { useResearch: true }, 'Research:', 'All 2 research docs'],
    ])('shows all %s when none specifically selected', (_what, toggles, label, all) => {
      renderSummary(toggles, { documents: mockDocuments })

      expect(screen.getByText(label)).toBeInTheDocument()
      expect(screen.getByText(all)).toBeInTheDocument()
    })

    it.each([
      ['document titles', { useDocuments: true, selectedDocumentIds: ['d1'] }, 'Product Spec'],
      ['research titles', { useResearch: true, selectedResearchIds: ['r1'] }, 'User Research'],
    ])('shows selected %s', (_what, overrides, rendered) => {
      renderSummary(overrides, { documents: mockDocuments })

      expect(screen.getByText(rendered)).toBeInTheDocument()
    })

    it.each([
      ['documents', 'useDocuments', 'Documents:'],
      ['research', 'useResearch', 'Research:'],
    ] as const)('does not show %s section when its toggle is false', (_what, toggle, label) => {
      renderSummary({ [toggle]: false }, { documents: mockDocuments })

      expect(screen.queryByText(label)).not.toBeInTheDocument()
    })
  })

  describe('Multiple Sources', () => {
    it('shows all enabled sources together', () => {
      renderSummary(
        { useFeedback: true, usePersonas: true, useDocuments: true, useResearch: true, days: 14 },
        { personas: mockPersonas, documents: mockDocuments },
      )

      expect(textsMissingFromScreen([
        'Sources:', 'Personas:', 'Documents:', 'Research:', 'Last 14 days',
      ])).toStrictEqual([])
      expect(screen.queryByText('No data sources selected')).not.toBeInTheDocument()
    })
  })
})
