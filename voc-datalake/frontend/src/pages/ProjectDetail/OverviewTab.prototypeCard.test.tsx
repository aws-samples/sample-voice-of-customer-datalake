/**
 * The prototype build gate and jobs-panel handover, now that the control is step 5
 * of the Overview card grid rather than a lone button in the project tab row.
 *
 * Ported wholesale from BuildPrototypeButton.test.tsx (deleted with the component)
 * because neither guarantee it pins is about where the control lives:
 *
 * - **U12, the confirm gate.** A synchronous window.confirm physically could not
 *   start a build without consent. The ConfirmModal state that replaced it can, if
 *   the wiring regresses — and the operation is billable and runs for minutes.
 * - **U9, the handover.** The control does not wait for the build. It hands off to
 *   the Background Jobs panel, which is the only thing that reports progress and
 *   failure, so failing to hand off makes a multi-minute billable build invisible.
 *
 * Driving these through OverviewTab rather than a bare hook is deliberate: the
 * move split what was one component into a hook plus a card, and it is the *seam*
 * between them — the card's disabled state, the hook's confirm, the shared
 * onJobStarted — that the move could break. Every matcher below is unchanged from
 * the original file, which is the evidence that behaviour was preserved.
 *
 * `t()` resolves against the real en catalogue (src/test/setup.ts), so a key that
 * moved or was never added echoes its raw path and these matchers fail — which is
 * the point, given a previous release shipped buttons announcing `editForm` to
 * assistive tech because both the code and its test agreed on a missing key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
import type { Project, ProjectDocument } from '../../api/types'

const mockBuildPrototype = vi.fn()
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    buildPrototype: (...args: unknown[]) => mockBuildPrototype(...args),
  },
}))

const mockJobStarted = vi.fn()

// Fully populated rather than a partial cast: an `as Project` on a two-field
// literal compiles under the app config but fails `typecheck:tests`, and a cast is
// exactly the thing that stops telling the truth when the type gains a field.
const project: Project = {
  project_id: 'proj_1',
  name: 'Test project',
  description: '',
  status: 'active',
  created_at: '2026-08-09T00:00:00Z',
  updated_at: '2026-08-09T00:00:00Z',
  persona_count: 0,
  document_count: 0,
}

function doc(documentType: ProjectDocument['document_type'], id: string): ProjectDocument {
  return {
    document_id: id,
    document_type: documentType,
    title: id,
    content: 'x',
    created_at: '2026-08-09T00:00:00Z',
  }
}

/**
 * The card reads availability off the documents it is given, so the old
 * `hasPrd`/`hasPrfaq` props become the presence of a PRD / PR-FAQ document — the
 * same condition, now derived where the rest of the grid derives its state.
 */
/** The tab for a given document set, so a test can re-render with a different one. */
function overviewTab(documents: ProjectDocument[]) {
  return (
    <OverviewTab
      project={project}
      personas={[]}
      documents={documents}
      onGeneratePersonas={vi.fn()}
      onGenerateDoc={vi.fn()}
      onRunResearch={vi.fn()}
      onRemixDocuments={vi.fn()}
      onOpenProductTool={vi.fn()}
      onJobStarted={mockJobStarted}
    />
  )
}

function renderCard(props: { hasPrd: boolean; hasPrfaq: boolean; hasPrototype?: boolean }) {
  const documents: ProjectDocument[] = []
  if (props.hasPrd) documents.push(doc('prd', 'prd_1'))
  if (props.hasPrfaq) documents.push(doc('prfaq', 'prfaq_1'))
  if (props.hasPrototype === true) documents.push(doc('prototype', 'proto_1'))

  return render(overviewTab(documents))
}

/** The build trigger, not the modal's confirm button. */
function buildButton() {
  return screen.getByRole('button', { name: /build prototype/i })
}

/**
 * The modal's confirm action, queried rather than got: the tests below assert on
 * its ABSENCE, which is the load-bearing half of a dialog that must not be
 * clickable once its question no longer applies.
 */
function confirmButton() {
  return screen.queryByRole('button', { name: /build anyway/i })
}

