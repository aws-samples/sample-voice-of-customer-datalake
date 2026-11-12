/**
 * The header's workspace menu: nothing outside a workspace, the name alone with one, and with two or more a
 * WAI-ARIA menu button whose items are full page loads to `/w/{slug}/dashboard`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { setCurrentWorkspace } from './currentWorkspace'
import WorkspaceMenu from './WorkspaceMenu'
import { ACME, JUNIPER } from '../test/workspaceFixtures'

function renderMenu(workspaces: readonly object[]) {
  routeFetchApi({ 'GET /me/workspaces': () => ({ workspaces }) })
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <button type="button">Elsewhere</button>
      <WorkspaceMenu />
    </QueryClientProvider>,
  )
}

beforeEach(() => resetFetchApi())
afterEach(() => setCurrentWorkspace(null))

describe('WorkspaceMenu', () => {
  it('renders nothing outside a workspace', () => {
    const { container } = renderMenu([ACME, JUNIPER])
    expect(container).toHaveTextContent(/^Elsewhere$/)
  })

  it('shows the one workspace by name, with no menu', async () => {
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME])
    expect(await screen.findByText('Workspace: Acme Outfitters')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Switch workspace/ })).not.toBeInTheDocument()
  })

  it('opens a menu of the other workspaces, each a full page load to its dashboard', async () => {
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME, JUNIPER])
    // The current workspace and its role are in the accessible names (inside role="menu" only items are read).
    const trigger = await screen.findByRole('button', { name: 'Workspace: Acme Outfitters, Admin. Switch workspace' })
    await userEvent.click(trigger)
    expect(screen.getByRole('menu', { name: 'Workspace: Acme Outfitters, Admin. Switch workspace' })).toHaveTextContent(/Current workspace.*Acme Outfitters.*Admin/)
    expect(screen.getAllByRole('menuitem').map((item) => [item.textContent, item.getAttribute('href')]))
      .toStrictEqual([['Juniper Trail Co.Editor', '/w/juniper/dashboard']])
    expect(screen.getByRole('menuitem', { name: /Juniper Trail Co./ })).toHaveFocus()
  })

  it('opens from the keyboard and closes on Escape with focus back on the button', async () => {
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME, JUNIPER])
    const trigger = await screen.findByRole('button', { name: /Switch workspace/ })
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: /Juniper Trail Co./ })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
