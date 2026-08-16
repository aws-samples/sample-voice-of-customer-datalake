/**
 * Where the prototype build is configured, and for which projects it is reachable.
 *
 * This suite replaces `OverviewTab.prototypeExtraSources.test.tsx`'s opening
 * property, "the controls are reachable without a dialog". That property was true
 * of the old placement and is deliberately abandoned: the configuration moves into
 * a wizard, so the card matches its five siblings. The invariant it has to be
 * traded for is stated once, here:
 *
 *   > The build configuration is reachable for EVERY project — including one with
 *   > exactly one PRD, one PR-FAQ and no prototype, the case that previously opened
 *   > no dialog at all.
 *
 * That case is the whole reason the controls sat on the card face, so it is the
 * regression test for the placement change and it is parametrised below rather
 * than asserted once.
 *
 * ⚠️ A bare `getByRole('dialog')` would be VACUOUS here: three project shapes
 * already open a `ConfirmModal` today, so "a dialog appears" passes on unchanged
 * code for those. The wizard is identified by carrying the configuration —
 * `prototype-extra-sources` (today on the card, outside any dialog) together with
 * `prototype-source-picker` — which no current code path puts in one container.
 *
 * `t()` resolves against the real en catalogue (src/test/setup.ts), so a key that
 * is missing or has moved renders its raw path and these matchers fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
import { emptyProductContext } from './productContextFields'
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
const PRD_2 = doc('prd', 'prd_2', 'Delivery spec v2', '2026-01-15T00:00:00Z')
const PRFAQ = doc('prfaq', 'prfaq_1', 'Launch note', '2026-02-01T00:00:00Z')
const RESEARCH_A = doc('research', 'research_a', 'Churn interviews', '2026-03-01T00:00:00Z')
const RESEARCH_B = doc('research', 'research_b', 'Pricing survey', '2026-04-01T00:00:00Z')
const PROTOTYPE = doc('prototype', 'proto_1', 'First cut', '2026-05-01T00:00:00Z')

const FILLED_CONTEXT: ProductContext = { ...emptyProductContext(), one_liner: 'A console for wombats' }

const VISUAL_A: ProductDoc = {
  doc_id: 'pd_a',
  filename: 'home-screen.png',
  content_type: 'image/png',
  size_bytes: 1024,
  status: 'ready',
  error: null,
  extracted_chars: 400,
  created_at: '2026-05-01T00:00:00Z',
}

function tab(documents: ProjectDocument[], productDocs?: ProductDoc[]) {
  return (
    <OverviewTab
      project={project}
      personas={[]}
      documents={documents}
      productContext={FILLED_CONTEXT}
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

const buildButton = () => screen.getByRole('button', { name: /build prototype/i })
/**
 * The panel, found the way assistive tech finds it. `ModalShell` owns
 * `role="dialog"`, the accessible name and the focus trap, so asserting those
 * attributes here would only re-test the shell — what this suite has to pin is
 * that the build configuration is INSIDE the dialog, which the content assertions
 * do.
 */
const wizard = () => screen.getByRole('dialog')
const maybeWizard = () => screen.queryByRole('dialog')

/**
 * The five project shapes that used to behave differently. Only the first opened no
 * dialog; the other four raised one of the three `confirmKeyFor` reasons. After the
 * move they must all do the same thing, which is what makes the card predictable.
 */
const SHAPES: ReadonlyArray<{ name: string; documents: ProjectDocument[] }> = [
  { name: 'one PRD, one PR-FAQ, no prototype (previously NO dialog)', documents: [PRD, PRFAQ, RESEARCH_A] },
  { name: 'a PRD only (previously the single-document note)', documents: [PRD, RESEARCH_A] },
  { name: 'a PR-FAQ only (previously the single-document note)', documents: [PRFAQ, RESEARCH_A] },
  { name: 'an existing prototype (previously the rebuild warning)', documents: [PRD, PRFAQ, PROTOTYPE] },
  { name: 'two PRDs (previously the choose-sources note)', documents: [PRD, PRD_2, PRFAQ] },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
})

describe('the build configuration is reachable for every project', () => {
  it.each(SHAPES)('opens the wizard on $name', async ({ documents }) => {
    render(tab(documents, [VISUAL_A]))

    await userEvent.click(buildButton())

    // Identified by what it CONTAINS, not merely by being a dialog: four of these
    // shapes already open a ConfirmModal, so a role-only assertion would pass on
    // unchanged code for them.
    const panel = wizard()
    expect(within(panel).getByTestId('prototype-extra-sources')).toBeInTheDocument()
    expect(within(panel).getByTestId('prototype-source-picker')).toBeInTheDocument()
    // The body is the wizard's own, not a confirm dialog that happens to be open.
    expect(within(panel).getByTestId('prototype-build-wizard')).toBeInTheDocument()
  })

  it('does not put the configuration on the card face any more', () => {
    render(tab([PRD, PRFAQ, RESEARCH_A], [VISUAL_A]))

    // Before the click there is no wizard, and the card must not be carrying the
    // controls either — that is the placement half of the change.
    expect(maybeWizard()).not.toBeInTheDocument()
    expect(screen.queryByTestId('prototype-extra-sources')).not.toBeInTheDocument()
  })
})

describe('opening the wizard is not itself a build', () => {
  it('starts no build when the card button only opens the wizard', async () => {
    render(tab([PRD, PRFAQ, RESEARCH_A], [VISUAL_A]))

    await userEvent.click(buildButton())

    expect(wizard()).toBeInTheDocument()
    // The endpoint is billable and has no existing-prototype check of its own, so
    // reaching the configuration must never be what spends the money.
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })
})

describe('the wizard owns its own open state', () => {
  it('keeps the panel open and the selection intact when the documents change underneath', async () => {
    // §5b: the confirm dialog it replaces derived its visibility from live document
    // data, and the page refetches documents whenever a job completes. Hosting user
    // input in something with that property discards the input mid-interaction.
    const { rerender } = render(tab([PRD, PRFAQ, RESEARCH_A], [VISUAL_A]))
    await userEvent.click(buildButton())

    const researchBox = within(wizard()).getByRole('checkbox', { name: /research reports/i })
    await userEvent.click(researchBox)
    expect(researchBox).toBeChecked()

    // An unrelated job finishing: the same project, one more document.
    rerender(tab([PRD, PRFAQ, RESEARCH_A, RESEARCH_B], [VISUAL_A]))

    expect(maybeWizard()).toBeInTheDocument()
    // Asserted as a DOM property, not as rendered text — `checked` is invisible to a
    // textContent read, which is how a working checkbox once got reported broken.
    expect(within(wizard()).getByRole('checkbox', { name: /research reports/i })).toBeChecked()
  })

  it('closes on an explicit cancel', async () => {
    render(tab([PRD, PRFAQ, RESEARCH_A], [VISUAL_A]))
    await userEvent.click(buildButton())
    expect(wizard()).toBeInTheDocument()

    await userEvent.click(within(wizard()).getByRole('button', { name: /^cancel$/i }))

    expect(maybeWizard()).not.toBeInTheDocument()
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })
})
