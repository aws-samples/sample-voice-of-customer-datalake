/**
 * The header's workspace menu: nothing outside a workspace; inside one a WAI-ARIA menu button whose menu lists the
 * other workspaces (full page loads to `/w/{slug}/dashboard`; not one the server refused in this tab), then Members
 * and Workspace settings (the in-app `/members` and `/workspace-settings` pages).
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
import { forgetRefused, rememberRefused } from './refusedWorkspaces'
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

/** The workspace's own pages, last in every menu. */
const OWN_PAGES = [['Members', '/members'], ['Workspace settings', '/workspace-settings']]

beforeEach(() => resetFetchApi())
afterEach(() => {
  setCurrentWorkspace(null)
  forgetRefused()
})

describe('WorkspaceMenu', () => {
  it('renders nothing outside a workspace', () => {
    const { container } = renderMenu([ACME, JUNIPER])
    expect(container).toHaveTextContent(/^Elsewhere$/)
  })

  it.each<[string, readonly object[], readonly string[]]>([
    ['with one workspace', [ACME], []],
    ['when every other workspace was refused in this tab', [ACME, JUNIPER], [JUNIPER.id]],
  ])('%s, names the current one and offers only its own pages', async (_case, workspaces, refused) => {
    for (const id of refused) rememberRefused(id)
    act(() => setCurrentWorkspace(ACME))
    renderMenu(workspaces)
    await userEvent.click(await screen.findByRole('button', { name: 'Workspace: Acme Outfitters, Admin. Workspace menu' }))
    expect(items()).toStrictEqual(OWN_PAGES)
  })

  it('opens a menu of the other workspaces, each a full page load to its dashboard, then its own pages', async () => {
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME, JUNIPER])
    // The current workspace and its role are in the accessible names (inside role="menu" only items are read).
    const trigger = await screen.findByRole('button', { name: 'Workspace: Acme Outfitters, Admin. Switch workspace' })
    await userEvent.click(trigger)
    expect(screen.getByRole('menu', { name: 'Workspace: Acme Outfitters, Admin. Switch workspace' })).toHaveTextContent(/Current workspace.*Acme Outfitters.*Admin/)
    expect(items()).toStrictEqual([['Juniper Trail Co.Editor', '/w/juniper/dashboard'], ...OWN_PAGES])
    expect(screen.getByRole('menuitem', { name: /Juniper Trail Co./ })).toHaveFocus()
  })

  it('leaves out a workspace the server refused in this tab', async () => {
    const field = { id: 'ws_01JCFLDT0000000000000000F1', slug: 'acme-field', name: 'Acme Outfitters Field Team', role: 'viewer' }
    rememberRefused(JUNIPER.id)
    act(() => setCurrentWorkspace(ACME))
    renderMenu([ACME, field, JUNIPER])
    await userEvent.click(await screen.findByRole('button', { name: /Switch workspace/ }))
    expect(items()).toStrictEqual([['Acme Outfitters Field TeamViewer', '/w/acme-field/dashboard'], ...OWN_PAGES])
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

  it.each(['Members', 'Workspace settings'])('closes when %s is chosen', async (name) => {
    act(() => setCurrentWorkspace(JUNIPER))
    renderMenu([JUNIPER])
    await userEvent.click(await screen.findByRole('button', { name: /Workspace menu/ }))
    await userEvent.click(screen.getByRole('menuitem', { name }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
