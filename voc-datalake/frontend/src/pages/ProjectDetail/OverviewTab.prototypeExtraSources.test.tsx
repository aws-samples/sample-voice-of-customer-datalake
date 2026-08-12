/**
 * The prototype card's two optional inputs: the project's product description
 * and its research reports.
 *
 * Where the controls live is the property under test, not a detail.
 * `confirmKeyFor` in `usePrototypeBuild` deliberately opens NO dialog for a
 * project with one PRD, one PR-FAQ and no prototype — the build starts on the
 * first click — and the source picker lives inside that dialog. So the fixture
 * that matters here is precisely that project: a control placed in the dialog is
 * unreachable for it, and no other fixture shows that.
 *
 * `t()` resolves against the real en catalogue (src/test/setup.ts), so a key that
 * is missing or has moved renders its raw path and these matchers fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
import { emptyProductContext } from './productContextFields'
// All eight catalogues, imported statically so a locale cannot be skipped the way
// a dynamic path could — same shape as components/DataSourceWizard/localization.test.tsx.
import de from '../../../public/locales/de/projectDetail.json'
import en from '../../../public/locales/en/projectDetail.json'
import es from '../../../public/locales/es/projectDetail.json'
import fr from '../../../public/locales/fr/projectDetail.json'
import ja from '../../../public/locales/ja/projectDetail.json'
import ko from '../../../public/locales/ko/projectDetail.json'
import pt from '../../../public/locales/pt/projectDetail.json'
import zh from '../../../public/locales/zh/projectDetail.json'
import type { Project, ProductContext, ProjectDocument } from '../../api/types'

const mockBuildPrototype = vi.fn()
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    buildPrototype: (...args: unknown[]) => mockBuildPrototype(...args),
  },
}))

const project: Project = {
  project_id: 'proj_1',
  name: 'Test project',
  description: '',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  persona_count: 0,
  document_count: 0,
}

function doc(
  documentType: ProjectDocument['document_type'],
  id: string,
  title: string,
  createdAt: string,
): ProjectDocument {
  return { document_id: id, document_type: documentType, title, content: 'x', created_at: createdAt }
}

const PRD = doc('prd', 'prd_1', 'Delivery spec', '2026-01-01T00:00:00Z')
const PRFAQ = doc('prfaq', 'prfaq_1', 'Launch note', '2026-02-01T00:00:00Z')
const RESEARCH_A = doc('research', 'research_a', 'Churn interviews', '2026-03-01T00:00:00Z')
const RESEARCH_B = doc('research', 'research_b', 'Pricing survey', '2026-04-01T00:00:00Z')

/** Exactly one filled field — enough to be non-empty, few enough to stay honest. */
const FILLED_CONTEXT: ProductContext = { ...emptyProductContext(), one_liner: 'A console for wombats' }

function tab(documents: ProjectDocument[], productContext?: ProductContext) {
  return (
    <OverviewTab
      project={project}
      personas={[]}
      documents={documents}
      productContext={productContext}
      onGeneratePersonas={vi.fn()}
      onGenerateDoc={vi.fn()}
      onRunResearch={vi.fn()}
      onRemixDocuments={vi.fn()}
      onOpenProductTool={vi.fn()}
      onJobStarted={vi.fn()}
    />
  )
}

function renderTab(documents: ProjectDocument[], productContext?: ProductContext) {
  return render(tab(documents, productContext))
}

const buildButton = () => screen.getByRole('button', { name: /build prototype/i })
const productContextBox = () => screen.getByRole('checkbox', { name: /product \/ service description/i })
const researchBox = () => screen.getByRole('checkbox', { name: /research reports/i })
const sentBody = () => mockBuildPrototype.mock.calls[0][1]

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
})

