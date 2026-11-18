/**
 * @fileoverview Whether the run workspace's threads show the agents' thinking (7.54.00): the "Show thinking" switch of
 * the Sessions pane, one choice for every session open. It is the person's own: kept in this browser under their
 * user (`voc-thread-thinking:<sub>`, like the onboarding cache's per-user key), the same on every run. Without a
 * stored choice it is on for an administrator (who reads a run to steer it) and off for everyone else.
 *
 * A storage that is blocked or full keeps the choice for as long as the page lives.
 *
 * @module pages/Agents/RunWorkspace/useShowThinking
 */
import { createContext, useCallback, useContext, useState } from 'react'
import { useIsAdmin, useMySub } from '../../../store/authStore'

const KEY_PREFIX = 'voc-thread-thinking:'

const keyOf = (sub: string): string => `${KEY_PREFIX}${sub === '' ? 'anonymous' : sub}`

/** The stored choice of `sub` ('on' / 'off'), null for none (or a record that is not one, or no storage). */
export function storedThinking(sub: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(keyOf(sub))
    if (raw === 'on') return true
    return raw === 'off' ? false : null
  } catch {
    return null
  }
}

function storeThinking(sub: string, on: boolean): void {
  try {
    window.localStorage.setItem(keyOf(sub), on ? 'on' : 'off')
  } catch {
    // (blocked or full: the choice lives as long as the page)
  }
}

/** The switch's state and its setter, for the signed-in person. */
export function useShowThinking(): { on: boolean; set: (on: boolean) => void } {
  const sub = useMySub()
  const isAdmin = useIsAdmin()
  const [chosen, setChosen] = useState<{ sub: string; on: boolean | null }>(() => ({ sub, on: storedThinking(sub) }))
  // (another person signed in on this page: their own choice)
  const on = (chosen.sub === sub ? chosen.on : storedThinking(sub)) ?? isAdmin
  const set = useCallback((next: boolean) => {
    storeThinking(sub, next)
    setChosen({ sub, on: next })
  }, [sub])
  return { on, set }
}

/** What the threads read of the switch (a thread outside the Sessions pane shows the thinking). */
export const ShowThinkingContext = createContext(true)

export const useThinkingShown = (): boolean => useContext(ShowThinkingContext)
