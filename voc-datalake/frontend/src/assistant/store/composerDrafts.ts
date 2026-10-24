/**
 * @fileoverview What the user has typed but not sent, per conversation (wave 4: a half-typed
 * word showed up in another conversation). Each conversation keeps its own draft while the tab
 * lives, like every chat app: switching away and back brings it back, and it never appears in
 * a new or another conversation. Memory only (never storage: a draft can hold anything), and
 * forgotten on sign-out with the rest of the assistant.
 *
 * @module assistant/store/composerDrafts
 */
import { create } from 'zustand'
import { onAssistantSignOut } from './assistantStore'

interface ComposerDraftsState {
  drafts: Readonly<Record<string, string>>
  setDraft: (threadId: string, text: string) => void
  reset: () => void
}

export const useComposerDrafts = create<ComposerDraftsState>()((set) => ({
  drafts: {},
  // An emptied draft is dropped, so the record only holds conversations with text.
  setDraft: (threadId, text) => set((s) => {
    const rest = Object.fromEntries(Object.entries(s.drafts).filter(([id]) => id !== threadId))
    return { drafts: text === '' ? rest : { ...rest, [threadId]: text } }
  }),
  reset: () => set({ drafts: {} }),
}))

/** The unsent text of one conversation ('' when none). */
export function draftOf(threadId: string): string {
  const { drafts } = useComposerDrafts.getState()
  return Object.hasOwn(drafts, threadId) ? (drafts[threadId] ?? '') : ''
}

onAssistantSignOut(() => useComposerDrafts.getState().reset())
