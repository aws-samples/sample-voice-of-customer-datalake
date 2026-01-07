import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectHeader from './ProjectHeader'

describe('ProjectHeader', () => {
  it('renders project name', () => {
    render(<ProjectHeader name="Test Project" onBack={vi.fn()} />)
    expect(screen.getByText('Test Project')).toBeInTheDocument()
  })

  it('renders description when provided', () => {
    render(<ProjectHeader name="Test" description="A test description" onBack={vi.fn()} />)
    expect(screen.getByText('A test description')).toBeInTheDocument()
  })

  it('does not render description when not provided', () => {
    render(<ProjectHeader name="Test" onBack={vi.fn()} />)
    expect(screen.queryByText('A test description')).not.toBeInTheDocument()
  })

  it('calls onBack when back button is clicked', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    render(<ProjectHeader name="Test" onBack={onBack} />)
    
    await user.click(screen.getByRole('button'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
