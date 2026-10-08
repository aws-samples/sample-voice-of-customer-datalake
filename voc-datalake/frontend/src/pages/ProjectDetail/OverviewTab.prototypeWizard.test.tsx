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
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  FILLED_CONTEXT, PRD, PRFAQ, RESEARCH_A, RESEARCH_B, VISUAL_A,
  datedDoc, prototypeMocks, prototypeProjectsApiModule, resetPrototypeMocks,
} from './prototype-fixtures'
// After the fixtures on purpose: this imports OverviewTab, whose module graph runs
// the `vi.mock` factory below, which needs the fixture module evaluated.
import { buildButton, overviewTab, renderOverviewTab } from './prototype-render-fixtures'
// The real en catalogue, so the dialog's expected accessible name is the shipped
// string rather than a copy of it that can drift.
import en from '../../../public/locales/en/projectDetail.json'
import type { ProjectDocument } from '../../api/types'
import type { ProductDoc } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => prototypeProjectsApiModule())
const { buildPrototype: mockBuildPrototype } = prototypeMocks

const PRD_2 = datedDoc('prd', 'prd_2', 'Delivery spec v2', '2026-01-15T00:00:00Z')
const PROTOTYPE = datedDoc('prototype', 'proto_1', 'First cut', '2026-05-01T00:00:00Z')

function tab(documents: ProjectDocument[], productDocs?: ProductDoc[]) {
  return overviewTab({ documents, productContext: FILLED_CONTEXT, productDocs })
}

/**
 * The panel, found the way assistive tech finds it. `ModalShell` owns
 * `role="dialog"`, the accessible name and the focus trap, so asserting those
 * attributes here would only re-test the shell — what this suite has to pin is
 * that the build configuration is INSIDE the dialog, which the content assertions
 * do.
 */
const wizard = () => screen.getByRole('dialog')
const maybeWizard = () => screen.queryByRole('dialog')

/** The one-of-each project — the shape most tests here open the wizard on. */
const BASELINE: ProjectDocument[] = [PRD, PRFAQ, RESEARCH_A]

/** Renders the tab for `documents` with the one ready visual every test here carries. */
function renderTab(documents: ProjectDocument[]) {
  return renderOverviewTab({ documents, productContext: FILLED_CONTEXT, productDocs: [VISUAL_A] })
}

/** Renders `documents` and opens the wizard; returns the user and `rerender`. */
async function openWizard(documents: ProjectDocument[] = BASELINE) {
  const user = userEvent.setup()
  const { rerender } = renderTab(documents)
  await user.click(buildButton())
  return { user, rerender }
}

/**
 * The five project shapes that used to behave differently. Only the first opened no
 * dialog; the other four raised one of the three `warningKeyFor` reasons. After the
 * move they must all do the same thing, which is what makes the card predictable.
 */
const SHAPES: ReadonlyArray<{ name: string; documents: ProjectDocument[] }> = [
  { name: 'one PRD, one PR-FAQ, no prototype (previously NO dialog)', documents: [PRD, PRFAQ, RESEARCH_A] },
  { name: 'a PRD only (previously the single-document note)', documents: [PRD, RESEARCH_A] },
  { name: 'a PR-FAQ only (previously the single-document note)', documents: [PRFAQ, RESEARCH_A] },
  { name: 'an existing prototype (previously the rebuild warning)', documents: [PRD, PRFAQ, PROTOTYPE] },
  { name: 'two PRDs (previously the choose-sources note)', documents: [PRD, PRD_2, PRFAQ] },
]

beforeEach(resetPrototypeMocks)

describe('the build configuration is reachable for every project', () => {
  it.each(SHAPES)('opens the wizard on $name', async ({ documents }) => {
    await openWizard(documents)

    // Identified by what it CONTAINS, not merely by being a dialog: four of these
    // shapes already open a ConfirmModal, so a role-only assertion would pass on
    // unchanged code for them.
    const panel = wizard()
    expect(within(panel).getByTestId('prototype-extra-sources')).toBeInTheDocument()
    expect(within(panel).getByTestId('prototype-source-picker')).toBeInTheDocument()
    // The body is the wizard's own, not a confirm dialog that happens to be open.
    expect(within(panel).getByTestId('prototype-build-wizard')).toBeInTheDocument()
    // Named, and named by the heading it renders. Querying by role alone cannot see
    // an unnamed dialog, so without this the switch from `ariaLabel` to
    // `ariaLabelledBy` could silently produce one and every test here would pass.
    expect(panel).toHaveAccessibleName(en.documents.prototype.button)
  })

  it('does not put the configuration on the card face any more', () => {
    renderTab(BASELINE)

    // Before the click there is no wizard, and the card must not be carrying the
    // controls either — that is the placement half of the change.
    expect(maybeWizard()).not.toBeInTheDocument()
    expect(screen.queryByTestId('prototype-extra-sources')).not.toBeInTheDocument()
  })
})

describe('opening the wizard is not itself a build', () => {
  it('starts no build when the card button only opens the wizard', async () => {
    await openWizard()

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
    const { user, rerender } = await openWizard()

    const researchBox = within(wizard()).getByRole('checkbox', { name: /research reports/i })
    await user.click(researchBox)
    expect(researchBox).toBeChecked()

    // An unrelated job finishing: the same project, one more document.
    rerender(tab([...BASELINE, RESEARCH_B], [VISUAL_A]))

    expect(maybeWizard()).toBeInTheDocument()
    // Asserted as a DOM property, not as rendered text — `checked` is invisible to a
    // textContent read, which is how a working checkbox once got reported broken.
    expect(within(wizard()).getByRole('checkbox', { name: /research reports/i })).toBeChecked()
  })

  it('refuses to build once the documents that enabled the card are gone', async () => {
    // Owned visibility has a consequence the old gate did not: an open panel can
    // OUTLIVE the state that enabled the card button. The card's `disabled` cannot
    // help here — it is behind the modal and the panel is already up — so the hook's
    // own guard is the last thing between the user and a billable call with nothing
    // to build from. Nothing else in this suite exercises that guard from the wizard
    // path, which is what makes this the regression test for it.
    const { user, rerender } = await openWizard()
    expect(wizard()).toBeInTheDocument()

    // Both source documents deleted from another surface while the panel is open.
    rerender(tab([RESEARCH_A], [VISUAL_A]))

    await user.click(within(wizard()).getByRole('button', { name: /^build prototype$/i }))

    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })

  it('closes on an explicit cancel', async () => {
    const { user } = await openWizard()
    expect(wizard()).toBeInTheDocument()

    await user.click(within(wizard()).getByRole('button', { name: /^cancel$/i }))

    expect(maybeWizard()).not.toBeInTheDocument()
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })
})
