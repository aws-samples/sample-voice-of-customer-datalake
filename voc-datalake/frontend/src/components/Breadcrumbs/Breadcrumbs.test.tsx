/**
 * @fileoverview Tests for Breadcrumbs component.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Breadcrumbs from './Breadcrumbs'

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
      renderWithRouter(['/'])
      expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).not.toBeInTheDocument()
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
      // eslint-disable-next-line testing-library/no-node-access
      expect(screen.getByText('Feedback').closest('[aria-current="page"]')).toBeInTheDocument()
    })
    it('renders nested routes correctly', () => {
      renderWithRouter(['/feedback/123'])
      expect(screen.getByText('Feedback')).toBeInTheDocument()
      expect(screen.getByText('123')).toBeInTheDocument()
    })
    it('renders deeply nested routes', () => {
      renderWithRouter(['/projects/123/personas'])
      expect(screen.getByText('Projects')).toBeInTheDocument()
      expect(screen.getByText('123')).toBeInTheDocument()
      expect(screen.getByText('personas')).toBeInTheDocument()
    })
  })

  describe('link behavior', () => {
    it('renders intermediate segments as links', () => {
      renderWithRouter(['/feedback/123'])
      const feedbackLink = screen.getByRole('link', { name: /feedback/i })
      expect(feedbackLink).toHaveAttribute('href', '/feedback')
    })
    it('does not render last segment as link', () => {
      renderWithRouter(['/feedback'])
      const feedbackText = screen.getByText('Feedback')
      expect(feedbackText.tagName).not.toBe('A')
    })
  })

  describe('chevron separators', () => {
    it('renders chevron between breadcrumb items', () => {
      const { container } = renderWithRouter(['/feedback'])
      // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
      expect(container.querySelectorAll('.lucide-chevron-right')).toHaveLength(1)
    })
    it('renders multiple chevrons for nested routes', () => {
      const { container } = renderWithRouter(['/feedback/123'])
      // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
      expect(container.querySelectorAll('.lucide-chevron-right')).toHaveLength(2)
    })
    it('chevrons have aria-hidden attribute', () => {
      const { container } = renderWithRouter(['/feedback'])
      // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
      const chevron = container.querySelector('.lucide-chevron-right')
      expect(chevron).toHaveAttribute('aria-hidden', 'true')
    })
  })

  describe('home icon', () => {
    it('renders home icon in home breadcrumb link', () => {
      renderWithRouter(['/feedback'])
      expect(screen.getByRole('link')).toBeInTheDocument()
    })
    it('home link contains home icon', () => {
      const { container } = renderWithRouter(['/feedback'])
      // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
      const homeIcon = container.querySelector('a[href="/"] svg')
      expect(homeIcon).toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has navigation landmark with breadcrumb label', () => {
      renderWithRouter(['/feedback'])
      expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toBeInTheDocument()
    })
  })

  describe('feedback-forms route', () => {
    it('displays correct label for feedback-forms route', () => {
      renderWithRouter(['/feedback-forms'])
      expect(screen.getByText('Feedback Forms')).toBeInTheDocument()
    })
  })
})
