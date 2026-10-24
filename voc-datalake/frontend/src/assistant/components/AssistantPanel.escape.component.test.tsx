/**
 * Escape closes the top-most layer (live 5.14: it closed only the review modal,
 * never the floating panel): a dialog over the panel first, then the sessions
 * drawer, then full screen → expanded, then the floating card itself — with
 * focus back on the launcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { screen, within } from '@testing-library/react'
import { stubElementScrollIntoView } from '@test/stubScrollTo'

const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createScriptedRunAgent())
vi.mock('../agui/client', agent.clientModule)
vi.mock('../sessions/sessionsApi', agent.sessionsModule)

import { listSessions } from '../sessions/sessionsApi'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { openPanel } from '@test/assistantPanelHarness'
import { rowAction } from '@test/assistantRowMenu'

function panelOpen(): boolean {
  return screen.queryByRole('dialog', { name: 'Assistant' }) !== null
}

describe('Escape on the floating assistant', () => {
  beforeEach(() => {
    stubElementScrollIntoView()
    useThreadStore.getState().reset()
    useAssistantUiStore.getState().reset()
    vi.mocked(listSessions).mockResolvedValue([])
  })

  it.each(['bubble', 'expanded'] as const)('closes the %s card and puts focus back on the launcher', async (mode) => {
    useAssistantUiStore.setState({ mode })
    const user = await openPanel()
    await user.keyboard('{Escape}')
    expect(panelOpen()).toBe(false)
    expect(screen.getByRole('button', { name: 'Open assistant' })).toHaveFocus()
  })

  it('leaves full screen for the expanded card first, and closes it on the next Escape', async () => {
    const user = await openPanel()
    act(() => {
      useAssistantUiStore.setState({ mode: 'fullscreen' })
    })
    await user.keyboard('{Escape}')
    expect(useAssistantUiStore.getState().mode).toBe('expanded')
    expect(panelOpen()).toBe(true)
    await user.keyboard('{Escape}')
    expect(panelOpen()).toBe(false)
  })

  it('closes the sessions drawer and leaves the panel open', async () => {
    const user = await openPanel()
    await user.click(screen.getByRole('button', { name: 'Past conversations' }))
    await screen.findByRole('complementary', { name: 'Past conversations' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: 'Past conversations' })).not.toBeInTheDocument()
    expect(panelOpen()).toBe(true)
  })

  it('closes a confirm dialog over the panel and leaves the panel open', async () => {
    vi.mocked(listSessions).mockResolvedValue([{
      id: 'old-1', title: 'Old chat', customTitle: null, kind: 'assistant', messageCount: 2,
      createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
    }])
    const user = await openPanel()
    await user.click(screen.getByRole('button', { name: 'Past conversations' }))
    const drawer = await screen.findByRole('complementary', { name: 'Past conversations' })
    await rowAction(user, 'Old chat', 'Delete', within(drawer))
    expect(screen.getByRole('dialog', { name: /Delete “Old chat”\?/u })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /Delete “Old chat”\?/u })).not.toBeInTheDocument()
    expect(panelOpen()).toBe(true)
  })
})
