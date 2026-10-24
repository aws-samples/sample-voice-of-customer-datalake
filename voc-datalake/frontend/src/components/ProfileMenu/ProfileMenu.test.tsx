/**
 * @fileoverview ProfileMenu: WAI-ARIA menu button (open/close, keyboard,
 * focus return, click outside) and its items (My profile, Sign out).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import { TestRouter } from '../../test/TestRouter'
import ProfileMenu from './ProfileMenu'

const ADMIN = { username: 'e2e-admin', email: 'e2e-admin@example.com', name: 'E2E admin' }

function renderMenu(options: { isAdmin?: boolean; user?: { name?: string; email?: string; username?: string } } = {}) {
  const onSignOut = vi.fn<() => void>()
  render(
    <TestRouter initialEntries={['/']}>
      <button type="button">Elsewhere</button>
      <ProfileMenu user={options.user ?? ADMIN} isAdmin={options.isAdmin ?? true} onSignOut={onSignOut} />
      <Routes>
        <Route path="/" element={<div>Home page</div>} />
        <Route path="/account" element={<div>Account page</div>} />
      </Routes>
    </TestRouter>,
  )
  return { onSignOut, trigger: screen.getByRole('button', { name: 'Account menu for E2E admin' }) }
}

describe('ProfileMenu trigger', () => {
  it('is a closed menu button named after the user, showing their initials', () => {
    const { trigger } = renderMenu()
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent(/^EA$/)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('falls back to the email for the name and initial', () => {
    render(
      <TestRouter initialEntries={['/']}>
        <ProfileMenu user={{ username: 'u1', email: 'alex@example.com' }} isAdmin={false} onSignOut={() => undefined} />
      </TestRouter>,
    )
    expect(screen.getByRole('button', { name: 'Account menu for alex@example.com' })).toHaveTextContent(/^A$/)
  })
})

describe('ProfileMenu opening', () => {
  it('opens on click with name, email, the admin badge and both items, focusing the first item', async () => {
    const { trigger } = renderMenu()
    await userEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Account menu for E2E admin' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(menu).toHaveTextContent(/E2E admin.*e2e-admin@example\.com.*Administrator/)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['My profile', 'Sign out'])
    expect(screen.getByRole('menuitem', { name: 'My profile' })).toHaveFocus()
  })

  it('shows no Administrator badge for a non-admin', async () => {
    const { trigger } = renderMenu({ isAdmin: false })
    await userEvent.click(trigger)
    expect(screen.getByRole('menu')).not.toHaveTextContent('Administrator')
  })

  it.each([
    ['{Enter}', 'My profile'],
    [' ', 'My profile'],
    ['{ArrowDown}', 'My profile'],
    ['{ArrowUp}', 'Sign out'],
  ])('opens from the keyboard with %s and focuses %s', async (key, focused) => {
    const { trigger } = renderMenu()
    trigger.focus()
    await userEvent.keyboard(key)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: focused })).toHaveFocus()
  })
})

describe('ProfileMenu keyboard and dismissal', () => {
  it('moves with the arrow keys, wrapping, and Home/End', async () => {
    const { trigger } = renderMenu()
    await userEvent.click(trigger)
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'My profile' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'My profile' })).toHaveFocus()
  })

  it('closes on Escape and gives focus back to the button', async () => {
    const { trigger } = renderMenu()
    await userEvent.click(trigger)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on a click outside', async () => {
    const { trigger } = renderMenu()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes when the button is clicked again', async () => {
    const { trigger } = renderMenu()
    await userEvent.click(trigger)
    await userEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('ProfileMenu items', () => {
  it('"My profile" goes to /account and closes the menu', async () => {
    const { trigger } = renderMenu()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitem', { name: 'My profile' }))
    expect(screen.getByText('Account page')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('"Sign out" calls the sign-out handler once', async () => {
    const { trigger, onSignOut } = renderMenu()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('fits a phone: the menu is capped to the viewport width and wraps a long email', async () => {
    const { trigger } = renderMenu({ user: { ...ADMIN, email: 'a-very-long-address-that-would-overflow@example.com' } })
    await userEvent.click(trigger)
    expect(screen.getByRole('menu')).toHaveClass('max-w-[calc(100vw-2rem)]', 'right-0')
    expect(screen.getByText(/a-very-long-address/)).toHaveClass('[overflow-wrap:anywhere]')
  })
})
