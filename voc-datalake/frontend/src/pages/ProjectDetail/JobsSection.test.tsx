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

  /**
   * Truncation reporting (issue #231).
   *
   * The backend caps how much feedback fits in one generation. It used to say so
   * only in a CloudWatch log line, so a user reading personas built from a
   * fraction of their filtered corpus had no way to know. These pin the notice
   * to the metadata, so a backend field landing without its consumer — the way
   * this one first did — fails here.
   */
  describe('truncated-context notice', () => {
    const truncatedPersonaJob = (metadata: Record<string, unknown>) => createJob({
      job_type: 'generate_personas',
      status: 'completed',
      result: { metadata },
    })

    it('reports how many feedback items the result was actually based on', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[truncatedPersonaJob({
            context_truncated: true, feedback_items_used: 145, feedback_count: 300,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      expect(
        screen.getByText(/Based on 145 of the 300 feedback items read/),
      ).toBeInTheDocument()
    })

    it('names the total as what was READ, not as the size of the corpus', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[truncatedPersonaJob({
            context_truncated: true, feedback_items_used: 145, feedback_count: 300,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // feedback_count is the number of records the job FETCHED, which its own
      // fetch limit bounds. Presenting it as the whole corpus would be
      // confidently wrong about the denominator on exactly the projects where
      // the loss is largest — the class of defect this issue is about.
      expect(screen.getByText(/of the 300 feedback items read/)).toBeInTheDocument()
    })

    it('stays silent when the whole corpus reached the model', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[truncatedPersonaJob({
            context_truncated: false, feedback_items_used: 60, feedback_count: 60,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // A notice on every job would train the user to ignore it.
      expect(screen.queryByText(/did not fit in one generation/)).not.toBeInTheDocument()
    })

    it('stays silent for a job whose result carries no metadata', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[createJob({ status: 'completed', result: { document_id: 'doc-1' } })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      expect(screen.queryByText(/did not fit in one generation/)).not.toBeInTheDocument()
    })

    it('still warns when the counts are missing but truncation is flagged', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[truncatedPersonaJob({ context_truncated: true })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // Losing the counts must not lose the warning: "some feedback was
      // dropped" is still the thing the user needs to know.
      expect(
        screen.getByText(/Some feedback did not fit in one generation/),
      ).toBeInTheDocument()
    })

    it('shows the artifact label and the notice together', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[createJob({
            status: 'completed',
            result: {
              document_id: 'doc-1',
              title: 'Q3 Persona Set',
              metadata: {
                context_truncated: true, feedback_items_used: 90, feedback_count: 145,
              },
            },
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // The common case for document generation: a named artifact that is also
      // partially grounded. Both paragraphs render, and neither suppresses the
      // other.
      expect(screen.getByText(/Q3 Persona Set/)).toBeInTheDocument()
      expect(
        screen.getByText(/Based on 90 of the 145 feedback items read/),
      ).toBeInTheDocument()
    })

    it('reports the fetch limit separately from trimming', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[truncatedPersonaJob({
            context_truncated: false,
            feedback_items_used: 145,
            feedback_count: 145,
            fetch_limit_reached: true,
            fetch_limit: 145,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // Nothing was trimmed, so the trimming notice must stay away — but the
      // corpus is a ceiling rather than a total, and context_truncated cannot
      // express that: it compares what the model saw against what was READ.
      expect(
        screen.getByText(/reads at most 145 feedback items/),
      ).toBeInTheDocument()
      expect(
        screen.queryByText(/did not fit in one generation/),
      ).not.toBeInTheDocument()
    })

    it('shows both notices when the fetch was capped and the read was trimmed', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[truncatedPersonaJob({
            context_truncated: true,
            feedback_items_used: 120,
            feedback_count: 145,
            fetch_limit_reached: true,
            fetch_limit: 145,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      expect(
        screen.getByText(/Based on 120 of the 145 feedback items read/),
      ).toBeInTheDocument()
      expect(
        screen.getByText(/reads at most 145 feedback items/),
      ).toBeInTheDocument()
    })
  })

  /**
   * Wire-shape tolerance for the metadata block.
   *
   * The values come from a DynamoDB job record, so the declared types are the
   * API's intent rather than the wire's guarantee — `api/feedbackSchema.ts`
   * exists because numeric fields on the feedback endpoints really do arrive as
   * strings. `parseJobGrounding` normalizes this block for the same reason.
   */
  describe('truncation notice with untrustworthy metadata', () => {
    /**
     * A job whose metadata is whatever the wire supplied.
     *
     * The declared type is the shape the API intends, and the point of these
     * cases is what happens when the wire disagrees with it — so the fixture has
     * to widen past the declared type to express its own input. Confined to this
     * helper, and routed through `unknown` rather than `any` so nothing else here
     * loses type checking.
     */
    const jobWithMetadata = (metadata: unknown) => createJob({
      result: { metadata } as unknown as ProjectJob['result'],
      status: 'completed',
    })

    it('renders numeric counts that arrive as strings', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[jobWithMetadata({
            context_truncated: true, feedback_items_used: '145', feedback_count: '300',
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      expect(
        screen.getByText(/Based on 145 of the 300 feedback items read/),
      ).toBeInTheDocument()
    })

    it('does not announce a loss for a string "false" flag', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[jobWithMetadata({
            context_truncated: 'false', feedback_items_used: 60, feedback_count: 60,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // A non-empty string is truthy in JavaScript, so a coercing read would
      // warn about a loss that never happened on every completed job.
      expect(
        screen.queryByText(/did not fit in one generation/),
      ).not.toBeInTheDocument()
    })

    it('falls back to the count-free wording for unusable numbers', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[jobWithMetadata({
            context_truncated: true, feedback_items_used: 'many', feedback_count: 300,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      // The warning is the load-bearing part; the numbers are the detail.
      expect(
        screen.getByText(/Some feedback did not fit in one generation/),
      ).toBeInTheDocument()
    })

    it('falls back rather than claiming more was used than was read', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection
          jobs={[jobWithMetadata({
            context_truncated: true, feedback_items_used: 300, feedback_count: 145,
          })]}
          onDismiss={vi.fn()}
        />,
      )
      await expandCompleted(user)
      expect(
        screen.getByText(/Some feedback did not fit in one generation/),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Based on 300/)).not.toBeInTheDocument()
    })

    it('survives a metadata block that is not an object', async () => {
      const user = userEvent.setup()
      render(
        <JobsSection jobs={[jobWithMetadata('truncated')]} onDismiss={vi.fn()} />,
      )
      await expandCompleted(user)
      expect(screen.getByText('completed')).toBeInTheDocument()
      expect(
        screen.queryByText(/did not fit in one generation/),
      ).not.toBeInTheDocument()
    })
  })

  /**
   * The failed-job branch was moved above the completed-result branch. These pin
   * that the move is inert, which is why it needed no behavioural change: the
   * two conditions are mutually exclusive by construction, since
   * hasCompletedResult requires status 'completed' and the error branch requires
   * status 'failed'.
   */
  describe('failed jobs that also carry a result', () => {
    it('shows the error, not the artifact label', () => {
      render(
        <JobsSection
          jobs={[createJob({
            status: 'failed',
            error: 'Bedrock timed out',
            result: { document_id: 'doc-1', title: 'Half-written PRD' },
          })]}
          onDismiss={vi.fn()}
        />,
      )
      expect(screen.getByText('Bedrock timed out')).toBeInTheDocument()
      expect(screen.queryByText(/Half-written PRD/)).not.toBeInTheDocument()
    })

    it('does not show a truncation notice for a failed job', () => {
      render(
        <JobsSection
          jobs={[createJob({
            status: 'failed',
            error: 'Bedrock timed out',
            result: {
              metadata: {
                context_truncated: true, feedback_items_used: 10, feedback_count: 145,
              },
            },
          })]}
          onDismiss={vi.fn()}
        />,
      )
      // Nothing was generated, so how much evidence it would have used is not
      // the useful thing to say.
      expect(screen.getByText('Bedrock timed out')).toBeInTheDocument()
      expect(
        screen.queryByText(/did not fit in one generation/),
      ).not.toBeInTheDocument()
    })
  })
})
