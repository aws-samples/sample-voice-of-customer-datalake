/**
 * The prototype card's optional inputs: the project's product description, its
 * research reports, and the uploaded visuals a build takes its palette from.
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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
import { MAX_SELECTED_PRODUCT_DOC_IDS } from './overviewState'
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
import type { Project, ProductContext, ProductDoc, ProjectDocument } from '../../api/types'

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

function tab(
  documents: ProjectDocument[],
  productContext?: ProductContext,
  productDocs?: ProductDoc[],
) {
  return (
    <OverviewTab
      project={project}
      personas={[]}
      documents={documents}
      productContext={productContext}
      productDocs={productDocs}
      onGeneratePersonas={vi.fn()}
      onGenerateDoc={vi.fn()}
      onRunResearch={vi.fn()}
      onRemixDocuments={vi.fn()}
      onOpenProductTool={vi.fn()}
      onJobStarted={vi.fn()}
    />
  )
}

function renderTab(
  documents: ProjectDocument[],
  productContext?: ProductContext,
  productDocs?: ProductDoc[],
) {
  return render(tab(documents, productContext, productDocs))
}

/**
 * One uploaded product doc. Defaults to a ready PNG — the only combination the
 * visual picker may offer — so every fixture below states only the way it differs.
 */
function productDoc(overrides: Partial<ProductDoc> & { doc_id: string; filename: string }): ProductDoc {
  return {
    content_type: 'image/png',
    size_bytes: 1024,
    status: 'ready',
    error: null,
    extracted_chars: 400,
    created_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

const VISUAL_A = productDoc({ doc_id: 'pd_a', filename: 'home-screen.png' })
const VISUAL_B = productDoc({ doc_id: 'pd_b', filename: 'settings-screen.png' })

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

/**
 * The visual picker. Two properties separate it from the research list above and
 * both are asserted here rather than assumed: the ids are sent with NO gating
 * boolean (the API has no `use_visuals`, so the ticked list is the whole request),
 * and only a `ready` IMAGE may be ticked — the two conditions
 * `build_visual_brief_block` applies before a visual reaches the prompt at all.
 */
describe('which uploaded visuals the build reads', () => {
  const label = (key: 'visuals' | 'visualsLimit' | 'visualsNotReady', value: number) =>
    en.documents.prototype[key].replace(/\{\{total\}\}|\{\{max\}\}/, String(value))

  it('offers the visuals immediately, with no master box to turn them on', () => {
    // There is no `use_visuals` field to hold, so a master would be UI state with
    // nothing to send it to — and a collapsed group would hide ticked ids that are
    // still being sent. The list is therefore open from the start, which is what
    // this asserts: no click, and the rows are already there.
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    expect(screen.getByText(label('visuals', 2))).toBeInTheDocument()
    expect(screen.getByTestId('prototype-visual-list')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'home-screen.png' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'settings-screen.png' })).toBeInTheDocument()
  })

  it('sends the ticked ids in the order they were ticked', async () => {
    // Order is precedence: the generator's prompt prefers the first visual where
    // two disagree, so B-then-A must arrive as B, A and not in option order.
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    await user.click(screen.getByRole('checkbox', { name: 'settings-screen.png' }))
    await user.click(screen.getByRole('checkbox', { name: 'home-screen.png' }))
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toEqual(['pd_b', 'pd_a'])
  })

  it('sends no visual ids when none is ticked, and still builds', async () => {
    // The positive control. Without it, "sends the ticked visuals" is
    // indistinguishable from "always sends every visual", and the request every
    // existing caller makes would be free to change.
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toEqual([])
    expect(screen.getByText(en.documents.prototype.started)).toBeInTheDocument()
  })

  it('offers only ready images, and says how many are still being processed', async () => {
    // A text upload is not a visual at all — it reaches the prompt through the
    // product-context box — so it is absent without comment. An image that is
    // still extracting has no description yet, so it cannot be ticked, but it
    // WAS uploaded: silence there reads as a lost file.
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, [
      VISUAL_A,
      productDoc({ doc_id: 'pd_text', filename: 'notes.md', content_type: 'text/markdown' }),
      productDoc({ doc_id: 'pd_wip', filename: 'wip.png', status: 'extracting', extracted_chars: 0 }),
    ])

    expect(screen.getByRole('checkbox', { name: 'home-screen.png' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'notes.md' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'wip.png' })).not.toBeInTheDocument()
    // The count in the heading counts what is SELECTABLE, not what was uploaded.
    expect(screen.getByText(label('visuals', 1))).toBeInTheDocument()
    expect(screen.getByText(label('visualsNotReady', 1))).toBeInTheDocument()
  })

  it('renders nothing about visuals for a project with no image uploads', () => {
    // A text-only upload must not produce an empty visuals section: a group whose
    // only possible contribution is nothing is an invitation to a no-op, the same
    // rule the research box follows.
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, [
      productDoc({ doc_id: 'pd_text', filename: 'notes.md', content_type: 'text/markdown' }),
    ])

    expect(screen.queryByTestId('prototype-visual-sources')).not.toBeInTheDocument()
  })

  it('refuses one visual past the bound and says what the bound is', async () => {
    // The API rejects an over-long list, and its 400 arrives after the choice is
    // made and names no mockup to give up. Built one over the live bound so it
    // keeps testing whatever that number becomes.
    const user = userEvent.setup()
    const many = Array.from(
      { length: MAX_SELECTED_PRODUCT_DOC_IDS + 1 },
      (_, i) => productDoc({ doc_id: `pd_${i}`, filename: `screen-${i}.png` }),
    )
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, many)

    for (const option of many.slice(0, MAX_SELECTED_PRODUCT_DOC_IDS)) {
      await user.click(screen.getByRole('checkbox', { name: option.filename }))
    }
    const overBound = screen.getByRole('checkbox', { name: many[MAX_SELECTED_PRODUCT_DOC_IDS].filename })
    expect(overBound).toBeDisabled()
    expect(screen.getByText(label('visualsLimit', MAX_SELECTED_PRODUCT_DOC_IDS))).toBeInTheDocument()

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toHaveLength(MAX_SELECTED_PRODUCT_DOC_IDS)
    expect(sentBody().selected_product_doc_ids).not.toContain(`pd_${MAX_SELECTED_PRODUCT_DOC_IDS}`)
  })

  it('refuses an over-bound tick that reaches the hook past the disabled box', async () => {
    // The bound has two independent guards — the `disabled` attribute above and a
    // refusal inside `onToggleVisualId` — and the first one masks the second from
    // any test that clicks. Verified by mutation: with the hook's guard deleted,
    // every other test here still passes, and so does the research equivalent it
    // was copied from. A dispatched change event is the smallest way to reach the
    // handler as a programmatic or assistive-tech path could, and it is what makes
    // the second guard load-bearing rather than decorative.
    const user = userEvent.setup()
    const many = Array.from(
      { length: MAX_SELECTED_PRODUCT_DOC_IDS + 1 },
      (_, i) => productDoc({ doc_id: `pd_${i}`, filename: `screen-${i}.png` }),
    )
    renderTab([PRD, PRFAQ], FILLED_CONTEXT, many)

    for (const option of many.slice(0, MAX_SELECTED_PRODUCT_DOC_IDS)) {
      await user.click(screen.getByRole('checkbox', { name: option.filename }))
    }
    fireEvent.click(screen.getByRole('checkbox', { name: `screen-${MAX_SELECTED_PRODUCT_DOC_IDS}.png` }))
    fireEvent.change(
      screen.getByRole('checkbox', { name: `screen-${MAX_SELECTED_PRODUCT_DOC_IDS}.png` }),
      { target: { checked: true } },
    )
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toHaveLength(MAX_SELECTED_PRODUCT_DOC_IDS)
  })

  it('drops a visual deleted between the tick and the click', async () => {
    // The doc list refetches on mount and focus, and the Product tab can delete an
    // upload while this card is open. Sending its id would be a 4xx — someone
    // else's deletion becoming this build's failure. The `mockBuildPrototype`
    // assertion alone would pass without the filter, so the surviving id is
    // asserted too.
    const user = userEvent.setup()
    const { rerender } = renderTab([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    await user.click(screen.getByRole('checkbox', { name: 'settings-screen.png' }))
    await user.click(screen.getByRole('checkbox', { name: 'home-screen.png' }))
    rerender(tab([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A]))
    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toEqual(['pd_a'])
  })
})

