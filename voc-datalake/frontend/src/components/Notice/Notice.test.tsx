/**
 * @fileoverview Notice: the empty card and the banner, their roles, and their one action.
 * @module components/Notice
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Inbox, Plus, RefreshCw, TriangleAlert } from 'lucide-react'
import Notice from './Notice'

describe('Notice (empty)', () => {
  it('names the empty list with a heading and a hint, and its action fills it', async () => {
    const onClick = vi.fn()
    render(<Notice variant="empty" icon={Inbox} title="No forms yet" text="Create one to start collecting feedback."
      action={{ label: 'Create form', icon: Plus, emphasis: 'primary', onClick }} />)

    expect(screen.getByRole('heading', { level: 2, name: 'No forms yet' })).toBeInTheDocument()
    expect(screen.getByText('Create one to start collecting feedback.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create form' }))

    expect(onClick).toHaveBeenCalledExactlyOnceWith()
  })

  it('has no live role unless the page gives it one', () => {
    const { rerender } = render(<Notice variant="empty" icon={Inbox} title="Nothing here" text="Hint" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    rerender(<Notice variant="empty" role="status" icon={Inbox} title="Nothing here" text="Hint" />)
    expect(screen.getByRole('status')).toHaveTextContent('Nothing hereHint')
  })

  it('renders no button when there is no action', () => {
    render(<Notice variant="empty" icon={Inbox} title="Nothing here" text="Hint" />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('takes a link as its action', () => {
    render(
      <MemoryRouter>
        <Notice variant="empty" icon={Inbox} title="No sources" text="Connect one first." action={{ label: 'Data sources', to: '/scrapers' }} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Data sources' })).toHaveAttribute('href', '/scrapers')
  })
})

describe('Notice (banner)', () => {
  it('announces a failure as an alert in the danger tone', () => {
    render(<Notice variant="banner" tone="danger" role="alert" icon={TriangleAlert} text="Could not load the queue." />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load the queue.')
    expect(alert).toHaveClass('bg-danger-subtle')
  })

  it('shows standing advice as a note in the warn tone, with the action that resolves it', async () => {
    const onClick = vi.fn()
    render(<Notice variant="banner" tone="warn" role="note" className="mb-4" icon={TriangleAlert}
      text="This form is disabled." action={{ label: 'Enable', onClick }} />)

    const note = screen.getByRole('note')
    expect(note).toHaveClass('bg-warn-subtle', 'mb-4')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enable' }))
    expect(onClick).toHaveBeenCalledExactlyOnceWith()
  })

  it('makes a busy action wait, with its icon spinning', () => {
    render(<Notice variant="banner" tone="danger" icon={TriangleAlert} text="Failed."
      action={{ label: 'Try again', icon: RefreshCw, onClick: vi.fn(), busy: true }} />)

    const button = screen.getByRole('button', { name: 'Try again' })
    expect(button).toBeDisabled()
    expect(button.querySelector('svg')).toHaveClass('animate-spin')
  })

  it('disables an action the page marks disabled, without a spinner', () => {
    render(<Notice variant="banner" tone="warn" icon={TriangleAlert} text="Paused."
      action={{ label: 'Resume', icon: RefreshCw, onClick: vi.fn(), disabled: true }} />)

    const button = screen.getByRole('button', { name: 'Resume' })
    expect(button).toBeDisabled()
    expect(button.querySelector('svg')).not.toHaveClass('animate-spin')
  })
})
