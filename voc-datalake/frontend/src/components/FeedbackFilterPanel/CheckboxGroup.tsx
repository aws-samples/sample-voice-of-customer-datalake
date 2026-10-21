/**
 * @fileoverview One multi-select filter dimension rendered as a checkbox list.
 * @module components/FeedbackFilterPanel/CheckboxGroup
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { humanize } from '../../utils/enrichmentLabels'

export interface CheckboxOption {
  readonly value: string
  readonly label: string
  readonly count?: number
}

interface CheckboxGroupProps {
  readonly legend: string
  readonly options: readonly CheckboxOption[]
  readonly selected: readonly string[]
  readonly onToggle: (value: string) => void
  readonly onClear: () => void
  /**
   * Label slug-like selected values the options don't list (default: humanize).
   * Pass false for free-text values (custom fields) so they show verbatim.
   */
  readonly humanizeMissing?: boolean
}

/**
 * Selected values the option list does not contain (a deep link, or a selection
 * persisted from another time window) are still shown, so a filter that is
 * narrowing the page can always be seen and unchecked.
 */
function withSelected(options: readonly CheckboxOption[], selected: readonly string[], humanizeMissing: boolean): CheckboxOption[] {
  const known = new Set(options.map((o) => o.value))
  const missing = selected
    .filter((v) => !known.has(v))
    .map((value) => ({ value, label: humanizeMissing ? humanize(value) : value }))
  return [...missing, ...options]
}

export function CheckboxGroup({ legend, options, selected, onToggle, onClear, humanizeMissing = true }: CheckboxGroupProps) {
  const { t } = useTranslation('common')
  const id = useId()
  const shown = withSelected(options, selected, humanizeMissing)

  return (
    // The legend must be the fieldset's FIRST child to name the group for
    // assistive tech; floating it (and the Clear button) keeps the one-row header.
    <fieldset className="min-w-0">
      <legend className="float-left mb-1.5 text-xs font-medium text-gray-500">{legend}</legend>
      {selected.length > 0 && (
        <button type="button" onClick={onClear} className="float-right text-xs text-blue-600 hover:text-blue-800">
          {t('feedbackFilters.clearGroup')}
        </button>
      )}
      {shown.length === 0 ? (
        <p className="clear-both text-xs text-gray-400">{t('feedbackFilters.noOptions')}</p>
      ) : (
        <div className="clear-both flex flex-col gap-1 max-h-44 overflow-y-auto pr-1">
          {shown.map((option, index) => {
            // By position, not value: custom-field values are free text, and an
            // id may not contain whitespace ("Las Vegas, NV").
            const inputId = `${id}-${index}`
            return (
              <label key={option.value} htmlFor={inputId} className="flex items-center gap-2 cursor-pointer min-w-0">
                <input
                  id={inputId}
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => onToggle(option.value)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 shrink-0"
                />
                <span className="text-xs text-gray-700 truncate" title={option.label}>{option.label}</span>
                {option.count !== undefined && (
                  <span className="ml-auto text-xs text-gray-400 tabular-nums">{option.count.toLocaleString()}</span>
                )}
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
