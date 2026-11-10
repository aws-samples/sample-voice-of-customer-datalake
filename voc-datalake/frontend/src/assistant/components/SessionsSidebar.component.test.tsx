/**
 * The wide panels' collapsible conversation sidebar (`/chat`, full screen):
 * collapse to a rail and back, the persisted preference, the rail's New
 * conversation button, keyboard use (focus stays on the toggle), and that
 * the rail's toggle is the only collapse control (no header duplicate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { screen, within } from '@testing-library/react'
import { textRunEvents as textRun } from '@test/assistantDoubles'
import { openPanel, renderChatPage, typeAndSend } from '@test/assistantPanelHarness'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'

// The scripted agent replaces the transport and the sessions API (both hoisted above the imports).
const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createScriptedRunAgent())
vi.mock('../sessions/sessionsApi', agent.sessionsModule)
vi.mock('../agui/client', agent.clientModule)
const { scripts } = agent

const COLLAPSE = 'Collapse conversation list'
const EXPAND = 'Expand conversation list'

function sidebar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Conversations' })
}

function sidebarButton(name: string): HTMLElement {
  return within(sidebar()).getByRole('button', { name })
}

async function openFullScreen() {
  const user = await openPanel()
  act(() => {
    useAssistantUiStore.setState({ mode: 'fullscreen' })
  })
  return user
}

describe('SessionsSidebar', () => {
  beforeEach(() => {
    // The stub's restore is this hook's teardown (vitest runs a returned function after each test).
    const restoreScrollIntoView = stubElementScrollIntoView()
    scripts.length = 0
    useThreadStore.getState().reset()
    useAssistantUiStore.getState().reset()
    return restoreScrollIntoView
  })

  describe('collapse and expand', () => {
    it('starts expanded with the full list and a collapse button', () => {
      renderChatPage()
      expect(sidebar()).toHaveAttribute('data-collapsed', 'false')
      expect(within(sidebar()).getByRole('heading', { level: 3, name: 'History' })).toBeInTheDocument()
      expect(sidebarButton(COLLAPSE)).toHaveAttribute('title', COLLAPSE)
    })

    it('collapses to a narrow rail with only New conversation and expand', async () => {
      const user = renderChatPage()
      await user.click(sidebarButton(COLLAPSE))
      expect(sidebar()).toHaveClass('w-12')
      expect(within(sidebar()).queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
      expect(within(sidebar()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toStrictEqual([EXPAND, 'New conversation'])
    })

    it('expands back to the full list', async () => {
      const user = renderChatPage()
      await user.click(sidebarButton(COLLAPSE))
      await user.click(sidebarButton(EXPAND))
      expect(sidebar()).toHaveClass('w-64')
      expect(within(sidebar()).getByRole('heading', { level: 3, name: 'History' })).toBeInTheDocument()
    })

    it('marks the toggle as a disclosure of the sidebar', async () => {
      const user = renderChatPage()
      const collapse = sidebarButton(COLLAPSE)
      expect(collapse).toHaveAttribute('aria-expanded', 'true')
      expect(collapse).toHaveAttribute('aria-controls', sidebar().id)
      await user.click(collapse)
      expect(sidebarButton(EXPAND)).toHaveAttribute('aria-expanded', 'false')
    })

    it('starts a new conversation from the rail', async () => {
      const user = renderChatPage()
      scripts.push(textRun('r1', 'a1', 'First answer.'))
      await typeAndSend(user, 'First question')
      await screen.findByText('First answer.')
      await user.click(sidebarButton(COLLAPSE))
      await user.click(sidebarButton('New conversation'))
      expect(screen.queryByText('First answer.')).not.toBeInTheDocument()
      expect(screen.getByText('How can I help?')).toBeInTheDocument()
    })
  })

  describe('persistence', () => {
    it('stores the collapsed preference in the assistant UI store', async () => {
      const user = renderChatPage()
      await user.click(sidebarButton(COLLAPSE))
      expect(useAssistantUiStore.getState().sessionsCollapsed).toBe(true)
      await user.click(sidebarButton(EXPAND))
      expect(useAssistantUiStore.getState().sessionsCollapsed).toBe(false)
    })

    it('renders the rail straight away when the stored preference is collapsed', () => {
      useAssistantUiStore.setState({ sessionsCollapsed: true })
      renderChatPage()
      expect(sidebar()).toHaveAttribute('data-collapsed', 'true')
      expect(sidebarButton(EXPAND)).toBeInTheDocument()
    })

    it('applies the same preference to full screen', async () => {
      useAssistantUiStore.setState({ sessionsCollapsed: true })
      await openFullScreen()
      expect(sidebar()).toHaveAttribute('data-collapsed', 'true')
    })
  })

  describe('keyboard', () => {
    it('collapses with Enter and keeps focus on the toggle', async () => {
      const user = renderChatPage()
      sidebarButton(COLLAPSE).focus()
      await user.keyboard('{Enter}')
      expect(sidebar()).toHaveAttribute('data-collapsed', 'true')
      expect(sidebarButton(EXPAND)).toHaveFocus()
    })

    it('expands with Space and keeps focus on the toggle', async () => {
      useAssistantUiStore.setState({ sessionsCollapsed: true })
      const user = renderChatPage()
      sidebarButton(EXPAND).focus()
      await user.keyboard(' ')
      expect(sidebar()).toHaveAttribute('data-collapsed', 'false')
      expect(sidebarButton(COLLAPSE)).toHaveFocus()
    })

    it('reaches the rail New conversation button with Tab after the toggle', async () => {
      useAssistantUiStore.setState({ sessionsCollapsed: true })
      const user = renderChatPage()
      sidebarButton(EXPAND).focus()
      await user.tab()
      expect(sidebarButton('New conversation')).toHaveFocus()
    })
  })

  describe('one collapse control (live 5.14: the header and the rail both had one)', () => {
    it('on /chat the header has no Hide / Show conversations button; the rail toggle is the only one', () => {
      renderChatPage()
      expect(screen.queryByRole('button', { name: /^(Hide|Show) conversations$/u })).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: COLLAPSE })).toHaveLength(1)
    })

    it('in full screen the header has none either, and the rail toggle collapses the list', async () => {
      const user = await openFullScreen()
      expect(screen.queryByRole('button', { name: /^(Hide|Show) conversations$/u })).not.toBeInTheDocument()
      await user.click(sidebarButton(COLLAPSE))
      expect(sidebar()).toHaveAttribute('data-collapsed', 'true')
    })
  })
})
