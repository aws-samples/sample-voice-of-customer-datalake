/**
 * @fileoverview Tests for the Home / getting-started page.
 * @module pages/Home
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '../../test/test-utils'
import Home from './Home'

describe('Home', () => {
  describe('hero', () => {
    it('renders the welcome heading and intro', () => {
      render(<Home />)

      expect(
        screen.getByRole('heading', { level: 1, name: /welcome to voice of the customer/i }),
      ).toBeInTheDocument()
      expect(screen.getByText(/turn scattered customer feedback into product decisions/i)).toBeInTheDocument()
    })
  })

  describe('how it works', () => {
    it('renders the section and all four phase titles in order', () => {
      render(<Home />)

      expect(screen.getByRole('heading', { name: /how it works/i })).toBeInTheDocument()

      const phase1 = screen.getByText('Collect & inspect data')
      const phase2 = screen.getByText('Read the signals')
      const phase3 = screen.getByText('Turn insight into ideas')
      const phase4 = screen.getByText('Validate & prioritize')

      expect(phase1).toBeInTheDocument()
      expect(phase2).toBeInTheDocument()
      expect(phase3).toBeInTheDocument()
      expect(phase4).toBeInTheDocument()

      // Phases render top-to-bottom in lifecycle order.
      const order = [phase1, phase2, phase3, phase4]
      for (let i = 1; i < order.length; i++) {
        // eslint-disable-next-line no-bitwise
        const relation = order[i - 1].compareDocumentPosition(order[i])
        expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }
    })

    it('links each phase into the matching sidebar section', () => {
      render(<Home />)

      // One representative link per phase (exact names avoid matching the
      // quick-start card descriptions, which mention "web scrapers"/"AI Chat").
      expect(screen.getByRole('link', { name: 'Scrapers' })).toHaveAttribute('href', '/scrapers')
      expect(screen.getByRole('link', { name: 'Data Explorer' })).toHaveAttribute('href', '/data-explorer')
      expect(screen.getByRole('link', { name: 'Problem Analysis' })).toHaveAttribute('href', '/problems')
      expect(screen.getByRole('link', { name: 'AI Chat' })).toHaveAttribute('href', '/chat')
      expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects')
      expect(screen.getByRole('link', { name: 'Feedback Forms' })).toHaveAttribute('href', '/feedback-forms')
      expect(screen.getByRole('link', { name: 'Prioritization' })).toHaveAttribute('href', '/prioritization')
    })
  })

  describe('quick start', () => {
    it('renders the quick-start section with a primary path to collect data', () => {
      render(<Home />)

      expect(screen.getByRole('heading', { name: /quick start/i })).toBeInTheDocument()

      // Primary card links to the scraper setup and carries the CTA label.
      const primary = screen.getByRole('link', { name: /collect reviews/i })
      expect(primary).toHaveAttribute('href', '/scrapers')
      expect(screen.getByText('Start here')).toBeInTheDocument()

      // Secondary quick-start cards.
      expect(screen.getByRole('link', { name: /or share a form/i })).toHaveAttribute('href', '/feedback-forms')
      expect(screen.getByRole('link', { name: /then analyze/i })).toHaveAttribute('href', '/chat')
    })
  })
})
