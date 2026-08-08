import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
import { emptyProductContext } from './productContextFields'
import type { Project, ProjectPersona, ProjectDocument, ProductContext } from '../../api/types'

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com/v1' },
  }),
}))

const mockProject: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: 'A test project',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  persona_count: 0,
  document_count: 0,
}

const defaultProps = {
  project: mockProject,
  personas: [] as ProjectPersona[],
  documents: [] as ProjectDocument[],
  onGeneratePersonas: vi.fn(),
  onGenerateDoc: vi.fn(),
  onRunResearch: vi.fn(),
  onRemixDocuments: vi.fn(),
  onOpenProductTool: vi.fn(),
  onSaveKiroPrompt: vi.fn(),
}

const persona = (id: string): ProjectPersona => ({
  persona_id: id,
  name: `Persona ${id}`,
  tagline: '',
  created_at: '',
})

const doc = (id: string, type: ProjectDocument['document_type']): ProjectDocument => ({
  document_id: id,
  document_type: type,
  title: `Doc ${id}`,
  content: '',
  created_at: '',
})

const contextWith = (fields: Partial<ProductContext>): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

/**
 * The action-card headings, in DOM order. Scoped to the card grid so the Kiro
 * export card's heading below it cannot drift into the assertion.
 */
function cardTitlesInOrder(): string[] {
  return within(screen.getByTestId('overview-cards'))
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent ?? '')
}

/** The card whose heading contains `title`, for assertions scoped to one card. */
function cardFor(title: string): HTMLElement {
  const heading = within(screen.getByTestId('overview-cards'))
    .getAllByRole('heading', { level: 3 })
    .find((h) => (h.textContent ?? '').includes(title))
  const card = heading?.closest('div.bg-white')
  if (!(card instanceof HTMLElement)) throw new Error(`no card found for "${title}"`)
  return card
}

