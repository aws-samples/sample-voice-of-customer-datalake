/**
 * The prototype card's optional inputs: the project's product description, its
 * research reports, and the uploaded visuals a build takes its palette from.
 *
 * Where the controls live is the property under test, not a detail.
 * `warningKeyFor` in `usePrototypeBuild` deliberately opens NO dialog for a
 * project with one PRD, one PR-FAQ and no prototype — the build starts on the
 * first click — and the source picker lives inside that dialog. So the fixture
 * that matters here is precisely that project: a control placed in the dialog is
 * unreachable for it, and no other fixture shows that.
 *
 * `t()` resolves against the real en catalogue (src/test/setup.ts), so a key that
 * is missing or has moved renders its raw path and these matchers fail.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
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

/** The card only — for the two assertions that are about the card, not the panel. */
function renderCard(
  documents: ProjectDocument[],
  productContext?: ProductContext,
  productDocs?: ProductDoc[],
) {
  return render(tab(documents, productContext, productDocs))
}

/**
 * The card, with the build wizard opened — where these controls now live.
 *
 * `fireEvent` rather than `userEvent` for this one click, deliberately: it is
 * synchronous, so every test below keeps the signature it had when the controls
 * were on the card face. `userEvent.click` returns a promise, and a test that
 * forgot to await it would assert against a panel that had not opened yet — a
 * failure mode that looks like the feature being broken.
 */
function renderWizard(
  documents: ProjectDocument[],
  productContext?: ProductContext,
  productDocs?: ProductDoc[],
) {
  const result = render(tab(documents, productContext, productDocs))
  // Resolved through i18n rather than hardcoded English: one test in this file
  // switches the catalogue to German, and a hardcoded name would fail there with
  // "cannot find the button" — a message that points at the card rather than at the
  // query.
  // Matched as a SUBSTRING of the accessible name, not equal to it: the card carries
  // the "Configure & " prefix its five siblings have, and the panel's own submit is
  // the bare verb. Anchoring here would break on the prefix; using the bare verb
  // keeps this locale-independent, and the card is the only match while the panel is
  // still closed.
  fireEvent.click(screen.getByRole('button', {
    name: new RegExp(i18n.t('documents.prototype.button', { ns: 'projectDetail' }), 'i'),
  }))
  return result
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
/** Extraction has not finished — it will, so the note asks for patience. */
const VISUAL_EXTRACTING = productDoc({
  doc_id: 'pd_wip', filename: 'wip.png', status: 'extracting', extracted_chars: 0,
})
/** Extraction failed — it will never finish, so the note has to ask for an upload. */
const VISUAL_FAILED = productDoc({
  doc_id: 'pd_bad',
  filename: 'broken.png',
  status: 'failed',
  extracted_chars: 0,
  error: 'Extraction failed',
})

/** One visual label from the real en catalogue, with its count interpolated. */
const label = (
  key: 'visuals' | 'visualsLimit' | 'visualsNotReady' | 'visualsFailed',
  value: number,
) => en.documents.prototype[key].replace(/\{\{total\}\}|\{\{max\}\}/, String(value))

/**
 * A note's wording WITHOUT its count, for asserting the line is absent whatever
 * number it would have carried.
 *
 * The exact string is the right assertion for presence — the count is half of what
 * the line says — but the wrong one for absence: `not.toBeInTheDocument` on
 * "1 failed…" also passes while the code renders "2 failed…", which is exactly the
 * kind of off-by-a-fixture pass these two counts can produce.
 */
const noteStem = (key: 'visualsNotReady' | 'visualsFailed') =>
  en.documents.prototype[key].replace('{{total}}', '').trim()

/** Everything the visual group says, as one string. */
const visualNotes = () => screen.getByTestId('prototype-visual-sources').textContent ?? ''

/** The card's button. It opens the wizard; it no longer starts anything. */
const buildButton = () => screen.getByRole('button', { name: /configure & build prototype/i })
/**
 * The wizard's own submit — the only control that spends money.
 *
 * Scoped to the dialog rather than matched by label alone, so this cannot silently
 * start resolving to the card's button if either label changes.
 */
const startBuild = () => within(screen.getByRole('dialog'))
  .getByRole('button', { name: en.documents.prototype.button })
const productContextBox = () => screen.getByRole('checkbox', { name: /product \/ service description/i })
const researchBox = () => screen.getByRole('checkbox', { name: /research reports/i })
const sentBody = () => mockBuildPrototype.mock.calls[0][1]

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
})

