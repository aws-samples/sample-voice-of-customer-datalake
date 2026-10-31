/**
 * @fileoverview A multi-value filter: a button that names the selection and opens a checkbox list.
 *
 * Nothing checked = every value (no filter); several checked = any of them, which is exactly
 * what the server's comma lists mean (`api/feedbackFacets.ts`). The panel closes on Escape
 * (focus returns to the button) and on a click outside. Shared by the Dashboard and Categories
 * filter bars. Ported from PR #429's `FeedbackFilterPanel` checkbox groups (@aws-bryan).
 *
 * @module components/FacetMultiSelect
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'

interface FacetMultiSelectProps<T extends string> {
  /** What the facet filters, e.g. "Source": the button's and the group's accessible name. */
  readonly label: string
  /** What the button says with nothing checked, e.g. "All sources". */
  readonly allLabel: string
  readonly options: readonly T[]
  readonly selected: readonly T[]
  readonly onToggle: (value: T) => void
  readonly onClear: () => void
  /** How an option reads; the raw value stays the filter. */
  readonly display?: (option: T) => string
}

/** The button text: "All …", the one value's label, or "N selected". */
function useSummary<T extends string>(props: FacetMultiSelectProps<T>, display: (option: T) => string): string {
  const { t } = useTranslation('components')
  const { selected, allLabel } = props
  if (selected.length === 0) return allLabel
  const [only] = selected
  if (selected.length === 1 && only !== undefined) return display(only)
  return t('facetFilters.selectedCount', { count: selected.length })
}

const noCleanup = () => {}

/** Close on Escape (focus back to the button) and on a pointer press outside `root`. */
function useDismiss(open: boolean, close: () => void, root: React.RefObject<HTMLDivElement | null>,
  button: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return noCleanup
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close()
      button.current?.focus()
    }
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, close, root, button])
}

const identity = <T extends string>(option: T): string => option

export default function FacetMultiSelect<T extends string>(props: FacetMultiSelectProps<T>) {
  const { label, options, selected, onToggle, onClear, display = identity } = props
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const summary = useSummary(props, display)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, root, button)

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        className={clsx('select w-auto inline-flex items-center gap-2 text-left', selected.length > 0 && 'ring-1 ring-inset ring-accent/40')}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate max-w-[12rem]">{summary}</span>
        <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={label}
          className="absolute z-20 mt-1 min-w-[12rem] max-h-72 overflow-auto rounded-md border border-border bg-surface p-2 shadow-lg">
          {options.map((option) => (
            <label key={option} className="flex items-center gap-2 min-h-9 px-1 cursor-pointer text-sm text-text">
              <input type="checkbox" className="rounded-sm accent-accent focus-ring"
                checked={selected.includes(option)} onChange={() => onToggle(option)} />
              <span>{display(option)}</span>
            </label>
          ))}
          {selected.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm mt-1 w-full justify-start" onClick={() => onClear()}>
              {t('facetFilters.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
