/**
 * @fileoverview Pins the "Export / MCP" tab's two-card structure and its i18n wiring.
 *
 * Two gaps this closes, both of which let a regression through silently:
 *
 * 1. STRUCTURE. An earlier revision rendered the export-prompt template editor as
 *    a THIRD sibling card, splitting the token-free Export grouping in two. Every
 *    existing test passed both before and after it was nested, so nothing
 *    distinguished the two layouts. These tests fail if it becomes a sibling again.
 *
 * 2. LOCALE. Every other test in this folder runs under `en`, where a hardcoded
 *    literal and its translation are the same string — so an en-only suite cannot
 *    fail on unwired i18n. The `de` test asserts German catalogue values reach the
 *    DOM, and reads them FROM the shipped catalogue so rewording a translation
 *    does not break the test; only unwiring a component does.
 */
import {
  describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach,
} from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import McpAccessTab from './McpAccessTab'
import { canCopyExport } from './autoseedSelection'
import deProjectDetail from '../../../public/locales/de/projectDetail.json'
import enProjectDetail from '../../../public/locales/en/projectDetail.json'
import type { Project, ProjectPersona, ProjectDocument } from '../../api/types'

const mockListApiTokens = vi.fn()
const mockAutoseedProject = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    listApiTokens: (...args: unknown[]) => mockListApiTokens(...args),
    createApiToken: vi.fn(),
    deleteApiToken: vi.fn(),
    autoseedProject: (...args: unknown[]) => mockAutoseedProject(...args),
  },
}))

vi.mock('../../api/baseUrl', () => ({
  stripTrailingSlashes: (url: string) => url.replace(/\/$/, ''),
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com/v1' } }),
}))

const mockProject: Project = {
  project_id: 'proj-123',
  name: 'Test Project',
  description: 'A test project',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  persona_count: 0,
  document_count: 0,
}

/** The card wrapper this tab uses for both cards. */
const CARD_SELECTOR = 'div.bg-white.rounded-xl'

const onePersona: ProjectPersona[] = [{
  persona_id: 'p1', name: 'Persona A', tagline: 'Tag A', created_at: '',
}]

const oneDocument: ProjectDocument[] = [{
  document_id: 'd1', title: 'Doc A', document_type: 'prd', content: '', created_at: '',
}]