/**
 * This block used to be called "the controls are reachable without a dialog", and
 * that property is deliberately gone — the configuration moved into the wizard, and
 * its replacement ("reachable for EVERY project, including the one that previously
 * opened nothing") lives in `OverviewTab.prototypeWizard.test.tsx`, which is where
 * the placement is now pinned. What stays here is what the controls DO.
 */
describe('what the optional inputs send', () => {
  it('offers both tick-boxes on a project with one PRD, one PR-FAQ and no prototype', async () => {
    // Still the fixture worth naming: this is the project that used to open no
    // dialog at all, so it is the one a placement regression would strand.
    renderWizard([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    expect(screen.getByTestId('prototype-extra-sources')).toBeInTheDocument()
    expect(productContextBox()).toBeInTheDocument()
    expect(researchBox()).toBeInTheDocument()
    // And the pickers are its neighbours now, not a separate dialog's content.
    expect(screen.getByTestId('prototype-source-picker')).toBeInTheDocument()
  })

  it('sends what was ticked on that same project', async () => {
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    await user.click(productContextBox())
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().use_product_context).toBe(true)
  })

  it('sends both flags off when nothing is ticked', async () => {
    // The request every existing caller makes. Off must stay off, or the feature
    // changes builds nobody asked it to.
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().use_product_context).toBe(false)
    expect(sentBody().use_research).toBe(false)
    expect(sentBody().selected_research_ids).toEqual([])
  })

  it('offers no research box when the project has no research', () => {
    // A box whose only possible contribution is an empty section is an invitation
    // to a no-op — the same reason `SourceRow` renders nothing for a type the
    // project has none of.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT)

    expect(screen.queryByRole('checkbox', { name: /research reports/i })).not.toBeInTheDocument()
    expect(productContextBox()).toBeInTheDocument()
  })
})

