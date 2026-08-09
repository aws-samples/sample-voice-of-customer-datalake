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
  describe, it, expect, vi, beforeAll, afterAll, beforeEach,
} from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import McpAccessTab from './McpAccessTab'
import deProjectDetail from '../../../public/locales/de/projectDetail.json'
import enProjectDetail from '../../../public/locales/en/projectDetail.json'
import type { Project, ProjectPersona } from '../../api/types'

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

function renderTab(personas: ProjectPersona[] = onePersona) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <McpAccessTab
        projectId="proj-123"
        project={mockProject}
        personas={personas}
        documents={[]}
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
    // KiroExportSettings' EmptyState branch — stated explicitly so the card
    // count above is known to cover that path rather than only the preview one.
    expect(screen.getByText(enProjectDetail.kiroExport.noPrompt)).toBeInTheDocument()
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
