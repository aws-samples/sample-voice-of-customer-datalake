import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectTabs from './ProjectTabs'

describe('ProjectTabs', () => {
  const defaultProps = {
    activeTab: 'overview' as const,
    personasCount: 3,
    documentsCount: 5,
    onTabChange: vi.fn(),
  }

  it('renders all four tabs', () => {
    render(<ProjectTabs {...defaultProps} />)
    expect(screen.getByText('Overview')).toBeInTheDocument()
    expect(screen.getByText(/Personas/)).toBeInTheDocument()
    expect(screen.getByText(/Documents/)).toBeInTheDocument()
    expect(screen.getByText('AI Chat')).toBeInTheDocument()
  })

  it('displays personas count', () => {
    render(<ProjectTabs {...defaultProps} personasCount={7} />)
    expect(screen.getByText(/\(7\)/)).toBeInTheDocument()
  })

  it('displays documents count', () => {
    render(<ProjectTabs {...defaultProps} documentsCount={12} />)
    expect(screen.getByText(/\(12\)/)).toBeInTheDocument()
  })

  it('highlights active tab with blue styling', () => {
    render(<ProjectTabs {...defaultProps} activeTab="personas" />)
    const personasTab = screen.getByText(/Personas/).closest('button')
    expect(personasTab).toHaveClass('border-blue-600', 'text-blue-600')
  })

  it('calls onTabChange when tab is clicked', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(<ProjectTabs {...defaultProps} onTabChange={onTabChange} />)
    
    await user.click(screen.getByText(/Documents/))
    expect(onTabChange).toHaveBeenCalledWith('documents')
  })

  it('calls onTabChange with correct tab id for each tab', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(<ProjectTabs {...defaultProps} onTabChange={onTabChange} />)
    
    await user.click(screen.getByText('AI Chat'))
    expect(onTabChange).toHaveBeenCalledWith('chat')
  })
})
