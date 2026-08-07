/**
 * @fileoverview Tests for the Home / getting-started page.
 * @module pages/Home
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '../../test/test-utils'
import Home from './Home'

describe('Home', () => {
  // Regression: the phase-2 card carried `{ to: '/feedback', labelKey:
  // 'common:nav.feedback' }`. Both were removed when the Feedback list was
  // consolidated into Categories, so i18next fell back to echoing the key and
  // the app's landing page rendered a chip labelled literally "nav.feedback" in
  // all 8 locales. Reverting the fix makes both of these fail.
  describe('no stale navigation or unresolved labels', () => {
    it('renders no raw i18n key anywhere on the page', () => {
      const { container } = render(<Home />)
      // An unresolved i18next key renders as its own dotted path, e.g.
      // "nav.feedback" or "home.phase1Title". Every segment starts lowercase.
      // That last part matters: `textContent` concatenates adjacent blocks
      // without whitespace, so prose yields tokens like "next.How" — requiring a
      // lowercase segment start excludes those without weakening the check.
      const rawKeys = (container.textContent ?? '')
        .split(/\s+/)
        .filter((token) => /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(token))
      expect(rawKeys).toEqual([])
    })

    it('does not link to the removed /feedback route', () => {
      const { container } = render(<Home />)
      const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
      expect(hrefs).not.toContain('/feedback')
      // The signals phase still offers its surviving destinations.
      expect(hrefs).toContain('/categories')
      expect(hrefs).toContain('/problems')
    })
  })

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
