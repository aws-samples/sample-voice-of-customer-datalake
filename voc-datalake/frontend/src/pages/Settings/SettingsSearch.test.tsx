/**
 * Administration's search (7.54.00, SettingsSearch.tsx) as a WAI-ARIA combobox: a listbox of results with an
 * announced count, the active option by `aria-activedescendant`, Enter (or a click) opens its path, Escape clears.
 */
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import SettingsSearch from './SettingsSearch'

function mount() {
  const router = createMemoryRouter([{ path: '*', element: <SettingsSearch isAdmin isPlatformAdmin={false} /> }],
    { initialEntries: ['/admin'] })
  renderWithQueryClient(<RouterProvider router={router} />)
  return { router, user: userEvent.setup(), box: screen.getByRole('combobox', { name: 'Search settings' }) }
}

describe('SettingsSearch', () => {
  it('lists the matches in a listbox and announces how many', async () => {
    const { user, box } = mount()
    await user.type(box, 'radar')
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('option').map((option) => option.textContent)[0]).toBe('Radar in Data sources')
    expect(screen.getByRole('status')).toHaveTextContent(/settings? found/)
  })

  it('moves the active option with the arrow keys and opens it with Enter', async () => {
    const { user, box, router } = mount()
    await user.type(box, 'theme')
    const first = screen.getAllByRole('option')[0]
    expect(box).toHaveAttribute('aria-activedescendant', first?.id)
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect([router.state.location.pathname, box]).toStrictEqual(['/admin/brand/theme', expect.anything()])
    expect(box).toHaveValue('')
  })

  it('says when nothing matches, and Escape clears the query', async () => {
    const { user, box } = mount()
    await user.type(box, 'zzzz')
    expect(screen.getByRole('status')).toHaveTextContent('No setting matches "zzzz"')
    await user.keyboard('{Escape}')
    expect(box).toHaveAttribute('aria-expanded', 'false')
    expect(box).toHaveValue('')
  })

  it('opens a result on a click', async () => {
    const { user, box, router } = mount()
    await user.type(box, 'invite')
    await user.click(screen.getByRole('option', { name: 'People' }))
    expect(router.state.location.pathname).toBe('/admin/people')
  })
})
