/**
 * @fileoverview The wizard's filter chip: a pressed / not-pressed button (sources, categories, the
 * Feature requests board picker); its colours and the list toggle live in `./filterChipState`.
 *
 * @module components/DataSourceWizard/FilterChip
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { SELECTED_FILTER, UNSELECTED_FILTER } from './filterChipState'

export function FilterChip({ pressed, onToggle, className, children, disabled = false }: Readonly<{
  pressed: boolean
  onToggle: () => void
  /** Size and wrapping; the selected colours come from here. */
  className: string
  children: ReactNode
  /** A chip that cannot be picked now (a list at its cap); the caller says why next to the chips. */
  disabled?: boolean
}>) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onToggle} disabled={disabled}
      className={clsx('rounded-lg border', className, pressed ? SELECTED_FILTER : UNSELECTED_FILTER,
        disabled && 'opacity-50 cursor-not-allowed')}>
      {children}
    </button>
  )
}
