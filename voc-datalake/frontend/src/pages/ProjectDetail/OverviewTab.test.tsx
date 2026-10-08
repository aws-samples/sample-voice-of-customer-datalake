import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  configStoreModule, contextWith, makeProject, overviewDoc as doc, overviewPersona as persona,
} from './project-detail-fixtures'
import OverviewTab from './OverviewTab'
import { emptyProductContext } from './productContextFields'
import { EDITOR_ACCESS, VIEWER_ACCESS } from './projectAccess-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { Project, ProjectPersona } from '../../api/projectTypes'
import { required } from '../../components/component-spec-fixtures'

vi.mock('../../store/configStore', () => configStoreModule())

const mockProject: Project = makeProject({ project_id: 'proj-1' })

const noPersonas: ProjectPersona[] = []
const noDocuments: ProjectDocument[] = []

const defaultProps = {
  project: mockProject,
  personas: noPersonas,
  documents: noDocuments,
  onGeneratePersonas: vi.fn(),
  onGenerateDoc: vi.fn(),
  onRunResearch: vi.fn(),
  onRemixDocuments: vi.fn(),
  onOpenProductTool: vi.fn(),
}

/** The tab on a project where every step has produced something. */
function renderPopulatedTab() {
  return render(
    <OverviewTab
      {...defaultProps}
      personas={[persona('p1'), persona('p2'), persona('p3')]}
      documents={[doc('d1', 'research'), doc('d2', 'prd'), doc('d3', 'prfaq')]}
      productContext={contextWith({ product_name: 'VoC', one_liner: 'Feedback intelligence' })}
    />,
  )
}

/**
 * The action-card headings, in DOM order. Scoped to the card grid so the Kiro
 * export card's heading below it cannot drift into the assertion.
 */
function cardTitlesInOrder(): string[] {
  return within(screen.getByTestId('overview-cards'))
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent)
}

/** The card whose heading contains `title`, for assertions scoped to one card. */
function cardFor(title: string): HTMLElement {
  const heading = within(screen.getByTestId('overview-cards'))
    .getAllByRole('heading', { level: 2 })
    .find((h) => h.textContent.includes(title))
  const card = heading?.closest('div.card')
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
    await user.click(required(buttons.at(0), 'the first Generate button'))
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

  it('does not render Kiro Export Settings on the Overview tab (the editor was removed with Export / MCP)', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.queryByText('Kiro Export Settings')).not.toBeInTheDocument()
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
      // Prototype needs one of PRD/PR-FAQ where remix needs two documents, and it
      // produces a new artifact where remix revises existing ones — so it sits
      // between them rather than at the end.
      expect(titles).toStrictEqual([
        expect.stringContaining('Product / Service Description'),
        expect.stringContaining('Generate Personas'),
        expect.stringContaining('Run Research'),
        expect.stringContaining('Generate PRD / PR-FAQ'),
        expect.stringContaining('Clickable Prototype'),
        expect.stringContaining('Remix Documents'),
      ])
    })

    it('carries each card position in the heading, not in a parallel hidden label', () => {
      // The position is heading text, so it reaches everyone through one channel.
      // These assert the heading's full text content, which is what fails if the
      // number goes back to a decorative badge plus an aria-hidden span — the
      // number would leave the heading, and an exact match cannot miss that.
      render(<OverviewTab {...defaultProps} />)

      const titles = cardTitlesInOrder()
      expect(titles[0]).toBe('1. Product / Service Description')
      expect(titles[2]).toBe('3. Run Research')
      expect(titles[4]).toBe('5. Clickable Prototype')
      expect(titles[5]).toBe('6. Remix Documents')
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

      renderPopulatedTab()
      for (const text of populatedStates) {
        expect(screen.getByText(text)).toBeInTheDocument()
      }
    })

    it('reports what each step has produced', () => {
      renderPopulatedTab()

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
      // Scoped per card rather than counted: three cards share the string "None
      // yet", so a bare count passes while any one of them stops reporting and
      // another starts reporting twice.
      const silentCards = ['Generate Personas', 'Generate PRD / PR-FAQ', 'Clickable Prototype']
        .filter((title) => within(cardFor(title)).queryByText('None yet') === null)
      expect(silentCards).toStrictEqual([])
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
          // A prototype is now one of the recommendable steps, so "every step has
          // output" needs one — without it the recommendation correctly points at
          // the prototype and this test would be asserting the wrong thing.
          documents={[doc('d1', 'research'), doc('d2', 'prd'), doc('d3', 'prototype')]}
          productContext={contextWith({ product_name: 'VoC' })}
        />,
      )

      expect(screen.queryByText('Next step:')).not.toBeInTheDocument()
    })
  })

  // `project.access.can_edit === false` is what the server returns for a viewer
  // member of a private project. The cards stay (they report what the project
  // has); the five buttons that would open a write are disabled, and the product
  // card — which only switches tabs — is not.
  describe('for a viewer (project.access.can_edit false)', () => {
    const viewerProject: Project = { ...mockProject, access: VIEWER_ACCESS }
    const twoDocs = [doc('1', 'prd'), doc('2', 'prfaq')]

    it('disables every write card button but leaves the product card usable', () => {
      render(<OverviewTab {...defaultProps} project={viewerProject} documents={twoDocs} personas={[persona('p1')]} />)

      expect(within(cardFor('Product')).getByRole('button')).toBeEnabled()
      for (const title of ['Personas', 'Research', 'PRD', 'Prototype', 'Remix']) {
        expect(within(cardFor(title)).getByRole('button')).toBeDisabled()
      }
    })

    it('recommends no next step and promotes no card, since a viewer can take none', () => {
      // The same props recommend research to an editor (see "next step" above).
      render(
        <OverviewTab
          {...defaultProps}
          project={viewerProject}
          personas={[persona('p1')]}
          productContext={contextWith({ product_name: 'VoC' })}
        />,
      )

      expect(screen.queryByText('Next step:')).not.toBeInTheDocument()
      for (const button of within(screen.getByTestId('overview-cards')).getAllByRole('button')) {
        expect(button).not.toHaveClass('btn-primary')
      }
    })

    it('does not blame a missing document when the real reason is read-only access', () => {
      render(<OverviewTab {...defaultProps} project={viewerProject} documents={twoDocs} />)
      expect(screen.queryByText('Need at least 2 documents')).not.toBeInTheDocument()
    })

    it('keeps the two-document message for an editor with one document', () => {
      render(<OverviewTab {...defaultProps} documents={[doc('1', 'prd')]} />)
      expect(screen.getByText('Need at least 2 documents')).toBeInTheDocument()
    })
  })

  it('leaves every card button enabled for an editor (explicit can_edit true)', () => {
    const editorProject: Project = { ...mockProject, access: EDITOR_ACCESS }
    render(<OverviewTab {...defaultProps} project={editorProject} documents={[doc('1', 'prd'), doc('2', 'prfaq')]} />)
    for (const title of ['Product', 'Personas', 'Research', 'PRD', 'Prototype', 'Remix']) {
      expect(within(cardFor(title)).getByRole('button')).toBeEnabled()
    }
  })
})