describe('the controls are reachable without a dialog', () => {
  it('offers both tick-boxes on a project with one PRD, one PR-FAQ and no prototype', async () => {
    // The one project that opens no confirm dialog at all. A control placed inside
    // ConfirmModal is invisible here, and every other fixture in this suite would
    // still pass.
    renderTab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    expect(screen.getByTestId('prototype-extra-sources')).toBeInTheDocument()
    expect(productContextBox()).toBeInTheDocument()
    expect(researchBox()).toBeInTheDocument()
    // No dialog was needed to get here.
    expect(screen.queryByTestId('prototype-source-picker')).not.toBeInTheDocument()
  })

  it('sends what was ticked on that same one-click project', async () => {
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    await user.click(productContextBox())
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().use_product_context).toBe(true)
  })

  it('sends both flags off when nothing is ticked', async () => {
    // The request every existing caller makes. Off must stay off, or the feature
    // changes builds nobody asked it to.
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().use_product_context).toBe(false)
    expect(sentBody().use_research).toBe(false)
    expect(sentBody().selected_research_ids).toEqual([])
  })

  it('offers no research box when the project has no research', () => {
    // A box whose only possible contribution is an empty section is an invitation
    // to a no-op — the same reason `SourceRow` renders nothing for a type the
    // project has none of.
    renderTab([PRD, PRFAQ], FILLED_CONTEXT)

    expect(screen.queryByRole('checkbox', { name: /research reports/i })).not.toBeInTheDocument()
    expect(productContextBox()).toBeInTheDocument()
  })
})

describe('which research reports the build reads', () => {
  it('ticking research selects every report on offer', async () => {
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().use_research).toBe(true)
    // Newest first, matching the order `overviewState` derives and the backend's
    // own newest-of-type rule.
    expect(sentBody().selected_research_ids).toEqual(['research_b', 'research_a'])
  })

  it('sends only the reports left ticked', async () => {
    // The feature: choose the research, rather than take all of it. Nothing else
    // here fails if the per-report boxes are ignored.
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())
    await user.click(screen.getByRole('checkbox', { name: 'Pricing survey' }))
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_research_ids).toEqual(['research_a'])
  })

  it('drops a report that is deleted between the tick and the click', async () => {
    // The document list refetches whenever a job completes, so a report can
    // disappear under an open card. Sending its id would be a 4xx — someone else's
    // deletion becoming this build's failure. Found by mutation: without a
    // re-render in the fixture, the filter that prevents it has no test at all.
    const user = userEvent.setup()
    const { rerender } = renderTab([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())
    rerender(tab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT))
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_research_ids).toEqual(['research_a'])
  })

  it('unticking research sends no ids at all', async () => {
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    await user.click(researchBox())
    await user.click(researchBox())
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().use_research).toBe(false)
    expect(sentBody().selected_research_ids).toEqual([])
    expect(screen.queryByTestId('prototype-research-list')).not.toBeInTheDocument()
  })
})

describe('the card no longer presents PRD/PR-FAQ as the whole input list', () => {
  it('states the optional inputs on an enabled card for a project that has them', () => {
    // The fixture matters twice over: with no research there would be nothing to
    // omit, so "states the omission" would be indistinguishable from "there was
    // nothing to omit" — and a DISABLED card renders
    // `documents.prototype.needsDocs` instead of this description, so the
    // assertion would pass for the wrong reason.
    renderTab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    expect(buildButton()).toBeEnabled()
    expect(screen.getByText(en.overview.prototypeDesc)).toBeInTheDocument()
    expect(en.overview.prototypeDesc).toMatch(/product description/i)
    expect(en.overview.prototypeDesc).toMatch(/research/i)
  })

  it.each([
    ['de', de], ['en', en], ['es', es], ['fr', fr],
    ['ja', ja], ['ko', ko], ['pt', pt], ['zh', zh],
  ])('names no document type as the exhaustive input list in %s', (_locale, catalogue) => {
    // Language-independent on purpose: every catalogue kept the Latin "PRD /
    // PR-FAQ" verbatim in the old sentence, so naming either is the tell that a
    // catalogue was left behind — and it is the one assertion that works for all
    // eight without asserting on a translation's wording.
    expect(catalogue.overview.prototypeDesc).not.toMatch(/PRD|PR.?FAQ/i)
    expect(catalogue.overview.prototypeDesc).not.toBe('')
  })

  it.each([
    ['de', de], ['en', en], ['es', es], ['fr', fr],
    ['ja', ja], ['ko', ko], ['pt', pt], ['zh', zh],
  ])('carries the new control labels in %s', (_locale, catalogue) => {
    // A catalogue missing one of these renders the raw key path in that language —
    // visible to a user of that locale, and to nobody running the tests under `en`.
    const prototype = catalogue.documents.prototype
    expect(prototype.extraSources).toBeTruthy()
    expect(prototype.useProductContext).toBeTruthy()
    expect(prototype.useResearch).toContain('{{total}}')
    expect(prototype.researchLimit).toContain('{{max}}')
  })
})
