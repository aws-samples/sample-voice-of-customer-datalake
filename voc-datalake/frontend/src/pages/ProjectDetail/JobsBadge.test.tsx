/**
 * Background jobs used to be a block above the content on every project tab. They
 * are one header badge now ("2 running") that opens the jobs panel.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JobsBadge from './JobsBadge'
import type { ProjectJob } from '../../api/projectTypes'

const job = (id: string, status: ProjectJob['status']): ProjectJob => ({
  job_id: id, status, progress: 40, created_at: '2026-10-01T09:00:00Z', job_type: 'research',
})

describe('JobsBadge', () => {
  it('says how many are running and opens the panel; Escape closes it', async () => {
    const user = userEvent.setup()
    render(<JobsBadge jobs={[job('a', 'running'), job('b', 'pending'), job('c', 'failed')]} onDismiss={vi.fn()} />)
    const badge = screen.getByRole('button', { name: /2 running/ })
    expect(screen.queryByRole('region', { name: 'Background Jobs' })).not.toBeInTheDocument()
    await user.click(badge)
    expect(screen.getByRole('region', { name: 'Background Jobs' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Background Jobs' })).not.toBeInTheDocument()
  })

  it('names failures when nothing is running, and renders nothing without jobs', () => {
    const { rerender } = render(<JobsBadge jobs={[job('c', 'failed'), job('d', 'completed')]} />)
    expect(screen.getByRole('button', { name: /1 failed/ })).toBeInTheDocument()
    rerender(<JobsBadge jobs={[]} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
