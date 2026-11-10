/**
 * @fileoverview Open state of a Home section the user can skip (the setup
 * checklist, "How it works").
 *
 * Every section starts expanded unless the user skipped it: the skip is stored
 * per user on the server, so a skipped section starts collapsed on every
 * browser. Toggling the chevron is a local choice for this visit, except that
 * expanding a skipped section un-skips it (`onUnskip`). Skipping hands control
 * back to the server answer, so the section collapses once the save lands and
 * stays open (with its error) when the save fails.
 *
 * @module pages/Home/useSkippableOpen
 */
import { useState } from 'react'

export interface SkippableOpen {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Call when the user presses the section's Skip, next to persisting it. */
  followServer: () => void
}

export function useSkippableOpen(skipped: boolean, onUnskip: () => void): SkippableOpen {
  // undefined = no choice this visit: the stored skip decides.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined)
  return {
    open: chosen ?? !skipped,
    onOpenChange: (next) => {
      setChosen(next)
      if (next && skipped) onUnskip()
    },
    followServer: () => { setChosen(undefined) },
  }
}