describe('prototype card confirm gate (U12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('asks for confirmation instead of building when only a PRD exists', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: false })

    await user.click(buildButton())

    // The gate's whole purpose: no billable work before consent.
    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.getByText(/No PR-FAQ yet/i)).toBeInTheDocument()
  })

  it('asks for confirmation instead of building when only a PR-FAQ exists', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: false, hasPrfaq: true })

    await user.click(buildButton())

    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.getByText(/No PRD yet/i)).toBeInTheDocument()
  })

  it('starts exactly one build when the confirmation is accepted', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: false })
    await user.click(buildButton())

    await user.click(screen.getByRole('button', { name: /build anyway/i }))

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(mockBuildPrototype).toHaveBeenCalledWith('proj_1', expect.anything())
  })

  it('starts no build when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: false })
    await user.click(buildButton())

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
  })

  it('builds immediately without a confirmation when both documents exist', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/No PRD yet/i)).not.toBeInTheDocument()
  })

  it('does not build when neither document exists', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: false, hasPrfaq: false })

    // The trigger is disabled in this state; clicking must be inert.
    await user.click(buildButton())

    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })

  it('explains why the button is disabled when there is nothing to build from', () => {
    renderCard({ hasPrd: false, hasPrfaq: false })

    // New with the move: the tab-row button could only carry this as a hover
    // title, which never reaches a keyboard or touch user.
    expect(buildButton()).toBeDisabled()
    expect(screen.getByText(/Create a PRD or a PR-FAQ first/i)).toBeInTheDocument()
  })

  it('does not claim a document is missing while a build is in flight', async () => {
    // Regression: this card is the only one whose `disabled` has TWO reasons
    // (no source document, and busy), and the message was rendered
    // unconditionally — so for the whole duration of every *successful* build it
    // told a user who plainly had a PRD to go and create one.
    const user = userEvent.setup()
    let releaseRequest = () => {}
    mockBuildPrototype.mockImplementation(() => new Promise((resolve) => {
      releaseRequest = () => resolve({ job_id: 'job_1' })
    }))
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    // The label becomes "Building…" while in flight, so the trigger has to be found
    // by that name — the disabled state is real, and the point is what it *says*.
    const busyButton = await screen.findByRole('button', { name: /building…/i })
    expect(busyButton).toBeDisabled()
    expect(screen.queryByText(/Create a PRD or a PR-FAQ first/i)).not.toBeInTheDocument()

    // Released and then awaited, so the state update it causes happens inside the
    // test rather than after it — an unawaited release surfaces as an act warning
    // whose timing depends on the machine.
    releaseRequest()
    await waitFor(() => expect(buildButton()).toBeInTheDocument())
  })
})