describe('which research reports the build reads', () => {
  it('ticking research selects every report on offer', async () => {
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())
    await user.click(startBuild())

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
    renderWizard([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())
    await user.click(screen.getByRole('checkbox', { name: 'Pricing survey' }))
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_research_ids).toEqual(['research_a'])
  })

  it('drops a report that is deleted between the tick and the click', async () => {
    // The document list refetches whenever a job completes, so a report can
    // disappear under an open card. Sending its id would be a 4xx — someone else's
    // deletion becoming this build's failure. Found by mutation: without a
    // re-render in the fixture, the filter that prevents it has no test at all.
    const user = userEvent.setup()
    const { rerender } = renderWizard([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

    await user.click(researchBox())
    rerender(tab([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT))
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_research_ids).toEqual(['research_a'])
  })

  it('unticking research sends no ids at all', async () => {
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

    await user.click(researchBox())
    await user.click(researchBox())
    await user.click(startBuild())

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
  it('offers the visuals immediately, with no master box to turn them on', () => {
    // There is no `use_visuals` field to hold, so a master would be UI state with
    // nothing to send it to — and a collapsed group would hide ticked ids that are
    // still being sent. The list is therefore open from the start, which is what
    // this asserts: no click, and the rows are already there.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    expect(screen.getByText(label('visuals', 2))).toBeInTheDocument()
    expect(screen.getByTestId('prototype-visual-list')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'home-screen.png' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'settings-screen.png' })).toBeInTheDocument()
  })

  it('sends the ticked ids in the order they were ticked', async () => {
    // Order is precedence: the generator's prompt prefers the first visual where
    // two disagree, so B-then-A must arrive as B, A and not in option order.
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    await user.click(screen.getByRole('checkbox', { name: 'settings-screen.png' }))
    await user.click(screen.getByRole('checkbox', { name: 'home-screen.png' }))
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toEqual(['pd_b', 'pd_a'])
  })

  it('sends no visual ids when none is ticked, and still builds', async () => {
    // The positive control. Without it, "sends the ticked visuals" is
    // indistinguishable from "always sends every visual", and the request every
    // existing caller makes would be free to change.
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toEqual([])
    expect(screen.getByText(en.documents.prototype.started)).toBeInTheDocument()
  })

  it('offers only ready images, and says how many are still being processed', async () => {
    // A text upload is not a visual at all — it reaches the prompt through the
    // product-context box — so it is absent without comment. An image that is
    // still extracting has no description yet, so it cannot be ticked, but it
    // WAS uploaded: silence there reads as a lost file.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [
      VISUAL_A,
      productDoc({ doc_id: 'pd_text', filename: 'notes.md', content_type: 'text/markdown' }),
      VISUAL_EXTRACTING,
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
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [
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
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, many)

    for (const option of many.slice(0, MAX_SELECTED_PRODUCT_DOC_IDS)) {
      await user.click(screen.getByRole('checkbox', { name: option.filename }))
    }
    const overBound = screen.getByRole('checkbox', { name: many[MAX_SELECTED_PRODUCT_DOC_IDS].filename })
    expect(overBound).toBeDisabled()
    expect(screen.getByText(label('visualsLimit', MAX_SELECTED_PRODUCT_DOC_IDS))).toBeInTheDocument()

    await user.click(startBuild())

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
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, many)

    for (const option of many.slice(0, MAX_SELECTED_PRODUCT_DOC_IDS)) {
      await user.click(screen.getByRole('checkbox', { name: option.filename }))
    }
    fireEvent.click(screen.getByRole('checkbox', { name: `screen-${MAX_SELECTED_PRODUCT_DOC_IDS}.png` }))
    fireEvent.change(
      screen.getByRole('checkbox', { name: `screen-${MAX_SELECTED_PRODUCT_DOC_IDS}.png` }),
      { target: { checked: true } },
    )
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toHaveLength(MAX_SELECTED_PRODUCT_DOC_IDS)
  })

  it('lets a visual be ticked again after a full selection loses one to a deletion', async () => {
    // The bound guard and `visualLimitReached` must measure the SAME list. The guard
    // used to count the raw stored ids while the flag counted only ids still on
    // offer, so: tick the maximum, have one deleted from the Product tab, and the
    // flag said "not at the bound" — the remaining boxes rendered ENABLED — while
    // the guard still counted the maximum and swallowed every click. A control that
    // looks available and does nothing is worse than a disabled one.
    //
    // The replacement is asserted as SENT rather than as merely checked: the click
    // could set the box while the id never reaches the request.
    const user = userEvent.setup()
    const all = Array.from(
      { length: MAX_SELECTED_PRODUCT_DOC_IDS + 1 },
      (_, i) => productDoc({ doc_id: `pd_${i}`, filename: `screen-${i}.png` }),
    )
    const atBound = all.slice(0, MAX_SELECTED_PRODUCT_DOC_IDS)
    const spare = all[MAX_SELECTED_PRODUCT_DOC_IDS]
    const { rerender } = renderWizard([PRD, PRFAQ], FILLED_CONTEXT, all)

    for (const option of atBound) {
      await user.click(screen.getByRole('checkbox', { name: option.filename }))
    }
    // The first ticked visual is deleted elsewhere; the rest, and the spare, remain.
    rerender(tab([PRD, PRFAQ], FILLED_CONTEXT, [...atBound.slice(1), spare]))

    const spareBox = screen.getByRole('checkbox', { name: spare.filename })
    expect(spareBox).toBeEnabled()
    await user.click(spareBox)
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    const sent = sentBody().selected_product_doc_ids
    expect(sent).toHaveLength(MAX_SELECTED_PRODUCT_DOC_IDS)
    expect(sent).toContain(spare.doc_id)
    // And the deleted one is gone rather than merely displaced.
    expect(sent).not.toContain(atBound[0].doc_id)
  })

  it('never sends more than the bound after a visual re-extracts and returns', async () => {
    // The one that needs NO deletion, which is what makes it the reachable case.
    // `toggleWithinBound` counts only ids still on offer, so a visual that
    // re-enters `extracting` stops being counted while it stays in state: tick the
    // maximum, one re-extracts, tick a replacement, extraction finishes — and the
    // stored list is one over the bound. Unsliced, the request carries that extra id
    // and the API answers 400 naming a length the user never chose, which is exactly
    // what the bound exists to prevent.
    const user = userEvent.setup()
    const all = Array.from(
      { length: MAX_SELECTED_PRODUCT_DOC_IDS + 1 },
      (_, i) => productDoc({ doc_id: `pd_${i}`, filename: `screen-${i}.png` }),
    )
    const atBound = all.slice(0, MAX_SELECTED_PRODUCT_DOC_IDS)
    const spare = all[MAX_SELECTED_PRODUCT_DOC_IDS]
    const { rerender } = renderWizard([PRD, PRFAQ], FILLED_CONTEXT, all)

    for (const option of atBound) {
      await user.click(screen.getByRole('checkbox', { name: option.filename }))
    }
    // The first ticked visual goes back to extracting, so it leaves the options...
    const reExtracting = { ...atBound[0], status: 'extracting' as const }
    rerender(tab([PRD, PRFAQ], FILLED_CONTEXT, [reExtracting, ...atBound.slice(1), spare]))
    // ...the user tops the selection back up...
    await user.click(screen.getByRole('checkbox', { name: spare.filename }))
    // ...and then extraction finishes, so it is offered again.
    rerender(tab([PRD, PRFAQ], FILLED_CONTEXT, all))
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    const sent = sentBody().selected_product_doc_ids
    // The bound holds, and the survivors are the earliest ticks rather than an
    // arbitrary subset — a slice keeps the precedence order the prompt reads.
    expect(sent).toHaveLength(MAX_SELECTED_PRODUCT_DOC_IDS)
    expect(sent).toEqual(atBound.map((d) => d.doc_id))
    expect(sent).not.toContain(spare.doc_id)
  })

  it('drops a visual deleted between the tick and the click', async () => {
    // The doc list refetches on mount and focus, and the Product tab can delete an
    // upload while this card is open. Sending its id would be a 4xx — someone
    // else's deletion becoming this build's failure. The `mockBuildPrototype`
    // assertion alone would pass without the filter, so the surviving id is
    // asserted too.
    const user = userEvent.setup()
    const { rerender } = renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    await user.click(screen.getByRole('checkbox', { name: 'settings-screen.png' }))
    await user.click(screen.getByRole('checkbox', { name: 'home-screen.png' }))
    rerender(tab([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A]))
    await user.click(startBuild())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().selected_product_doc_ids).toEqual(['pd_a'])
  })
})

