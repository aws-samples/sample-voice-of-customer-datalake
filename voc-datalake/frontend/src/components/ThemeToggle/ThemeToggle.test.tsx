import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useThemeStore } from '../../theme/themeStore'
import ThemeToggle from './ThemeToggle'

describe('ThemeToggle', () => {
  beforeEach(() => { useThemeStore.setState({ preference: 'system' }) })

  it('labels the current preference and the one a click switches to', () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'System theme — switch to Light theme' })).toBeInTheDocument()
  })

  it('cycles system → light → dark → system on each click', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)
    const button = screen.getByRole('button')
    const clickAndRead = async () => {
      await user.click(button)
      return {
        preference: useThemeStore.getState().preference,
        name: button.getAttribute('aria-label') ?? '',
      }
    }

    const first = await clickAndRead()
    const second = await clickAndRead()
    const third = await clickAndRead()

    expect([first, second, third]).toStrictEqual([
      { preference: 'light', name: 'Light theme — switch to Dark theme' },
      { preference: 'dark', name: 'Dark theme — switch to System theme' },
      { preference: 'system', name: 'System theme — switch to Light theme' },
    ])
  })

  it('exposes the preference for styling hooks', () => {
    useThemeStore.setState({ preference: 'dark' })
    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toHaveAttribute('data-theme-pref', 'dark')
  })
})