describe('OverviewTab', () => {
  it('renders Generate Personas action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Create user personas from feedback')).toBeInTheDocument()
  })

  it('renders Generate PRD / PR-FAQ action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Create product documents from feedback')).toBeInTheDocument()
  })

  it('renders Run Research action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Deep dive into feedback with filters')).toBeInTheDocument()
  })

  it('renders Remix Documents action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Combine and revise documents into new versions')).toBeInTheDocument()
  })

  it('calls onGeneratePersonas when Generate button is clicked', async () => {
    const user = userEvent.setup()
    const onGeneratePersonas = vi.fn()
    render(<OverviewTab {...defaultProps} onGeneratePersonas={onGeneratePersonas} />)

    const buttons = screen.getAllByRole('button', { name: /Generate/i })
    await user.click(buttons[0])
    expect(onGeneratePersonas).toHaveBeenCalledTimes(1)
  })

  it('calls onRunResearch when Run Research button is clicked', async () => {
    const user = userEvent.setup()
    const onRunResearch = vi.fn()
    render(<OverviewTab {...defaultProps} onRunResearch={onRunResearch} />)

    await user.click(screen.getByRole('button', { name: /Run Research/i }))
    expect(onRunResearch).toHaveBeenCalledTimes(1)
  })

  it('disables Remix Documents when less than 2 documents', () => {
    render(<OverviewTab {...defaultProps} documents={[]} />)
    const remixButton = screen.getByRole('button', { name: /Remix/i })
    expect(remixButton).toBeDisabled()
  })

  it('shows disabled message for Remix Documents', () => {
    render(<OverviewTab {...defaultProps} documents={[]} />)
    expect(screen.getByText('Need at least 2 documents')).toBeInTheDocument()
  })

  it('enables Remix Documents when 2+ documents exist', () => {
    render(<OverviewTab {...defaultProps} documents={[doc('1', 'prd'), doc('2', 'prd')]} />)
    const remixButton = screen.getByRole('button', { name: /Remix/i })
    expect(remixButton).not.toBeDisabled()
  })

  it('renders Kiro Export Settings card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Kiro Export Settings')).toBeInTheDocument()
  })

  it('shows empty state when no export prompt configured', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText(/No Kiro export prompt configured/)).toBeInTheDocument()
  })

  // ── U8 ──────────────────────────────────────────────────────────────────────

  describe('dependency order', () => {
    it('places Run Research before Generate PRD / PR-FAQ', () => {
      // The old grid had PRD/PR-FAQ third and research fourth, so following the
      // cards in order produced documents with no research behind them. Research
      // can read personas and documents can read research, so this is the order
      // the generators actually support.
      render(<OverviewTab {...defaultProps} />)

      const titles = cardTitlesInOrder()
      expect(titles).toHaveLength(5)
      expect(titles[0]).toContain('Product / Service Description')
      expect(titles[1]).toContain('Generate Personas')
      expect(titles[2]).toContain('Run Research')
      expect(titles[3]).toContain('Generate PRD / PR-FAQ')
      expect(titles[4]).toContain('Remix Documents')
    })

    it('carries each card position in the heading, not in a parallel hidden label', () => {
      // The position is heading text, so it reaches everyone through one channel.
      // Asserting on the accessible name is what pins that: it would fail if the
      // number went back to being a decorative badge with an aria-hidden span.
      render(<OverviewTab {...defaultProps} />)

      const titles = cardTitlesInOrder()
      expect(titles[0]).toBe('1. Product / Service Description')
      expect(titles[2]).toBe('3. Run Research')
      expect(titles[4]).toBe('5. Remix Documents')
    })
  })

  describe('per-card state', () => {
    /**
     * The bug, stated as a test: before U8 these two renders were identical, so
     * nothing on the tab could tell an untouched project from a finished one.
     *
     * Asserts the four specific state strings rather than just "the markup
     * differs" — a difference anywhere would pass while three of the four cards
     * had silently stopped reporting.
     */
    it('reports every step differently for an empty project and a populated one', () => {
      const populatedStates = [
        '2 of 11 fields filled',
        'Personas created: 3',
        'Research documents: 1',
        'PRD / PR-FAQ documents: 2',
      ]

      const { unmount } = render(
        <OverviewTab {...defaultProps} productContext={emptyProductContext()} />,
      )
      for (const text of populatedStates) {
        expect(screen.queryByText(text)).not.toBeInTheDocument()
      }
      unmount()

      render(
        <OverviewTab
          {...defaultProps}
          personas={[persona('p1'), persona('p2'), persona('p3')]}
          documents={[doc('d1', 'research'), doc('d2', 'prd'), doc('d3', 'prfaq')]}
          productContext={contextWith({ product_name: 'VoC', one_liner: 'Feedback intelligence' })}
        />,
      )
      for (const text of populatedStates) {
        expect(screen.getByText(text)).toBeInTheDocument()
      }
    })

    it('reports what each step has produced', () => {
      render(
        <OverviewTab
          {...defaultProps}
          personas={[persona('p1'), persona('p2'), persona('p3')]}
          documents={[doc('d1', 'research'), doc('d2', 'prd'), doc('d3', 'prfaq')]}
          productContext={contextWith({ product_name: 'VoC', one_liner: 'Feedback intelligence' })}
        />,
      )

      // The "of 11" is deliberately a literal: it is the number the user reads, so
      // adding a product-context field should fail here and make someone look at
      // the copy rather than silently shifting it.
      expect(screen.getByText('2 of 11 fields filled')).toBeInTheDocument()
      expect(screen.getByText('Personas created: 3')).toBeInTheDocument()
      expect(screen.getByText('Research documents: 1')).toBeInTheDocument()
      expect(screen.getByText('PRD / PR-FAQ documents: 2')).toBeInTheDocument()
    })

    it('says so when a step has produced nothing', () => {
      render(<OverviewTab {...defaultProps} productContext={emptyProductContext()} />)

      expect(screen.getByText('Not described yet')).toBeInTheDocument()
      expect(screen.getByText('Not run yet')).toBeInTheDocument()
      expect(screen.getAllByText('None yet')).toHaveLength(2)
    })

    it('shows no product state at all while the context is unknown', () => {
      render(<OverviewTab {...defaultProps} />)

      expect(screen.queryByText('Not described yet')).not.toBeInTheDocument()
      expect(screen.queryByText(/fields filled/)).not.toBeInTheDocument()
    })
  })

  describe('upstream hints', () => {
    it('suggests generating personas before research when there are none', () => {
      render(<OverviewTab {...defaultProps} />)
      expect(screen.getByText(/Generate personas first to ground the research/)).toBeInTheDocument()
    })

    it('drops the hint once personas exist', () => {
      render(<OverviewTab {...defaultProps} personas={[persona('p1')]} />)
      expect(screen.queryByText(/Generate personas first to ground the research/)).not.toBeInTheDocument()
    })

    it('does not disable a generator just because an optional input is missing', () => {
      // The hints are advice. Every generator works without its optional inputs,
      // so gating them would block work the backend accepts.
      //
      // Scoped by card rather than by index: indexing into the button list would
      // depend on the very ordering these tests exist to pin, so a reorder would
      // silently change what is being asserted.
      render(<OverviewTab {...defaultProps} />)

      expect(within(cardFor('Run Research')).getByRole('button')).not.toBeDisabled()
      expect(within(cardFor('Generate PRD / PR-FAQ')).getByRole('button')).not.toBeDisabled()
      expect(within(cardFor('Generate Personas')).getByRole('button')).not.toBeDisabled()
    })
  })

  describe('next step', () => {
    it('recommends research on a project with personas and no research', () => {
      render(
        <OverviewTab
          {...defaultProps}
          personas={[persona('p1')]}
          productContext={contextWith({ product_name: 'VoC' })}
        />,
      )

      expect(screen.getByText('Next step:')).toBeInTheDocument()
      expect(screen.getByText(/Run research — your personas can ground it/)).toBeInTheDocument()
    })

    it('recommends nothing once every step has output', () => {
      render(
        <OverviewTab
          {...defaultProps}
          personas={[persona('p1')]}
          documents={[doc('d1', 'research'), doc('d2', 'prd')]}
          productContext={contextWith({ product_name: 'VoC' })}
        />,
      )

      expect(screen.queryByText('Next step:')).not.toBeInTheDocument()
    })
  })
})
