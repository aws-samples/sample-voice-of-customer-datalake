import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JobsSection from './JobsSection'
import type { ProjectJob } from '../../api/projectTypes'

const personaJob = (metadata: Record<string, unknown>): ProjectJob => ({
  job_id: 'job-1',
  job_type: 'generate_personas',
  status: 'completed',
  progress: 100,
  created_at: '2026-10-30T10:00:00Z',
  updated_at: '2026-10-30T10:05:00Z',
  result: { metadata },
})

async function renderCompleted(job: ProjectJob) {
  const user = userEvent.setup()
  render(<JobsSection jobs={[job]} onDismiss={vi.fn()} />)
  await user.click(screen.getByRole('button', { expanded: false }))
}

describe('DuplicateNamesNotice (#353)', () => {
  it('says how many new personas an additive run dropped for a repeated name', async () => {
    await renderCompleted(personaJob({ duplicate_names_dropped: 2 }))
    expect(screen.getByTestId('duplicate-names-dropped')).toHaveTextContent(
      '2 new personas were not added: their names repeat ones this project already has.',
    )
  })

  it('uses the singular for one', async () => {
    await renderCompleted(personaJob({ duplicate_names_dropped: '1' }))
    expect(screen.getByTestId('duplicate-names-dropped')).toHaveTextContent('1 new persona was not added')
  })

  it.each([
    ['zero', { duplicate_names_dropped: 0 }],
    ['absent (an older job record)', {}],
    ['malformed', { duplicate_names_dropped: true }],
  ])('stays silent when the count is %s', async (_label, metadata) => {
    await renderCompleted(personaJob(metadata))
    expect(screen.queryByTestId('duplicate-names-dropped')).not.toBeInTheDocument()
  })
})