function renderTab(
  personas: ProjectPersona[] = onePersona,
  documents: ProjectDocument[] = [],
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <McpAccessTab
        projectId="proj-123"
        project={mockProject}
        personas={personas}
        documents={documents}
        onSaveKiroPrompt={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

/** Nearest enclosing card, as an assertable element rather than a bare null. */
function cardContaining(element: HTMLElement): Element {
  const card = element.closest(CARD_SELECTOR)
  if (card === null) {
    throw new Error(`no ${CARD_SELECTOR} ancestor — card chrome changed`)
  }
  return card
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListApiTokens.mockResolvedValue({ tokens: [] })
})

/**
 * Empties the PERSONAS section only.
 *
 * Both sections must be populated and only one emptied, because with no documents
 * the old OR-based rule and the correct rule agree — a test using `renderTab()`
 * alone passes against the bug, which mutation testing caught. The personas
 * section renders first, hence [0].
 */
const deselectAllPersonas = () => screen.getAllByRole('button', {
  name: enProjectDetail.autoseed.deselectAll,
})[0]

describe('McpAccessTab — two-card structure', () => {
  it('renders the template editor inside the Export card, not as a separate card', async () => {
    const { container } = renderTab()

    const exportHeading = await screen.findByRole('heading', {
      level: 3, name: enProjectDetail.export.title,
    })
    const templateHeading = screen.getByRole('heading', {
      level: 4, name: enProjectDetail.kiroExport.title,
    })

    // The assertion that fails if the editor goes back to being a sibling card.
    expect(cardContaining(templateHeading)).toBe(cardContaining(exportHeading))
    expect(container.querySelectorAll(CARD_SELECTOR)).toHaveLength(2)

    // `mockProject` carries no kiro_export_prompt, so this render exercises
    // KiroExportSettings' EmptyState branch. Pinned by SHARED WRAPPER rather
    // than by the global card count above: this fails specifically if EmptyState
    // grows its own card chrome, where a count assertion would only catch it
    // once the total happened to drift.
    const emptyState = screen.getByText(enProjectDetail.kiroExport.noPrompt)
    expect(cardContaining(emptyState)).toBe(cardContaining(exportHeading))
  })

  it('keeps the MCP card separate from the Export card', async () => {
    renderTab()

    const exportHeading = await screen.findByRole('heading', {
      level: 3, name: enProjectDetail.export.title,
    })
    const mcpHeading = screen.getByRole('heading', {
      level: 3, name: enProjectDetail.mcp.title,
    })

    expect(cardContaining(mcpHeading)).not.toBe(cardContaining(exportHeading))
  })

  it('shows the template editor even when the project has no personas or documents', async () => {
    renderTab([])

    // The template feeds Card 2's autoseed payload too, so an empty project must
    // still expose the only editor for it.
    expect(
      await screen.findByRole('heading', { level: 4, name: enProjectDetail.kiroExport.title }),
    ).toBeInTheDocument()
  })
})

describe('McpAccessTab — renders translated copy under de', () => {
  beforeAll(async () => {
    i18n.addResourceBundle('de', 'projectDetail', deProjectDetail)
    await i18n.changeLanguage('de')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders both card headings and the template section from the German catalogue', async () => {
    renderTab()

    expect(await screen.findByRole('heading', {
      level: 3, name: deProjectDetail.export.title,
    })).toBeInTheDocument()
    expect(screen.getByRole('heading', {
      level: 3, name: deProjectDetail.mcp.title,
    })).toBeInTheDocument()
    expect(screen.getByRole('heading', {
      level: 4, name: deProjectDetail.kiroExport.title,
    })).toBeInTheDocument()
  })

})

describe('canCopyExport — a non-empty section with nothing selected is unsendable', () => {
  // The rule exists because the autoseed API cannot express "none": an absent
  // persona_ids is read as ALL, so exporting with zero selected would ship the
  // items the user just deselected. These cases pin that reasoning.
  const ids = (...v: string[]) => new Set(v)

  it('allows the default state where everything is selected', () => {
    expect(canCopyExport(ids('p1'), 1, ids('d1'), 1)).toBe(true)
  })

  it('allows a strict subset in one section while the other is full', () => {
    expect(canCopyExport(ids('p1'), 2, ids('d1'), 1)).toBe(true)
  })

  it('refuses when personas exist but none are selected, even if a document is', () => {
    // The exact bug: this state used to leave the button enabled and export
    // every persona, because the filter was omitted rather than sent empty.
    expect(canCopyExport(ids(), 2, ids('d1'), 1)).toBe(false)
  })

  it('refuses when documents exist but none are selected, even if a persona is', () => {
    expect(canCopyExport(ids('p1'), 1, ids(), 3)).toBe(false)
  })

  it('ignores a section that has no items at all', () => {
    expect(canCopyExport(ids('p1'), 1, ids(), 0)).toBe(true)
    expect(canCopyExport(ids(), 0, ids('d1'), 1)).toBe(true)
  })

  it('refuses when the project has nothing to export', () => {
    expect(canCopyExport(ids(), 0, ids(), 0)).toBe(false)
  })
})

describe('McpAccessTab — export guard is enforced in the UI', () => {
  it('disables the copy button and says why once a whole section is deselected', async () => {
    renderTab(onePersona, oneDocument)
    const user = userEvent.setup()

    const copyButton = await screen.findByRole('button', {
      name: new RegExp(enProjectDetail.export.copyContext, 'i'),
    })
    expect(copyButton).toBeEnabled()

    // Deselect every persona while the document stays selected: the state whose
    // request would omit persona_ids and therefore mean "all personas".
    await user.click(deselectAllPersonas())

    expect(copyButton).toBeDisabled()
    expect(screen.getByText(enProjectDetail.export.selectAtLeastOne)).toBeInTheDocument()
  })

  it('does not call the autoseed API while a whole section is deselected', async () => {
    renderTab(onePersona, oneDocument)
    const user = userEvent.setup()

    await user.click(deselectAllPersonas())
    await user.click(await screen.findByRole('button', {
      name: new RegExp(enProjectDetail.export.copyContext, 'i'),
    }))

    // The billable/data-scope guard: nothing may be fetched or copied in a state
    // whose request would silently mean "everything".
    expect(mockAutoseedProject).not.toHaveBeenCalled()
  })
})

describe('McpAccessTab — Card 2 hides the curl snippet when it would mean "everything"', () => {
  it('suppresses the autoseed prompt, not just its copy button, once a section is emptied', async () => {
    renderTab(onePersona, oneDocument)
    const user = userEvent.setup()

    // Expand Kiro Autoseed so the snippet is on screen to begin with.
    await user.click(await screen.findByText(enProjectDetail.autoseed.title))
    expect(screen.getByText(enProjectDetail.autoseed.pasteHint)).toBeInTheDocument()

    await user.click(deselectAllPersonas())

    // Disabling the button is not enough: the rendered curl omits persona_ids,
    // which the API reads as "all", and text on screen can be selected by hand.
    expect(screen.queryByText(enProjectDetail.autoseed.pasteHint)).not.toBeInTheDocument()
    expect(screen.queryByText(/curl -s/)).not.toBeInTheDocument()
  })
})

describe('McpAccessTab — the export copy writes to the clipboard exactly once', () => {
  it('does not write twice when reporting the copy as done', async () => {
    // useCopyToClipboard.copy() writes internally. Both copy handlers await their
    // OWN writeText so a rejection can be surfaced, so they must use the
    // state-only markCopied(); calling copy() as well wrote a second time and
    // swallowed that second rejection with `void`.
    // Spy on the existing clipboard rather than stubbing `navigator` wholesale:
    // the global setup installs its mock with defineProperty ON navigator, and
    // replacing the whole object does not reliably reach the component in jsdom.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    mockAutoseedProject.mockResolvedValue({
      project: { name: 'p', description: '' },
      files: [{ path: '.kiro/steering/p.md', content: 'body' }],
    })

    renderTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', {
      name: new RegExp(enProjectDetail.export.copyContext, 'i'),
    }))

    await screen.findByText(enProjectDetail.export.copyCopied)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('body')
  })

  afterEach(() => {
    // Restore unconditionally so a failure above cannot leak the spy.
    vi.restoreAllMocks()
  })
})

