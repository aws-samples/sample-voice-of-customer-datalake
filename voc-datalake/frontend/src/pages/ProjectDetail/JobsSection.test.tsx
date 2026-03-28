import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JobsSection from './JobsSection'
import type { ProjectJob } from '../../api/types'

const createJob = (overrides: Partial<ProjectJob> = {}): ProjectJob => ({
  job_id: 'job-1',
  project_id: 'proj-1',
  job_type: 'research',
  status: 'running',
  progress: 50,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

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

  it('renders job status badge', () => {
    render(<JobsSection jobs={[createJob({ status: 'completed' })]} onDismiss={vi.fn()} />)
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

  it('shows dismiss button for completed jobs', () => {
    render(<JobsSection jobs={[createJob({ status: 'completed' })]} onDismiss={vi.fn()} />)
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
    
    await user.click(screen.getByTitle('Dismiss'))
    expect(onDismiss).toHaveBeenCalledWith('test-job')
  })

  it('limits displayed jobs to 5', () => {
    const jobs = Array.from({ length: 7 }, (_, i) => createJob({ job_id: `job-${i}`, status: 'completed' }))
    render(<JobsSection jobs={jobs} onDismiss={vi.fn()} />)
    
    const dismissButtons = screen.getAllByTitle('Dismiss')
    expect(dismissButtons).toHaveLength(5)
  })

  it('renders stale warning for old running jobs', () => {
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString() // 15 min ago
    render(<JobsSection jobs={[createJob({ status: 'running', updated_at: oldTime })]} onDismiss={vi.fn()} />)
    expect(screen.getByText(/No updates for 10\+ minutes/)).toBeInTheDocument()
  })
})
