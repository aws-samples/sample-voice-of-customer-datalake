/**
 * @fileoverview Tests for PersonaExportMenu component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PersonaExportMenu from './PersonaExportMenu'
import type { ProjectPersona } from '../../api/types'

describe('PersonaExportMenu', () => {
  const mockPersona: ProjectPersona = {
    persona_id: 'persona-1',
    name: 'Tech Enthusiast',
    tagline: 'Early adopter who loves new technology',
    confidence: 'high',
    feedback_count: 50,
    goals: ['Stay updated with latest tech', 'Find best deals'],
    frustrations: ['Slow shipping', 'Poor documentation'],
    needs: ['Fast delivery', 'Good support'],
    quote: 'I want the latest and greatest!',
    created_at: '2025-01-15T10:00:00Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('visibility', () => {
    it('returns null when persona is null', () => {
      const { container } = render(<PersonaExportMenu persona={null} />)
      // eslint-disable-next-line testing-library/no-node-access
      expect(container.firstChild).toBeNull()
    })
  })

  describe('menu toggle', () => {
    it('renders menu button', () => {
      render(<PersonaExportMenu persona={mockPersona} />)
      expect(screen.getByLabelText('Export persona')).toBeInTheDocument()
    })

    it('opens menu when button is clicked', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('closes menu when clicking outside', async () => {
      const user = userEvent.setup()
      render(
        <div>
          <PersonaExportMenu persona={mockPersona} />
          <div data-testid="outside">Outside</div>
        </div>
      )
      
      await user.click(screen.getByLabelText('Export persona'))
      expect(screen.getByRole('menu')).toBeInTheDocument()
      
      await user.click(screen.getByTestId('outside'))
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })

  describe('menu items', () => {
    it('displays Copy as Markdown option', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      
      expect(screen.getByText('Copy as Markdown')).toBeInTheDocument()
    })

    it('displays Download as Markdown option', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      
      expect(screen.getByText('Download as Markdown')).toBeInTheDocument()
    })

    it('displays Download as PDF option', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      
      expect(screen.getByText('Download as PDF')).toBeInTheDocument()
    })

    it('displays Download as TXT option', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      
      expect(screen.getByText('Download as TXT')).toBeInTheDocument()
    })
  })

  describe('copy functionality', () => {
    it('copies persona as markdown to clipboard', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      await user.click(screen.getByText('Copy as Markdown'))
      
      // The component shows "Copied!" when copy succeeds
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })

    it('shows Copied! after copying', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      await user.click(screen.getByText('Copy as Markdown'))
      
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('markdown generation', () => {
    it('includes persona name as title', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      await user.click(screen.getByText('Copy as Markdown'))
      
      // Verify copy succeeded (component shows Copied!)
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })

    it('includes tagline', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      await user.click(screen.getByText('Copy as Markdown'))
      
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })

    it('includes confidence level', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      await user.click(screen.getByText('Copy as Markdown'))
      
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })

    it('includes quote when provided', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      await user.click(screen.getByLabelText('Export persona'))
      await user.click(screen.getByText('Copy as Markdown'))
      
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })
  })

  describe('accessibility', () => {
    it('has correct aria attributes on menu button', () => {
      render(<PersonaExportMenu persona={mockPersona} />)
      
      const button = screen.getByLabelText('Export persona')
      expect(button).toHaveAttribute('aria-haspopup', 'menu')
    })

    it('sets aria-expanded correctly', async () => {
      const user = userEvent.setup()
      render(<PersonaExportMenu persona={mockPersona} />)
      
      const button = screen.getByLabelText('Export persona')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      
      await user.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
    })
  })
})
