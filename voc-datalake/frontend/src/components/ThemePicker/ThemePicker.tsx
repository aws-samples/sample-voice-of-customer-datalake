/**
 * @fileoverview A radio group of colour-theme cards, each with a small live preview.
 *
 * The preview is wrapped in `data-theme="<id>-<mode>"`, so that theme's tokens apply to
 * the preview subtree only (the mode is the one painted on `<html>`). Keyboard per the
 * WAI-ARIA radio group: Tab reaches the checked card; the arrow keys, Home and End move
 * and check; Space checks. Read-only: the cards stay focusable and arrows move focus,
 * but nothing is checked.
 *
 * @module components/ThemePicker
 */
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { themeAttribute } from '../../theme/themeCatalog'
import type { ColorThemeId, ThemeMode } from '../../theme/themeCatalog'
import { useDocumentMode } from './useDocumentMode'
import { targetIndex } from './radioKeys'

export interface ThemeOption {
  /** What `onChange` receives (a theme id, or a choice such as `workspace`). */
  readonly value: string
  /** The palette the preview shows. */
  readonly theme: ColorThemeId
  readonly label: string
}

interface ThemePickerProps {
  readonly options: readonly ThemeOption[]
  readonly value: string
  readonly onChange: (value: string) => void
  /** The id of the visible label of the group. */
  readonly labelledBy: string
  readonly readOnly?: boolean
}

function Preview({ theme, mode }: Readonly<{ theme: ColorThemeId; mode: ThemeMode }>) {
  return (
    <div data-theme={themeAttribute(theme, mode)} aria-hidden="true" className="rounded-md border border-border bg-bg p-2 space-y-1.5">
      <div className="h-1.5 w-2/3 rounded-full bg-text-strong" />
      <div className="h-1.5 w-1/2 rounded-full bg-muted" />
      <div className="flex items-center gap-1.5 rounded-sm border border-border bg-card p-1.5">
        <span className="h-3 flex-1 rounded-sm bg-bg-elevated" />
        <span className="h-3 w-5 rounded-sm bg-accent" />
      </div>
    </div>
  )
}

export default function ThemePicker({ options, value, onChange, labelledBy, readOnly = false }: ThemePickerProps) {
  const mode = useDocumentMode()
  const cards = useRef<(HTMLButtonElement | null)[]>([])
  const checkedIndex = options.findIndex((option) => option.value === value)
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex

  const choose = (option: ThemeOption) => {
    if (!readOnly && option.value !== value) onChange(option.value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = targetIndex(event.key, index, options.length)
    if (next === null) return
    event.preventDefault()
    cards.current[next]?.focus()
    const option = options.at(next)
    if (option !== undefined) choose(option)
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-readonly={readOnly || undefined}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-3">
      {options.map((option, index) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => { cards.current[index] = el }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => choose(option)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={clsx(
              'focus-ring flex flex-col gap-2 rounded-lg border p-2 text-left',
              checked ? 'border-accent bg-accent-subtle' : 'border-border bg-card',
              readOnly ? 'cursor-default' : 'hover:bg-bg-hover',
            )}
          >
            <Preview theme={option.theme} mode={mode} />
            <span className="flex items-start gap-1.5 text-sm text-text break-words min-w-0">
              {checked ? <Check size={14} className="mt-0.5 flex-shrink-0 text-accent-text" aria-hidden="true" /> : null}
              <span className="min-w-0">{option.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
