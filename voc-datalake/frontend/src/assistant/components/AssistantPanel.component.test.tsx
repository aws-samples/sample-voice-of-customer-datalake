/**
 * Assistant UI end to end with the transport mocked: streaming text, approval
 * cards (B2's module mocked) → exactly one resume run, panel modes, the /chat
 * route, and reset on sign-out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { EventType } from '@ag-ui/core'
import { screen, waitFor, within } from '@testing-library/react'
import { render } from '@test/test-utils'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { tabTimes } from '@test/keyboard'
import type { AguiEvent } from '../agui/sse'
import type { RunAgentInput } from '@ag-ui/core'
import type { ApprovalCardProps } from '../types'

const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createScriptedRunAgent())
const { runs, scripts } = agent

vi.mock('../agui/client', agent.clientModule)
vi.mock('../sessions/sessionsApi', agent.sessionsModule)

vi.mock('../approvals/ApprovalCard', () => ({
  default: ({ interrupt, toolCall, onResolve }: ApprovalCardProps) => (
    <div data-testid="approval-card">
      <span>{toolCall.name}</span>
      <span data-testid={`args-${toolCall.id}`}>{JSON.stringify(toolCall.args)}</span>
      <button
        type="button"
        onClick={() => onResolve({ interruptId: interrupt.id, toolCallId: interrupt.toolCallId, outcome: { status: 'executed', summary: `did ${toolCall.name}` } })}
      >
        approve {toolCall.id}
      </button>
    </div>
  ),
}))

import AssistantRoot from './AssistantRoot'
import Chat from '../../pages/Chat/Chat'
import { saveSession } from '../sessions/sessionsApi'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { useAuthStore } from '../../store/authStore'
import { HANG, textRunEvents as textRun, toolCallEvents as toolCall } from '@test/assistantDoubles'
import { openPanel, renderChatPage, typeAndSend as send } from '@test/assistantPanelHarness'
import type { User } from '@test/assistantPanelHarness'

const interruptRun: AguiEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 't', runId: 'r1' },
  ...toolCall('w1', 'create_document', '{"project_id":"p1","title":"A","content":"x"}'),
  ...toolCall('w2', 'update_project', '{"project_id":"p1","name":"B"}'),
  {
    type: EventType.RUN_FINISHED,
    threadId: 't',
    runId: 'r1',
    outcome: {
      type: 'interrupt',
      interrupts: [
        { id: 'approval:w1', reason: 'tool_approval', toolCallId: 'w1', expiresAt: '2999-01-01T00:00:00Z' },
        { id: 'approval:w2', reason: 'tool_approval', toolCallId: 'w2', expiresAt: '2999-01-01T00:00:00Z' },
      ],
    },
  },
]

/** Run the two-interrupt script, approve both cards and wait for the resumed answer. */
async function approveBoth(user: User) {
  scripts.push(interruptRun, textRun('r2', 'a2', 'Both done.'))
  await send(user, 'Create a doc and rename the project')
  await user.click(await screen.findByRole('button', { name: 'approve w1' }))
  await user.click(screen.getByRole('button', { name: 'approve w2' }))
  await screen.findByText('Both done.')
}

function runAt(index: number): RunAgentInput {
  const run = runs.at(index)
  if (run === undefined) throw new Error(`run ${index} was not started`)
  return run
}

