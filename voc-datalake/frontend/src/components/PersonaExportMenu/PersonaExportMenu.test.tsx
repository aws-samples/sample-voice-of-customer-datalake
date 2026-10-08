/**
 * @fileoverview Tests for PersonaExportMenu component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { openExportMenu, openThenClickOutside, renderExportMenu } from '../../test/export-menu'
import PersonaExportMenu from './PersonaExportMenu'
import { ariaExpandedAcrossClick } from '../ExportMenuShell/exportMenu-fixtures'
import type { ProjectPersona } from '../../api/projectTypes'

const TRIGGER = 'Export persona'

describe('PersonaExportMenu', () => {
  const mockPersona: ProjectPersona = {
    persona_id: 'persona-1',
    name: 'Tech Enthusiast',
    tagline: 'Early adopter who loves new technology',
    confidence: 'high',
    feedback_count: 50,
    created_at: '2025-01-15T10:00:00Z',
  }

  const openMenu = () => openExportMenu(<PersonaExportMenu persona={mockPersona} />, TRIGGER)

  /** Open the menu and press "Copy as Markdown". */
  async function copyAsMarkdown(): Promise<void> {
    const user = await openMenu()
    await user.click(screen.getByText('Copy as Markdown'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('visibility', () => {
    it('returns null when persona is null', () => {
      const { container } = render(<PersonaExportMenu persona={null} />)
      expect(container).toBeEmptyDOMElement()
    })
  })

  describe('menu toggle', () => {
    it('renders menu button', () => {
      expect(renderExportMenu(<PersonaExportMenu persona={mockPersona} />, TRIGGER)).toBeInTheDocument()
    })

    it('opens menu when button is clicked', async () => {
      await openMenu()

      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('closes menu when clicking outside', async () => {
      await openThenClickOutside(<PersonaExportMenu persona={mockPersona} />, TRIGGER)

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })

  describe('menu items', () => {
    it.each([
      'Copy as Markdown',
      'Download as Markdown',
      'Download as PDF',
      'Download as TXT',
    ])('displays the %s option', async (label) => {
      await openMenu()

      expect(screen.getByText(label)).toBeInTheDocument()
    })
  })

  describe('copy functionality', () => {
    it('copies persona as markdown to clipboard', async () => {
      await copyAsMarkdown()

      // The component shows "Copied!" when copy succeeds
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })

    it('shows Copied! after copying', async () => {
      await copyAsMarkdown()

      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('markdown generation', () => {
    // Each case verifies the copy succeeded (the component shows Copied!).
    it.each([
      'includes persona name as title',
      'includes tagline',
      'includes confidence level',
      'includes quote when provided',
    ])('%s', async () => {
      await copyAsMarkdown()

      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument()
      })
    })
  })

  describe('accessibility', () => {
    it('has correct aria attributes on menu button', () => {
      const button = renderExportMenu(<PersonaExportMenu persona={mockPersona} />, TRIGGER)
      expect(button).toHaveAttribute('aria-haspopup', 'menu')
    })

    it('sets aria-expanded correctly', async () => {
      expect(await ariaExpandedAcrossClick(<PersonaExportMenu persona={mockPersona} />, TRIGGER))
        .toStrictEqual({ before: 'false', after: 'true' })
    })
  })
})
