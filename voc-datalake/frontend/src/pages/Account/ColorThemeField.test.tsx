/**
 * Account → Preferences → Colour theme: "Workspace default (<name>)" plus the five themes,
 * stored as the person's own choice in the theme store.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useThemeStore } from '../../theme/themeStore'
import ColorThemeField from './ColorThemeField'

beforeEach(() => {
  useThemeStore.setState({ colorTheme: 'workspace', workspaceTheme: 'nord' })
})

describe('ColorThemeField', () => {
  it('offers the workspace default, named after the workspace theme, and the five themes', () => {
    render(<ColorThemeField />)
    const group = screen.getByRole('radiogroup', { name: 'Colour theme' })
    expect(group).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((r) => r.textContent))
      .toStrictEqual(['Workspace default (Nord)', 'Kiro', 'Nord', 'Dracula', 'High contrast', 'Quick'])
    expect(screen.getByRole('radio', { name: 'Workspace default (Nord)' })).toHaveAttribute('aria-checked', 'true')
  })

  it('previews the workspace default in the workspace theme', () => {
    const { container } = render(<ColorThemeField />)
    expect(container.querySelector('[data-theme]')?.getAttribute('data-theme')).toMatch(/^nord-/)
  })

  it('stores a picked theme as my own choice', async () => {
    render(<ColorThemeField />)
    await userEvent.click(screen.getByRole('radio', { name: 'Dracula' }))
    expect(useThemeStore.getState().colorTheme).toBe('dracula')
    expect(screen.getByRole('radio', { name: 'Dracula' })).toHaveAttribute('aria-checked', 'true')
  })

  it('goes back to following the workspace', async () => {
    useThemeStore.setState({ colorTheme: 'quick' })
    render(<ColorThemeField />)
    await userEvent.click(screen.getByRole('radio', { name: 'Workspace default (Nord)' }))
    expect(useThemeStore.getState().colorTheme).toBe('workspace')
  })
})