/**
 * The two reasons an uploaded image cannot be offered, told apart.
 *
 * One count for both said "still being processed" about a `failed` extraction
 * forever, sending the user back to wait for something that will never arrive. The
 * fixture that discriminates is a `failed` doc: the original only ever used
 * `extracting`, which is why the defect shipped — every assertion about it passed
 * either way.
 */
describe('an image that cannot be offered says which kind of wait it is', () => {
  it('reports an extracting image as in flight, not as failed', () => {
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_EXTRACTING])

    expect(screen.getByText(label('visualsNotReady', 1))).toBeInTheDocument()
    expect(visualNotes()).not.toContain(noteStem('visualsFailed'))
  })

  it('reports a failed image as failed, not as in flight', () => {
    // THE discriminating case. Under the old single count this line read "1 still
    // being processed" — advice to wait for an extraction that has already given
    // up, with no mention that uploading the file again is the way out.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_FAILED])

    expect(screen.getByText(label('visualsFailed', 1))).toBeInTheDocument()
    expect(visualNotes()).not.toContain(noteStem('visualsNotReady'))
  })

  it('reports both counts when one image is extracting and another failed', () => {
    // Independent lines, not a winner: the user has one file to wait for and a
    // different one to re-upload, and either note alone hides half of that.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_EXTRACTING, VISUAL_FAILED])

    expect(screen.getByText(label('visualsNotReady', 1))).toBeInTheDocument()
    expect(screen.getByText(label('visualsFailed', 1))).toBeInTheDocument()
  })

  it('reports neither line when every uploaded image is ready', () => {
    // The positive control: without it, "reports the failed ones" is
    // indistinguishable from "always shows both lines".
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    expect(visualNotes()).not.toContain(noteStem('visualsNotReady'))
    expect(visualNotes()).not.toContain(noteStem('visualsFailed'))
  })

  it('offers neither the failed nor the extracting image as selectable', () => {
    // Counting them must not have made them tickable: neither has an extracted
    // description, so `build_visual_brief_block` would ignore either one — a box
    // that contributes nothing to the build it appears to configure.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_EXTRACTING, VISUAL_FAILED])

    expect(screen.getByRole('checkbox', { name: 'home-screen.png' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'wip.png' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'broken.png' })).not.toBeInTheDocument()
    // The heading counts what is SELECTABLE, so neither of the two shows up there.
    expect(screen.getByText(label('visuals', 1))).toBeInTheDocument()
  })
})

