/**
 * @fileoverview A page's open tab, kept in `?tab=` so every tab is a deep link. The first
 * tab is the default and carries no param; an unknown value reads as the default. Switching
 * REPLACES the history entry, so Back leaves the page instead of replaying tab clicks.
 * @module pages/Participants/useTabParam
 */
import { useSearchParams } from 'react-router-dom'

export function useTabParam<T extends string>(tabs: readonly [T, ...T[]]): readonly [T, (tab: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const [fallback] = tabs
  const current = tabs.find((tab) => tab === searchParams.get('tab')) ?? fallback
  const choose = (tab: T) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.set('tab', tab)
      if (tab === fallback) next.delete('tab')
      return next
    }, { replace: true })
  }
  return [current, choose]
}