describe('AssistantPanel', () => {
  // jsdom has no scrollIntoView; the returned teardown removes the stub again.
  beforeEach(() => stubElementScrollIntoView())

  beforeEach(() => {
    runs.length = 0
    scripts.length = 0
    useThreadStore.getState().reset()
    useAssistantUiStore.getState().reset()
  })

  it('sends with Enter and renders the streamed answer', async () => {
    scripts.push(textRun('r1', 'a1', 'Customers mostly mention **delivery**.'))
    const user = await openPanel()
    await send(user, 'What is up?')

    expect(await screen.findByText('delivery')).toBeInTheDocument()
    expect(screen.getByText('What is up?')).toBeInTheDocument()
    // Saved as the run starts (a reload mid-run keeps the question) and again
    // when it ends, carrying the answer.
    await waitFor(() => expect(saveSession).toHaveBeenCalledTimes(2))
    expect(JSON.stringify(vi.mocked(saveSession).mock.calls.at(-1))).toContain('delivery')
  })

  it('starts exactly one run carrying the user message and the page context', async () => {
    scripts.push(textRun('r1', 'a1', 'ok'))
    const user = await openPanel()
    await send(user, 'What is up?')
    await screen.findByText('ok')

    expect(runs).toHaveLength(1)
    expect(runAt(0).messages).toStrictEqual([expect.objectContaining({ role: 'user', content: 'What is up?' })])
    expect(runAt(0).forwardedProps).toMatchObject({ page: { kind: 'project', projectId: 'p1', path: '/projects/p1' } })
  })

  it('Shift+Enter inserts a newline instead of sending', async () => {
    const user = await openPanel()
    await user.type(screen.getByLabelText('Message the assistant'), 'line1{Shift>}{Enter}{/Shift}line2')
    expect(runs).toHaveLength(0)
    expect(screen.getByLabelText('Message the assistant')).toHaveValue('line1\nline2')
  })

  describe('approvals', () => {
    it('shows one approval card per interrupt, with its args, and blocks the composer', async () => {
      scripts.push(interruptRun)
      const user = await openPanel()
      await send(user, 'Create a doc and rename the project')

      expect(await screen.findAllByTestId('approval-card')).toHaveLength(2)
      expect(screen.getByTestId('args-w1')).toHaveTextContent('"title":"A"')
      expect(screen.getByText('Approve or decline the pending action to continue.')).toBeInTheDocument()
    })

    it('resumes exactly once, only after every interrupt is resolved', async () => {
      scripts.push(interruptRun, textRun('r2', 'a2', 'Both done.'))
      const user = await openPanel()
      await send(user, 'Create a doc and rename the project')
      await user.click(await screen.findByRole('button', { name: 'approve w1' }))
      expect(runs).toHaveLength(1)

      await user.click(screen.getByRole('button', { name: 'approve w2' }))
      expect(await screen.findByText('Both done.')).toBeInTheDocument()
      expect(runs).toHaveLength(2)
      expect(screen.queryAllByTestId('approval-card')).toHaveLength(0)
    })

    it('the resume run continues the same thread with both resolutions', async () => {
      await approveBoth(await openPanel())
      const [first, resume] = [runAt(0), runAt(1)]
      expect(resume.threadId).toBe(first.threadId)
      expect(resume.runId).not.toBe(first.runId)
      expect(resume.resume).toStrictEqual([
        { interruptId: 'approval:w1', status: 'resolved', payload: { approved: true } },
        { interruptId: 'approval:w2', status: 'resolved', payload: { approved: true } },
      ])
    })

    it('the resume run replays the tool calls and one tool message per outcome', async () => {
      await approveBoth(await openPanel())
      const { messages } = runAt(1)
      expect(messages.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'tool', 'tool'])
      expect(messages[1]).toMatchObject({ toolCalls: [{ id: 'w1' }, { id: 'w2' }] })
      expect(messages.slice(2).map((m) => (m.role === 'tool' ? [m.toolCallId, JSON.parse(String(m.content))] : null))).toStrictEqual([
        ['w1', { status: 'executed', summary: 'did create_document' }],
        ['w2', { status: 'executed', summary: 'did update_project' }],
      ])
    })
  })

  describe('modes', () => {
    it('switches bubble → expanded → fullscreen', async () => {
      const user = await openPanel()
      expect(screen.getByRole('dialog').className).toContain('w-[400px]')

      await user.click(screen.getByRole('button', { name: 'Expand' }))
      expect(screen.getByRole('dialog').className).toContain('w-[720px]')

      await user.click(screen.getByRole('button', { name: 'Full screen' }))
      expect(screen.getByRole('dialog').className).toContain('inset-0')
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    })

    it('Esc leaves fullscreen for expanded, and Close closes the panel', async () => {
      const user = await openPanel()
      act(() => {
        useAssistantUiStore.setState({ mode: 'fullscreen' })
      })

      await user.keyboard('{Escape}')
      expect(useAssistantUiStore.getState().mode).toBe('expanded')

      await user.click(screen.getByRole('button', { name: 'Close' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    // Below `sm` bubble and expanded are the same full-width sheet, so Expand
    // would do nothing there; jsdom applies no media queries, so the responsive
    // classes themselves are what can be pinned.
    it('hides Expand in the narrow-viewport sheet but keeps Full screen', async () => {
      await openPanel()
      expect(screen.getByRole('dialog').className).toContain('max-sm:inset-x-2')
      expect(screen.getByRole('button', { name: 'Expand' })).toHaveClass('max-sm:hidden')
      expect(screen.getByRole('button', { name: 'Full screen' })).not.toHaveClass('max-sm:hidden')
    })
  })

  // Regression (backlog "Agent 1 #5"): the panel and sessions-drawer X buttons are
  // DialogClose with their own labels, so they never collide with an approval
  // card's "Dismiss".
  describe('close buttons are labelled "Close", never "Dismiss"', () => {
    it('on the panel', async () => {
      await openPanel()
      expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('dialog-close')
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    })

    it('on the sessions drawer, which it closes', async () => {
      const user = await openPanel()
      await user.click(screen.getByRole('button', { name: 'Past conversations' }))
      const drawer = await screen.findByRole('complementary', { name: 'Past conversations' })
      const drawerClose = within(drawer).getByRole('button', { name: 'Close' })
      expect(drawerClose).toHaveClass('dialog-close')
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
      await user.click(drawerClose)
      expect(screen.queryByRole('complementary', { name: 'Past conversations' })).not.toBeInTheDocument()
    })
  })

  // Design audit D-OVL: opening left focus on the launcher, the drawer ignored
  // Escape (it stayed open and focus was lost), and closing dropped focus on <body>.
  describe('keyboard focus', () => {
    it('opening the floating panel puts focus in the composer', async () => {
      await openPanel()
      expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveFocus()
    })

    it('the sessions drawer takes focus, closes on Escape and returns focus to its button', async () => {
      const user = await openPanel()
      const toggle = screen.getByRole('button', { name: 'Past conversations' })
      await user.click(toggle)
      const drawer = await screen.findByRole('complementary', { name: 'Past conversations' })
      expect(drawer).toContainElement(document.activeElement instanceof HTMLElement ? document.activeElement : null)
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('complementary', { name: 'Past conversations' })).not.toBeInTheDocument()
      expect(toggle).toHaveFocus()
    })

    it('closing the panel from its header returns focus to the launcher', async () => {
      const user = await openPanel()
      await user.click(screen.getByRole('button', { name: 'Close' }))
      expect(screen.getByRole('button', { name: 'Open assistant' })).toHaveFocus()
    })

    it('keeps Tab inside the sessions drawer, which covers the panel', async () => {
      const user = await openPanel()
      await user.click(screen.getByRole('button', { name: 'Past conversations' }))
      const drawer = await screen.findByRole('complementary', { name: 'Past conversations' })
      await tabTimes(user, 6)
      expect(drawer).toContainElement(document.activeElement instanceof HTMLElement ? document.activeElement : null)
    })
  })

  it('/chat has its own level-one heading (the shell no longer supplies one)', () => {
    renderChatPage()
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  // Regression: a `relative` class on the floating panel overrode `fixed` (same
  // specificity, later in the stylesheet), so the 600px bubble rendered in flow
  // and its header was pushed above the viewport.
  it.each(['bubble', 'expanded', 'fullscreen'] as const)('positions the floating %s panel with `fixed` only', async (mode) => {
    await openPanel()
    useAssistantUiStore.setState({ mode })
    const classes = (await screen.findByRole('dialog')).className.split(/\s+/)
    expect(classes).toContain('fixed')
    expect(classes).not.toContain('relative')
  })

  it('greets an empty conversation with the idle Kiro ghost', async () => {
    await openPanel()
    const greeting = screen.getByText('How can I help?')
    const ghost = greeting.parentElement?.querySelector('svg')
    expect(ghost).toHaveAttribute('aria-hidden', 'true')
    expect(ghost).toHaveClass('text-aim')
  })

  it('shows the page context chip and page-specific suggestions', async () => {
    await openPanel()
    expect(screen.getByText('Using: Project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Summarize this project and its personas' })).toBeInTheDocument()
  })

  it('is hidden on /chat, where the page renders the assistant itself', () => {
    render(<><AssistantRoot /><Chat /></>, { initialEntries: ['/chat'] })
    expect(screen.queryByRole('button', { name: 'Open assistant' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Assistant' })).toBeInTheDocument()
    expect(screen.getByText('Using: AI chat')).toBeInTheDocument()
  })

  describe('/chat with several conversations', () => {
    function sidebar() {
      return screen.getByRole('navigation', { name: 'Conversations' })
    }

    it('fills the content area with the conversation sidebar beside the chat', () => {
      renderChatPage()
      const region = screen.getByRole('region', { name: 'Assistant' })
      expect(region.className).toContain('h-full')
      expect(region.parentElement?.className).not.toContain('max-w-4xl')
      expect(within(sidebar()).getByRole('button', { name: 'New conversation' })).toBeInTheDocument()
      expect(within(sidebar()).getByRole('list', { name: 'History' })).toBeInTheDocument()
    })

    /** First conversation left running, a second one answered: returns the sidebar's Open list. */
    async function runTwoConversations(user: User) {
      scripts.push(HANG, textRun('r2', 'a2', 'Second answer.'))
      await send(user, 'First question')
      const open = within(sidebar()).getByRole('list', { name: 'Open' })
      await within(open).findByLabelText('Running')
      await user.click(within(sidebar()).getByRole('button', { name: 'New conversation' }))
      await send(user, 'Second question')
      await screen.findByText('Second answer.')
      return open
    }

    it('starts a second conversation while the first one is still running', async () => {
      const open = await runTwoConversations(renderChatPage())
      expect(within(open).getByLabelText('Running')).toBeInTheDocument()
      expect(runs).toHaveLength(2)
      expect(new Set(runs.map((r) => r.threadId)).size).toBe(2)
    })

    it('"New conversation" clears the view without stopping the running one', async () => {
      scripts.push(HANG)
      const user = renderChatPage()
      await send(user, 'First question')
      await user.click(within(sidebar()).getByRole('button', { name: 'New conversation' }))
      expect(screen.queryByRole('log', { name: 'Conversation' })).not.toBeInTheDocument()
      expect(within(sidebar()).getByLabelText('Running')).toBeInTheDocument()
    })

    it('switching back shows the running conversation with its Stop button', async () => {
      const user = renderChatPage()
      const open = await runTwoConversations(user)
      await user.click(within(open).getByRole('button', { name: 'Running First question' }))
      const log = screen.getByRole('log', { name: 'Conversation' })
      expect(within(log).getByText('First question')).toBeInTheDocument()
      expect(within(log).queryByText('Second answer.')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    })

    it('closing a running conversation from the sidebar stops it', async () => {
      scripts.push(HANG)
      const user = renderChatPage()
      await send(user, 'Long question')
      const open = within(sidebar()).getByRole('list', { name: 'Open' })
      await user.click(await within(open).findByRole('button', { name: 'Stop and close “Long question”' }))
      expect(screen.queryByRole('log', { name: 'Conversation' })).not.toBeInTheDocument()
      expect(within(sidebar()).queryByRole('list', { name: 'Open' })).not.toBeInTheDocument()
    })
  })

  it('resets the UI and thread when the user signs out', () => {
    act(() => {
      useAuthStore.setState({ isAuthenticated: true })
      useAssistantUiStore.getState().setOpen(true)
      useThreadStore.getState().dispatch({ type: 'local/user_message', message: { id: 'u', role: 'user', content: 'secret' } })
    })
    const threadId = useThreadStore.getState().thread.threadId
    act(() => useAuthStore.getState().logout())
    expect(useAssistantUiStore.getState().open).toBe(false)
    expect(useThreadStore.getState().thread.messages).toStrictEqual([])
    expect(useThreadStore.getState().thread.threadId).not.toBe(threadId)
  })
})
