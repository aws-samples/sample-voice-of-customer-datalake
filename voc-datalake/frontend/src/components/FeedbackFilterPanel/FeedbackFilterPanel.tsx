/**
 * @fileoverview The collapsible feedback filter panel shared by Dashboard,
 * Categories and Problem Analysis (and reused by the project pre-filter).
 *
 * Fully controlled: the page owns the `FeedbackFilterState` (usually through
 * `usePageFilters`) and gets the next state from `onChange`. Option lists come
 * from the page (entities for the window), so the panel never fetches.
 * Enrichment-field groups are generated from the registry
 * (api/enrichmentFields.ts), so a new field appears here without a code change.
 *
 * @module components/FeedbackFilterPanel
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Filter, Loader2, X } from 'lucide-react'
import { ENRICHMENT_FIELDS, enrichmentFilterOptions } from '../../api/enrichmentFields'
import {
  EMPTY_FEEDBACK_FILTERS,
  SENTIMENT_OPTIONS,
  countActiveFilters,
  toggleValue,
} from '../../api/feedbackFilters'
import type { FeedbackFilterState, ListDimension } from '../../api/feedbackFilters'
import { CheckboxGroup } from './CheckboxGroup'
import type { CheckboxOption } from './CheckboxGroup'
import { enrichmentLabel, enrichmentValueLabel, humanize } from '../../utils/enrichmentLabels'

export interface FilterOptions {
  readonly sources: readonly string[]
  readonly categories: readonly string[]
  /** Rendered only when provided (Problem Analysis). */
  readonly subcategories?: readonly string[]
}

/**
 * One admin-configured custom-field filter: its `custom_fields` key, display
 * label, and suggested values. The selection lives in `filters.customFields`.
 */
export interface CustomFilterControl {
  readonly key: string
  readonly label: string
  readonly values: readonly string[]
}

/** Per-option counts for the window, shown beside each checkbox when known. */
export interface FilterCounts {
  readonly sources?: Readonly<Record<string, number>>
  readonly categories?: Readonly<Record<string, number>>
}

export interface FeedbackFilterPanelProps {
  readonly filters: FeedbackFilterState
  readonly onChange: (next: FeedbackFilterState) => void
  readonly options: FilterOptions
  readonly counts?: FilterCounts
  readonly customFilterControls?: readonly CustomFilterControl[]
  readonly defaultExpanded?: boolean
  /** Page-specific controls rendered inside the expanded panel (e.g. star rating). */
  readonly extra?: ReactNode
  /** Always-visible controls in the header row (e.g. the Categories search box). */
  readonly headerExtra?: ReactNode
  /** Content pinned to the header's right edge (e.g. Export PDF). */
  readonly trailing?: ReactNode
  /** Extra "is anything narrowing the page" signal for page-local controls, for Clear all. */
  readonly extraActive?: boolean
  /** Clears page-local controls too when the user hits Clear all. */
  readonly onClearExtra?: () => void
  /**
   * The page is still showing results for an earlier selection while the
   * current one loads (or waits out the debounce). Shown as a quiet status in
   * the header so the panel can stay open across several changes.
   */
  readonly isUpdating?: boolean
}

function UpdatingStatus({ isUpdating }: Readonly<{ isUpdating: boolean }>) {
  const { t } = useTranslation('common')
  // The live region is always mounted so assistive tech announces the change.
  return (
    <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-gray-500">
      {isUpdating && (
        <>
          <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
          {t('feedbackFilters.updating')}
        </>
      )}
    </span>
  )
}

function toOptions(values: readonly string[], counts?: Readonly<Record<string, number>>): CheckboxOption[] {
  return values.map((value) => ({ value, label: humanize(value), count: counts?.[value] }))
}

export default function FeedbackFilterPanel(props: FeedbackFilterPanelProps) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
  const bodyId = useId()
  const active = countActiveFilters(props.filters)
  const anyActive = active > 0 || (props.extraActive ?? false)

  const clearAll = () => {
    props.onChange(EMPTY_FEEDBACK_FILTERS)
    props.onClearExtra?.()
  }

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className={clsx('flex items-center gap-2 text-left min-w-0', !props.headerExtra && 'flex-1')}
        >
          <Filter size={16} className="text-gray-500 shrink-0" />
          <span className="text-sm font-medium text-gray-800">{t('feedbackFilters.title')}</span>
          {active > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
              {t('feedbackFilters.activeCount', { count: active })}
            </span>
          )}
          {expanded ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
        </button>
        {props.headerExtra && <div className="flex-1 min-w-[12rem]">{props.headerExtra}</div>}
        <UpdatingStatus isUpdating={props.isUpdating ?? false} />
        {anyActive && (
          <button type="button" onClick={clearAll} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 whitespace-nowrap">
            <X size={14} /> {t('feedbackFilters.clearAll')}
          </button>
        )}
        {props.trailing && <div className="flex items-center border-l border-gray-200 pl-3">{props.trailing}</div>}
      </div>
      <div id={bodyId} hidden={!expanded} className="border-t border-gray-100 px-4 py-4 space-y-4">
        {props.extra}
        <FilterGroups {...props} />
      </div>
    </div>
  )
}