describe('McpAccessTab — autoseed group labels resolve', () => {
  it('renders a translated document-type group heading, not a raw key path', async () => {
    // McpAccessTab builds this key as a TEMPLATE LITERAL, which the i18n gate's
    // extractor cannot see — so the gate can neither confirm the reference nor
    // catch a deletion. A render assertion is the only check that would fail.
    // Needs a document: the group heading is per document-type.
    renderTab(onePersona, oneDocument)

    expect(await screen.findByText(enProjectDetail.autoseed.docTypes.prd)).toBeInTheDocument()
    expect(screen.queryByText(/autoseed\.docTypes\./)).not.toBeInTheDocument()
  })
})

describe('projectDetail catalogue — export labels are translated, not copied', () => {
  // Renders nothing on purpose: this is a catalogue guard, not a component test,
  // so it lives in its own describe rather than under "renders translated copy".
  // It pins the i18n gate's finding — both values were byte-identical to English
  // in all 7 non-en catalogues, which the gate rejects and has no allowlist for.
  // If a locale ever legitimately shares a word with English, drop that locale
  // from this guard rather than weakening it for all of them.
  it('gives de its own wording for the Export card title and the tab label', () => {
    expect(deProjectDetail.export.title).not.toBe(enProjectDetail.export.title)
    expect(deProjectDetail.tabs.mcpAccess).not.toBe(enProjectDetail.tabs.mcpAccess)
  })
})
