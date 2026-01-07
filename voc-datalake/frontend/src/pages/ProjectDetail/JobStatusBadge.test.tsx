import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import JobStatusBadge from './JobStatusBadge'

describe('JobStatusBadge', () => {
  it('renders running status with blue styling', () => {
    render(<JobStatusBadge status="running" isStale={false} />)
    const badge = screen.getByText('running')
    expect(badge).toHaveClass('bg-blue-100', 'text-blue-700')
  })

  it('renders pending status with yellow styling', () => {
    render(<JobStatusBadge status="pending" isStale={false} />)
    const badge = screen.getByText('pending')
    expect(badge).toHaveClass('bg-yellow-100', 'text-yellow-700')
  })

  it('renders completed status with green styling', () => {
    render(<JobStatusBadge status="completed" isStale={false} />)
    const badge = screen.getByText('completed')
    expect(badge).toHaveClass('bg-green-100', 'text-green-700')
  })

  it('renders failed status with red styling', () => {
    render(<JobStatusBadge status="failed" isStale={false} />)
    const badge = screen.getByText('failed')
    expect(badge).toHaveClass('bg-red-100', 'text-red-700')
  })

  it('renders stale status with amber styling and different label', () => {
    render(<JobStatusBadge status="running" isStale={true} />)
    const badge = screen.getByText('may have failed')
    expect(badge).toHaveClass('bg-amber-100', 'text-amber-700')
  })

  it('prioritizes stale styling over status styling', () => {
    render(<JobStatusBadge status="completed" isStale={true} />)
    const badge = screen.getByText('may have failed')
    expect(badge).toHaveClass('bg-amber-100', 'text-amber-700')
  })
})
