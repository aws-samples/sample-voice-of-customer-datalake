/**
 * @fileoverview Assistant UI state (persisted) and the open threads (memory only).
 *
 * Several conversations can be open at once and each can run on its own: the
 * thread store holds one slot per open conversation and one of them is in view
 * (`activeId`, mirrored into `thread` for cheap selectors).
 *
 * Only UI preferences are persisted — the panel mode, the web-search toggle,
 * notifications and the active thread id in localStorage, and open/closed in
 * sessionStorage (per tab: opening the panel in one tab never opens it in
 * another; `tabScopedStorage`). Thread contents never touch either storage:
 * they live in memory here and in DynamoDB through the sessions API.
 *
 * Both stores reset when the user signs out (auth store `isAuthenticated`
 * flips to false), so the next person on the machine never sees the previous
 * user's conversation.
 *
 * @module assistant/store/assistantStore
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useAuthStore } from '../../store/authStore'
import { newId } from '../agui/client'
import { isValidSessionId } from '../sessions/schema'
import { createThreadState, threadReducer } from '../thread/reducer'
import { tabScopedStorage } from './tabScopedStorage'
import type { ThreadAction } from '../thread/reducer'
import type { ThreadState } from '../thread/types'

const PANEL_MODES = ['bubble', 'expanded', 'fullscreen'] as const
export type PanelMode = (typeof PANEL_MODES)[number]

interface AssistantUiState {
  open: boolean
  mode: PanelMode
  useWebSearch: boolean
  /** Desktop notifications when a conversation not on screen needs approval, replies or fails. */
  notify: boolean
  activeThreadId: string | null
  /** The wide panels' conversation sidebar is folded to a narrow rail (like the main menu). */
  sessionsCollapsed: boolean
  /**
   * A prompt to prefill in the composer of the conversation in view (a brief card's
   * act button, `openAssistant`). Memory only, never persisted, never sent by itself:
   * the user reads it and presses send. `id` tells two identical prompts apart.
   */
  pendingDraft: PendingDraft | null
  /**
   * Full screen was stepped out of for a moment to show a page the assistant linked to
   * (useRouteNavigate). Memory only: the stored `mode` stays the user's choice, so the next
   * open of the panel, a reload or the Full screen button brings full screen back — the panel
   * only changes mode when the USER changes it (wave 4, industry default).
   */
  uncovered: boolean
  setOpen: (open: boolean) => void
  setMode: (mode: PanelMode) => void
  setUseWebSearch: (on: boolean) => void
  setNotify: (on: boolean) => void
  setActiveThreadId: (id: string | null) => void
  setSessionsCollapsed: (collapsed: boolean) => void
  setPendingDraft: (draft: PendingDraft | null) => void
  /** Show the page behind a full-screen panel without changing the user's mode (see `uncovered`). */
  uncover: () => void
  reset: () => void
}

interface PendingDraft {
  id: number
  text: string
}

type PersistedUi = Pick<AssistantUiState, 'open' | 'mode' | 'useWebSearch' | 'notify' | 'activeThreadId' | 'sessionsCollapsed'>

const UI_DEFAULTS: PersistedUi = {
  open: false,
  mode: 'bubble',
  useWebSearch: false,
  notify: false,
  activeThreadId: null,
  sessionsCollapsed: false,
}

/** Not persisted (left out of `partialize`): a reload never brings back an unsent card prompt. */
const MEMORY_DEFAULTS: Pick<AssistantUiState, 'pendingDraft' | 'uncovered'> = { pendingDraft: null, uncovered: false }

function isPanelMode(value: unknown): value is PanelMode {
  // Stryker disable next-line ConditionalExpression: a non-string never equals a PANEL_MODES entry, so the typeof is a type guard only
  return typeof value === 'string' && PANEL_MODES.some((m) => m === value)
}

/** A stored id the sessions route could never serve is dropped on load, not kept for every later page load. */
function rememberedSessionId(value: unknown): string | null {
  return typeof value === 'string' && isValidSessionId(value) ? value : null
}

export const useAssistantUiStore = create<AssistantUiState>()(
  persist(
    (set) => ({
      ...UI_DEFAULTS,
      ...MEMORY_DEFAULTS,
      // Opening the panel again, or choosing a mode, ends a step out of full screen.
      setOpen: (open) => set(open ? { open, uncovered: false } : { open }),
      setMode: (mode) => set({ mode, uncovered: false }),
      setUseWebSearch: (useWebSearch) => set({ useWebSearch }),
      setNotify: (notify) => set({ notify }),
      setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
      setSessionsCollapsed: (sessionsCollapsed) => set({ sessionsCollapsed }),
      setPendingDraft: (pendingDraft) => set({ pendingDraft }),
      uncover: () => set({ uncovered: true }),
      reset: () => set({ ...UI_DEFAULTS, ...MEMORY_DEFAULTS }),
    }),
    {
      name: 'voc-assistant-ui',
      // `open` is per tab (sessionStorage); the preferences stay shared (localStorage).
      storage: createJSONStorage(() => tabScopedStorage(['open'])),
      partialize: (s): PersistedUi => ({
        open: s.open, mode: s.mode, useWebSearch: s.useWebSearch, notify: s.notify, activeThreadId: s.activeThreadId,
        sessionsCollapsed: s.sessionsCollapsed,
      }),
      // A tampered or stale record must not put the panel into a mode that does not exist.
      merge: (persisted, current) => {
        if (typeof persisted !== 'object' || persisted === null) return current
        const record: Record<string, unknown> = { ...persisted }
        return {
          ...current,
          open: record.open === true,
          mode: isPanelMode(record.mode) ? record.mode : current.mode,
          useWebSearch: record.useWebSearch === true,
          notify: record.notify === true,
          activeThreadId: rememberedSessionId(record.activeThreadId),
          sessionsCollapsed: record.sessionsCollapsed === true,
        }
      },
    },
  ),
)

