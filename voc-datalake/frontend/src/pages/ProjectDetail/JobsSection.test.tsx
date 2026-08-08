import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JobsSection from './JobsSection'
import type { ProjectJob } from '../../api/types'

const createJob = (overrides: Partial<ProjectJob> = {}): ProjectJob => ({
  job_id: 'job-1',
  job_type: 'research',
  status: 'running',
  progress: 50,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

/** Completed jobs rest behind a summary line; open it to reach their rows. */
const expandCompleted = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { expanded: false }))
}

describe('JobsSection', () => {
  it('returns null when jobs array is empty', () => {
    const { container } = render(<JobsSection jobs={[]} onDismiss={vi.fn()} />)
    // eslint-disable-next-line testing-library/no-node-access -- checking null render
    expect(container.firstChild).toBeNull()
  })

  it('renders Background Jobs header when jobs exist', () => {
    render(<JobsSection jobs={[createJob()]} onDismiss={vi.fn()} />)
    expect(screen.getByText('Background Jobs')).toBeInTheDocument()
  })

  it('renders job type label', () => {
    render(<JobsSection jobs={[createJob({ job_type: 'generate_prd' })]} onDismiss={vi.fn()} />)
    expect(screen.getByText('PRD Generation')).toBeInTheDocument()
  })

  it('renders job status badge', async () => {
    const user = userEvent.setup()
    render(<JobsSection jobs={[createJob({ status: 'completed' })]} onDismiss={vi.fn()} />)
    await expandCompleted(user)
    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  it('renders progress bar for running jobs', () => {
    render(<JobsSection jobs={[createJob({ status: 'running', progress: 75 })]} onDismiss={vi.fn()} />)
    expect(screen.getByText('75%')).toBeInTheDocument()
  })

  it('renders current step for running jobs', () => {
    render(<JobsSection jobs={[createJob({ status: 'running', current_step: 'analyzing_data' })]} onDismiss={vi.fn()} />)
    expect(screen.getByText('analyzing data')).toBeInTheDocument()
  })

  it('renders error message for failed jobs', () => {
    render(<JobsSection jobs={[createJob({ status: 'failed', error: 'Something went wrong' })]} onDismiss={vi.fn()} />)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('shows dismiss button for completed jobs', async () => {
    const user = userEvent.setup()
    render(<JobsSection jobs={[createJob({ status: 'completed' })]} onDismiss={vi.fn()} />)
    await expandCompleted(user)
    expect(screen.getByTitle('Dismiss')).toBeInTheDocument()
  })

  it('shows dismiss button for failed jobs', () => {
    render(<JobsSection jobs={[createJob({ status: 'failed' })]} onDismiss={vi.fn()} />)
    expect(screen.getByTitle('Dismiss')).toBeInTheDocument()
  })

  it('calls onDismiss when dismiss button is clicked', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(<JobsSection jobs={[createJob({ status: 'completed', job_id: 'test-job' })]} onDismiss={onDismiss} />)

    await expandCompleted(user)
    await user.click(screen.getByTitle('Dismiss'))
    expect(onDismiss).toHaveBeenCalledWith('test-job')
  })

  it('shows every completed job once expanded, not just the first five', async () => {
    const user = userEvent.setup()
    const jobs = Array.from({ length: 7 }, (_, i) => createJob({ job_id: `job-${i}`, status: 'completed' }))
    render(<JobsSection jobs={jobs} onDismiss={vi.fn()} />)

    await expandCompleted(user)

    // The summary line says 7, so the expansion has to show 7. The old
    // slice(0, 5) would have made the count a lie.
    expect(screen.getAllByTitle('Dismiss')).toHaveLength(7)
  })
})

/**
 * U7: the panel renders above the tab content on every project tab, so a
 * finished project used to open with a block of stale log rows outranking the
 * actions the user came for. These pin the resting state, and pin that failures
 * are exempt from it — since the long-running actions now hand their wait to
 * this panel, hiding a failure would make it unreportable.
 */
describe('JobsSection resting state', () => {
  it('collapses a finished project to a single summary line', () => {
    const jobs = Array.from({ length: 4 }, (_, i) => createJob({ job_id: `job-${i}`, status: 'completed' }))
    render(<JobsSection jobs={jobs} onDismiss={vi.fn()} />)

    expect(screen.getByText('4 completed')).toBeInTheDocument()
    // Collapsed means no per-job rows at all: no job labels, no dismiss controls.
    expect(screen.queryByTitle('Dismiss')).not.toBeInTheDocument()
    expect(screen.queryByText('Research')).not.toBeInTheDocument()
  })

  it('keeps a running job expanded while completed ones rest', () => {
    render(
      <JobsSection
        jobs={[
          createJob({ job_id: 'running', status: 'running', progress: 40 }),
          createJob({ job_id: 'done-1', status: 'completed' }),
          createJob({ job_id: 'done-2', status: 'completed' }),
        ]}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByText('2 completed')).toBeInTheDocument()
  })

  it('keeps a failed job visible without expanding anything', () => {
    render(
      <JobsSection
        jobs={[
          createJob({ job_id: 'boom', status: 'failed', error: 'Prototype build failed' }),
          createJob({ job_id: 'done', status: 'completed' }),
        ]}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('Prototype build failed')).toBeInTheDocument()
    expect(screen.getByText('1 completed')).toBeInTheDocument()
  })

  it('never hides an in-flight job behind failures, however many there are', () => {
    const jobs = [
      ...Array.from({ length: 6 }, (_, i) => createJob({ job_id: `failed-${i}`, status: 'failed' as const })),
      createJob({ job_id: 'running', status: 'running', progress: 55 }),
    ]
    render(<JobsSection jobs={jobs} onDismiss={vi.fn()} />)

    // The cap applies to failures only, and in-flight work is ordered first, so
    // the running job is visible even though six failures precede it in the list.
    expect(screen.getByText('55%')).toBeInTheDocument()
  })

  it('makes failures past the cap reachable rather than merely counted', async () => {
    const user = userEvent.setup()
    const jobs = Array.from({ length: 5 }, (_, i) => createJob({
      job_id: `failed-${i}`,
      status: 'failed' as const,
      error: `failure number ${i}`,
    }))
    render(<JobsSection jobs={jobs} onDismiss={vi.fn()} />)

    // Three inline, two behind a summary that must expand — a bare count would
    // leave them unreachable until the visible ones were dismissed one by one.
    expect(screen.getByText('failure number 0')).toBeInTheDocument()
    expect(screen.queryByText('failure number 4')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByText('failure number 4')).toBeInTheDocument()
  })

  it('shows only a time for a job created today', () => {
    render(<JobsSection jobs={[createJob({ created_at: new Date().toISOString() })]} onDismiss={vi.fn()} />)
    expect(screen.getByText(/^\d{1,2}:\d{2}$/)).toBeInTheDocument()
  })

  it('dates a job that is not from today', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    render(<JobsSection jobs={[createJob({ created_at: threeDaysAgo })]} onDismiss={vi.fn()} />)

    // A bare HH:mm is ambiguous across days, so the label must carry a date part.
    expect(screen.queryByText(/^\d{1,2}:\d{2}$/)).not.toBeInTheDocument()
    expect(screen.getByText(/[A-Za-z]{3} \d{1,2}, \d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  it('renders nothing rather than an empty panel when a created_at is unparseable', () => {
    render(<JobsSection jobs={[createJob({ created_at: 'not-a-date' })]} onDismiss={vi.fn()} />)
    // Used to throw "Invalid time value" out of the render.
    expect(screen.getByText('Background Jobs')).toBeInTheDocument()
  })

  it('renders stale warning for old running jobs', () => {
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString() // 15 min ago
    render(<JobsSection jobs={[createJob({ status: 'running', updated_at: oldTime })]} onDismiss={vi.fn()} />)
    expect(screen.getByText(/No updates for 10\+ minutes/)).toBeInTheDocument()
  })
})
