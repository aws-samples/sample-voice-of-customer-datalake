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
function renderCard(props: { hasPrd: boolean; hasPrfaq: boolean }) {
  const documents: ProjectDocument[] = []
  if (props.hasPrd) documents.push(doc('prd', 'prd_1'))
  if (props.hasPrfaq) documents.push(doc('prfaq', 'prfaq_1'))

  return render(
    <OverviewTab
      project={project}
      personas={[]}
      documents={documents}
      onGeneratePersonas={vi.fn()}
      onGenerateDoc={vi.fn()}
      onRunResearch={vi.fn()}
      onRemixDocuments={vi.fn()}
      onOpenProductTool={vi.fn()}
      onSaveKiroPrompt={vi.fn()}
      onJobStarted={mockJobStarted}
    />,
  )
}

/** The build trigger, not the modal's confirm button. */
function buildButton() {
  return screen.getByRole('button', { name: /build prototype/i })
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