describe('a card that cannot act offers no choices', () => {
  it('renders no tick-boxes on a project with no PRD and no PR-FAQ', () => {
    // The fixture the rest of this suite never had: research and a filled product
    // context, so there IS something to offer, and no PRD or PR-FAQ, so the card is
    // disabled and nothing can be built. Choices above a dead button read as an
    // offer — the user ticks them, then reads that they must create a document
    // first. Every other fixture here passes whether or not the gate exists.
    renderTab([RESEARCH_A], FILLED_CONTEXT)

    expect(buildButton()).toBeDisabled()
    expect(screen.getByText(en.documents.prototype.needsDocs)).toBeInTheDocument()
    expect(screen.queryByTestId('prototype-extra-sources')).not.toBeInTheDocument()
    // Asserted on the roles too, not just the container: a gate that kept the
    // wrapper and hid its contents would leave the box focusable.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('offers them again as soon as one document exists', () => {
    // The other half, from the same fixture one document later: the gate must be
    // the disabled state and not something that hides the controls outright.
    renderTab([PRD, RESEARCH_A], FILLED_CONTEXT)

    expect(buildButton()).toBeEnabled()
    expect(screen.getByTestId('prototype-extra-sources')).toBeInTheDocument()
  })
})

describe('two similarly-named reports are distinguishable', () => {
  it('gives each report title a tooltip carrying the full string', async () => {
    // The titles are `truncate`d in a narrow column, so two reports named
    // "Churn interviews Q1"/"Q2" render as the same visible string. A screen
    // reader gets the full label either way; a sighted mouse user has only this.
    const user = userEvent.setup()
    renderTab([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())

    expect(screen.getByTitle('Churn interviews')).toBeInTheDocument()
    expect(screen.getByTitle('Pricing survey')).toBeInTheDocument()
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
    expect(prototype.visuals).toContain('{{total}}')
    expect(prototype.visualsLimit).toContain('{{max}}')
    expect(prototype.visualsNotReady).toContain('{{total}}')
  })

  it.each([
    ['de', de], ['es', es], ['fr', fr],
    ['ja', ja], ['ko', ko], ['pt', pt], ['zh', zh],
  ])('translates the visual labels rather than copying English in %s', (_locale, catalogue) => {
    // The i18n gate counts a value identical to English as `untranslated`, and a
    // key present in seven catalogues and absent from the eighth as `missing` —
    // both of which are invisible to anyone running the suite under `en`. The
    // count assertion above proves the key exists; this proves it was translated.
    expect(catalogue.documents.prototype.visuals).not.toBe(en.documents.prototype.visuals)
    expect(catalogue.documents.prototype.visualsLimit).not.toBe(en.documents.prototype.visualsLimit)
    expect(catalogue.documents.derivation.visualsUsed_other)
      .not.toBe(en.documents.derivation.visualsUsed_other)
  })
})