describe('prototype card rebuild guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('confirms before building a second prototype, since the first is kept', async () => {
    // The build endpoint has no existing-prototype check, so a second click starts
    // another multi-minute billable build. Moving the control into the card grid
    // made it more discoverable, so the accidental-spend path needed closing even
    // though the wider "view vs rebuild" question is still open.
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: true, hasPrototype: true })

    await user.click(buildButton())

    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.getByText(/already has a prototype/i)).toBeInTheDocument()
  })

  it('builds the second prototype once the rebuild is confirmed', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: true, hasPrototype: true })
    await user.click(buildButton())

    await user.click(screen.getByRole('button', { name: /build anyway/i }))

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
  })

  it('starts nothing when the rebuild is cancelled', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: true, hasPrototype: true })
    await user.click(buildButton())

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })

  it('warns about the duplicate rather than the single source when both apply', async () => {
    // Spending money on a duplicate is the more consequential surprise, so it wins
    // over the "PR-FAQ is missing" note when a project has one document and one
    // prototype.
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: false, hasPrototype: true })

    await user.click(buildButton())

    expect(screen.getByText(/already has a prototype/i)).toBeInTheDocument()
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
  })

  it('reports how many prototypes exist so the card is not silent about them', () => {
    renderCard({ hasPrd: true, hasPrfaq: true, hasPrototype: true })

    expect(screen.getByText('Prototypes built: 1')).toBeInTheDocument()
  })

  it('closes the confirm rather than emptying it when the reason to ask disappears', async () => {
    // The confirm reason is derived from live data, and this page refetches
    // documents whenever a job completes. So a PR-FAQ generation finishing while
    // the single-document dialog is open removes the thing being confirmed — and
    // gating the dialog on its own open flag alone left it up with no message.
    const user = userEvent.setup()
    const { rerender } = renderCard({ hasPrd: true, hasPrfaq: false })

    await user.click(buildButton())
    expect(screen.getByText(/No PR-FAQ yet/i)).toBeInTheDocument()

    rerender(overviewTab([doc('prd', 'prd_1'), doc('prfaq', 'prfaq_1')]))

    // The role, the question and the action, so this cannot go vacuous if the
    // shell's ARIA role ever changes: the bug being pinned was a dialog that was
    // still THERE and still clickable, just with nothing written in it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
    expect(confirmButton()).not.toBeInTheDocument()
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })

  it('closes the confirm rather than swapping its question for a costlier one', async () => {
    // Same refetch, a different outcome: a prototype arriving while the
    // single-document confirm is open changes what "Build anyway" MEANS — from
    // "build from the PRD alone" to "build a second prototype and keep the first".
    // Rewriting the message under an open dialog would have the button answer a
    // question the user never read, so the dialog closes and the next click asks.
    const user = userEvent.setup()
    const { rerender } = renderCard({ hasPrd: true, hasPrfaq: false })

    await user.click(buildButton())
    expect(screen.getByText(/No PR-FAQ yet/i)).toBeInTheDocument()

    rerender(overviewTab([doc('prd', 'prd_1'), doc('prototype', 'proto_1')]))

    expect(screen.queryByText(/already has a prototype/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })

  it('does not re-open the confirm when a later reason to ask arrives', async () => {
    // An open flag outlives the question it was raised for: once the reason
    // disappeared the flag stayed set, so the NEXT reason to ask put a modal back
    // on screen that the user never asked for — one reflexive click from a
    // multi-minute billable build. Tracking which question was asked is what makes
    // this unreachable.
    const user = userEvent.setup()
    const { rerender } = renderCard({ hasPrd: true, hasPrfaq: false })

    await user.click(buildButton())
    expect(screen.getByText(/No PR-FAQ yet/i)).toBeInTheDocument()

    // The reason to ask disappears: the PR-FAQ generation completes.
    rerender(overviewTab([doc('prd', 'prd_1'), doc('prfaq', 'prfaq_1')]))
    expect(confirmButton()).not.toBeInTheDocument()

    // A later job produces a prototype, which is a new reason to ask.
    rerender(overviewTab([doc('prd', 'prd_1'), doc('prfaq', 'prfaq_1'), doc('prototype', 'proto_1')]))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/already has a prototype/i)).not.toBeInTheDocument()
    expect(confirmButton()).not.toBeInTheDocument()
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })
})

describe('prototype card handover to the jobs panel (U9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('announces the started job once the build request succeeds', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    await waitFor(() => expect(mockJobStarted).toHaveBeenCalledTimes(1))
  })

  it('reports the failure inline and announces nothing when the build cannot start', async () => {
    const user = userEvent.setup()
    mockBuildPrototype.mockRejectedValue(new Error('Bedrock unavailable'))
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    await waitFor(() => expect(screen.getByText(/Bedrock unavailable/)).toBeInTheDocument())
    expect(mockJobStarted).not.toHaveBeenCalled()
  })

  it('shows the failure instead of the acknowledgement, not both', async () => {
    const user = userEvent.setup()
    mockBuildPrototype.mockRejectedValue(new Error('Bedrock unavailable'))
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    // A build that failed to start has not started. The card has one status line,
    // so an error that lost to the acknowledgement would be invisible.
    await waitFor(() => expect(screen.getByText(/Bedrock unavailable/)).toBeInTheDocument())
    expect(screen.queryByText(/track it in background jobs/i)).not.toBeInTheDocument()
  })

  it('shows the busy label only until the request returns, not until the job finishes', async () => {
    const user = userEvent.setup()
    // Hold the request open so the busy label is observable — otherwise this
    // assertion passes on a button that never showed it at all.
    let releaseRequest = () => {}
    mockBuildPrototype.mockImplementation(() => new Promise((resolve) => {
      releaseRequest = () => resolve({ job_id: 'job_1' })
    }))
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())
    expect(await screen.findByText(/building…/i)).toBeInTheDocument()

    releaseRequest()

    // The old code kept "Building…" for up to five minutes of polling.
    await waitFor(() => expect(screen.queryByText(/building…/i)).not.toBeInTheDocument())
  })

  it('acknowledges the start, since the panel renders nothing until it refetches', async () => {
    const user = userEvent.setup()
    renderCard({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    expect(await screen.findByText(/track it in background jobs/i)).toBeInTheDocument()
  })
})
