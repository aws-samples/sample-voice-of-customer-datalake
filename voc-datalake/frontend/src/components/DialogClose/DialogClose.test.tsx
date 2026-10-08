import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import DialogClose from './DialogClose'

describe('DialogClose', () => {
  it('has an accessible name that does not collide with footer Close/Cancel buttons', () => {
    render(<DialogClose onClick={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Dismiss' })
    expect(button).toHaveClass('dialog-close')
    expect(button).toHaveAttribute('type', 'button')
  })

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn()
    render(<DialogClose onClick={onClick} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not fire while disabled', async () => {
    const onClick = vi.fn()
    render(<DialogClose onClick={onClick} disabled />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('takes a custom accessible name for surfaces that already have a Dismiss control', () => {
    render(<DialogClose onClick={vi.fn()} label="Close assistant" />)
    const button = screen.getByRole('button', { name: 'Close assistant' })
    expect(button).toHaveAttribute('title', 'Close assistant')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('merges extra classes', () => {
    render(<DialogClose onClick={vi.fn()} className="flex-shrink-0" />)
    expect(screen.getByRole('button')).toHaveClass('dialog-close', 'flex-shrink-0')
  })
})
