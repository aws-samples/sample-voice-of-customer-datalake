/**
 * @fileoverview Tests for Breadcrumbs component.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Breadcrumbs from './Breadcrumbs'

// Helper to render with router
function renderWithRouter(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter
      initialEntries={initialEntries}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Breadcrumbs />
    </MemoryRouter>
  )
}

describe('Breadcrumbs', () => {
  describe('visibility', () => {
    it('returns null on home page', () => {
      const { container } = renderWithRouter(['/'])
      expect(container.firstChild).toBeNull()
    })

    it('renders breadcrumbs on non-home pages', () => {
      renderWithRouter(['/feedback'])
      expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toBeInTheDocument()
    })
  })

  describe('route labels', () => {
    it('displays correct label for feedback route', () => {
      renderWithRouter(['/feedback'])
      expect(screen.getByText('Feedback')).toBeInTheDocument()
    })

    it('displays correct label for categories route', () => {
      renderWithRouter(['/categories'])
      expect(screen.getByText('Categories')).toBeInTheDocument()
    })

    it('displays correct label for chat route', () => {
      renderWithRouter(['/chat'])
      expect(screen.getByText('AI Chat')).toBeInTheDocument()
    })

    it('displays correct label for scrapers route', () => {
      renderWithRouter(['/scrapers'])
      expect(screen.getByText('Web Scrapers')).toBeInTheDocument()
    })

    it('displays correct label for settings route', () => {
      renderWithRouter(['/settings'])
      expect(screen.getByText('Settings')).toBeInTheDocument()
    })

    it('displays correct label for projects route', () => {
      renderWithRouter(['/projects'])
      expect(screen.getByText('Projects')).toBeInTheDocument()
    })

    it('displays correct label for data-explorer route', () => {
      renderWithRouter(['/data-explorer'])
      expect(screen.getByText('Data Explorer')).toBeInTheDocument()
    })

    it('displays correct label for prioritization route', () => {
      renderWithRouter(['/prioritization'])
      expect(screen.getByText('Prioritization')).toBeInTheDocument()
    })

    it('displays correct label for problems route', () => {
      renderWithRouter(['/problems'])
      expect(screen.getByText('Problem Analysis')).toBeInTheDocument()
    })

    it('falls back to segment name for unknown routes', () => {
      renderWithRouter(['/unknown-route'])
      expect(screen.getByText('unknown-route')).toBeInTheDocument()
    })
  })

  describe('navigation structure', () => {
    it('includes Home link as first breadcrumb', () => {
      renderWithRouter(['/feedback'])
      const homeLink = screen.getByRole('link')
      expect(homeLink).toHaveAttribute('href', '/')
    })

    it('marks current page with aria-current', () => {
      renderWithRouter(['/feedback'])
      // The current page span has aria-current="page" - find by aria attribute
      const currentPage = screen.getByText('Feedback').closest('[aria-current="page"]')
      expect(currentPage).toBeInTheDocument()
    })

    it('renders nested routes correctly', () => {
      renderWithRouter(['/feedback/123'])
      expect(screen.getByText('Feedback')).toBeInTheDocument()
      expect(screen.getByText('123')).toBeInTheDocument()
    })
  })
})