/** The mode the floating panel shows: the user's choice, except expanded while full screen is uncovered. */
export function shownMode(state: Pick<AssistantUiState, 'mode' | 'uncovered'>): PanelMode {
  return state.mode === 'fullscreen' && state.uncovered ? 'expanded' : state.mode
}

/** One conversation held in memory. Several can be open (and running) at once. */
export interface ThreadSlot {
  thread: ThreadState
  /** When the session was first saved (sent back on every save). */
  createdAt: string
  /** A run finished (or stopped for approval) while another conversation was in view. */
  unread: boolean
  /**
   * The newest server revision this tab has seen for the conversation (the
   * stream's `assistant.session` event, or a loaded record): sent as
   * `baseRevision` so a save never overwrites a newer server revision.
   */
  revision: number
}

/**
 * Upper bound on conversations kept in memory. Opening one more evicts the
 * oldest conversation that is idle and not in view (it stays in the history,
 * it is only dropped from memory); running ones are never evicted.
 */
export const MAX_OPEN_THREADS = 8

interface ThreadStoreState {
  /** Open conversations by thread id. */
  slots: Record<string, ThreadSlot>
  /** Open thread ids, oldest first (sidebar order is newest first). */
  order: string[]
  activeId: string
  /** The active conversation — mirrors `slots[activeId]` for cheap selectors. */
  thread: ThreadState
  /** Bumped after every successful save, so session lists know to refetch. */
  saveTick: number
  /**
   * Bringing back the conversation that was in view before a reload
   * (runtime/restoreSession). `pending` blocks the composer, so a message typed
   * meanwhile can never land in a throwaway conversation; any explicit choice
   * (New conversation, picking one) settles it, and the restore then leaves the
   * view alone. Compared by identity: a newer restore replaces the ticket.
   */
  restore: RestoreTicket
  setRestore: (ticket: RestoreTicket) => void
  /** Apply an action to one thread; a closed thread ignores it (returns null). */
  dispatchTo: (threadId: string, action: ThreadAction) => ThreadState | null
  /** Open (or replace) a conversation and bring it into view. */
  replace: (thread: ThreadState, createdAt?: string, revision?: number) => void
  /** Record a newer server revision for an open conversation (never lowers it). */
  setRevision: (threadId: string, revision: number) => void
  /** Bring an open conversation into view. False when it is not open. */
  activate: (threadId: string) => boolean
  /** Start a fresh conversation in view (reuses the active one when it is still empty). */
  openNew: () => void
  /** Drop a conversation from memory; the next open one (or a fresh one) comes into view. */
  close: (threadId: string) => void
  noteSaved: () => void
  /** Forget every conversation (sign-out). */
  reset: () => void
}

type SlotsState = Pick<ThreadStoreState, 'slots' | 'order' | 'activeId' | 'thread'>

export interface RestoreTicket {
  readonly status: 'idle' | 'pending' | 'done'
}

const RESTORE_IDLE: RestoreTicket = { status: 'idle' }
export const RESTORE_DONE: RestoreTicket = { status: 'done' }

/** The user chose a conversation themselves: a restore still loading must not take the view over. */
function settledRestore(ticket: RestoreTicket): RestoreTicket {
  return ticket.status === 'pending' ? RESTORE_DONE : ticket
}

function freshSlot(): ThreadSlot {
  // Stryker disable next-line BooleanLiteral: a fresh slot always goes straight through withActive, which clears unread
  return { thread: createThreadState(newId()), createdAt: new Date().toISOString(), unread: false, revision: 0 }
}

function isBusy(thread: ThreadState): boolean {
  return thread.status === 'streaming' || thread.status === 'awaiting_approval' || thread.status === 'generating'
}

export function slotOf(slots: Record<string, ThreadSlot>, threadId: string): ThreadSlot | undefined {
  return Object.hasOwn(slots, threadId) ? slots[threadId] : undefined
}

/** Assemble the state with `slot` in view; the slot in view is never left unread. */
function withActive(slots: Record<string, ThreadSlot>, order: string[], slot: ThreadSlot): SlotsState {
  const active = slot.unread ? { ...slot, unread: false } : slot
  const activeId = active.thread.threadId
  return { slots: { ...slots, [activeId]: active }, order, activeId, thread: active.thread }
}

