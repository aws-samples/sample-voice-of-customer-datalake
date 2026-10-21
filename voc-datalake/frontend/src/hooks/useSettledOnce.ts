/**
 * @fileoverview True once `isLoading` has been false at least once.
 *
 * Pages use it to show a full-page spinner only for their very FIRST load.
 * After that, a re-query (a filter change, a cleared selection) renders inline
 * and the filter panel stays mounted, so it does not collapse or lose focus
 * between clicks.
 *
 * @module hooks/useSettledOnce
 */
import { useState } from 'react'

export function useSettledOnce(isLoading: boolean): boolean {
  const [settled, setSettled] = useState(!isLoading)
  // Derived state, updated during render (React's documented pattern for
  // "remember something about previous renders"); it only ever flips once.
  if (!isLoading && !settled) setSettled(true)
  return settled
}
