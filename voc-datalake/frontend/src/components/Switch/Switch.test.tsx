import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Switch from './Switch'

describe('Switch', () => {
  it('is a named switch that reports the new state', async () => {
    const onChange = vi.fn()
    render(<Switch label="Desktop notifications" checked={false} onChange={onChange} disabled={false} />)
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Desktop notifications' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  // Wave 5: de "Desktop-Benachrichtigungen" pushed the page sideways at 390 px / 200 % text.
  it('wraps a long label beside a track that never shrinks', () => {
    render(<Switch label="Desktop-Benachrichtigungen" checked onChange={vi.fn()} disabled={false} />)
    const label = screen.getByTestId('switch-label')
    expect(label).toHaveClass('min-w-0', 'break-words', 'hyphens-auto')
    expect(label.closest('label')).toHaveClass('max-w-full')
    expect(label.previousElementSibling).toHaveClass('flex-shrink-0')
  })
})
