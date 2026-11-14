/**
 * @fileoverview The conversations this tab runs but the workspace does not keep.
 *
 * A platform admin who entered a workspace without being a member gets the chat routes' 404 there
 * (lambda/api/chat_handler.py resolves members only), while the assistant still answers and saves nothing
 * (lambda/stream/src/assistant/session/workspace-member.ts). Such a save is settled, not a failure: the conversation is
 * marked unsaved and shown so, and nothing retries it.
 *
 * @module assistant/sessions/unsavedThreads
 */
import { create } from 'zustand'

const useUnsavedStore = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }))

/** Mark `threadId` as not kept by the server. */
export function markUnsaved(threadId: string): void {
  useUnsavedStore.setState((state) => (state.ids.has(threadId) ? state : { ids: new Set([...state.ids, threadId]) }))
}

/** Forget every mark (sign-out, or leaving the workspace). */
export function clearUnsaved(): void {
  useUnsavedStore.setState({ ids: new Set() })
}

/** Whether `threadId` runs without being saved; re-renders when that changes. */
export function useIsUnsaved(threadId: string): boolean {
  return useUnsavedStore((state) => state.ids.has(threadId))
}
