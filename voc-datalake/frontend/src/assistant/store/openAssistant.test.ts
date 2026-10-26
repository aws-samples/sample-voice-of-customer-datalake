/**
 * openAssistant (a brief card's act button): a NEW conversation, the prompt prefilled
 * and never sent, the pending draft kept in memory only and adopted once by the panel.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Message } from '@ag-ui/core'
import { createThreadState } from '../thread/reducer'
import { useAssistantUiStore, useThreadStore } from './assistantStore'
import { composeDraft, openAssistant } from './openAssistant'
import { usePendingDraft } from './usePendingDraft'

const SENT: Message = { id: 'm1', role: 'user', content: 'an earlier question' }

beforeEach(() => {
  useAssistantUiStore.getState().reset()
  useThreadStore.getState().reset()
})

describe('composeDraft', () => {
  it('keeps a prompt without evidence as it is', () => {
    expect(composeDraft({ prompt: 'Investigate shipping' })).toBe('Investigate shipping')
  })

  it('names at most ten evidence reviews on their own line', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `f${i}`)
    const draft = composeDraft({ prompt: 'Why?', context: { feedbackIds: ids } })
    expect(draft).toBe(`Why?\n\n[feedback: ${ids.slice(0, 10).join(', ')}]`)
  })
})

describe('openAssistant', () => {
  it('opens the floating panel on a new conversation with the prompt pending', () => {
    useThreadStore.getState().replace({ ...createThreadState('old'), messages: [SENT] })
    openAssistant({ prompt: 'Investigate' }, '/')
    const ui = useAssistantUiStore.getState()
    expect(ui.open).toBe(true)
    expect(ui.pendingDraft?.text).toBe('Investigate')
    expect(useThreadStore.getState().thread.threadId).not.toBe('old')
    expect(useThreadStore.getState().thread.messages).toStrictEqual([])
  })

  it('leaves the floating panel closed on /chat, where the page is the assistant', () => {
    openAssistant({ prompt: 'Investigate' }, '/chat')
    expect(useAssistantUiStore.getState().open).toBe(false)
  })

  it('gives two identical prompts in a row different ids', () => {
    openAssistant({ prompt: 'Same' }, '/')
    const first = useAssistantUiStore.getState().pendingDraft?.id ?? 0
    openAssistant({ prompt: 'Same' }, '/')
    expect(useAssistantUiStore.getState().pendingDraft?.id ?? 0).toBeGreaterThan(first)
  })

  it('never persists the pending draft', () => {
    openAssistant({ prompt: 'Secret plan' }, '/')
    const partialize = useAssistantUiStore.persist.getOptions().partialize
    expect(JSON.stringify(partialize?.(useAssistantUiStore.getState()))).not.toContain('Secret plan')
  })

  it('forgets the pending draft on sign-out reset', () => {
    openAssistant({ prompt: 'Investigate' }, '/')
    useAssistantUiStore.getState().reset()
    expect(useAssistantUiStore.getState().pendingDraft).toBeNull()
  })
})

describe('usePendingDraft', () => {
  it('hands the prompt to the composer once and clears it from the store', () => {
    const adopted: string[] = []
    act(() => { openAssistant({ prompt: 'Draft a PR/FAQ' }, '/') })
    const { rerender } = renderHook(() => { usePendingDraft((text) => { adopted.push(text) }) })
    rerender()
    expect(adopted).toStrictEqual(['Draft a PR/FAQ'])
    expect(useAssistantUiStore.getState().pendingDraft).toBeNull()
  })
})
