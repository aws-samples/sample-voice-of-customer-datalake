/**
 * @fileoverview The Questions tab's status line, as a context (statusLine.tsx renders it): any part of the tab
 * announces a move, a delete with its Undo, or the new default ending through {@link useAnnounce}.
 *
 * @module pages/FeedbackForms/questions/statusLineContext
 */
import { createContext, useContext } from 'react'

export interface Announcement {
  readonly message: string
  /** Undo what was just done (offered for 10 s). */
  readonly undo?: () => void
}

export type Announce = (announcement: Announcement) => void

function announceNowhere(): void {
  // (outside the Questions tab there is no status line to write to)
}

export const AnnounceContext = createContext<Announce>(announceNowhere)

export function useAnnounce(): Announce {
  return useContext(AnnounceContext)
}
