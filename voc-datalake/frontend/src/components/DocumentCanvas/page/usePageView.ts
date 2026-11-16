/**
 * @fileoverview What the page's View menu and its toolbar switch (two doors to one state): the comments panel (a
 * PR/FAQ or PRD), the outline ("Contents") and the full width. They are the person's preferences, not the address:
 * kept in this browser (localStorage, `voc-document-view`) and the same on every document page. Only an explicit
 * switch (the toolbar's button, the View menu's entry, its shortcut) stores a choice.
 *
 * Without a stored choice the panel is closed (its toolbar button counts the open threads), Contents is shown and the
 * text takes the full width (off, it keeps a comfortable line length). Version 1 is the first stored shape: before
 * 7.46.00 the switches lived only as long as the page, so there is no earlier record to migrate, and everyone starts
 * on these defaults. A record that is not one (tampered, from a later shape) costs only its own fields.
 *
 * `revealComments` opens the panel for what needs it: a comment started on a selection (the format bar's Comment,
 * Ctrl/⌘+Alt+M), a click on a commented passage, a link to a thread, a persona review that filed comments. It opens
 * for this visit of the page only and stores nothing: the next page (another document, a reload) shows the stored
 * choice again. An explicit switch while it is open stores what it shows next (closing it stores "closed").
 *
 * @module components/DocumentCanvas/page/usePageView
 */
import { useMemo, useState } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { CanvasViewControls } from '../actions/canvasMenus'

interface StoredView {
  readonly comments: boolean
  readonly outline: boolean
  readonly fullWidth: boolean
}

type Switch = keyof StoredView

interface DocumentViewState extends StoredView {
  /** Stores `on` as the person's choice for `which`. */
  readonly choose: (which: Switch, on: boolean) => void
}

const VIEW_DEFAULTS: StoredView = { comments: false, outline: true, fullWidth: true }

/** A stored field, or its default when the record does not hold a usable one. */
function storedSwitch(persisted: unknown, which: Switch): boolean {
  const value: unknown = typeof persisted === 'object' && persisted !== null ? Reflect.get(persisted, which) : undefined
  return typeof value === 'boolean' ? value : VIEW_DEFAULTS[which]
}

export const useDocumentViewStore = create<DocumentViewState>()(
  persist(
    (set) => ({
      ...VIEW_DEFAULTS,
      choose: (which, on) => set({ [which]: on }),
    }),
    {
      name: 'voc-document-view',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state): StoredView => ({ comments: state.comments, outline: state.outline, fullWidth: state.fullWidth }),
      merge: (persisted, current) => ({
        ...current,
        comments: storedSwitch(persisted, 'comments'),
        outline: storedSwitch(persisted, 'outline'),
        fullWidth: storedSwitch(persisted, 'fullWidth'),
      }),
    },
  ),
)

export interface PageView extends CanvasViewControls {
  readonly revealComments: () => void
}

export function usePageView(commentable: boolean): PageView {
  const comments = useDocumentViewStore((state) => state.comments)
  const outline = useDocumentViewStore((state) => state.outline)
  const fullWidth = useDocumentViewStore((state) => state.fullWidth)
  const choose = useDocumentViewStore((state) => state.choose)
  // Opened for what needed it, for this visit of the page only (see the module's doc).
  const [revealed, setRevealed] = useState(false)
  const commentsShown = comments || revealed
  return useMemo(() => ({
    comments: commentable ? {
      on: commentsShown,
      toggle: () => {
        setRevealed(false)
        choose('comments', !commentsShown)
      },
    } : undefined,
    outline: { on: outline, toggle: () => choose('outline', !outline) },
    fullWidth: { on: fullWidth, toggle: () => choose('fullWidth', !fullWidth) },
    revealComments: () => setRevealed(true),
  }), [choose, commentable, commentsShown, fullWidth, outline])
}
