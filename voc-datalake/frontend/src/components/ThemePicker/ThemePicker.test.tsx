/**
 * ThemePicker: a WAI-ARIA radio group (one tab stop, arrows move and check, read-only
 * moves focus only) whose previews carry the theme's `data-theme` in the painted mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ThemePicker from './ThemePicker'
import type { ThemeOption } from './ThemePicker'

const OPTIONS: ThemeOption[] = [
  { value: 'kiro', theme: 'kiro', label: 'Kiro' },
  { value: 'nord', theme: 'nord', label: 'Nord' },
  { value: 'dracula', theme: 'dracula', label: 'Dracula' },
]

function mount(props: Partial<Parameters<typeof ThemePicker>[0]> = {}) {
  const onChange = vi.fn<(value: string) => void>()
  render(
    <>
      <span id="label">Colour theme</span>
      <ThemePicker options={OPTIONS} value="nord" onChange={onChange} labelledBy="label" {...props} />
    </>,
  )
  return onChange
}

afterEach(() => { delete document.documentElement.dataset.mode })

describe('ThemePicker', () => {
  it('is a labelled radio group with the value checked', () => {
    mount()
    expect(screen.getByRole('radiogroup', { name: 'Colour theme' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Nord' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Kiro' })).toHaveAttribute('aria-checked', 'false')
  })

  it('has one tab stop, the checked card', () => {
    mount()
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toStrictEqual([-1, 0, -1])
  })

  it('makes the first card the tab stop when nothing is checked', () => {
    mount({ value: 'missing' })
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toStrictEqual([0, -1, -1])
  })

  it('checks a clicked card', async () => {
    const onChange = mount()
    await userEvent.click(screen.getByRole('radio', { name: 'Dracula' }))
    expect(onChange).toHaveBeenCalledWith('dracula')
  })

  it('does not report the card that is already checked', async () => {
    const onChange = mount()
    await userEvent.click(screen.getByRole('radio', { name: 'Nord' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves focus and checks with the arrow keys, wrapping around', async () => {
    const onChange = mount()
    screen.getByRole('radio', { name: 'Nord' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Dracula' })).toHaveFocus()
    expect(onChange).toHaveBeenLastCalledWith('dracula')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Kiro' })).toHaveFocus()
    expect(onChange).toHaveBeenLastCalledWith('kiro')
  })

  it('read-only: arrows move focus, nothing is checked', async () => {
    const onChange = mount({ readOnly: true })
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-readonly', 'true')
    screen.getByRole('radio', { name: 'Nord' }).focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'Kiro' })).toHaveFocus()
    await userEvent.click(screen.getByRole('radio', { name: 'Dracula' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('wraps each preview in its theme, in the mode painted on <html>', async () => {
    document.documentElement.dataset.mode = 'light'
    const { container } = render(<ThemePicker options={OPTIONS} value="kiro" onChange={vi.fn()} labelledBy="x" />)
    const themes = () => [...container.querySelectorAll('[data-theme]')].map((el) => el.getAttribute('data-theme'))
    expect(themes()).toStrictEqual(['kiro-light', 'nord-light', 'dracula-light'])
    document.documentElement.dataset.mode = 'dark'
    await waitFor(() => expect(themes()).toStrictEqual(['kiro-dark', 'nord-dark', 'dracula-dark']))
  })
})