describe('the visual tick-boxes are a named group', () => {
  it('exposes the heading as the group\'s accessible name', () => {
    // Asserted through the role and its computed name rather than through the
    // markup, so the association is what is tested: the research sub-list gets it
    // from its master checkbox and this list has no master by design, so without
    // an explicit group the rows announce as loose checkboxes carrying filenames
    // and nothing says what ticking one does.
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_B])

    const group = screen.getByRole('group', { name: label('visuals', 2) })
    expect(group).toContainElement(screen.getByRole('checkbox', { name: 'home-screen.png' }))
    expect(group).toContainElement(screen.getByRole('checkbox', { name: 'settings-screen.png' }))
  })
})

describe('a card that cannot act offers no choices', () => {
  // The property is unchanged — choices for an action that cannot be taken read as
  // an offer — but the controls moved into the wizard, so it is now enforced one
  // step earlier: the card's button is what refuses, and the panel is never
  // reachable. Asserting the absence of tick-boxes alone would be WEAKER than the
  // old test, because they are absent on every unopened card, so the assertion that
  // carries the property is that the button does not open anything.
  it('cannot open the wizard on a project with no PRD and no PR-FAQ', () => {
    // Research and a filled product context, so there IS something to offer, and no
    // PRD or PR-FAQ, so nothing can be built.
    renderCard([RESEARCH_A], FILLED_CONTEXT)

    expect(buildButton()).toBeDisabled()
    expect(screen.getByText(en.documents.prototype.needsDocs)).toBeInTheDocument()

    // A disabled button swallows the click, so the panel never opens and no control
    // inside it is reachable or focusable.
    fireEvent.click(buildButton())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('opens with the choices as soon as one document exists', () => {
    // The other half, from the same fixture one document later: the gate must be the
    // button's disabled state and nothing else.
    renderCard([PRD, RESEARCH_A], FILLED_CONTEXT)
    expect(buildButton()).toBeEnabled()

    fireEvent.click(buildButton())

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('prototype-extra-sources')).toBeInTheDocument()
  })
})

describe('two similarly-named reports are distinguishable', () => {
  it('gives each report title a tooltip carrying the full string', async () => {
    // The titles are `truncate`d in a narrow column, so two reports named
    // "Churn interviews Q1"/"Q2" render as the same visible string. A screen
    // reader gets the full label either way; a sighted mouse user has only this.
    const user = userEvent.setup()
    renderWizard([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], FILLED_CONTEXT)

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
    renderWizard([PRD, PRFAQ, RESEARCH_A], FILLED_CONTEXT)

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
    // `{{total}}` and not i18next `count`, matching every neighbouring label: a
    // plural-suffixed key would be two more strings per catalogue for a number
    // that only ever opens a short grey line.
    expect(prototype.visualsFailed).toContain('{{total}}')
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
    expect(catalogue.documents.prototype.visualsFailed)
      .not.toBe(en.documents.prototype.visualsFailed)
    expect(catalogue.documents.derivation.visualsUsed_other)
      .not.toBe(en.documents.derivation.visualsUsed_other)
  })
})

describe('the failed note renders from a non-English catalogue', () => {
  // The catalogue assertions above prove the key exists in all eight and differs
  // from English. This proves the COMPONENT resolves it in a non-English locale:
  // a value filed under a slightly different path in a translated catalogue
  // satisfies both of those and still renders its raw dotted key to a German user.
  // Same shape as McpAccessTab.structure.test.tsx, which registers `de` the same
  // way — the harness itself loads only `en`.
  beforeAll(async () => {
    i18n.addResourceBundle('de', 'projectDetail', de)
    await i18n.changeLanguage('de')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the German wording, not the key path or the English string', () => {
    renderWizard([PRD, PRFAQ], FILLED_CONTEXT, [VISUAL_A, VISUAL_FAILED])

    expect(screen.getByText(
      de.documents.prototype.visualsFailed.replace('{{total}}', '1'),
    )).toBeInTheDocument()
    expect(visualNotes()).not.toContain('documents.prototype.visualsFailed')
    expect(visualNotes()).not.toContain(noteStem('visualsFailed'))
  })
})
