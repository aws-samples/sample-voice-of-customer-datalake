import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import JobStatusBadge from './JobStatusBadge'

describe('JobStatusBadge', () => {
  it('renders running status with blue styling', () => {
    render(<JobStatusBadge status="running" isStale={false} />)
    const badge = screen.getByText('running')
    expect(badge).toHaveClass('bg-info-subtle', 'text-info')
  })

  it('renders pending status with yellow styling', () => {
    render(<JobStatusBadge status="pending" isStale={false} />)
    const badge = screen.getByText('pending')
    expect(badge).toHaveClass('bg-warn-subtle', 'text-warn')
  })

  it('renders completed status with green styling', () => {
    render(<JobStatusBadge status="completed" isStale={false} />)
    const badge = screen.getByText('completed')
    expect(badge).toHaveClass('bg-ok-subtle', 'text-ok')
  })

  it('renders failed status with red styling', () => {
    render(<JobStatusBadge status="failed" isStale={false} />)
    const badge = screen.getByText('failed')
    expect(badge).toHaveClass('bg-danger-subtle', 'text-danger')
  })

  it('renders stale status with amber styling and different label', () => {
    render(<JobStatusBadge status="running" isStale={true} />)
    const badge = screen.getByText('may have failed')
    expect(badge).toHaveClass('bg-warn-subtle', 'text-warn')
  })

  it('prioritizes stale styling over status styling', () => {
    render(<JobStatusBadge status="completed" isStale={true} />)
    const badge = screen.getByText('may have failed')
    expect(badge).toHaveClass('bg-warn-subtle', 'text-warn')
  })
})
