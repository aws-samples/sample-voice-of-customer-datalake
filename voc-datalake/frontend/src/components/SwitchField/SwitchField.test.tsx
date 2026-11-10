import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwitchField from './SwitchField'

describe('SwitchField', () => {
  it('is a named switch that reports the new state', async () => {
    const onChange = vi.fn()
    render(<SwitchField label="Email alerts" checked={false} onChange={onChange} />)
    await userEvent.setup().click(screen.getByRole('switch', { name: /Email alerts/ }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  // Wave 5: de "E-Mail-Benachrichtigungen" pushed Admin → System sideways at 390 px / 200 % text.
  it('wraps a long label and hint beside a track that never shrinks', () => {
    render(<SwitchField label="E-Mail-Benachrichtigungen" hint="Hinweis" checked onChange={vi.fn()} />)
    const text = screen.getByTestId('switch-field-text')
    expect(text).toHaveClass('min-w-0', 'break-words', 'hyphens-auto')
    expect(text.closest('label')).toHaveClass('max-w-full')
    expect(text.previousElementSibling).toHaveClass('flex-shrink-0')
  })
})