function singleSlotState(): SlotsState {
  const slot = freshSlot()
  return withActive({}, [slot.thread.threadId], slot)
}

/** Ids to drop (oldest first) so one more conversation fits: idle and not `keep`. */
function evictionIds(slots: Record<string, ThreadSlot>, order: string[], keep: string): Set<string> {
  const excess = order.length - MAX_OPEN_THREADS + 1
  // Stryker disable next-line EqualityOperator: at excess 0 the fall-through takes slice(0, 0), the same empty set
  if (excess <= 0) return new Set()
  const candidates = order.filter((id) => {
    if (id === keep) return false
    const slot = slotOf(slots, id)
    // Stryker disable next-line ConditionalExpression,BooleanLiteral: every id in order has a slot (type guard only)
    if (slot === undefined) return false
    return !isBusy(slot.thread)
  })
  return new Set(candidates.slice(0, excess))
}

/** The slots for `ids`, in that order (ids with no slot are skipped). */
function pickSlots(slots: Record<string, ThreadSlot>, ids: string[]): Record<string, ThreadSlot> {
  const picked: Record<string, ThreadSlot> = {}
  for (const id of ids) {
    const slot = slotOf(slots, id)
    // Stryker disable next-line ConditionalExpression: every id in order has a slot (type guard only)
    if (slot !== undefined) picked[id] = slot
  }
  return picked
}

function addSlot(state: SlotsState, slot: ThreadSlot): SlotsState {
  const id = slot.thread.threadId
  const without = state.order.filter((other) => other !== id)
  const dropped = evictionIds(state.slots, without, state.activeId)
  const order = without.filter((other) => !dropped.has(other))
  return withActive(pickSlots(state.slots, order), [...order, id], slot)
}

/** Whether a reducer step ended a run (stream finished, failed or stopped for approval). */
function runEnded(before: ThreadState, after: ThreadState): boolean {
  return before.status === 'streaming' && after.status !== 'streaming'
}

export const useThreadStore = create<ThreadStoreState>()((set, get) => ({
  ...singleSlotState(),
  saveTick: 0,
  restore: RESTORE_IDLE,
  setRestore: (restore) => set({ restore }),
  dispatchTo: (threadId, action) => {
    const state = get()
    const slot = slotOf(state.slots, threadId)
    if (slot === undefined) return null
    const next = threadReducer(slot.thread, action)
    const unread = slot.unread || (threadId !== state.activeId && runEnded(slot.thread, next))
    const slots = { ...state.slots, [threadId]: { ...slot, thread: next, unread } }
    set(threadId === state.activeId ? { slots, thread: next } : { slots })
    return next
  },
  // Stryker disable next-line BooleanLiteral: the replaced slot goes through withActive, which clears unread
  replace: (thread, createdAt, revision = 0) => set((s) => ({
    ...addSlot(s, { thread, createdAt: createdAt ?? new Date().toISOString(), unread: false, revision }),
    restore: settledRestore(s.restore),
  })),
  setRevision: (threadId, revision) => {
    const state = get()
    const slot = slotOf(state.slots, threadId)
    if (slot === undefined || revision <= slot.revision) return
    set({ slots: { ...state.slots, [threadId]: { ...slot, revision } } })
  },
  activate: (threadId) => {
    const state = get()
    const slot = slotOf(state.slots, threadId)
    if (slot === undefined) return false
    set({ ...withActive(state.slots, state.order, slot), restore: settledRestore(state.restore) })
    return true
  },
  openNew: () => {
    const state = get()
    const restore = settledRestore(state.restore)
    if (state.thread.messages.length === 0 && !isBusy(state.thread)) {
      set({ restore })
      return
    }
    set({ ...addSlot(state, freshSlot()), restore })
  },
  close: (threadId) => {
    const state = get()
    if (slotOf(state.slots, threadId) === undefined) return
    const order = state.order.filter((id) => id !== threadId)
    const slots = pickSlots(state.slots, order)
    if (threadId !== state.activeId) {
      set({ slots, order })
      return
    }
    const nextId = order.at(-1)
    // Stryker disable next-line ConditionalExpression: slotOf(slots, undefined) is undefined too (type guard only)
    const next = nextId === undefined ? undefined : slotOf(slots, nextId)
    set(next === undefined ? singleSlotState() : withActive(slots, order, next))
  },
  noteSaved: () => set((s) => ({ saveTick: s.saveTick + 1 })),
  reset: () => set({ ...singleSlotState(), saveTick: 0, restore: RESTORE_IDLE }),
}))

/** Hooks run on sign-out (the runtime registers its abort here). */
const signOutListeners = new Set<() => void>()

export function onAssistantSignOut(listener: () => void): () => void {
  signOutListeners.add(listener)
  return () => {
    signOutListeners.delete(listener)
  }
}

function resetAssistant(): void {
  for (const listener of signOutListeners) listener()
  useAssistantUiStore.getState().reset()
  useThreadStore.getState().reset()
}

useAuthStore.subscribe((state, previous) => {
  if (previous.isAuthenticated && !state.isAuthenticated) resetAssistant()
})
