import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PressedChoices from './PressedChoices'

const CHOICES = ['one', 'two'] as const

function renderChoices(onChange = vi.fn<(choice: 'one' | 'two') => void>()) {
  render(<PressedChoices label="Pick" choices={CHOICES} value="one" onChange={onChange} display={(c) => c.toUpperCase()}
    className="row" pressedClassName="on" idleClassName="off" />)
  return onChange
}

describe('PressedChoices', () => {
  it('names the group and presses exactly the current choice', () => {
    renderChoices()
    expect(screen.getByRole('group', { name: 'Pick' })).toHaveClass('row')
    expect(screen.getByRole('button', { name: 'ONE' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'TWO' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('styles pressed and idle choices with their own classes', () => {
    renderChoices()
    expect(screen.getByRole('button', { name: 'ONE' })).toHaveClass('on')
    expect(screen.getByRole('button', { name: 'TWO' })).toHaveClass('off')
  })

  it('reports the clicked choice', async () => {
    const onChange = renderChoices()
    await userEvent.setup().click(screen.getByRole('button', { name: 'TWO' }))
    expect(onChange).toHaveBeenCalledWith('two')
  })
})
