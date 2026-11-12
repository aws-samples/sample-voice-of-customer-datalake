/**
 * The header's workspace menu: nothing outside a workspace; inside one a WAI-ARIA menu button whose menu lists the
 * other workspaces (full page loads to `/w/{slug}/dashboard`), then Members (the in-app `/members` page).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'
import { TestRouter } from '../test/TestRouter'

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { setCurrentWorkspace } from './currentWorkspace'
import WorkspaceMenu from './WorkspaceMenu'
import { ACME, JUNIPER } from '../test/workspaceFixtures'

function renderMenu(workspaces: readonly object[]) {
  routeFetchApi({ 'GET /me/workspaces': () => ({ workspaces }) })
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TestRouter initialEntries={['/dashboard']}>
        <button type="button">Elsewhere</button>
        <WorkspaceMenu />
      </TestRouter>
    </QueryClientProvider>,
  )
}

/** Every menu item as [text, href]. */
const items = () => screen.getAllByRole('menuitem').map((item) => [item.textContent, item.getAttribute('href')])

beforeEach(() => resetFetchApi())
afterEach(() => setCurrentWorkspace(null))

describe('WorkspaceMenu', () => {
  it('renders nothing outside a workspace', () => {
    const { container } = renderMenu([ACME, JUNIPER])
    expect(container).toHaveTextContent(/^Elsewhere$/)
  })

  it('with one workspace, names it and offers only Members', async () => {
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME])
    await userEvent.click(await screen.findByRole('button', { name: 'Workspace: Acme Outfitters, Admin. Workspace menu' }))
    expect(items()).toStrictEqual([['Members', '/members']])
  })

  it('opens a menu of the other workspaces, each a full page load to its dashboard, then Members', async () => {
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME, JUNIPER])
    // The current workspace and its role are in the accessible names (inside role="menu" only items are read).
    const trigger = await screen.findByRole('button', { name: 'Workspace: Acme Outfitters, Admin. Switch workspace' })
    await userEvent.click(trigger)
    expect(screen.getByRole('menu', { name: 'Workspace: Acme Outfitters, Admin. Switch workspace' })).toHaveTextContent(/Current workspace.*Acme Outfitters.*Admin/)
    expect(items()).toStrictEqual([['Juniper Trail Co.Editor', '/w/juniper/dashboard'], ['Members', '/members']])
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

  it('closes when Members is chosen', async () => {
    act(() => setCurrentWorkspace(JUNIPER))
    renderMenu([JUNIPER])
    await userEvent.click(await screen.findByRole('button', { name: /Workspace menu/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Members' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
