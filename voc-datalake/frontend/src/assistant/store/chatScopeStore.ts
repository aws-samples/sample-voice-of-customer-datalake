/**
 * @fileoverview The /chat filter panel's scope, per conversation (ported from #429's per-conversation
 * chat filters, docs/assistant-chat-scope.md).
 *
 * The filters use the page-filter vocabulary (`PAGE_FILTER_KEYS`, the Categories URL's own
 * spelling), so the stream reads them exactly like a page's filters: as a floor the model cannot
 * widen. Kept in memory for the tab's lifetime: a reload starts every conversation unscoped.
 *
 * @module assistant/store/chatScopeStore
 */
import { create } from 'zustand'
import { MAX_PAGE_FILTER_CHARS, chatScopeSchema } from '../contract'
import type { ChatScope, PAGE_FILTER_KEYS } from '../contract'

export type ScopeFilterKey = (typeof PAGE_FILTER_KEYS)[number]
export type ScopeFilters = Partial<Record<ScopeFilterKey, string>>

interface ChatScopeState {
  /** threadId → the filters set for that conversation (absent = none). */
  byThread: Readonly<Record<string, ScopeFilters>>
  setFilters: (threadId: string, filters: ScopeFilters) => void
}

/** Drop empty values, so a cleared field leaves the scope rather than sending `""`. */
function compact(filters: ScopeFilters): ScopeFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value.trim() !== ''))
}

export const useChatScopeStore = create<ChatScopeState>()((set) => ({
  byThread: {},
  setFilters: (threadId, filters) => set((state) => ({ byThread: { ...state.byThread, [threadId]: compact(filters) } })),
}))

const NO_FILTERS: ScopeFilters = {}

/**
 * The scope a /chat run sends when its filters cannot pass the contract: a sentiment no review has,
 * so the floor admits nothing. Never no scope, which would read without the user's filters (fail open).
 */
export const REFUSED_SCOPE: ChatScope = { filters: { sentiment: 'none' } }

/** The conversation's filters (a stable empty object when none). */
export function useScopeFilters(threadId: string): ScopeFilters {
  return useChatScopeStore((state) => state.byThread[threadId] ?? NO_FILTERS)
}

/**
 * The `forwardedProps.scope` a run of this conversation sends: its filters (validated against the
 * contract) and no `limit`, so the server's default and maximum (CHAT_SCOPE_MAX_ITEMS) applies.
 * Every /chat turn carries a scope, even an empty one: it switches the reading cap on.
 */
export function chatScopeFor(threadId: string): ChatScope {
  const filters = useChatScopeStore.getState().byThread[threadId] ?? NO_FILTERS
  // Each value is cut to the contract bound, like page.filters: a cut list only narrows the floor,
  // while dropping the filters would send a run with none (fail open).
  const bounded = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value.slice(0, MAX_PAGE_FILTER_CHARS)]))
  const parsed = chatScopeSchema.safeParse(Object.keys(bounded).length > 0 ? { filters: bounded } : {})
  return parsed.success ? parsed.data : REFUSED_SCOPE
}
