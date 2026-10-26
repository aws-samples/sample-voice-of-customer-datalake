import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ProjectHeader from './ProjectHeader'
import { useAssistantUiStore } from '../../assistant/store/assistantStore'
import { required } from '../../components/component-spec-fixtures'

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
    
    await user.click(required(screen.getAllByRole('button').at(0), 'the back button'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('names the icon-only back button and renders the title as the page h1', () => {
    render(<ProjectHeader name="Test" onBack={vi.fn()} />)
    const back = screen.getByRole('button', { name: 'Back to projects' })
    expect(back).toHaveAttribute('title', 'Back to projects')
    expect(screen.getByRole('heading', { level: 1, name: 'Test' })).toBeInTheDocument()
  })

  it('renders no badge or Share button unless asked to', () => {
    render(<ProjectHeader name="Test" onBack={vi.fn()} />)
    expect(screen.queryByTestId('project-visibility-badge')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })

  it('shows the visibility badge and a Share button that announces a dialog', async () => {
    const user = userEvent.setup()
    const onShare = vi.fn()
    render(<ProjectHeader name="Test" visibility="private" onShare={onShare} onBack={vi.fn()} />)

    expect(screen.getByTestId('project-visibility-badge')).toHaveTextContent('Private')
    const share = screen.getByRole('button', { name: 'Share' })
    expect(share).toHaveAttribute('aria-haspopup', 'dialog')
    await user.click(share)
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it('opens the floating assistant from "Ask the assistant"', async () => {
    const user = userEvent.setup()
    useAssistantUiStore.getState().setOpen(false)
    render(<ProjectHeader name="Test" onBack={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Ask the assistant' }))
    expect(useAssistantUiStore.getState().open).toBe(true)
  })

  it('puts the actions on their own row in a header narrower than 52rem so the title keeps the full width', () => {
    render(<ProjectHeader name="Test" onBack={vi.fn()} />)
    const row = screen.getByTestId('project-header')
    expect(row).toHaveClass('flex-wrap', '@[52rem]:flex-nowrap')
    expect(row.parentElement).toHaveClass('@container')
    expect(screen.getByTestId('project-header-actions')).toHaveClass('w-full', '@[52rem]:w-auto')
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('min-w-0', '[overflow-wrap:anywhere]')
  })

  it('gives the clamped description its full text as a tooltip', () => {
    render(<ProjectHeader name="Test" description="A long description that may be clamped" onBack={vi.fn()} />)
    const description = screen.getByText('A long description that may be clamped')
    expect(description).toHaveClass('line-clamp-2')
    expect(description).toHaveAttribute('title', 'A long description that may be clamped')
  })

  it('links to the global Connect page pinned to the project, only when given a projectId', () => {
    const { unmount } = render(<ProjectHeader name="Test" onBack={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /Connect via MCP/ })).not.toBeInTheDocument()
    unmount()

    render(<MemoryRouter><ProjectHeader name="Test" onBack={vi.fn()} projectId="proj 1" /></MemoryRouter>)
    const link = screen.getByRole('link', { name: /Connect via MCP/ })
    expect(link).toHaveAttribute('href', '/connect?project=proj%201')
    expect(link).toHaveAttribute('title', 'Connect an external assistant to this project')
  })
})
