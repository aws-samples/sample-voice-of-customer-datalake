/**
 * Regression tests for ChatTab — protects against the "Cannot read properties of
 * undefined (reading 'length')" crash when opening the AI Chat tab for a project
 * that has no chat history yet.
 */
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatTab from './ChatTab'
import { useProjectChatStore } from '../../store/projectChatStore'
import type { ProjectPersona, ProjectDocument } from '../../api/types'

// jsdom doesn't implement scrollIntoView — stub it so the effect in ChatTab works.
// Using Object.defineProperty because the method does not exist on Element,
// so vi.spyOn cannot wrap it.
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  value: vi.fn(),
  writable: true,
  configurable: true,
})

// Mock useStreamChat to avoid touching the streaming client
vi.mock('../../hooks/useStreamChat', () => ({
  useStreamChat: () => ({
    isStreaming: false,
    streamingText: '',
    thinkingText: '',
    activeTools: [],
    toolSteps: [],
    documentChanges: [],
    error: null,
    completedTurns: [],
    currentPersona: null,
    sendMessage: vi.fn(),
    cancel: vi.fn(),
  }),
}))

const defaultProps = {
  projectId: 'proj_empty',
  personas: [] as ProjectPersona[],
  documents: [] as ProjectDocument[],
  onSaveAsDocument: vi.fn(),
  onDocumentChanged: vi.fn(),
}

describe('ChatTab', () => {
  beforeEach(() => {
    // Reset the persisted store to the initial empty state
    useProjectChatStore.setState({ messagesByProject: {} })
  })

  it('renders the empty state without crashing when the store has no entry for the project', () => {
    render(<ChatTab {...defaultProps} />)
    expect(screen.getByText(/Start a conversation/i)).toBeInTheDocument()
  })

  it('does not render the clear-history button when there are no messages', () => {
    render(<ChatTab {...defaultProps} />)
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
  })

  it('renders existing messages when the store has an entry for the project', () => {
    useProjectChatStore.setState({
      messagesByProject: {
        proj_with_history: [
          { role: 'user', content: 'What are our top issues?' },
          { role: 'assistant', content: 'Support and delivery are the top drivers.' },
        ],
      },
    })

    render(<ChatTab {...defaultProps} projectId="proj_with_history" />)
    expect(screen.getByText('What are our top issues?')).toBeInTheDocument()
    expect(screen.getByText('Support and delivery are the top drivers.')).toBeInTheDocument()
  })

  it('shows the clear-history button once messages exist', async () => {
    const user = userEvent.setup()
    useProjectChatStore.setState({
      messagesByProject: {
        proj_with_history: [{ role: 'user', content: 'Hello' }],
      },
    })

    render(<ChatTab {...defaultProps} projectId="proj_with_history" />)
    const clearButton = screen.getByRole('button', { name: /clear/i })
    expect(clearButton).toBeInTheDocument()

    await user.click(clearButton)
    expect(useProjectChatStore.getState().messagesByProject.proj_with_history).toStrictEqual([])
  })
})
