/**
 * @fileoverview The wizard's filter chip: a pressed / not-pressed button (sources, categories, the
 * Feature requests board picker); its colours and the list toggle live in `./filterChipState`.
 *
 * @module components/DataSourceWizard/FilterChip
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { SELECTED_FILTER, UNSELECTED_FILTER } from './filterChipState'

export function FilterChip({ pressed, onToggle, className, children }: Readonly<{
  pressed: boolean
  onToggle: () => void
  /** Size and wrapping; the selected colours come from here. */
  className: string
  children: ReactNode
}>) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onToggle}
      className={clsx('rounded-lg border', className, pressed ? SELECTED_FILTER : UNSELECTED_FILTER)}>
      {children}
    </button>
  )
}
