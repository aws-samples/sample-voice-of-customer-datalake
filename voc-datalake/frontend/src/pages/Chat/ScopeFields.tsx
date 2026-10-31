/**
 * @fileoverview The controls of the /chat filter panel: one per scope filter, in the
 * page-filter vocabulary (source, category, sentiment, rating + rating_dir, urgent, channel, tag).
 * Native controls only (select, checkbox), so every field is keyboard operable and labelled.
 *
 * @module pages/Chat/ScopeFields
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { ScopeFilterKey, ScopeFilters } from '../../assistant/store/chatScopeStore'
import { splitList } from './useScopeCount'

export interface ScopeOptions {
  readonly sources: readonly string[]
  readonly categories: readonly string[]
  readonly channels: readonly string[]
  readonly tags: readonly string[]
}

const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const
/** `<direction>:<stars>` options: at least 2–5 stars, at most 1–4 stars. */
const RATING_CHOICES = ['up:5', 'up:4', 'up:3', 'up:2', 'below:4', 'below:3', 'below:2', 'below:1'] as const

interface FieldsProps {
  readonly filters: ScopeFilters
  readonly options: ScopeOptions
  readonly onChange: (next: ScopeFilters) => void
}

/** One select over a list of values, with an "any" choice that clears the filter. */
function ValueSelect({ field, label, anyLabel, values, display, filters, onChange }: Readonly<{
  field: ScopeFilterKey
  label: string
  anyLabel: string
  values: readonly string[]
  display: (value: string) => string
}> & FieldsProps) {
  const id = useId()
  const current = filters[field] ?? ''
  // A value set elsewhere (a restored scope) stays selectable even when the window no longer lists it.
  const shown = current !== '' && !values.includes(current) ? [current, ...values] : values
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-muted">{label}</label>
      <select id={id} className="select" value={current} onChange={(e) => onChange({ ...filters, [field]: e.target.value })}>
        <option value="">{anyLabel}</option>
        {shown.map((value) => <option key={value} value={value}>{display(value)}</option>)}
      </select>
    </div>
  )
}

function ratingValue(filters: ScopeFilters): string {
  if (filters.rating === undefined) return ''
  return `${filters.rating_dir === 'below' ? 'below' : 'up'}:${filters.rating}`
}

function RatingSelect({ filters, onChange }: Omit<FieldsProps, 'options'>) {
  const { t } = useTranslation('assistant')
  const id = useId()
  // The store drops empty values, so '' clears a field.
  const pick = (value: string) => {
    const [direction, stars] = value.split(':')
    onChange({ ...filters, rating: stars ?? '', rating_dir: direction === 'below' ? 'below' : '' })
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-muted">{t('scope.rating')}</label>
      <select id={id} className="select" value={ratingValue(filters)} onChange={(e) => pick(e.target.value)}>
        <option value="">{t('scope.anyRating')}</option>
        {RATING_CHOICES.map((choice) => {
          const [direction, stars] = choice.split(':')
          return (
            <option key={choice} value={choice}>
              {t(direction === 'below' ? 'scope.ratingAtMost' : 'scope.ratingAtLeast', { count: Number(stars) })}
            </option>
          )
        })}
      </select>
    </div>
  )
}

/** Several categories (`category=a,b`), as a checkbox group. */
function CategoryChecks({ filters, options, onChange }: FieldsProps) {
  const { t } = useTranslation('assistant')
  const labels = useDisplayLabels()
  const selected = splitList(filters.category)
  const shown = [...new Set([...selected, ...options.categories])]
  const toggle = (category: string) => {
    const next = selected.includes(category) ? selected.filter((c) => c !== category) : [...selected, category]
    onChange({ ...filters, category: next.join(',') })
  }
  return (
    <fieldset className="col-span-full flex flex-col gap-1">
      <legend className="text-[12px] font-medium text-muted">{t('scope.categories')}</legend>
      {shown.length === 0 && <p className="text-[12px] text-muted">{t('scope.noCategories')}</p>}
      <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
        {shown.map((category) => (
          <label key={category} className="flex min-h-7 cursor-pointer items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={selected.includes(category)} onChange={() => toggle(category)} />
            {labels.category(category)}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export default function ScopeFields({ filters, options, onChange }: FieldsProps) {
  const { t } = useTranslation('assistant')
  const labels = useDisplayLabels()
  const plain = (value: string) => value
  const common = { filters, options, onChange }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <ValueSelect {...common} field="source" label={t('scope.source')} anyLabel={t('scope.anySource')}
        values={options.sources} display={labels.source} />
      <ValueSelect {...common} field="sentiment" label={t('scope.sentiment')} anyLabel={t('scope.anySentiment')}
        values={SENTIMENTS} display={(value) => t(`scope.sentiments.${value}`, { defaultValue: value })} />
      <RatingSelect filters={filters} onChange={onChange} />
      <ValueSelect {...common} field="channel" label={t('scope.channel')} anyLabel={t('scope.anyChannel')}
        values={options.channels} display={plain} />
      <ValueSelect {...common} field="tag" label={t('scope.tag')} anyLabel={t('scope.anyTag')}
        values={options.tags} display={plain} />
      <label className="flex min-h-9 cursor-pointer items-center gap-2 self-end text-[13px]">
        <input
          type="checkbox"
          checked={filters.urgent === '1'}
          onChange={(e) => onChange({ ...filters, urgent: e.target.checked ? '1' : '' })}
        />
        {t('scope.urgentOnly')}
      </label>
      <CategoryChecks {...common} />
    </div>
  )
}
