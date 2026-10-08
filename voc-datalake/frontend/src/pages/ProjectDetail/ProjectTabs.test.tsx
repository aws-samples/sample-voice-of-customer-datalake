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

  /** Renders the tabs with a fresh `onTabChange` spy and a user to drive them. */
  function renderWithUser() {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(<ProjectTabs {...defaultProps} onTabChange={onTabChange} />)
    return { user, onTabChange }
  }

  /** Puts keyboard focus on the Overview tab, where every key test starts. */
  function focusOverview() {
    screen.getByRole('tab', { name: 'Overview' }).focus()
  }

  it('renders all tabs', () => {
    render(<ProjectTabs {...defaultProps} />)
    expect(screen.getByText('Overview')).toBeInTheDocument()
    expect(screen.getByText(/Personas/)).toBeInTheDocument()
    expect(screen.getByText(/Documents/)).toBeInTheDocument()
  })

  it('renders no chat tab (the floating assistant replaces it)', () => {
    render(<ProjectTabs {...defaultProps} />)
    expect(screen.queryByText('AI Chat')).not.toBeInTheDocument()
  })

  it('renders no Export / MCP tab (the global MCP on /connect replaces it)', () => {
    render(<ProjectTabs {...defaultProps} />)
    expect(screen.queryByRole('tab', { name: /MCP|Export/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual([
      'Overview', 'Personas(3)', 'Product', 'Documents(5)',
    ])
  })

  it('displays personas count', () => {
    render(<ProjectTabs {...defaultProps} personasCount={7} />)
    expect(screen.getByText(/\(7\)/)).toBeInTheDocument()
  })

  it('displays documents count', () => {
    render(<ProjectTabs {...defaultProps} documentsCount={12} />)
    expect(screen.getByText(/\(12\)/)).toBeInTheDocument()
  })

  it('highlights the active tab and marks it selected', () => {
    render(<ProjectTabs {...defaultProps} activeTab="personas" />)
    const personasTab = screen.getByRole('tab', { name: /Personas/ })
    expect(personasTab).toHaveClass('tab', 'tab-active')
    expect(personasTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false')
  })

  it('exposes the tabs as a labelled tablist, not a navigation landmark', () => {
    render(<ProjectTabs {...defaultProps} />)
    expect(screen.getByRole('tablist')).toHaveAccessibleName()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    // Overview, Personas, Product, Documents (project chat moved to the floating
    // assistant, Export / MCP to the global Connect page).
    expect(screen.getAllByRole('tab')).toHaveLength(4)
  })

  it('only the selected tab is in the Tab order (roving tabindex)', () => {
    render(<ProjectTabs {...defaultProps} activeTab="documents" />)
    const tabIndexes = screen.getAllByRole('tab').map((tab) => tab.getAttribute('tabindex'))
    expect(tabIndexes).toStrictEqual(['-1', '-1', '-1', '0'])
  })

  it('arrow keys move the selection and wrap around', async () => {
    const { user, onTabChange } = renderWithUser()

    focusOverview()
    await user.keyboard('{ArrowRight}')
    expect(onTabChange).toHaveBeenLastCalledWith('personas')
    expect(screen.getByRole('tab', { name: /Personas/ })).toHaveFocus()

    focusOverview()
    await user.keyboard('{ArrowLeft}')
    expect(onTabChange).toHaveBeenLastCalledWith('documents')
  })

  it('Home and End jump to the first and last tab', async () => {
    const { user, onTabChange } = renderWithUser()

    focusOverview()
    await user.keyboard('{ArrowLeft}')
    await user.keyboard('{Home}')
    expect(onTabChange).toHaveBeenLastCalledWith('overview')
    await user.keyboard('{End}')
    expect(onTabChange).toHaveBeenLastCalledWith('documents')
  })

  it('ignores other keys', async () => {
    const { user, onTabChange } = renderWithUser()
    focusOverview()
    await user.keyboard('a')
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('calls onTabChange when tab is clicked', async () => {
    const { user, onTabChange } = renderWithUser()
    
    await user.click(screen.getByText(/Documents/))
    expect(onTabChange).toHaveBeenCalledWith('documents')
  })

  it('calls onTabChange with correct tab id for each tab', async () => {
    const { user, onTabChange } = renderWithUser()
    
    await user.click(screen.getByText('Product'))
    expect(onTabChange).toHaveBeenCalledWith('product')
  })
})
