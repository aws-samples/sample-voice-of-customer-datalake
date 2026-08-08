/**
 * U12: the single-document confirm gate.
 *
 * This replaced a synchronous window.confirm with ConfirmModal state. The old
 * code physically could not start a build without user consent; the new code
 * can if the showConfirm wiring regresses, and the operation is billable and
 * runs for minutes. These tests pin the gate itself, not the styling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BuildPrototypeButton from './BuildPrototypeButton'

const mockBuildPrototype = vi.fn()
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    buildPrototype: (...args: unknown[]) => mockBuildPrototype(...args),
  },
}))

const mockJobStarted = vi.fn()

function renderButton(props: { hasPrd: boolean; hasPrfaq: boolean }) {
  return render(
    <BuildPrototypeButton
      projectId="proj_1"
      hasPrd={props.hasPrd}
      hasPrfaq={props.hasPrfaq}
      onJobStarted={mockJobStarted}
    />,
  )
}

/** The build trigger, not the modal's confirm button. */
function buildButton() {
  return screen.getByRole('button', { name: /build prototype/i })
}

describe('BuildPrototypeButton confirm gate (U12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('asks for confirmation instead of building when only a PRD exists', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: true, hasPrfaq: false })

    await user.click(buildButton())

    // The gate's whole purpose: no billable work before consent.
    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.getByText(/No PR-FAQ yet/i)).toBeInTheDocument()
  })

  it('asks for confirmation instead of building when only a PR-FAQ exists', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: false, hasPrfaq: true })

    await user.click(buildButton())

    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.getByText(/No PRD yet/i)).toBeInTheDocument()
  })

  it('starts exactly one build when the confirmation is accepted', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: true, hasPrfaq: false })
    await user.click(buildButton())

    await user.click(screen.getByRole('button', { name: /build anyway/i }))

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(mockBuildPrototype).toHaveBeenCalledWith('proj_1', expect.anything())
  })

  it('starts no build when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: true, hasPrfaq: false })
    await user.click(buildButton())

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
  })

  it('builds immediately without a confirmation when both documents exist', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/No PR-FAQ yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/No PRD yet/i)).not.toBeInTheDocument()
  })

  it('does not build when neither document exists', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: false, hasPrfaq: false })

    // The trigger is disabled in this state; clicking must be inert.
    await user.click(buildButton())

    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })
})

/**
 * U9: this component no longer waits for the build. It hands off to the jobs
 * panel, which is the only thing that reports progress and failure now — so
 * failing to hand off makes a multi-minute billable build invisible.
 */
describe('BuildPrototypeButton handover to the jobs panel (U9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('announces the started job once the build request succeeds', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    await waitFor(() => expect(mockJobStarted).toHaveBeenCalledTimes(1))
  })

  it('reports the failure inline and announces nothing when the build cannot start', async () => {
    const user = userEvent.setup()
    mockBuildPrototype.mockRejectedValue(new Error('Bedrock unavailable'))
    renderButton({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    await waitFor(() => expect(screen.getByText(/Bedrock unavailable/)).toBeInTheDocument())
    expect(mockJobStarted).not.toHaveBeenCalled()
  })

  it('stops showing the busy label once the request returns, without waiting for the job', async () => {
    const user = userEvent.setup()
    renderButton({ hasPrd: true, hasPrfaq: true })

    await user.click(buildButton())

    // The old code kept "Building…" for up to five minutes of polling.
    await waitFor(() => expect(screen.queryByText(/building…/i)).not.toBeInTheDocument())
  })
})