function FilterGroups({ filters, onChange, options, counts, customFilterControls }: FeedbackFilterPanelProps) {
  const { t } = useTranslation('common')
  const toggle = (key: ListDimension) => (value: string) =>
    onChange({ ...filters, [key]: toggleValue(filters[key], value) })
  const clear = (key: ListDimension) => () => onChange({ ...filters, [key]: [] })
  const sentimentOptions = SENTIMENT_OPTIONS.map((value) => ({ value, label: t(`sentiment.${value}`) }))

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <CheckboxGroup legend={t('feedbackFilters.sources')} options={toOptions(options.sources, counts?.sources)}
        selected={filters.sources} onToggle={toggle('sources')} onClear={clear('sources')} />
      <CheckboxGroup legend={t('feedbackFilters.categories')} options={toOptions(options.categories, counts?.categories)}
        selected={filters.categories} onToggle={toggle('categories')} onClear={clear('categories')} />
      {options.subcategories && (
        <CheckboxGroup legend={t('feedbackFilters.subcategories')} options={toOptions(options.subcategories)}
          selected={filters.subcategories} onToggle={toggle('subcategories')} onClear={clear('subcategories')} />
      )}
      <CheckboxGroup legend={t('feedbackFilters.sentiment')} options={sentimentOptions}
        selected={filters.sentiments} onToggle={toggle('sentiments')} onClear={clear('sentiments')} />
      <EnrichmentGroups filters={filters} onChange={onChange} />
      <UrgencyGroup filters={filters} onChange={onChange} />
      <CustomFieldGroups filters={filters} onChange={onChange} customFilterControls={customFilterControls} />
    </div>
  )
}

function EnrichmentGroups({ filters, onChange }: Pick<FeedbackFilterPanelProps, 'filters' | 'onChange'>) {
  const { t } = useTranslation('common')
  const setField = (name: string, values: string[]) =>
    onChange({ ...filters, enrichment: { ...filters.enrichment, [name]: values } })
  return (
    <>
      {ENRICHMENT_FIELDS.map((field) => {
        const selected = filters.enrichment[field.name] ?? []
        return (
          <CheckboxGroup
            key={field.name}
            legend={enrichmentLabel(t, field.name)}
            options={enrichmentFilterOptions(field).map((value) => ({ value, label: enrichmentValueLabel(t, field.name, value) }))}
            selected={selected}
            onToggle={(value) => setField(field.name, toggleValue(selected, value))}
            onClear={() => setField(field.name, [])}
          />
        )
      })}
    </>
  )
}

function UrgencyGroup({ filters, onChange }: Pick<FeedbackFilterPanelProps, 'filters' | 'onChange'>) {
  const { t } = useTranslation('common')
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-medium text-gray-500 mb-1.5">{t('feedbackFilters.urgency')}</legend>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={filters.urgentOnly}
          onChange={(e) => onChange({ ...filters, urgentOnly: e.target.checked })}
          className="rounded border-gray-300 text-red-600 focus:ring-red-500 w-3.5 h-3.5"
        />
        <span className="text-xs text-gray-700">{t('feedbackFilters.urgentOnly')}</span>
      </label>
    </fieldset>
  )
}

/**
 * One multi-select group per admin-configured custom field. The options are the
 * field's suggested values; a selected value outside them (a deep link, or one
 * that aged out of the sample) still shows, via CheckboxGroup. Values render
 * verbatim — they are customer data, not slugs to humanize.
 */
function CustomFieldGroups({
  filters, onChange, customFilterControls = [],
}: Pick<FeedbackFilterPanelProps, 'filters' | 'onChange' | 'customFilterControls'>) {
  const setValues = (key: string, values: string[]) => {
    const rest = Object.fromEntries(Object.entries(filters.customFields).filter(([k]) => k !== key))
    // An empty selection is "any": drop the key rather than store [].
    onChange({ ...filters, customFields: values.length > 0 ? { ...rest, [key]: values } : rest })
  }
  return (
    <>
      {customFilterControls.map((control) => {
        const selected = filters.customFields[control.key] ?? []
        return (
          <CheckboxGroup
            key={control.key}
            legend={control.label}
            options={control.values.map((value) => ({ value, label: value }))}
            selected={selected}
            onToggle={(value) => setValues(control.key, toggleValue(selected, value))}
            onClear={() => setValues(control.key, [])}
            humanizeMissing={false}
          />
        )
      })}
    </>
  )
}
