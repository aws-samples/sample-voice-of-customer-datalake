import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import CollapsibleSection from './CollapsibleSection'

function Harness({ size }: Readonly<{ size?: 'md' | 'sm' }>) {
  const [open, setOpen] = useState(false)
  return <CollapsibleSection title="Advanced" open={open} onOpenChange={setOpen} size={size}><p>Question id</p></CollapsibleSection>
}

describe('CollapsibleSection', () => {
  it('opens and closes from its heading button, and mounts its content only while open', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Advanced' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Question id')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Advanced' })).toHaveTextContent('Question id')
  })

  it('tells its owner about every toggle (controlled)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<CollapsibleSection title="Logic" open onOpenChange={onOpenChange}><p>Rules</p></CollapsibleSection>)
    await user.click(screen.getByRole('button', { name: 'Logic' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the page-section title at 18 px by default, and 14 px with size="sm"', () => {
    const { unmount } = render(<Harness />)
    expect(screen.getByRole('heading', { name: 'Advanced' })).toHaveClass('text-lg')
    unmount()
    render(<Harness size="sm" />)
    const heading = screen.getByRole('heading', { name: 'Advanced' })
    expect(heading).toHaveClass('text-sm', 'font-semibold')
    expect(heading).not.toHaveClass('text-lg')
    expect(heading.parentElement).toHaveClass('px-3', 'py-2')
  })
})
